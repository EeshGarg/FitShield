package com.usha.fitshield

/**
 * Executes the Android adapter's pure Kotlin decision logic so the Node test
 * suite can assert on what it really does, rather than on what its source looks
 * like it does.
 *
 * Only sources that import nothing from Android can be compiled here (today:
 * Schedule). The VPN-era packet, host-match and boot-restore logic is gone with
 * the VpnService Google Play rejected.
 *
 * This file is TEST SCAFFOLDING. It is not in the app's source set and never
 * ships in the APK; it is compiled on demand by test/helpers/kotlin-runner.js
 * together with the real sources it exercises.
 *
 * Protocol: one command per stdin line, one result per stdout line, in order.
 * Any command that throws answers "ERR:<class>".
 */
private fun run(line: String): String {
    // Padded so an omitted trailing argument reads as "-" (absent).
    val a = line.trim().split(" ") + List(16) { "-" }
    return when (a[0]) {
        // sched <true|false> <start> <end> <nowMinutes>
        "sched" -> Schedule.withinWindow(a[1] == "true", a[2], a[3], a[4].toInt()).toString()

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
