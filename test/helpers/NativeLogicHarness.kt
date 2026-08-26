package com.usha.fitshield

/**
 * Executes the Android adapter's pure Kotlin decision logic so the Node test
 * suite can assert on what it really does, rather than on what its source looks
 * like it does.
 *
 * There is no emulator here, and a grep over Kotlin cannot tell you whether an
 * IPv6 packet with a Hop-by-Hop header yields the right transport offset, or
 * whether a truncated one returns null instead of throwing out of the tun read
 * loop. Both are answerable off-device, because IpPacket / HostPeek /
 * BootRestore / VpnIntent deliberately import nothing from Android.
 *
 * This file is TEST SCAFFOLDING. It is not in the app's source set and never
 * ships in the APK; it is compiled on demand by test/helpers/kotlin-runner.js
 * together with the real sources it exercises.
 *
 * Protocol: one command per stdin line, one result per stdout line, in order.
 * Byte strings travel as lowercase hex both ways, and every returned *text*
 * value is hex-encoded too, so no separator can ever appear inside a value. Any
 * command that throws answers "ERR:<class>" — which is how "a malformed packet
 * cannot crash the filter" is asserted rather than assumed.
 */
private fun hex(bytes: ByteArray): String {
    val sb = StringBuilder(bytes.size * 2)
    for (b in bytes) {
        val v = b.toInt() and 0xFF
        if (v < 16) sb.append('0')
        sb.append(Integer.toHexString(v))
    }
    return sb.toString()
}

private fun unhex(text: String): ByteArray {
    if (text == "-") return ByteArray(0)
    val out = ByteArray(text.length / 2)
    for (i in out.indices) {
        out[i] = ((Character.digit(text[i * 2], 16) shl 4) or Character.digit(text[i * 2 + 1], 16)).toByte()
    }
    return out
}

private fun hexText(s: String) = hex(s.toByteArray(Charsets.UTF_8))

private fun run(line: String): String {
    // Padded so an omitted or empty trailing argument reads as "-" (absent)
    // instead of walking off the end of the token list.
    val a = line.trim().split(" ") + List(16) { "-" }
    return when (a[0]) {
        // parse <packetHex> [len]
        "parse" -> {
            val pkt = unhex(a[1])
            val len = if (a[2] == "-") pkt.size else a[2].toInt()
            val h = IpPacket.parse(pkt, len)
            if (h == null) "null"
            else "v=${h.version} p=${h.protocol} off=${h.transportOffset} src=${hex(h.src)} dst=${hex(h.dst)}"
        }

        // sni <payloadHex>  /  host <payloadHex>
        "sni", "host" -> {
            val b = unhex(a[1])
            val r = if (a[0] == "sni") HostPeek.tlsSni(b, b.size) else HostPeek.httpHost(b, b.size)
            when {
                r == null -> "need"
                r.isEmpty() -> "none"
                else -> "host=${hexText(r)}"
            }
        }

        // key <addrHex>
        "key" -> "k=${hexText(IpPacket.addressKey(unhex(a[1])))}"

        // tcp <srcHex> <dstHex> <sport> <dport> <seq> <ack> <flags> <win> <payloadHex|-> <mss|->
        "tcp" -> {
            val payload = if (a[9] == "-") null else unhex(a[9])
            val mss = if (a[10] == "-") null else a[10].toInt()
            val pkt = IpPacket.buildTcp(
                unhex(a[1]), unhex(a[2]), a[3].toInt(), a[4].toInt(),
                a[5].toInt(), a[6].toInt(), a[7].toInt(), a[8].toInt(), payload, mss
            )
            "pkt=${hex(pkt)}"
        }

        // udp <srcHex> <dstHex> <sport> <dport> <payloadHex>
        "udp" -> {
            val payload = unhex(a[5])
            "pkt=${hex(IpPacket.buildUdp(unhex(a[1]), unhex(a[2]), a[3].toInt(), a[4].toInt(), payload, payload.size))}"
        }

        // decide <storedIntent|-> <consentHeld>
        "decide" -> BootRestore.decide(
            if (a[1] == "-") null else String(unhex(a[1]), Charsets.UTF_8),
            a[2] == "true"
        ).name

        // record <EVENT>
        "record" -> VpnIntent.record(VpnIntent.Event.valueOf(a[1]))?.toString() ?: "null"

        // encode <true|false>  /  decode <storedIntent|->
        "encode" -> "s=${hexText(VpnIntent.encode(a[1] == "true"))}"
        "decode" -> VpnIntent.decode(if (a[1] == "-") null else String(unhex(a[1]), Charsets.UTF_8)).toString()

        "key_name" -> "s=${hexText(VpnIntent.KEY)}"

        else -> "ERR:unknown-command"
    }
}

fun main() {
    val out = StringBuilder()
    generateSequence(::readLine).forEach { line ->
        if (line.isBlank()) return@forEach
        out.append(
            try {
                run(line)
            } catch (e: Throwable) {
                "ERR:${e.javaClass.simpleName}"
            }
        ).append('\n')
    }
    print(out)
}
