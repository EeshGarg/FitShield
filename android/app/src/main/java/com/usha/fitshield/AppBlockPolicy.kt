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

    /**
     * App blocking is ON by default, like every category below it.
     *
     * It used to default false, which made "turn FitShield on" a half-measure:
     * sites were filtered and the DoorDash app still opened, because a second
     * switch nobody had been shown was still off. Every `appBlock*` category
     * already defaulted true, so the master switch was the only thing in this
     * file that did not — and the effect of that one `false` was that the
     * feature appeared not to work at all.
     *
     * Defaulting it true grants nothing on its own. App blocking cannot act
     * without the AccessibilityService, which only the user can turn on in
     * system settings, after the disclosure in index.html. This decides what
     * happens once they have: it works, rather than silently not.
     */
    fun isEnabled(context: Context): Boolean = bool(prefs(context), "appBlockingEnabled", true)

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

    /** True only during the scheduled window when scheduling is on; always true
     *  otherwise. The arithmetic is [Schedule], which the suite can execute. */
    private fun withinSchedule(p: SharedPreferences): Boolean = Schedule.withinWindow(
        bool(p, "scheduleEnabled", false),
        str(p, "scheduleStart", "18:00"),
        str(p, "scheduleEnd", "23:00"),
        Calendar.getInstance().let { it.get(Calendar.HOUR_OF_DAY) * 60 + it.get(Calendar.MINUTE) }
    )

    /**
     * Whether the schedule permits blocking right now.
     *
     * Exposed because "Block only during scheduled hours" sits in Blocking
     * Options, which reads as covering everything FitShield blocks — and it did
     * not: app blocking honoured it while the connection filter kept resetting
     * sites around the clock. One switch, two answers, and nothing said so.
     */
    fun scheduleAllows(context: Context): Boolean = withinSchedule(prefs(context))

    // ---- temporary unlock ----------------------------------------------------

    private fun unlocks(p: SharedPreferences): JSONObject = try {
        JSONObject(p.getString(KEY_UNLOCKS, "{}") ?: "{}")
    } catch (e: Exception) { JSONObject() }

    fun isUnlocked(context: Context, brandId: String): Boolean {
        val expiry = unlockExpiry(context, brandId) ?: return false
        return expiry > System.currentTimeMillis()
    }

    /** When [brandId]'s temporary unlock expires, or null when it has none.
     *  Exposed so the connection filter can honour the same unlock the pause
     *  screen granted, instead of resetting the app the user just chose to open. */
    fun unlockExpiry(context: Context, brandId: String): Long? {
        val expiry = unlocks(prefs(context)).optLong(brandId, 0L)
        return if (expiry > 0L) expiry else null
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
        // Same default as isEnabled() above, and it has to stay the same: these
        // two disagreeing would mean the UI reporting app blocking as on while
        // this returned false for every app.
        if (!bool(p, "appBlockingEnabled", true)) return false
        if (allowedBrands(p).contains(brand.brandId)) return false   // per-app opt-out
        if (!categoryEnabled(p, brand.category)) return false
        if (!withinSchedule(p)) return false
        if (isUnlocked(context, brand.brandId)) return false
        return true
    }
}
