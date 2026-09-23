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
 * The window is INCLUSIVE at the start and EXCLUSIVE at the end, and
 * `start == end` means the WHOLE DAY — which is `windowActive` in
 * extension/fitshield-core.js, the reference implementation. This file used to
 * say `now in start..end`, inclusive at both ends, with `start == end` meaning
 * that single minute. Both differences were real and both went the same way:
 * Android blocked a minute the user had not asked for at the end of every
 * window, and read an all-day window as sixty seconds of blocking a day.
 *
 * Nothing flagged it, because each platform had a green test asserting its own
 * answer — `test/schedule.test.js` pinned exclusivity and
 * `test/android-packet-filter.test.js` pinned inclusivity, for the same stored
 * `18:00`-`23:00`. Two suites can certify a disagreement indefinitely if neither
 * ever compares itself to the other. They do now: the harness runs THIS function
 * and `evaluateSchedule` over one table of boundary minutes and asserts the
 * answers match.
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
     *
     * Core reaches the SAME answer by a different route, which is worth knowing
     * before anyone "fixes" this to match it more literally: `normalizeSchedule`
     * DROPS a window whose times will not parse, an empty window list normalizes
     * the mode to "always", and `evaluateSchedule` then returns
     * `{active: true, reason: "always"}`. So both platforms keep blocking; core
     * gets there by discarding the window and Android by ignoring the parse
     * failure. `windowActive` alone returns false, which is why reading that
     * function in isolation suggests a divergence that is not there — the
     * malformed cases are in the parity table in
     * test/android-packet-filter.test.js precisely so that stays checked.
     */
    fun withinWindow(enabled: Boolean, start: String, end: String, nowMinutes: Int): Boolean {
        if (!enabled) return true
        val from = parseMinutes(start) ?: return true
        val to = parseMinutes(end) ?: return true
        // start == end is the WHOLE DAY, as core reads it. `now in from..to` gave
        // it exactly one minute — so "block all day", the most absolute thing this
        // setting can say, was the weakest schedule it could express.
        if (from == to) return true
        // Inclusive at the start, EXCLUSIVE at the end. With 18:00-23:00 the
        // window closes AT 23:00, rather than running through 23:00:59.
        return if (from < to) nowMinutes >= from && nowMinutes < to
        else nowMinutes >= from || nowMinutes < to
    }
}
