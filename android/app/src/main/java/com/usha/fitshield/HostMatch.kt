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

    /** Lowercase, strip a trailing root dot and a leading "www.". */
    fun normalize(host: String?): String? {
        if (host.isNullOrBlank()) return null
        var h = host.trim().lowercase()
        h = h.trimEnd('.')
        if (h.startsWith("www.")) h = h.substring(4)
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
