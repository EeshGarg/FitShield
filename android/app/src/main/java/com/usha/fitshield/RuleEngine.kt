package com.usha.fitshield

import android.content.Context
import org.json.JSONObject

/**
 * Loads the GENERATED FitShield rules asset and answers "is this host blocked?".
 *
 * The host set comes ONLY from `assets/fitshield-rules.json`, which is produced
 * by the canonical pipeline (tools/generate-android-rules.js) from the separated
 * engine (blocklist.js) over the canonical datasets. There is no hand-maintained
 * list here and no second source of truth.
 *
 * The matching rule is identical to the engine's blocklist.js `domainMatches`:
 * a query host is blocked when it equals an apex domain or is a subdomain of one
 * (host == apex || host endsWith "." + apex). This is checked by walking the
 * query's domain suffixes against the apex set, which is exactly that contract.
 */
class RuleEngine private constructor(private val apexes: Set<String>) {

    val count: Int get() = apexes.size

    /** True when [host] is an apex in the set or a subdomain of one. */
    fun isBlocked(host: String?): Boolean {
        val normalized = normalize(host) ?: return false
        // Walk suffixes: a.b.example.com -> b.example.com -> example.com -> com
        var index = 0
        var candidate = normalized
        while (true) {
            if (apexes.contains(candidate)) return true
            index = candidate.indexOf('.')
            if (index < 0) return false
            candidate = candidate.substring(index + 1)
        }
    }

    private fun normalize(host: String?): String? {
        if (host.isNullOrBlank()) return null
        var h = host.trim().lowercase()
        h = h.trimEnd('.')                 // trailing root dot
        if (h.startsWith("www.")) h = h.substring(4)
        return if (h.isEmpty()) null else h
    }

    companion object {
        const val ASSET_NAME = "fitshield-rules.json"

        /** Load and parse the generated asset. Throws if the asset is missing or
         *  not the generated artifact (defensive against an accidental fork). */
        fun fromAssets(context: Context): RuleEngine {
            context.assets.open(ASSET_NAME).use { stream ->
                val text = stream.readBytes().toString(Charsets.UTF_8)
                val json = JSONObject(text)
                require(json.optBoolean("_generated", false)) {
                    "$ASSET_NAME is not the generated FitShield rules artifact"
                }
                val hosts = json.getJSONArray("hosts")
                val set = HashSet<String>(hosts.length() * 2)
                for (i in 0 until hosts.length()) {
                    set.add(hosts.getString(i).lowercase())
                }
                return RuleEngine(set)
            }
        }
    }
}
