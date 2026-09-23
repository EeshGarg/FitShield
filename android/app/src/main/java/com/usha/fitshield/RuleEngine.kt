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
     *  [category], PRIMARY operating [country], and — for an ALIAS host only —
     *  the [brandId] that host belongs to. Empty strings when unknown. */
    data class BlockMeta(val country: String, val category: String, val brandId: String = "")

    val count: Int get() = apexes.size

    /** Metadata for the matched apex/host, or null when the asset has none. */
    fun metaFor(host: String?): BlockMeta? = if (host == null) null else meta[host.lowercase()]

    /**
     * The brand id [host] belongs to — the key a temporary unlock is stored under.
     *
     * This exists because the filter was ASSUMING the matched host is the brand
     * id. BlockActivity records "Open anyway" under `brandId`, which is the
     * entry's canonical domain, while the filter looked the unlock up by the host
     * it had just matched. Those are the same string for almost every host and
     * different for every ALIAS domain, and four shipped brands have both an
     * Android app and an alias: burgerking.com/bk.com, nandos.co.uk/nandos.com,
     * wingstop.com/wingstop.co.uk and food.jumia.com's four country domains. For
     * those, the user chose "Open anyway", the app was opened for them, and every
     * connection it made to the alias domain was reset — re-blocked on the very
     * host they had just been let through.
     *
     * The mapping is DATA: `meta[host].b`, emitted by
     * tools/generate-android-rules.js only where it differs from the host, because
     * it is a property of the curated datasets rather than of this code. Falling
     * back to [host] is correct for every non-alias host and for the user's own
     * custom domains, which belong to no brand.
     */
    fun brandIdFor(host: String?): String {
        val normalized = host ?: return ""
        val brand = metaFor(normalized)?.brandId
        return if (brand != null && brand.isNotEmpty()) brand else normalized
    }

    /** The always-allow layer, for tests and callers that need to see it. */
    val allowlist: Set<String> get() = allow

    /** The user's own blocked domains. */
    val customSites: Set<String> get() = custom

    /**
     * Hosts the user put on the always-allow list, which the UI promises are
     * "never blocked". Kept as a separate layer rather than subtracted from
     * [apexes] so the generated asset remains the only answer to what IS
     * blockable, and the user's exemptions stay visible as exemptions.
     *
     * This layer existed only in the UI until it was tested on a device: the
     * list was stored and displayed, the filter never read it, and a domain the
     * user had explicitly allowed was still reset. A control that does nothing
     * is worse than one that is absent, because the user believes it worked.
     */
    @Volatile private var allow: Set<String> = emptySet()

    /**
     * Domains typed into "Custom URLs". The generated asset can only ever hold
     * the curated brands, so without this layer that section accepted a domain,
     * listed it back with a Remove button, and never blocked it. The extension
     * treats its custom list as a union with the curated buckets; so does this.
     */
    @Volatile private var custom: Set<String> = emptySet()

    /** Replace the always-allow layer. Safe to call while the filter runs. */
    fun setAllowlist(hosts: Collection<String>) {
        allow = HostMatch.allowSet(hosts)
    }

    /** Replace the user's own blocked domains. Safe to call while it runs. */
    fun setCustomSites(hosts: Collection<String>) {
        custom = HostMatch.customSet(hosts)
    }

    /** True when [host] is an apex in the set or a subdomain of one. */
    fun isBlocked(host: String?): Boolean = blockedApex(host) != null

    /** The matching apex for [host] (the suffix found in the set), or null. Used
     *  for stats so "most blocked sites" is keyed by the curated apex, not the
     *  full query name. Same apex/subdomain rule as the engine's domainMatches. */
    fun blockedApex(host: String?): String? = HostMatch.blockedApex(apexes, custom, allow, host)

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
                                entry.optString("k", ""),
                                // Present only on an alias host; see brandIdFor.
                                entry.optString("b", "").lowercase()
                            )
                        }
                    }
                }
                return RuleEngine(set, metaMap)
            }
        }
    }
}
