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
 *  - Reads IPv4 packets from the TUN.
 *  - TCP: terminates the client side locally (the app<->TUN path is lossless and
 *    in-order, so no congestion control / retransmit is needed on our side),
 *    peeks the first client payload for the SNI/Host, and either
 *      - BLOCKS (curated match): sends RST so the connection fails, or
 *      - ALLOWS: opens a *protected* socket to the real destination IP and
 *        transparently relays bytes both ways (the OS handles real TCP).
 *  - UDP: drops QUIC (UDP/443) so browsers fall back to TCP where the SNI is
 *    visible; relays other UDP (e.g. NTP) through a protected socket.
 *  - IPv6 is captured and dropped (forces IPv4 fallback); documented limitation.
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
        val version = (pkt[0].toInt() ushr 4) and 0xF
        if (version != 4) return                    // IPv6 captured but dropped (forces IPv4)
        val ihl = (pkt[0].toInt() and 0xF) * 4
        if (ihl < 20 || ihl > len) return
        when (pkt[9].toInt() and 0xFF) {
            6 -> handleTcp(pkt, ihl, len)
            17 -> handleUdp(pkt, ihl, len)
            // other protocols (ICMP, etc.) dropped
        }
    }

    // ---- TCP ----------------------------------------------------------------

    private fun handleTcp(pkt: ByteArray, ihl: Int, len: Int) {
        val srcIp = pkt.copyOfRange(12, 16)
        val dstIp = pkt.copyOfRange(16, 20)
        val tcp = ihl
        if (tcp + 20 > len) return
        val srcPort = u16(pkt, tcp)
        val dstPort = u16(pkt, tcp + 2)
        val seq = u32(pkt, tcp + 4)
        val ack = u32(pkt, tcp + 8)
        val dataOff = ((pkt[tcp + 12].toInt() and 0xFF) ushr 4) * 4
        val flags = pkt[tcp + 13].toInt() and 0xFF
        val window = u16(pkt, tcp + 14)
        val payloadOff = tcp + dataOff
        val payloadLen = len - payloadOff
        if (payloadOff > len) return

        val key = "${ip(srcIp)}:$srcPort>${ip(dstIp)}:$dstPort"
        val syn = flags and 0x02 != 0
        val rst = flags and 0x04 != 0
        val fin = flags and 0x01 != 0
        val isAck = flags and 0x10 != 0

        var flow = flows[key]

        if (rst) { flow?.close(false); flows.remove(key); return }

        if (syn && flow == null) {
            if (flows.size > MAX_FLOWS) { flows.entries.firstOrNull()?.let { it.value.close(false); flows.remove(it.key) } }
            flow = TcpFlow(key, srcIp, dstIp, srcPort, dstPort, seq)
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
                443 -> parseTlsSni(bytes, bytes.size)
                80 -> parseHttpHost(bytes, bytes.size)
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
            Log.d(TAG, "RST $key (sndNxt=$sndNxt rcvNxt=$rcvNxt)")
            send(FLAG_RST or FLAG_ACK, withMss = false, payload = null)
        }
        private fun ackOnly() { send(FLAG_ACK, withMss = false, payload = null) }

        private fun send(flags: Int, withMss: Boolean, payload: ByteArray?) {
            val pkt = buildIpTcp(serverIp, clientIp, serverPort, clientPort, sndNxt, rcvNxt, flags, 65535, payload, withMss)
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

    private fun handleUdp(pkt: ByteArray, ihl: Int, len: Int) {
        val udp = ihl
        if (udp + 8 > len) return
        val srcPort = u16(pkt, udp)
        val dstPort = u16(pkt, udp + 2)
        if (dstPort == 443) return                       // drop QUIC → forces TCP fallback (SNI visible)
        val payloadOff = udp + 8
        val payloadLen = len - payloadOff
        if (payloadLen <= 0) return
        val srcIp = pkt.copyOfRange(12, 16)
        val dstIp = pkt.copyOfRange(16, 20)
        val key = "${ip(srcIp)}:$srcPort>${ip(dstIp)}:$dstPort"
        val flow = udpFlows.getOrPut(key) {
            UdpFlow(key, srcIp, dstIp, srcPort, dstPort).also { it.start() }
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
                        val reply = buildIpUdp(serverIp, clientIp, serverPort, clientPort, buf, dp.length)
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

    // ---- packet builders ----------------------------------------------------

    private fun buildIpTcp(
        src: ByteArray, dst: ByteArray, srcPort: Int, dstPort: Int,
        seq: Int, ack: Int, flags: Int, window: Int, payload: ByteArray?, withMss: Boolean
    ): ByteArray {
        val opts = if (withMss) 4 else 0
        val tcpLen = 20 + opts + (payload?.size ?: 0)
        val total = 20 + tcpLen
        val out = ByteArray(total)
        // IPv4 header
        out[0] = 0x45; out[1] = 0
        out[2] = (total ushr 8).toByte(); out[3] = total.toByte()
        out[4] = 0; out[5] = 0; out[6] = 0x40; out[7] = 0     // id 0, DF
        out[8] = 64; out[9] = 6                                 // ttl, proto=TCP
        System.arraycopy(src, 0, out, 12, 4)
        System.arraycopy(dst, 0, out, 16, 4)
        val ipSum = checksum(out, 0, 20)
        out[10] = (ipSum ushr 8).toByte(); out[11] = ipSum.toByte()
        // TCP header
        val t = 20
        put16(out, t, srcPort); put16(out, t + 2, dstPort)
        put32(out, t + 4, seq); put32(out, t + 8, ack)
        val dataOffWords = (20 + opts) / 4
        out[t + 12] = (dataOffWords shl 4).toByte()
        out[t + 13] = flags.toByte()
        put16(out, t + 14, window)
        // checksum (t+16) left 0 for now; urgent (t+18) = 0
        if (withMss) { out[t + 20] = 2; out[t + 21] = 4; put16(out, t + 22, MSS) }
        payload?.let { System.arraycopy(it, 0, out, t + 20 + opts, it.size) }
        val tcpSum = tcpUdpChecksum(src, dst, 6, out, t, tcpLen)
        put16(out, t + 16, tcpSum)
        return out
    }

    private fun buildIpUdp(
        src: ByteArray, dst: ByteArray, srcPort: Int, dstPort: Int, payload: ByteArray, plen: Int
    ): ByteArray {
        val udpLen = 8 + plen
        val total = 20 + udpLen
        val out = ByteArray(total)
        out[0] = 0x45; out[2] = (total ushr 8).toByte(); out[3] = total.toByte()
        out[6] = 0x40; out[8] = 64; out[9] = 17
        System.arraycopy(src, 0, out, 12, 4)
        System.arraycopy(dst, 0, out, 16, 4)
        val ipSum = checksum(out, 0, 20)
        out[10] = (ipSum ushr 8).toByte(); out[11] = ipSum.toByte()
        val u = 20
        put16(out, u, srcPort); put16(out, u + 2, dstPort)
        put16(out, u + 4, udpLen)
        System.arraycopy(payload, 0, out, u + 8, plen)
        val udpSum = tcpUdpChecksum(src, dst, 17, out, u, udpLen)
        put16(out, u + 6, if (udpSum == 0) 0xFFFF else udpSum)
        return out
    }

    // ---- SNI / Host parsing (need-more = null, no-name = "", else host) ------

    private fun parseTlsSni(b: ByteArray, len: Int): String? {
        if (len < 5) return null
        if ((b[0].toInt() and 0xFF) != 0x16) return ""            // not a TLS handshake
        val recEnd = 5 + u16(b, 3)
        if (len < recEnd) return null                              // ClientHello record incomplete
        var p = 5
        if (p >= len || (b[p].toInt() and 0xFF) != 0x01) return "" // not ClientHello
        val hsEnd = p + 4 + u24(b, p + 1)
        if (hsEnd > len) return null
        p += 4 + 2 + 32                                            // hdr + version + random
        if (p + 1 > len) return null
        val sidLen = b[p].toInt() and 0xFF; p += 1 + sidLen
        if (p + 2 > len) return null
        p += 2 + u16(b, p)                                         // cipher suites
        if (p + 1 > len) return null
        p += 1 + (b[p].toInt() and 0xFF)                          // compression methods
        if (p + 2 > len) return ""
        val extEnd = minOf(p + 2 + u16(b, p), len); p += 2
        while (p + 4 <= extEnd) {
            val type = u16(b, p); val el = u16(b, p + 2); p += 4
            if (type == 0x0000) {                                  // server_name
                var q = p + 2                                       // skip server_name_list length
                while (q + 3 <= minOf(p + el, len)) {
                    val nameType = b[q].toInt() and 0xFF
                    val nameLen = u16(b, q + 1); q += 3
                    if (nameType == 0 && q + nameLen <= len) {
                        return String(b, q, nameLen, Charsets.US_ASCII).lowercase()
                    }
                    q += nameLen
                }
                return ""
            }
            p += el
        }
        return ""
    }

    private fun parseHttpHost(b: ByteArray, len: Int): String? {
        val s = String(b, 0, minOf(len, 4096), Charsets.ISO_8859_1)
        val m = Regex("(?im)^Host:[ \\t]*([^\\r\\n:]+)").find(s)
        if (m != null) return m.groupValues[1].trim().lowercase()
        if (s.contains("\r\n\r\n") || len > 4096) return ""        // headers done, no Host
        return null
    }

    // ---- byte helpers -------------------------------------------------------

    private fun u16(b: ByteArray, o: Int) = ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)
    private fun u24(b: ByteArray, o: Int) = ((b[o].toInt() and 0xFF) shl 16) or ((b[o + 1].toInt() and 0xFF) shl 8) or (b[o + 2].toInt() and 0xFF)
    private fun u32(b: ByteArray, o: Int) = ((b[o].toInt() and 0xFF) shl 24) or ((b[o + 1].toInt() and 0xFF) shl 16) or ((b[o + 2].toInt() and 0xFF) shl 8) or (b[o + 3].toInt() and 0xFF)
    private fun put16(b: ByteArray, o: Int, v: Int) { b[o] = (v ushr 8).toByte(); b[o + 1] = v.toByte() }
    private fun put32(b: ByteArray, o: Int, v: Int) { b[o] = (v ushr 24).toByte(); b[o + 1] = (v ushr 16).toByte(); b[o + 2] = (v ushr 8).toByte(); b[o + 3] = v.toByte() }
    private fun ip(a: ByteArray) = "${a[0].toInt() and 0xFF}.${a[1].toInt() and 0xFF}.${a[2].toInt() and 0xFF}.${a[3].toInt() and 0xFF}"
    private fun seqGt(a: Int, b: Int): Boolean = (a - b) in 1..Int.MAX_VALUE

    private fun checksum(buf: ByteArray, off: Int, len: Int): Int {
        var sum = 0L; var i = off; var rem = len
        while (rem > 1) { sum += (((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)).toLong(); i += 2; rem -= 2 }
        if (rem == 1) sum += ((buf[i].toInt() and 0xFF) shl 8).toLong()
        while ((sum shr 16) != 0L) sum = (sum and 0xFFFFL) + (sum shr 16)
        return (sum.inv() and 0xFFFFL).toInt()
    }

    /** TCP/UDP checksum over the IPv4 pseudo-header + segment. */
    private fun tcpUdpChecksum(src: ByteArray, dst: ByteArray, proto: Int, buf: ByteArray, off: Int, segLen: Int): Int {
        var sum = 0L
        for (k in 0 until 4 step 2) sum += (((src[k].toInt() and 0xFF) shl 8) or (src[k + 1].toInt() and 0xFF)).toLong()
        for (k in 0 until 4 step 2) sum += (((dst[k].toInt() and 0xFF) shl 8) or (dst[k + 1].toInt() and 0xFF)).toLong()
        sum += proto.toLong()
        sum += segLen.toLong()
        var i = off; var rem = segLen
        while (rem > 1) { sum += (((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)).toLong(); i += 2; rem -= 2 }
        if (rem == 1) sum += ((buf[i].toInt() and 0xFF) shl 8).toLong()
        while ((sum shr 16) != 0L) sum = (sum and 0xFFFFL) + (sum shr 16)
        return (sum.inv() and 0xFFFFL).toInt()
    }

    companion object {
        private const val TAG = "FitShieldFilter"
        private const val MAX_PACKET = 32767
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
