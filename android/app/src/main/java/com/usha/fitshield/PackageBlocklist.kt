package com.usha.fitshield

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Loads the GENERATED Android app-package dataset (`assets/android-packages.json`)
 * and answers "is this app package blocked, and which brand is it?".
 *
 * The package to brand map comes ONLY from the canonical pipeline
 * (tools/generate-android-packages.js) which compiles the data/android app files
 * plus the blocklists into data/generated/android-packages.json (bundled here).
 * There is no hand-maintained package list and no second source of truth — the
 * validator fails the build if the bundled asset drifts from the generated file.
 */
class PackageBlocklist private constructor(
    private val packages: Map<String, Brand>
) {
    /**
     * Curated brand a package belongs to.
     *
     * [category] is the APP GROUPING — the value the Settings pills and
     * [AppBlockPolicy.shouldBlock] switch on. It is coarse on purpose: a handful
     * of values, with roughly two thirds of all packages sharing `fast_food`.
     *
     * [foodCategory], [foodType] and [specialties] are the CURATED food metadata
     * straight from the blocklists, and they exist because the grouping is not a
     * food category. The block screen used to receive only the grouping, so the
     * shared recipe selector was asked "what answers fast_food?" for a burger
     * chain, a pizza chain, a sandwich chain and a bubble-tea shop alike and gave
     * all of them the same two answers. These three fields are what let the phone
     * ask the same question the browser extension asks.
     */
    data class Brand(
        val packageId: String,
        val brandId: String,
        val displayName: String,
        val category: String,
        val foodCategory: String,
        val foodType: String,
        val specialties: List<String>
    )

    val size: Int get() = packages.size

    /** The brand for [packageName], or null if it is not a blocked app. */
    fun match(packageName: String?): Brand? = if (packageName == null) null else packages[packageName]

    /**
     * Every mapped brand, in a stable order.
     *
     * Exposed so [WebAppBridge] can build the per-app toggle list from THIS map
     * instead of re-parsing the asset into a second, independent view of it. The
     * order is the asset's key order, which is deterministic because the generator
     * sorts it.
     */
    fun brands(): Collection<Brand> = packages.values

    companion object {
        const val ASSET_NAME = "android-packages.json"

        fun fromAssets(context: Context): PackageBlocklist {
            return try {
                context.assets.open(ASSET_NAME).use { stream ->
                    val json = JSONObject(stream.readBytes().toString(Charsets.UTF_8))
                    require(json.optBoolean("_generated", false)) {
                        "$ASSET_NAME is not the generated FitShield app-package artifact"
                    }
                    val pkgObj = json.optJSONObject("packages") ?: JSONObject()
                    val map = HashMap<String, Brand>(pkgObj.length() * 2)
                    val keys = pkgObj.keys()
                    while (keys.hasNext()) {
                        val pkg = keys.next()
                        val meta = pkgObj.optJSONObject(pkg) ?: continue
                        val spec = meta.optJSONArray("specialties")
                        map[pkg] = Brand(
                            packageId = pkg,
                            brandId = meta.optString("brandId", ""),
                            displayName = meta.optString("displayName", pkg),
                            category = meta.optString("category", ""),
                            foodCategory = meta.optString("foodCategory", ""),
                            foodType = meta.optString("foodType", ""),
                            specialties = if (spec == null) emptyList() else
                                (0 until spec.length()).mapNotNull { i ->
                                    spec.optString(i, "").takeIf { it.isNotEmpty() }
                                }
                        )
                    }
                    PackageBlocklist(map)
                }
            } catch (e: Exception) {
                // FAIL OPEN, LOUDLY — and the two halves of that are a deliberate
                // pair.
                //
                // Open: this is loaded by [FitShieldAccessibilityService.onServiceConnected].
                // Throwing here, the way [RuleEngine.fromAssets] does, would take the
                // accessibility service down every time the system reconnected it —
                // a crash-looping accessibility service, which the user cannot
                // diagnose and which is a worse outcome than app blocking being off.
                // RuleEngine can afford to throw because a VpnService that refuses to
                // start is visibly off in the UI; an AccessibilityService that dies on
                // connect looks exactly like one that is running.
                //
                // Loud: it used to return this silently, so a malformed asset meant
                // "block no apps" with every pill still showing on and nothing,
                // anywhere, saying why. That is the part that was wrong. The log names
                // the consequence rather than just the exception, because "app
                // blocking is inactive" is the fact someone reading logcat needs, and
                // [size] == 0 is what the dashboard reports through
                // WebAppBridge.appPackageCount().
                Log.e(
                    TAG,
                    "$ASSET_NAME could not be read, so NO app can be matched and app blocking is inactive. " +
                        "The asset is generated by tools/generate-android-packages.js; a build that shipped a " +
                        "malformed one is the likely cause.",
                    e
                )
                PackageBlocklist(emptyMap())
            }
        }

        private const val TAG = "FitShieldPackages"
    }
}
