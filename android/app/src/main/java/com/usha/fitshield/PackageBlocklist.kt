package com.usha.fitshield

import android.content.Context
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
    /** Curated brand a package belongs to. */
    data class Brand(val packageId: String, val brandId: String, val displayName: String, val category: String)

    val size: Int get() = packages.size

    /** The brand for [packageName], or null if it is not a blocked app. */
    fun match(packageName: String?): Brand? = if (packageName == null) null else packages[packageName]

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
                        map[pkg] = Brand(
                            packageId = pkg,
                            brandId = meta.optString("brandId", ""),
                            displayName = meta.optString("displayName", pkg),
                            category = meta.optString("category", "")
                        )
                    }
                    PackageBlocklist(map)
                }
            } catch (e: Exception) {
                PackageBlocklist(emptyMap())
            }
        }
    }
}
