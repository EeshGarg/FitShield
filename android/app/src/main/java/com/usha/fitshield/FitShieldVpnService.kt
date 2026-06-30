package com.usha.fitshield

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/**
 * Local DNS-filtering VpnService — PREVIEW / TEST QUALITY.
 *
 * Smallest working local DNS filter: it captures the device's DNS queries via a
 * local VpnService, checks each requested domain against the engine-derived
 * [RuleEngine], answers NXDOMAIN for blocked domains, and forwards allowed
 * queries to an upstream resolver. IPv4 + UDP/53 only.
 *
 * What it is NOT: not a commercial VPN, no tunneling of web traffic to any
 * server, no HTTPS inspection, no decryption, no certificates, no content
 * inspection, no telemetry. Only the DNS question name is read; nothing leaves
 * the device except allowed DNS queries to the upstream resolver. See
 * docs/ANDROID.md.
 *
 * PREVIEW: implemented and reviewable, but NOT built or run on a device in this
 * repository. IPv6 and DNS-over-HTTPS/TLS are intentionally out of scope (see
 * limitations in docs/ANDROID.md).
 */
class FitShieldVpnService : VpnService() {

    private var tunnel: ParcelFileDescriptor? = null
    private var worker: Thread? = null
    @Volatile private var active = false
    private lateinit var rules: RuleEngine

    override fun onCreate() {
        super.onCreate()
        rules = RuleEngine.fromAssets(this)
        Log.i(TAG, "Loaded ${rules.count} blockable hosts from the generated asset")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stop()
            return Service.START_NOT_STICKY
        }
        start()
        return Service.START_STICKY
    }

    private fun start() {
        if (active) return
        startForeground(NOTIF_ID, buildNotification())

        val pfd = Builder()
            .setSession("FitShield DNS filter")
            .addAddress(TUN_ADDRESS, 32)
            // Route ONLY our virtual DNS server through the tunnel: the system
            // sends DNS here, but no other traffic is captured.
            .addDnsServer(TUN_DNS)
            .addRoute(TUN_DNS, 32)
            .setBlocking(true)
            .establish()

        if (pfd == null) {
            Log.e(TAG, "establish() returned null (VPN consent not granted?)")
            stopSelf()
            return
        }

        tunnel = pfd
        active = true
        isRunning = true
        worker = Thread({ pump(pfd) }, "fitshield-dns").also { it.start() }
    }

    private fun stop() {
        active = false
        isRunning = false
        worker?.interrupt()
        worker = null
        try { tunnel?.close() } catch (_: Exception) {}
        tunnel = null
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stop()
        super.onDestroy()
    }

    // ---- DNS pump ------------------------------------------------------------

    private fun pump(pfd: ParcelFileDescriptor) {
        val input = FileInputStream(pfd.fileDescriptor)
        val output = FileOutputStream(pfd.fileDescriptor)
        val packet = ByteArray(MAX_PACKET)

        try {
            while (active) {
                val length = input.read(packet)
                if (length <= 0) continue
                try {
                    handlePacket(packet, length, output)
                } catch (e: Exception) {
                    Log.w(TAG, "packet handling error", e)
                }
            }
        } catch (e: Exception) {
            if (active) Log.e(TAG, "DNS pump stopped", e)
        }
    }

    /** Handle one IPv4/UDP/53 DNS query packet. Non-DNS/IPv6 packets are ignored
     *  (they do not reach the tun because only the IPv4 DNS server is routed). */
    private fun handlePacket(packet: ByteArray, length: Int, output: FileOutputStream) {
        if (length < 28) return
        val version = (packet[0].toInt() ushr 4) and 0xF
        if (version != 4) return                                  // IPv4 only (preview)
        val ihl = (packet[0].toInt() and 0xF) * 4
        if (ihl < 20 || ihl + 8 > length) return
        if ((packet[9].toInt() and 0xFF) != 17) return            // UDP
        val udp = ihl
        val dstPort = port(packet, udp + 2)
        if (dstPort != 53) return                                 // DNS only
        val dns = udp + 8
        if (dns + 12 > length) return

        val q = parseQuestion(packet, dns, length) ?: return
        val blocked = rules.isBlocked(q.name)
        Log.d(TAG, "${if (blocked) "BLOCK" else "allow"} ${q.name}")

        val dnsResponse = if (blocked) {
            synthesizeNxdomain(packet, dns, q.questionEnd)
        } else {
            forwardUpstream(packet, dns, length)
        } ?: return

        output.write(buildIpv4Udp(packet, ihl, dnsResponse))
        output.flush()
    }

    /** Forward the DNS query payload to the upstream resolver over a protected
     *  socket (so it leaves via the real network, not back through the VPN). */
    private fun forwardUpstream(packet: ByteArray, dns: Int, length: Int): ByteArray? {
        val query = packet.copyOfRange(dns, length)
        DatagramSocket().use { socket ->
            if (!protect(socket)) {
                Log.w(TAG, "could not protect upstream socket")
                return null
            }
            socket.soTimeout = UPSTREAM_TIMEOUT_MS
            val upstream = InetAddress.getByName(UPSTREAM_DNS)
            socket.send(DatagramPacket(query, query.size, upstream, 53))
            val buf = ByteArray(4096)
            val reply = DatagramPacket(buf, buf.size)
            socket.receive(reply)
            return buf.copyOfRange(0, reply.length)
        }
    }

    /** Build a minimal NXDOMAIN reply from the query: keep the question, set
     *  QR=1, RA=1, RCODE=3, and zero all answer/authority/additional counts. */
    private fun synthesizeNxdomain(packet: ByteArray, dns: Int, questionEnd: Int): ByteArray {
        // Response = DNS header + question only (drop any EDNS/OPT additionals).
        val out = packet.copyOfRange(dns, questionEnd)
        out[2] = (out[2].toInt() or 0x80).toByte()   // QR = 1 (response)
        out[3] = 0x83.toByte()                        // RA = 1, RCODE = 3 (NXDOMAIN)
        // QDCOUNT (4..5) kept; zero ANCOUNT/NSCOUNT/ARCOUNT (6..11).
        for (i in 6..11) out[i] = 0
        return out
    }

    /** Wrap a DNS payload in an IPv4/UDP packet addressed back to the client
     *  (swap src/dst + ports, recompute IP checksum; UDP checksum 0 is valid). */
    private fun buildIpv4Udp(original: ByteArray, ihl: Int, dnsPayload: ByteArray): ByteArray {
        val total = ihl + 8 + dnsPayload.size
        val out = ByteArray(total)
        System.arraycopy(original, 0, out, 0, ihl)             // copy IP header

        // IP: total length, TTL, clear options-derived checksum, swap addresses.
        out[2] = (total ushr 8).toByte(); out[3] = total.toByte()
        out[8] = 64                                            // TTL
        out[10] = 0; out[11] = 0                               // checksum (recomputed)
        System.arraycopy(original, 16, out, 12, 4)             // src = original dst
        System.arraycopy(original, 12, out, 16, 4)             // dst = original src
        val ipSum = checksum(out, 0, ihl)
        out[10] = (ipSum ushr 8).toByte(); out[11] = ipSum.toByte()

        // UDP: swap ports, set length, checksum 0 (optional for IPv4).
        val u = ihl
        System.arraycopy(original, ihl + 2, out, u, 2)         // srcPort = original dstPort (53)
        System.arraycopy(original, ihl, out, u + 2, 2)         // dstPort = original srcPort
        val udpLen = 8 + dnsPayload.size
        out[u + 4] = (udpLen ushr 8).toByte(); out[u + 5] = udpLen.toByte()
        out[u + 6] = 0; out[u + 7] = 0
        System.arraycopy(dnsPayload, 0, out, u + 8, dnsPayload.size)
        return out
    }

    // ---- DNS / IP parsing helpers -------------------------------------------

    private class Question(val name: String, val questionEnd: Int)

    /** Parse the first question's QNAME and return it plus the offset just past
     *  QTYPE+QCLASS. Rejects compression pointers (not used in questions). */
    private fun parseQuestion(packet: ByteArray, dns: Int, length: Int): Question? {
        var pos = dns + 12
        val sb = StringBuilder()
        while (pos < length) {
            val len = packet[pos].toInt() and 0xFF
            if (len == 0) { pos++; break }
            if (len and 0xC0 != 0) return null                 // compression pointer
            pos++
            if (pos + len > length) return null
            if (sb.isNotEmpty()) sb.append('.')
            for (i in 0 until len) sb.append((packet[pos + i].toInt() and 0xFF).toChar())
            pos += len
        }
        val questionEnd = pos + 4                               // QTYPE(2) + QCLASS(2)
        if (questionEnd > length || sb.isEmpty()) return null
        return Question(sb.toString().lowercase(), questionEnd)
    }

    private fun port(buf: ByteArray, off: Int): Int =
        ((buf[off].toInt() and 0xFF) shl 8) or (buf[off + 1].toInt() and 0xFF)

    /** 16-bit one's-complement checksum (IPv4 header). */
    private fun checksum(buf: ByteArray, off: Int, len: Int): Int {
        var sum = 0L
        var i = off
        var remaining = len
        while (remaining > 1) {
            sum += (((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)).toLong()
            i += 2; remaining -= 2
        }
        if (remaining == 1) sum += ((buf[i].toInt() and 0xFF) shl 8).toLong()
        while ((sum shr 16) != 0L) sum = (sum and 0xFFFFL) + (sum shr 16)
        return (sum.inv() and 0xFFFFL).toInt()
    }

    // ---- Foreground notification --------------------------------------------

    private fun buildNotification(): Notification {
        val channelId = "fitshield_vpn"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(channelId, "FitShield", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, channelId)
            .setContentTitle("FitShield is filtering DNS")
            .setContentText("Local and on-device. No traffic leaves your device except DNS.")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "FitShieldVpn"
        const val ACTION_START = "com.usha.fitshield.START"
        const val ACTION_STOP = "com.usha.fitshield.STOP"

        /** Lightweight running flag for the UI toggle (process-local). */
        @Volatile var isRunning = false
            private set

        private const val NOTIF_ID = 1
        private const val MAX_PACKET = 32767
        private const val TUN_ADDRESS = "10.111.222.1"
        private const val TUN_DNS = "10.111.222.2"
        // Allowed DNS is forwarded to a public resolver in this preview. No
        // queries go to FitShield; a future version may use the system resolver
        // (would require ACCESS_NETWORK_STATE). Documented in docs/ANDROID.md.
        private const val UPSTREAM_DNS = "1.1.1.1"
        private const val UPSTREAM_TIMEOUT_MS = 5000
    }
}
