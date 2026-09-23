package com.usha.fitshield

/**
 * Host matching for the Android filter, with NOTHING from Android in it.
 *
 * It lives apart from [RuleEngine] because RuleEngine needs a Context to read
 * the generated asset, and a class that needs a Context cannot be executed by
 * the Node suite. The decision itself — is this host blocked, and does the
 * user's always-allow list exempt it — is pure, so it is kept pure and the
 * suite runs the real code instead of asserting on the shape of its source.
 *
 * The matching contract is the engine's `domainMatches`: a host matches an
 * apex when it equals it or is a subdomain of it.
 */
object HostMatch {

    /**
     * The engine's `normalizeHostname`, in Kotlin.
     *
     * FS Engine/hostnames.js strips scheme, path, query, fragment, port, trailing
     * dot(s) and a leading "www."; this did only trim/lowercase/trailing-dot/www.
     *
     * For the VPN path that difference is harmless — a TLS SNI value is a bare
     * name and IpPacket already excludes the port — but the SAME function is
     * applied to USER-TYPED text, by [allowSet] and [customSet] (the always-allow
     * list and Custom URLs) and by WebAppBridge.checkHost (the domain tester). So
     * anyone who typed what they would naturally copy out of a browser —
     * `https://doordash.com/` or `doordash.com:443` — got a list entry that could
     * never match anything, stored and shown back to them with a Remove button.
     * The allow list's whole promise is "never blocked", and it silently did not
     * apply.
     *
     * The steps below mirror the engine's, in its order, including the branches
     * that only degenerate input reaches — see the comments inside. The pair is
     * driven over one shared fixture by test/android-packet-filter.test.js, which
     * asserts Kotlin's answer equals `normalizeHostname`'s for every case rather
     * than asserting either in isolation.
     *
     * The VPN path stays cheap. A bare lowercase SNI name contains none of `://`,
     * `/`, `?`, `#` or `:`, so every [indexOf] here answers -1 immediately and no
     * substring is allocated before the trailing-dot and `www.` checks that were
     * already being done.
     */
    fun normalize(host: String?): String? {
        if (host.isNullOrBlank()) return null
        var h = host.trim().lowercase()

        // Step 1 — a full URL. The engine hands anything containing "://" to
        // `new URL()` and uses `.hostname`, which is the authority with the
        // userinfo and the port removed; when the parse THROWS it leaves the string
        // untouched and lets step 2 do what it can. Both halves are reproduced,
        // because the second one is reachable: "http://" has no host, so URL()
        // throws, and step 2 then yields "http". Skipping that branch would have
        // been a silent disagreement on exactly the inputs nobody thinks about.
        val scheme = h.indexOf("://")
        if (scheme >= 0) {
            val authority = h.substring(scheme + 3)
            val end = authority.indexOfFirst { it == '/' || it == '?' || it == '#' }
            var hostPart = if (end >= 0) authority.substring(0, end) else authority
            val at = hostPart.lastIndexOf('@')                // userinfo
            if (at >= 0) hostPart = hostPart.substring(at + 1)
            val port = hostPart.indexOf(':')
            if (port >= 0) hostPart = hostPart.substring(0, port)
            // Empty means URL() would have thrown: leave `h` alone, exactly as the
            // engine's catch branch does.
            if (hostPart.isNotEmpty()) h = hostPart
        }

        // Step 2 — drop any path, query, fragment or port still present, in the
        // engine's order. The order is load-bearing: "a:b/c" loses "/c" first and
        // then everything from the colon, so it resolves to "a" on both platforms.
        // Note this deliberately does NOT strip userinfo — a bare
        // "user:pass@doordash.com" with no scheme normalises to "user" in the
        // engine too, and agreeing matters more than either answer being pretty.
        for (delimiter in charArrayOf('/', '?', '#', ':')) {
            val index = h.indexOf(delimiter)
            if (index >= 0) h = h.substring(0, index)
        }

        h = h.trimEnd('.')                       // trailing root dot(s), before www.
        if (h.startsWith("www.")) h = h.substring(4)
        // The engine returns "" for "no host"; this returns null, which is the same
        // statement in Kotlin's types and what every caller here already expects.
        return if (h.isEmpty()) null else h
    }

    /** Walk the query's domain suffixes against [set]:
     *  a.b.example.com -> b.example.com -> example.com -> com. */
    fun suffixMatch(set: Set<String>, host: String): String? {
        var candidate = host
        while (true) {
            if (set.contains(candidate)) return candidate
            val index = candidate.indexOf('.')
            if (index < 0) return null
            candidate = candidate.substring(index + 1)
        }
    }

    /**
     * Normalise a user-entered allow list into the form [blockedApex] compares
     * against. Done once when the list changes rather than per packet, and kept
     * here so the filter and the suite build the set the same way — a set built
     * two ways is a test that passes while the device does something else.
     */
    fun allowSet(hosts: Collection<String>): Set<String> = hosts.mapNotNull { normalize(it) }.toSet()

    /** Same normalisation for the domains the user asked to block themselves. */
    fun customSet(hosts: Collection<String>): Set<String> = allowSet(hosts)

    /**
     * The blocked apex for [host], or null when nothing blocks it.
     *
     * [allow] wins over [apexes], and covers subdomains by the same rule, so
     * allowing "example.com" also allows "shop.example.com". The allow layer
     * was UI-only until a device test caught it: the list was stored and shown
     * back to the user while the filter reset the connection anyway.
     */
    fun blockedApex(
        apexes: Set<String>,
        custom: Set<String>,
        allow: Set<String>,
        host: String?
    ): String? {
        val normalized = normalize(host) ?: return null
        // Allow is checked first and beats both sources. It is the only ordering
        // that lets someone rescue a domain they actually need.
        if (allow.isNotEmpty() && suffixMatch(allow, normalized) != null) return null
        // Curated first, so stats stay keyed by the curated apex. The user's own
        // list is a UNION with it, which is how getRuleCatalog builds the
        // extension's catalog: delivery + fast food + custom URLs.
        suffixMatch(apexes, normalized)?.let { return it }
        if (custom.isNotEmpty()) return suffixMatch(custom, normalized)
        return null
    }
}
