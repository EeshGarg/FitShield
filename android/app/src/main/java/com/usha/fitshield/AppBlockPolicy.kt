package com.usha.fitshield

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import java.util.Calendar

/**
 * Decides whether a blocked app should be intervened on *right now*, from the
 * SAME SharedPreferences ("fitshield") the web UI writes through android-shim.js.
 * Keeps the AccessibilityService free of policy so the rules live in one place.
 *
 * Values are stored by the web shim as JSON (bool → "true"/"false", numbers →
 * "5", strings → "\"18:00\""), so reads strip the JSON quoting.
 */
object AppBlockPolicy {

    private const val PREFS = "fitshield"
    private const val KEY_UNLOCKS = "appUnlocks"          // { brandId: expiryEpochMs }

    fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ---- reads ---------------------------------------------------------------

    private fun bool(p: SharedPreferences, key: String, def: Boolean): Boolean {
        val raw = p.getString(key, null) ?: return def
        return raw.trim('"').equals("true", ignoreCase = true)
    }

    private fun str(p: SharedPreferences, key: String, def: String): String {
        val raw = p.getString(key, null) ?: return def
        return raw.trim('"')
    }

    private fun int(p: SharedPreferences, key: String, def: Int): Int {
        val raw = p.getString(key, null)?.trim('"') ?: return def
        return raw.toDoubleOrNull()?.toInt() ?: def
    }

    fun isEnabled(context: Context): Boolean = bool(prefs(context), "appBlockingEnabled", false)

    /** Minutes a temporary unlock lasts (reuses the extension's pass duration). */
    fun unlockMinutes(context: Context): Int =
        int(prefs(context), "appUnlockMinutes", int(prefs(context), "passDurationMinutes", 5)).coerceIn(1, 240)

    /**
     * One branch per APP GROUPING, matching the pills in web/index.html, the
     * `CATS` map in web/app.js and APP_CATEGORIES in
     * tools/generate-android-packages.js. All four are held to each other by
     * test/android-controls.test.js, in both directions:
     *
     *  - a grouping with no pill would fall to `else -> true` and be blocked with
     *    no way for the user to turn it off;
     *  - a pill with no packages is a control that does nothing.
     *
     * `convenience` was the second kind. It had a pill, a key and a branch here,
     * and no blocklist row is `convenience`, so nothing could ever reach it.
     */
    private fun categoryEnabled(p: SharedPreferences, category: String): Boolean = when (category) {
        "delivery" -> bool(p, "appBlockDelivery", true)
        "fast_food" -> bool(p, "appBlockFastFood", true)
        "restaurant" -> bool(p, "appBlockRestaurant", true)
        "grocery" -> bool(p, "appBlockGrocery", true)
        "coffee" -> bool(p, "appBlockCoffee", true)
        "dessert" -> bool(p, "appBlockDessert", true)
        "meal_kit" -> bool(p, "appBlockMealKit", true)
        else -> true
    }

    /** True only during the scheduled window when scheduling is on; always true otherwise. */
    private fun withinSchedule(p: SharedPreferences): Boolean {
        if (!bool(p, "scheduleEnabled", false)) return true
        val start = parseMinutes(str(p, "scheduleStart", "18:00")) ?: return true
        val end = parseMinutes(str(p, "scheduleEnd", "23:00")) ?: return true
        val now = Calendar.getInstance().let { it.get(Calendar.HOUR_OF_DAY) * 60 + it.get(Calendar.MINUTE) }
        return if (start <= end) now in start..end else (now >= start || now <= end)  // overnight window
    }

    private fun parseMinutes(hhmm: String): Int? {
        val parts = hhmm.split(":")
        if (parts.size != 2) return null
        val h = parts[0].toIntOrNull() ?: return null
        val m = parts[1].toIntOrNull() ?: return null
        return h * 60 + m
    }

    // ---- temporary unlock ----------------------------------------------------

    private fun unlocks(p: SharedPreferences): JSONObject = try {
        JSONObject(p.getString(KEY_UNLOCKS, "{}") ?: "{}")
    } catch (e: Exception) { JSONObject() }

    fun isUnlocked(context: Context, brandId: String): Boolean {
        val expiry = unlocks(prefs(context)).optLong(brandId, 0L)
        return expiry > System.currentTimeMillis()
    }

    // Per-app "always allow" list (brandIds the user has opted out of blocking).
    private fun allowedBrands(p: SharedPreferences): Set<String> {
        return try {
            val arr = org.json.JSONArray(p.getString("appAllowBrands", "[]") ?: "[]")
            (0 until arr.length()).map { arr.getString(it) }.toSet()
        } catch (e: Exception) { emptySet() }
    }

    /** Record a temporary unlock for [brandId] lasting [minutes]. */
    fun unlock(context: Context, brandId: String, minutes: Int) {
        val p = prefs(context)
        synchronized(this) {
            val obj = unlocks(p)
            // prune expired entries so the map does not grow unbounded
            val now = System.currentTimeMillis()
            val pruned = JSONObject()
            obj.keys().forEach { k -> if (obj.optLong(k, 0L) > now) pruned.put(k, obj.optLong(k, 0L)) }
            pruned.put(brandId, now + minutes.coerceIn(1, 240) * 60_000L)
            p.edit().putString(KEY_UNLOCKS, pruned.toString()).apply()
        }
    }

    /** The full decision: should FitShield intervene on this brand right now? */
    fun shouldBlock(context: Context, brand: PackageBlocklist.Brand): Boolean {
        val p = prefs(context)
        if (!bool(p, "appBlockingEnabled", false)) return false
        if (allowedBrands(p).contains(brand.brandId)) return false   // per-app opt-out
        if (!categoryEnabled(p, brand.category)) return false
        if (!withinSchedule(p)) return false
        if (isUnlocked(context, brand.brandId)) return false
        return true
    }
}
