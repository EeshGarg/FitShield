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
class RuleEngine private constructor(
    private val apexes: Set<String>,
    private val meta: Map<String, BlockMeta>
) {

    /** Curated, engine-derived metadata for a blockable host: the brand's food
     *  [category] and PRIMARY operating [country]. Empty strings when unknown. */
    data class BlockMeta(val country: String, val category: String)

    val count: Int get() = apexes.size

    /** Metadata for the matched apex/host, or null when the asset has none. */
    fun metaFor(host: String?): BlockMeta? = if (host == null) null else meta[host.lowercase()]

    /** True when [host] is an apex in the set or a subdomain of one. */
    fun isBlocked(host: String?): Boolean = blockedApex(host) != null

    /** The matching apex for [host] (the suffix found in the set), or null. Used
     *  for stats so "most blocked sites" is keyed by the curated apex, not the
     *  full query name. Same apex/subdomain rule as the engine's domainMatches. */
    fun blockedApex(host: String?): String? {
        val normalized = normalize(host) ?: return null
        // Walk suffixes: a.b.example.com -> b.example.com -> example.com -> com
        var candidate = normalized
        while (true) {
            if (apexes.contains(candidate)) return candidate
            val index = candidate.indexOf('.')
            if (index < 0) return null
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
                // Optional per-host block metadata (category + primary country).
                val metaMap = HashMap<String, BlockMeta>()
                json.optJSONObject("meta")?.let { metaJson ->
                    val keys = metaJson.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        metaJson.optJSONObject(key)?.let { entry ->
                            metaMap[key.lowercase()] = BlockMeta(
                                entry.optString("c", ""),
                                entry.optString("k", "")
                            )
                        }
                    }
                }
                return RuleEngine(set, metaMap)
            }
        }
    }
}
