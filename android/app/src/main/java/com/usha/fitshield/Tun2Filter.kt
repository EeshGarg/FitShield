package com.usha.fitshield

import android.util.Log
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue

/**
 * Userspace connection filter for the FitShield VpnService — blocks by the name
 * the client is actually connecting to (TLS SNI on 443, HTTP Host on 80), NOT by
 * DNS. This is how blocking works even when the device uses strict Private DNS /
 * NextDNS (all DNS is encrypted and never reaches us): we read the destination
 * host out of the connection itself.
 *
 * What it does:
 *  - Reads IPv4 AND IPv6 packets from the TUN. Layer 3 is parsed by [IpPacket],
 *    which hands back a transport offset and the two address slices; from that
 *    point on the two families run the same code, and a 16-byte address reaches
 *    an IPv6 destination because `InetAddress.getByAddress` accepts both widths.
 *  - TCP: terminates the client side locally (the app<->TUN path is lossless and
 *    in-order, so no congestion control / retransmit is needed on our side),
 *    peeks the first client payload for the SNI/Host, and either
 *      - BLOCKS (curated match): sends RST so the connection fails, or
 *      - ALLOWS: opens a *protected* socket to the real destination IP and
 *        transparently relays bytes both ways (the OS handles real TCP).
 *  - UDP: drops QUIC (UDP/443) so browsers fall back to TCP where the SNI is
 *    visible; relays other UDP (e.g. NTP) through a protected socket.
 *
 * IPv6 used to be captured and then discarded here. On a dual-stack network that
 * silently degraded to IPv4; on an IPv6-only carrier it left the device with no
 * working internet at all for as long as FitShield was on. Removing the `::/0`
 * route would have restored connectivity by letting IPv6 bypass the filter
 * entirely, which would have turned a visible failure into an invisible one — a
 * blocked brand reachable over IPv6 simply would not be blocked. So the packets
 * are parsed instead.
 *
 * What it is NOT: no HTTPS interception/decryption, no certificates, no MITM, no
 * content inspection, no telemetry. Only the plaintext SNI/Host (already sent in
 * the clear by the client) is read. Allowed traffic is relayed byte-for-byte to
 * the same IP the client chose; FitShield never sees inside TLS.
 */
class Tun2Filter(
    private val vpn: FitShieldVpnService,
    private val rules: RuleEngine,
    private val input: FileInputStream,
    private val output: FileOutputStream,
    private val onBlock: (String) -> Unit
) {
    @Volatile var running = true
    private val writeLock = Any()
    private val flows = ConcurrentHashMap<String, TcpFlow>()
    private val udpFlows = ConcurrentHashMap<String, UdpFlow>()

    fun loop() {
        val buf = ByteArray(MAX_PACKET)
        try {
            while (running) {
                val n = input.read(buf)
                if (n <= 0) { if (n < 0) break else continue }
                try { dispatch(buf, n) } catch (e: Exception) { Log.w(TAG, "dispatch", e) }
            }
        } catch (e: Exception) {
            if (running) Log.e(TAG, "tun read loop stopped", e)
        }
    }

    fun shutdown() {
        running = false
        flows.values.forEach { it.close(false) }
        flows.clear()
        udpFlows.values.forEach { it.close() }
        udpFlows.clear()
    }

    /** Write one full IP packet back to the TUN (thread-safe: many flow threads). */
    fun emit(pkt: ByteArray, len: Int) {
        synchronized(writeLock) {
            try { output.write(pkt, 0, len); output.flush() } catch (e: Exception) { Log.w(TAG, "emit", e) }
        }
    }

    private fun dispatch(pkt: ByteArray, len: Int) {
        // Null covers every packet this filter must not act on: truncated,
        // fragmented, an unwalkable IPv6 extension chain, or a protocol we do
        // not handle (ICMP/ICMPv6, ESP, …). Dropping is the pre-existing
        // behaviour for those; what changed is that IPv6 is no longer one.
        val ip = IpPacket.parse(pkt, len) ?: return
        when (ip.protocol) {
            IpPacket.PROTO_TCP -> handleTcp(pkt, ip, len)
            IpPacket.PROTO_UDP -> handleUdp(pkt, ip, len)
        }
    }

    // ---- TCP ----------------------------------------------------------------

    private fun handleTcp(pkt: ByteArray, ip: IpPacket.Header, len: Int) {
        val tcp = ip.transportOffset
        if (tcp + 20 > len) return
        val srcPort = IpPacket.u16(pkt, tcp)
        val dstPort = IpPacket.u16(pkt, tcp + 2)
        val seq = IpPacket.u32(pkt, tcp + 4)
        val ack = IpPacket.u32(pkt, tcp + 8)
        val dataOff = ((pkt[tcp + 12].toInt() and 0xFF) ushr 4) * 4
        val flags = pkt[tcp + 13].toInt() and 0xFF
        val window = IpPacket.u16(pkt, tcp + 14)
        val payloadOff = tcp + dataOff
        val payloadLen = len - payloadOff
        if (dataOff < 20 || payloadOff > len) return

        val key = flowKey(ip, srcPort, dstPort)
        val syn = flags and 0x02 != 0
        val rst = flags and 0x04 != 0
        val fin = flags and 0x01 != 0
        val isAck = flags and 0x10 != 0

        var flow = flows[key]

        if (rst) { flow?.close(false); flows.remove(key); return }

        if (syn && flow == null) {
            if (flows.size > MAX_FLOWS) { flows.entries.firstOrNull()?.let { it.value.close(false); flows.remove(it.key) } }
            flow = TcpFlow(key, ip.src, ip.dst, srcPort, dstPort, seq)
            flows[key] = flow
            flow.onSyn()
            return
        }
        if (flow == null) return   // stray non-SYN for unknown flow — ignore

        if (isAck) flow.onAck(ack, window)
        if (payloadLen > 0) flow.onData(seq, pkt, payloadOff, payloadLen)
        if (fin) flow.onFin(seq, payloadLen)
    }

    /** One TCP connection. We are the client's peer; a protected [server] socket
     *  carries the allowed bytes to the real destination. */
    inner class TcpFlow(
        val key: String,
        private val clientIp: ByteArray,   // app side (return dst)
        private val serverIp: ByteArray,   // real destination (return src)
        private val clientPort: Int,
        private val serverPort: Int,
        clientIsn: Int
    ) {
        private var rcvNxt = clientIsn + 1                 // next seq expected from client
        private val ourIsn = (Math.random() * 0x7fffffff).toInt()
        private var sndNxt = ourIsn                        // our next send seq
        private var sndUna = ourIsn
        @Volatile private var sndWnd = 65535
        @Volatile private var closed = false
        @Volatile private var decided = false
        @Volatile private var finFromClient = false
        private val pre = java.io.ByteArrayOutputStream()  // buffered client bytes pre-decision
        @Volatile private var channel: java.nio.channels.SocketChannel? = null
        private val outQueue = LinkedBlockingQueue<ByteArray>()
        private val EOF = ByteArray(0)
        private val lock = Object()

        fun onSyn() {
            sndNxt = ourIsn
            sndUna = ourIsn
            send(FLAG_SYN or FLAG_ACK, withMss = true, payload = null)
            sndNxt = ourIsn + 1                            // SYN consumes one seq
        }

        fun onAck(ackNo: Int, window: Int) {
            synchronized(lock) {
                if (seqGt(ackNo, sndUna)) sndUna = ackNo
                sndWnd = if (window > 0) window else sndWnd
                lock.notifyAll()
            }
        }

        fun onData(seq: Int, pkt: ByteArray, off: Int, plen: Int) {
            if (closed) return
            if (seq != rcvNxt) { ackOnly(); return }       // dup/reorder (local path is in-order) — re-ack
            rcvNxt += plen
            ackOnly()
            if (!decided) {
                pre.write(pkt, off, plen)
                decide()
            } else {
                // Allowed: queue further client bytes; the writer drains them in
                // order after the buffered pre-decision bytes (see connectAndRelay).
                outQueue.offer(pkt.copyOfRange(off, off + plen))
            }
        }

        fun onFin(seq: Int, plen: Int) {
            if (closed) return
            // account for the FIN's sequence (after any payload already counted)
            if (seq + plen == rcvNxt) rcvNxt += 1
            finFromClient = true
            ackOnly()
            if (decided) outQueue.offer(EOF)   // signal the writer to half-close to the server
        }

        private fun decide() {
            val bytes = pre.toByteArray()
            val host = when (serverPort) {
                443 -> HostPeek.tlsSni(bytes, bytes.size)
                80 -> HostPeek.httpHost(bytes, bytes.size)
                else -> ""                                 // no name available → allow
            }
            if (host == null && pre.size() < PEEK_CAP) return   // need more data
            decided = true
            val name = host ?: ""
            val apex = if (name.isNotEmpty()) rules.blockedApex(name) else null
            // NOTE: never log the hostname — FitShield does not record browsing.
            if (apex != null) {
                onBlock(apex)
                sendRst()
                close(false)
            } else {
                connectAndRelay(bytes)
            }
        }

        private fun connectAndRelay(preBytes: ByteArray) {
            Thread({
                try {
                    // Open via a channel so the OS socket (fd) exists BEFORE protect():
                    // a plain `Socket()` has no fd until connect, so protect() would
                    // no-op and the upstream would loop back through our own tunnel.
                    // The fd Android opens here is AF_INET6 with V6ONLY off, so the
                    // same channel reaches a 4-byte and a 16-byte destination alike.
                    val ch = java.nio.channels.SocketChannel.open()
                    if (!vpn.protectSocket(ch.socket())) throw IllegalStateException("protect failed")
                    ch.socket().tcpNoDelay = true
                    ch.socket().connect(InetSocketAddress(InetAddress.getByAddress(serverIp), serverPort), CONNECT_TIMEOUT)
                    ch.configureBlocking(true)        // timed connect may leave it non-blocking
                    channel = ch
                    // Feed the buffered pre-decision bytes FIRST, before the queue
                    // drainer starts, so client bytes stay in order.
                    if (preBytes.isNotEmpty()) writeFully(ch, preBytes)
                    if (finFromClient) outQueue.offer(EOF)
                    // writer: client -> server (drains later client bytes in order).
                    // NIO channels allow one reader + one writer thread concurrently,
                    // which stream I/O does NOT — a blocked read starves the write.
                    Thread({ pumpToServer(ch) }, "fs-w").also { it.isDaemon = true; it.start() }
                    // reader: server -> client (this thread)
                    pumpToClient(ch)
                } catch (e: Exception) {
                    sendRst(); close(false)   // upstream connect/relay failed
                }
            }, "fs-c").also { it.isDaemon = true; it.start() }
        }

        private fun writeFully(ch: java.nio.channels.SocketChannel, data: ByteArray) {
            val bb = java.nio.ByteBuffer.wrap(data)
            while (bb.hasRemaining() && !closed) ch.write(bb)
        }

        private fun pumpToServer(ch: java.nio.channels.SocketChannel) {
            try {
                while (!closed) {
                    val chunk = outQueue.take()
                    if (chunk === EOF) { try { ch.socket().shutdownOutput() } catch (_: Exception) {}; break }
                    writeFully(ch, chunk)
                }
            } catch (e: Exception) {
                if (!closed) { sendRst(); close(false) }
            }
        }

        private fun pumpToClient(ch: java.nio.channels.SocketChannel) {
            try {
                val bb = java.nio.ByteBuffer.allocate(MSS)
                while (!closed) {
                    bb.clear()
                    val n = ch.read(bb)
                    if (n < 0) break
                    if (n == 0) continue
                    bb.flip()
                    val arr = ByteArray(n); bb.get(arr)
                    waitForWindow(n)
                    if (closed) break
                    sendData(arr, n)
                }
                if (!closed) sendFin()   // server closed → half-close toward the client
            } catch (e: Exception) {
                if (!closed) { sendRst(); close(false) }
            }
        }

        // Respect the client's advertised receive window (unscaled; we never
        // negotiate window scaling in our SYN-ACK, so the field is literal).
        private fun waitForWindow(len: Int) {
            synchronized(lock) {
                var guard = 0
                while (!closed && inflight() + len > maxOf(sndWnd, 4096) && guard < 2000) {
                    lock.wait(5); guard++
                }
            }
        }
        private fun inflight(): Long = ((sndNxt - sndUna).toLong() and 0xFFFFFFFFL)

        private fun sendData(buf: ByteArray, len: Int) {
            val seg = buf.copyOfRange(0, len)
            send(FLAG_ACK or FLAG_PSH, withMss = false, payload = seg)
            sndNxt += len
        }
        private fun sendFin() { send(FLAG_ACK or FLAG_FIN, withMss = false, payload = null); sndNxt += 1 }
        private fun sendRst() {
            if (closed) return
            // Debug builds only: a blocked connection is a filtering decision, and
            // FitShield never writes those (or hostnames) to logcat in release.
            if (BuildConfig.DEBUG) Log.d(TAG, "RST $key (sndNxt=$sndNxt rcvNxt=$rcvNxt)")
            send(FLAG_RST or FLAG_ACK, withMss = false, payload = null)
        }
        private fun ackOnly() { send(FLAG_ACK, withMss = false, payload = null) }

        private fun send(flags: Int, withMss: Boolean, payload: ByteArray?) {
            val pkt = IpPacket.buildTcp(
                serverIp, clientIp, serverPort, clientPort, sndNxt, rcvNxt, flags, 65535,
                payload, if (withMss) MSS else null
            )
            emit(pkt, pkt.size)
        }

        fun close(sendReset: Boolean) {
            if (closed) return
            closed = true
            if (sendReset) sendRst()
            try { channel?.close() } catch (_: Exception) {}
            outQueue.offer(EOF)
            flows.remove(key)
        }
    }

    // ---- UDP ----------------------------------------------------------------

    private fun handleUdp(pkt: ByteArray, ip: IpPacket.Header, len: Int) {
        val udp = ip.transportOffset
        if (udp + 8 > len) return
        val srcPort = IpPacket.u16(pkt, udp)
        val dstPort = IpPacket.u16(pkt, udp + 2)
        if (dstPort == 443) return                       // drop QUIC → forces TCP fallback (SNI visible)
        val payloadOff = udp + 8
        val payloadLen = len - payloadOff
        if (payloadLen <= 0) return
        val key = flowKey(ip, srcPort, dstPort)
        val flow = udpFlows.getOrPut(key) {
            UdpFlow(key, ip.src, ip.dst, srcPort, dstPort).also { it.start() }
        }
        flow.send(pkt.copyOfRange(payloadOff, payloadOff + payloadLen))
    }

    /** Relay one UDP "flow" (src/dst pair) through a protected socket. */
    inner class UdpFlow(
        val key: String,
        private val clientIp: ByteArray,
        private val serverIp: ByteArray,
        private val clientPort: Int,
        private val serverPort: Int
    ) {
        private val socket = java.net.DatagramSocket()
        @Volatile private var alive = true

        fun start() {
            if (!vpn.protectSocket(socket)) { alive = false; return }
            socket.soTimeout = UDP_IDLE_MS
            socket.connect(InetSocketAddress(InetAddress.getByAddress(serverIp), serverPort))
            Thread({
                val buf = ByteArray(2048)
                try {
                    while (alive) {
                        val dp = java.net.DatagramPacket(buf, buf.size)
                        socket.receive(dp)
                        val reply = IpPacket.buildUdp(serverIp, clientIp, serverPort, clientPort, buf, dp.length)
                        emit(reply, reply.size)
                    }
                } catch (e: Exception) {
                    // timeout / closed → tear down
                } finally { close() }
            }, "fs-udp").also { it.isDaemon = true; it.start() }
        }

        fun send(payload: ByteArray) {
            try { socket.send(java.net.DatagramPacket(payload, payload.size)) } catch (e: Exception) { close() }
        }

        fun close() {
            alive = false
            try { socket.close() } catch (_: Exception) {}
            udpFlows.remove(key)
        }
    }

    // ---- helpers ------------------------------------------------------------

    /** Flow-table key. IPv6 addresses are bracketed so they cannot run together
     *  with the port, and the two families can never collide on one key. */
    private fun flowKey(ip: IpPacket.Header, srcPort: Int, dstPort: Int): String =
        "${IpPacket.addressKey(ip.src)}:$srcPort>${IpPacket.addressKey(ip.dst)}:$dstPort"

    private fun seqGt(a: Int, b: Int): Boolean = (a - b) in 1..Int.MAX_VALUE

    companion object {
        private const val TAG = "FitShieldFilter"
        private const val MAX_PACKET = 32767
        /** One value for both families: 1400 + 40 (IPv6) + 20 (TCP) = 1460,
         *  still inside the tun's 1500-byte MTU, and unchanged for IPv4. */
        private const val MSS = 1400
        private const val MAX_FLOWS = 512
        private const val CONNECT_TIMEOUT = 8000
        private const val UDP_IDLE_MS = 30000
        private const val PEEK_CAP = 8192
        private const val FLAG_FIN = 0x01
        private const val FLAG_SYN = 0x02
        private const val FLAG_RST = 0x04
        private const val FLAG_PSH = 0x08
        private const val FLAG_ACK = 0x10
    }
}
