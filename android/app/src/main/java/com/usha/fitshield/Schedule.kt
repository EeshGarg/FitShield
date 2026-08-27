package com.usha.fitshield

/**
 * The "block only during scheduled hours" window, with no Android in it.
 *
 * The arithmetic lives apart from [AppBlockPolicy] because that class needs a
 * Context to read preferences, and a class that needs a Context cannot be run by
 * the Node suite. Overnight windows (22:00 to 02:00) are the case worth pinning:
 * they wrap past midnight, so the naive `now in start..end` is false for every
 * minute of them.
 *
 * The window is INCLUSIVE at both ends, matching the app-blocking policy this
 * was extracted from.
 */
object Schedule {

    /** "18:30" -> 1110 minutes past midnight. Null when it is not a time. */
    fun parseMinutes(hhmm: String): Int? {
        val parts = hhmm.split(":")
        if (parts.size != 2) return null
        val h = parts[0].toIntOrNull() ?: return null
        val m = parts[1].toIntOrNull() ?: return null
        if (h !in 0..23 || m !in 0..59) return null
        return h * 60 + m
    }

    /**
     * True when blocking should be active at [nowMinutes].
     *
     * Scheduling off means always active, and so does a window that cannot be
     * parsed: a malformed time must not be a silent way to switch protection
     * off, which is the direction this has to fail in.
     */
    fun withinWindow(enabled: Boolean, start: String, end: String, nowMinutes: Int): Boolean {
        if (!enabled) return true
        val from = parseMinutes(start) ?: return true
        val to = parseMinutes(end) ?: return true
        return if (from <= to) nowMinutes in from..to else (nowMinutes >= from || nowMinutes <= to)
    }
}
