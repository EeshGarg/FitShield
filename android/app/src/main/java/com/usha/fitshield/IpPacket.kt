package com.usha.fitshield

/**
 * Pure IP/transport header handling for the FitShield connection filter.
 *
 * Deliberately free of every Android import. Nothing here touches the network,
 * a socket, a file, a clock or a log — it only reads and writes byte arrays. Two
 * reasons:
 *
 *  1. This is the code that decides whether a packet is understood at all. When
 *     it was wrong, IPv6 was routed into the tunnel and then discarded, so an
 *     IPv6-only carrier left the user with no working internet while FitShield
 *     was on. That class of failure has to be provable off-device, and pure
 *     functions are what can be compiled and executed by the test suite.
 *  2. Every bound check in here is the difference between a malformed packet
 *     from the network being dropped and it throwing out of the read loop.
 *
 * IPv4 and IPv6 are handled by the same code path from [parse] onward: the
 * caller receives a transport offset and the two address slices, and everything
 * downstream (TLS SNI on 443, HTTP Host on 80, the relay socket, the flow table)
 * is address-family agnostic. `InetAddress.getByAddress` accepts both a 4-byte
 * and a 16-byte array, so the relay reaches an IPv6 destination over IPv6.
 */
internal object IpPacket {

    const val PROTO_TCP = 6
    const val PROTO_UDP = 17

    // IPv6 extension headers we can walk past to reach the transport header.
    private const val EXT_HOP_BY_HOP = 0
    private const val EXT_ROUTING = 43
    private const val EXT_FRAGMENT = 44
    private const val EXT_ESP = 50
    private const val EXT_AUTH = 51
    private const val EXT_NO_NEXT = 59
    private const val EXT_DEST_OPTS = 60
    private const val EXT_MOBILITY = 135
    private const val EXT_HIP = 139
    private const val EXT_SHIM6 = 140

    /** A chain longer than this is not a real packet; refuse rather than walk it. */
    private const val MAX_EXT_HEADERS = 8

    const val V4_HEADER = 20
    const val V6_HEADER = 40

    /**
     * What the filter needs from layer 3, for either address family.
     *
     * [src] and [dst] are 4 bytes for IPv4 and 16 for IPv6; their length is the
     * only thing anything downstream needs to know about the family.
     */
    class Header(
        val version: Int,
        val protocol: Int,
        val transportOffset: Int,
        val src: ByteArray,
        val dst: ByteArray
    )

    /**
     * Parse one IP packet's headers, or return null when it must be dropped.
     *
     * Null means "this filter cannot safely act on this packet": too short,
     * truncated, fragmented, an unreadable extension-header chain, encrypted at
     * layer 3 (ESP), or a transport we do not handle. A null is never an
     * exception — the read loop must not be able to die on a hostile packet.
     */
    fun parse(pkt: ByteArray, len: Int): Header? {
        if (len < 1 || len > pkt.size) return null
        return when ((pkt[0].toInt() ushr 4) and 0xF) {
            4 -> parseV4(pkt, len)
            6 -> parseV6(pkt, len)
            else -> null
        }
    }

    private fun parseV4(pkt: ByteArray, len: Int): Header? {
        if (len < V4_HEADER) return null
        val ihl = (pkt[0].toInt() and 0xF) * 4
        if (ihl < V4_HEADER || ihl > len) return null

        // Fragments. A non-first fragment carries no transport header at all, and
        // a FIRST fragment carries only part of the segment — feeding that to the
        // TCP path counts a partial payload as a whole one and corrupts the
        // sequence bookkeeping. Both are dropped. Our own MTU (1500) and the MSS
        // we advertise (1400) mean a client never has to fragment toward the tun,
        // so this drops nothing the filter would otherwise have seen.
        val fragField = u16(pkt, 6)
        val moreFragments = (fragField and 0x2000) != 0
        val fragOffset = fragField and 0x1FFF
        if (moreFragments || fragOffset != 0) return null

        return Header(
            version = 4,
            protocol = pkt[9].toInt() and 0xFF,
            transportOffset = ihl,
            src = pkt.copyOfRange(12, 16),
            dst = pkt.copyOfRange(16, 20)
        )
    }

    private fun parseV6(pkt: ByteArray, len: Int): Header? {
        if (len < V6_HEADER) return null

        var next = pkt[6].toInt() and 0xFF
        var off = V6_HEADER
        var hops = 0

        while (hops++ < MAX_EXT_HEADERS) {
            when (next) {
                PROTO_TCP, PROTO_UDP -> {
                    // The transport header must actually be inside the capture.
                    if (off > len) return null
                    return Header(
                        version = 6,
                        protocol = next,
                        transportOffset = off,
                        src = pkt.copyOfRange(8, 24),
                        dst = pkt.copyOfRange(24, 40)
                    )
                }

                EXT_HOP_BY_HOP, EXT_ROUTING, EXT_DEST_OPTS,
                EXT_MOBILITY, EXT_HIP, EXT_SHIM6 -> {
                    if (off + 2 > len) return null
                    val size = ((pkt[off + 1].toInt() and 0xFF) + 1) * 8
                    next = pkt[off].toInt() and 0xFF
                    off += size
                    if (off > len) return null
                }

                EXT_FRAGMENT -> {
                    if (off + 8 > len) return null
                    val frag = u16(pkt, off + 2)
                    val offsetUnits = frag ushr 3
                    val more = (frag and 0x1) != 0
                    // Same rule as IPv4: a real fragment is dropped rather than
                    // half-parsed. An "atomic" fragment header (offset 0, M
                    // clear) carries the whole datagram and is walked past.
                    if (offsetUnits != 0 || more) return null
                    next = pkt[off].toInt() and 0xFF
                    off += 8
                    if (off > len) return null
                }

                // Authentication Header measures itself in 4-octet units, minus 2.
                EXT_AUTH -> {
                    if (off + 2 > len) return null
                    val size = ((pkt[off + 1].toInt() and 0xFF) + 2) * 4
                    next = pkt[off].toInt() and 0xFF
                    off += size
                    if (off > len) return null
                }

                // ESP hides the transport header; "no next header" ends the chain.
                EXT_ESP, EXT_NO_NEXT -> return null

                else -> return null
            }
        }
        return null
    }

    /**
     * Flow-table key for one address. IPv6 is bracketed so an address that
     * contains colons can never run together with the port that follows it.
     */
    fun addressKey(addr: ByteArray): String {
        if (addr.size == 4) {
            return "${addr[0].toInt() and 0xFF}.${addr[1].toInt() and 0xFF}." +
                "${addr[2].toInt() and 0xFF}.${addr[3].toInt() and 0xFF}"
        }
        val sb = StringBuilder(addr.size * 3)
        sb.append('[')
        var i = 0
        while (i < addr.size) {
            if (i > 0) sb.append(':')
            val group = ((addr[i].toInt() and 0xFF) shl 8) or (addr[i + 1].toInt() and 0xFF)
            sb.append(Integer.toHexString(group))
            i += 2
        }
        sb.append(']')
        return sb.toString()
    }

    // ---- packet builders ----------------------------------------------------
    //
    // Both builders pick the address family from the length of [src] / [dst], so
    // a reply to an IPv6 flow is an IPv6 packet without any caller deciding.

    fun buildTcp(
        src: ByteArray, dst: ByteArray, srcPort: Int, dstPort: Int,
        seq: Int, ack: Int, flags: Int, window: Int, payload: ByteArray?,
        mss: Int?
    ): ByteArray {
        val opts = if (mss != null) 4 else 0
        val tcpLen = 20 + opts + (payload?.size ?: 0)
        val out = newIpPacket(src, dst, PROTO_TCP, tcpLen)
        val t = if (src.size == 4) V4_HEADER else V6_HEADER

        put16(out, t, srcPort); put16(out, t + 2, dstPort)
        put32(out, t + 4, seq); put32(out, t + 8, ack)
        out[t + 12] = (((20 + opts) / 4) shl 4).toByte()
        out[t + 13] = flags.toByte()
        put16(out, t + 14, window)
        // checksum (t+16) filled below; urgent pointer (t+18) stays 0
        if (mss != null) { out[t + 20] = 2; out[t + 21] = 4; put16(out, t + 22, mss) }
        payload?.let { System.arraycopy(it, 0, out, t + 20 + opts, it.size) }
        put16(out, t + 16, transportChecksum(src, dst, PROTO_TCP, out, t, tcpLen))
        return out
    }

    fun buildUdp(
        src: ByteArray, dst: ByteArray, srcPort: Int, dstPort: Int,
        payload: ByteArray, plen: Int
    ): ByteArray {
        val udpLen = 8 + plen
        val out = newIpPacket(src, dst, PROTO_UDP, udpLen)
        val u = if (src.size == 4) V4_HEADER else V6_HEADER

        put16(out, u, srcPort); put16(out, u + 2, dstPort)
        put16(out, u + 4, udpLen)
        System.arraycopy(payload, 0, out, u + 8, plen)
        val sum = transportChecksum(src, dst, PROTO_UDP, out, u, udpLen)
        // A zero UDP checksum means "not computed" in IPv4 and is ILLEGAL in
        // IPv6, so the all-ones form is sent for both.
        put16(out, u + 6, if (sum == 0) 0xFFFF else sum)
        return out
    }

    /** Allocate and fill the layer-3 header, leaving [segLen] bytes after it. */
    private fun newIpPacket(src: ByteArray, dst: ByteArray, proto: Int, segLen: Int): ByteArray {
        if (src.size == 4) {
            val total = V4_HEADER + segLen
            val out = ByteArray(total)
            out[0] = 0x45
            put16(out, 2, total)
            out[6] = 0x40                       // Don't Fragment
            out[8] = 64                         // TTL
            out[9] = proto.toByte()
            System.arraycopy(src, 0, out, 12, 4)
            System.arraycopy(dst, 0, out, 16, 4)
            put16(out, 10, checksum(out, 0, V4_HEADER))
            return out
        }
        val out = ByteArray(V6_HEADER + segLen)
        out[0] = 0x60                           // version 6, traffic class 0
        put16(out, 4, segLen)                   // payload length
        out[6] = proto.toByte()                 // next header
        out[7] = 64                             // hop limit
        System.arraycopy(src, 0, out, 8, 16)
        System.arraycopy(dst, 0, out, 24, 16)
        return out                              // IPv6 has no header checksum
    }

    // ---- checksums ----------------------------------------------------------

    fun checksum(buf: ByteArray, off: Int, len: Int): Int {
        var sum = 0L; var i = off; var rem = len
        while (rem > 1) { sum += (((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)).toLong(); i += 2; rem -= 2 }
        if (rem == 1) sum += ((buf[i].toInt() and 0xFF) shl 8).toLong()
        while ((sum shr 16) != 0L) sum = (sum and 0xFFFFL) + (sum shr 16)
        return (sum.inv() and 0xFFFFL).toInt()
    }

    /**
     * TCP/UDP checksum over the pseudo-header plus the segment.
     *
     * One function covers both families because the two pseudo-headers sum
     * identically: address words, then the protocol number, then the segment
     * length. IPv6 writes that length as 32 bits, which is why the high half is
     * added separately — it is zero at our sizes, and correct if it ever is not.
     */
    fun transportChecksum(src: ByteArray, dst: ByteArray, proto: Int, buf: ByteArray, off: Int, segLen: Int): Int {
        var sum = 0L
        var k = 0
        while (k < src.size) { sum += (((src[k].toInt() and 0xFF) shl 8) or (src[k + 1].toInt() and 0xFF)).toLong(); k += 2 }
        k = 0
        while (k < dst.size) { sum += (((dst[k].toInt() and 0xFF) shl 8) or (dst[k + 1].toInt() and 0xFF)).toLong(); k += 2 }
        sum += proto.toLong()
        sum += (segLen ushr 16).toLong()
        sum += (segLen and 0xFFFF).toLong()
        var i = off; var rem = segLen
        while (rem > 1) { sum += (((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)).toLong(); i += 2; rem -= 2 }
        if (rem == 1) sum += ((buf[i].toInt() and 0xFF) shl 8).toLong()
        while ((sum shr 16) != 0L) sum = (sum and 0xFFFFL) + (sum shr 16)
        return (sum.inv() and 0xFFFFL).toInt()
    }

    // ---- byte helpers -------------------------------------------------------

    fun u16(b: ByteArray, o: Int) = ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)
    fun u24(b: ByteArray, o: Int) = ((b[o].toInt() and 0xFF) shl 16) or ((b[o + 1].toInt() and 0xFF) shl 8) or (b[o + 2].toInt() and 0xFF)
    fun u32(b: ByteArray, o: Int) = ((b[o].toInt() and 0xFF) shl 24) or ((b[o + 1].toInt() and 0xFF) shl 16) or ((b[o + 2].toInt() and 0xFF) shl 8) or (b[o + 3].toInt() and 0xFF)
    fun put16(b: ByteArray, o: Int, v: Int) { b[o] = (v ushr 8).toByte(); b[o + 1] = v.toByte() }
    fun put32(b: ByteArray, o: Int, v: Int) { b[o] = (v ushr 24).toByte(); b[o + 1] = (v ushr 16).toByte(); b[o + 2] = (v ushr 8).toByte(); b[o + 3] = v.toByte() }
}

/**
 * The only two things FitShield reads out of a connection's payload: the TLS
 * ClientHello's server_name (port 443) and the HTTP Host header (port 80). Both
 * are sent in the clear by the client; nothing is decrypted and nothing beyond
 * the name is looked at.
 *
 * Pure and address-family agnostic on purpose — the caller has already resolved
 * the transport offset, so IPv4 and IPv6 reach identical code here. Each parser
 * answers with one of three things:
 *
 *   null  — need more bytes, the record is not complete yet
 *   ""    — there is no name to be had (not TLS, no Host header, malformed)
 *   host  — the lowercased name the client asked for
 */
internal object HostPeek {

    fun tlsSni(b: ByteArray, len: Int): String? {
        if (len < 5) return null
        if ((b[0].toInt() and 0xFF) != 0x16) return ""            // not a TLS handshake
        val recEnd = 5 + IpPacket.u16(b, 3)
        if (len < recEnd) return null                              // ClientHello record incomplete
        var p = 5
        if (p >= len || (b[p].toInt() and 0xFF) != 0x01) return "" // not ClientHello
        val hsEnd = p + 4 + IpPacket.u24(b, p + 1)
        if (hsEnd > len) return null
        p += 4 + 2 + 32                                            // hdr + version + random
        if (p + 1 > len) return null
        val sidLen = b[p].toInt() and 0xFF; p += 1 + sidLen
        if (p + 2 > len) return null
        p += 2 + IpPacket.u16(b, p)                                // cipher suites
        if (p + 1 > len) return null
        p += 1 + (b[p].toInt() and 0xFF)                           // compression methods
        if (p + 2 > len) return ""
        val extEnd = minOf(p + 2 + IpPacket.u16(b, p), len); p += 2
        while (p + 4 <= extEnd) {
            val type = IpPacket.u16(b, p); val el = IpPacket.u16(b, p + 2); p += 4
            if (type == 0x0000) {                                  // server_name
                var q = p + 2                                       // skip server_name_list length
                while (q + 3 <= minOf(p + el, len)) {
                    val nameType = b[q].toInt() and 0xFF
                    val nameLen = IpPacket.u16(b, q + 1); q += 3
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

    fun httpHost(b: ByteArray, len: Int): String? {
        val s = String(b, 0, minOf(len, 4096), Charsets.ISO_8859_1)
        val m = Regex("(?im)^Host:[ \\t]*([^\\r\\n:]+)").find(s)
        if (m != null) return m.groupValues[1].trim().lowercase()
        if (s.contains("\r\n\r\n") || len > 4096) return ""        // headers done, no Host
        return null
    }
}
