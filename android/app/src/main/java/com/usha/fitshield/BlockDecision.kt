package com.usha.fitshield

/**
 * Whether the connection filter should reset a connection — the whole decision,
 * with no Android in it so the suite can execute it.
 *
 * The inputs are deliberately plain: the matched apex, whether the user's
 * schedule permits blocking now, and when (if ever) that brand's temporary
 * unlock expires. Everything that needs a Context is resolved by the caller.
 *
 * The unlock input is the one that was missing. "Open anyway" on the pause
 * screen grants a temporary unlock for a brand, and the UI calls that
 * "unlocks that app for this many minutes" — but only the AccessibilityService
 * honoured it. The VpnService kept resetting the brand's domains, so the app
 * opened and then could not reach its own servers: on a Galaxy S24 Ultra,
 * Grubhub opened to "We weren't able to load this screen" and every retry added
 * another interruption to the counter. The user made an explicit choice and got
 * a broken app instead of the thing they chose.
 */
object BlockDecision {

    /**
     * True when the filter should send an RST for [apex].
     *
     * @param apex           the matched blocked apex, or null when nothing matched
     * @param scheduleAllows whether the user's window permits blocking right now
     * @param brandAllowed   whether the user put this brand on the per-app
     *                       "Allowed" list, which is a standing choice rather than
     *                       a timed one
     * @param unlockedUntil  epoch millis this brand's temporary unlock expires,
     *                       or null when there is no unlock for it
     * @param now            epoch millis
     */
    /**
     * True when a new TCP connection must be REFUSED outright, before the
     * handshake, rather than accepted into the tunnel.
     *
     * FitShield routes ::/0 into the tun so that IPv6 is filtered rather than
     * bypassing the filter. On a network with no IPv6 route that backfires: the
     * client's IPv6 attempt is accepted by the tunnel, the handshake completes
     * locally, the upstream connect then fails, and the client is sent an RST.
     * Having seen a connection ESTABLISH, the browser reports the site as reset
     * instead of falling back to IPv4 — so on an IPv4-only Wi-Fi, FitShield
     * broke unrelated dual-stack sites. Measured on a Galaxy S24 Ultra: with
     * FitShield on, en.wikipedia.org gave "This site can't be reached. The
     * connection was reset."; with it off the same page loaded, because the
     * IPv6 connect failed in 5ms and Happy Eyeballs moved to IPv4.
     *
     * Refusing the SYN reproduces that fast failure: the client sees the
     * address family as unusable and switches, exactly as it does without a VPN.
     * ::/0 stays routed, so the moment the network really has IPv6 the filter
     * sees it again.
     */
    fun shouldRefuseSyn(destinationIsIpv6: Boolean, ipv6Upstream: Boolean): Boolean =
        destinationIsIpv6 && !ipv6Upstream

    fun shouldReset(
        apex: String?,
        scheduleAllows: Boolean,
        brandAllowed: Boolean,
        unlockedUntil: Long?,
        now: Long
    ): Boolean {
        if (apex == null) return false
        if (!scheduleAllows) return false
        // The per-app "Allowed" pill. It used to be read ONLY by AppBlockPolicy —
        // the app path — so marking DoorDash allowed stopped the pause screen and
        // left the filter resetting doordash.com. The app opened and could not
        // reach its own servers: the user was shown "Allowed" and handed a broken
        // app, which is worse than either blocking it or allowing it cleanly.
        //
        // It sits ABOVE the unlock check because it is a standing choice, not a
        // timed one: there is nothing to expire.
        if (brandAllowed) return false
        if (unlockedUntil != null && unlockedUntil > now) return false
        return true
    }
}
