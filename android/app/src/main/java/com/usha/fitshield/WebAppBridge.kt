package com.usha.fitshield

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.webkit.JavascriptInterface
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native bridge exposed to the WebView as `Android`. android-shim.js builds the
 * platform-agnostic `fitshield.*` API on top of these synchronous methods.
 *
 * - storage*  -> SharedPreferences ("fitshield"), the SAME store the VpnService
 *   writes stats into, so the reused web UI shows live numbers.
 * - vpn*      -> start/stop FitShieldVpnService (enable routes through the
 *   Activity for the system VPN-consent dialog).
 * - privateDns* -> detect + open the system Private DNS setting (detect & guide).
 */
class WebAppBridge(private val activity: AppCompatActivity) {

    private val context: Context = activity.applicationContext
    private val prefs = context.getSharedPreferences("fitshield", Context.MODE_PRIVATE)
    private val engine by lazy { runCatching { RuleEngine.fromAssets(context) }.getOrNull() }

    /**
     * The SAME loader the AccessibilityService uses, parsed once for this bridge.
     *
     * Both `appPackageCount()` and `blockableApps()` used to re-read and re-parse
     * `android-packages.json` themselves, and `appPackageCount()` read the asset's
     * `counts.packages` field rather than the map. So a malformed asset — the case
     * [PackageBlocklist.fromAssets] deliberately absorbs — could leave the dashboard
     * announcing "1511 apps can be blocked" while the matcher held zero and nothing
     * could be blocked at all. Reading the count off the matcher makes it impossible
     * for the number on screen to disagree with the number in effect, which is what
     * lets app.js treat 0 as the honest signal that the dataset did not load.
     */
    private val packages by lazy { PackageBlocklist.fromAssets(context) }

    // ---- storage (backs fitshield.storage) ----------------------------------

    @JavascriptInterface
    fun storageGet(key: String): String? = prefs.getString(key, null)

    /**
     * Every key in [keysJson] in ONE bridge hop.
     *
     * A `@JavascriptInterface` call is a synchronous JS→native crossing, and
     * [storageGet] costs one of them per key: `renderAppBlocking` needed 9 and
     * `stats.get()` needed 5 — the second of those on the dashboard's 2s status
     * poll. Nothing about this is expensive on the Kotlin side: [prefs] is already
     * an in-memory map (SharedPreferences loads the whole file once), so the only
     * cost being paid per key was the crossing itself.
     *
     * The answer is a JSON object of key -> the SAME raw stored string
     * [storageGet] returns, which keeps the shim's parsing identical. A key this
     * store does not hold is simply LEFT OUT, so a missing key reads as absent —
     * byte-for-byte the behaviour of `storageGet` returning null for it.
     *
     * Each key is read inside its own `runCatching`, so a preference holding a
     * non-String (which makes `getString` throw) costs only itself. Reading them
     * one at a time already had that isolation, because a throwing
     * `@JavascriptInterface` method returns undefined for that call alone, and
     * losing it here would have been a regression dressed as an optimisation.
     *
     * @param keysJson a JSON array of preference key names
     */
    @JavascriptInterface
    fun storageGetMany(keysJson: String): String {
        val keys = runCatching { JSONArray(keysJson) }.getOrNull() ?: JSONArray()
        val out = JSONObject()
        for (i in 0 until keys.length()) {
            val key = keys.optString(i, "")
            if (key.isEmpty()) continue
            val value = runCatching { prefs.getString(key, null) }.getOrNull() ?: continue
            out.put(key, value)
        }
        return out.toString()
    }

    @JavascriptInterface
    fun storageSet(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    @JavascriptInterface
    fun storageRemove(key: String) {
        prefs.edit().remove(key).apply()
    }

    @JavascriptInterface
    fun storageClear() {
        prefs.edit().clear().apply()
    }

    @JavascriptInterface
    fun storageKeys(): String = JSONArray(prefs.all.keys.toList()).toString()

    // ---- runtime / i18n ------------------------------------------------------

    @JavascriptInterface
    fun getVersion(): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }
            .getOrDefault("") ?: ""

    @JavascriptInterface
    fun getUiLanguage(): String {
        val tag = context.resources.configuration.locales[0].toLanguageTag()
        return tag.replace('-', '_')
    }

    // ---- app blocking (accessibility) ---------------------------------------

    /** True when the FitShield app-blocking AccessibilityService is enabled. */
    @JavascriptInterface
    fun accessibilityEnabled(): Boolean {
        return runCatching {
            val flat = Settings.Secure.getString(
                context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: return false
            flat.split(":").any {
                it.contains(context.packageName) && it.contains("FitShieldAccessibilityService")
            }
        }.getOrDefault(false)
    }

    /**
     * Open the system Accessibility settings so the user can enable the service.
     *
     * Guarded by [recordAccessibilityConsent]. Google's prominent-disclosure rules
     * for an AccessibilityService require the disclosure to appear in the app
     * itself, before the request, and to be accepted by an affirmative action —
     * not a dialog the user can swipe away, and not a line in a privacy policy.
     * This screen used to open the moment the button was tapped, with the
     * explanation sitting elsewhere on the page, which satisfies none of that.
     *
     * The gate lives here rather than only in the WebView so that a UI change can
     * never route around it: without a recorded consent this does nothing.
     */
    @JavascriptInterface
    fun openAccessibilitySettings() {
        if (!accessibilityConsentGiven()) return
        activity.runOnUiThread {
            runCatching {
                activity.startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
    }

    /** True once the user has accepted the in-app disclosure. */
    @JavascriptInterface
    fun accessibilityConsentGiven(): Boolean =
        prefs.getString(ACCESSIBILITY_CONSENT_KEY, null)?.trim()?.trim('"').isNullOrEmpty().not()

    /**
     * Record the user's affirmative acceptance of the accessibility disclosure.
     * Stored as the ISO timestamp of the acceptance so it is auditable rather
     * than a bare boolean somebody could have flipped by accident.
     */
    @JavascriptInterface
    fun recordAccessibilityConsent() {
        prefs.edit()
            .putString(ACCESSIBILITY_CONSENT_KEY, "\"${java.time.Instant.now()}\"")
            .apply()
    }

    /** Withdraw it, so the disclosure is shown again next time. */
    @JavascriptInterface
    fun clearAccessibilityConsent() {
        prefs.edit().remove(ACCESSIBILITY_CONSENT_KEY).apply()
    }

    /**
     * True when this app may actually post notifications.
     *
     * POST_NOTIFICATIONS is a runtime grant on Android 13+, and it was declared
     * and never requested — so it was denied on every modern device. The ongoing
     * foreground notice going missing is cosmetic; the "protection is off after
     * your restart" notice going missing is not, so the dashboard needs to be
     * able to say when it cannot appear.
     */
    @JavascriptInterface
    fun notificationsEnabled(): Boolean = runCatching {
        androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
    }.getOrDefault(true)

    /** Open this app's notification settings. */
    @JavascriptInterface
    fun openNotificationSettings() {
        activity.runOnUiThread {
            runCatching {
                activity.startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }.onFailure {
                runCatching {
                    activity.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }
            }
        }
    }

    /** True when "display over other apps" is granted (makes the block screen
     *  launch reliably over a blocked app). Optional; blocking works without it. */
    @JavascriptInterface
    fun overlayEnabled(): Boolean = runCatching { Settings.canDrawOverlays(context) }.getOrDefault(false)

    /** Open the "display over other apps" permission screen for this app. */
    @JavascriptInterface
    fun openOverlaySettings() {
        activity.runOnUiThread {
            runCatching {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }.onFailure {
                // Fallback: some OEMs reject the package-scoped intent — open the list.
                runCatching {
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
        }
    }

    /** True when the local VPN (SNI/DNS site blocking) is running. */
    @JavascriptInterface
    fun vpnEnabled(): Boolean = FitShieldVpnService.isRunning

    /** Number of Android app packages FitShield can block (from the generated set). */
    @JavascriptInterface
    fun appPackageCount(): Int = packages.size

    /** The distinct blockable brands (for per-app toggles): [{brandId, displayName, category}]. */
    @JavascriptInterface
    fun blockableApps(): String = runCatching {
        val seen = HashSet<String>()
        val out = JSONArray()
        packages.brands().forEach { brand ->
            if (brand.brandId.isEmpty() || !seen.add(brand.brandId)) return@forEach
            out.put(JSONObject()
                .put("brandId", brand.brandId)
                .put("displayName", brand.displayName)
                .put("category", brand.category))
        }
        out.toString()
    }.getOrDefault("[]")

    // ---- optional "background protection" keep-alive (opt-in, off by default) --

    /** True when the opt-in background keep-alive service is enabled. */
    @JavascriptInterface
    fun keepAliveEnabled(): Boolean = prefs.getString("keepAliveEnabled", null)?.trim('"') == "true"

    /** Enable/disable the background keep-alive foreground service and persist it. */
    @JavascriptInterface
    fun setKeepAlive(on: Boolean) {
        prefs.edit().putString("keepAliveEnabled", on.toString()).apply()
        activity.runOnUiThread {
            runCatching {
                if (on) AppBlockKeepAliveService.start(context) else AppBlockKeepAliveService.stop(context)
            }
        }
    }

    /** True when the user has exempted FitShield from battery optimization.
     *  Read-only; needs no permission. */
    @JavascriptInterface
    fun batteryUnrestricted(): Boolean = runCatching {
        val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        pm.isIgnoringBatteryOptimizations(context.packageName)
    }.getOrDefault(false)

    /** Open the battery-optimization settings so the user can set FitShield to
     *  unrestricted. Uses the permission-free settings list (never the one-tap
     *  ACTION_REQUEST_… dialog, which would require an extra permission). */
    @JavascriptInterface
    fun openBatterySettings() {
        activity.runOnUiThread {
            runCatching {
                activity.startActivity(
                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }.onFailure {
                runCatching {
                    activity.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }
            }
        }
    }

    @JavascriptInterface
    fun openUrl(url: String) {
        activity.runOnUiThread {
            runCatching {
                activity.startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
    }

    // ---- vpn (backs fitshield.vpn) ------------------------------------------

    @JavascriptInterface
    fun vpnIsEnabled(): Boolean = FitShieldVpnService.isRunning

    @JavascriptInterface
    fun vpnEnable() {
        activity.runOnUiThread { (activity as? MainActivity)?.requestVpnEnable() }
    }

    @JavascriptInterface
    fun vpnDisable() {
        context.startService(
            Intent(context, FitShieldVpnService::class.java).setAction(FitShieldVpnService.ACTION_STOP)
        )
    }

    @JavascriptInterface
    fun ruleCount(): Int = engine?.count ?: 0

    /** True when the system has Private DNS (Automatic or a hostname) active.
     *  Read-only, for a neutral UI note explaining that local filtering is
     *  paused; FitShield never changes this setting. */
    @JavascriptInterface
    fun privateDnsActive(): Boolean {
        return runCatching {
            val mode = Settings.Global.getString(context.contentResolver, "private_dns_mode")
            mode != null && mode != "off"
        }.getOrDefault(false)
    }

    /** Convenience domain checker for the in-app tester. Returns the matched
     *  curated apex, or "" when the host is not blocked. Read-only; no side effects. */
    @JavascriptInterface
    fun checkHost(host: String): String = engine?.blockedApex(host) ?: ""

    /** Engine-derived filter metadata (version, host count, countries, categories)
     *  read straight from the generated rules asset. */
    @JavascriptInterface
    fun getRulesMetadata(): String {
        return runCatching {
            val raw = context.assets.open(RuleEngine.ASSET_NAME).use { it.readBytes().toString(Charsets.UTF_8) }
            val asset = JSONObject(raw)
            JSONObject()
                .put("version", asset.optString("appVersion"))
                .put("count", asset.optInt("count"))
                .put("countries", asset.optJSONArray("countries") ?: JSONArray())
                .put("categories", asset.optJSONArray("categories") ?: JSONArray())
                .toString()
        }.getOrDefault("{}")
    }

    /** Export all local settings + stats as a JSON backup via the system share
     *  sheet. Permission-free; nothing is uploaded by FitShield. */
    @JavascriptInterface
    fun exportSettings() {
        val settings = JSONObject()
        prefs.all.forEach { (k, v) ->
            val s = v as? String ?: return@forEach
            settings.put(k, runCatching { JSONObject(s) }.getOrNull()
                ?: runCatching { JSONArray(s) }.getOrNull()
                ?: runCatching { s.toInt() }.getOrNull()
                ?: s)
        }
        val backup = JSONObject()
            .put("_type", "fitshield-settings-backup")
            .put("schema", 1)
            .put("version", getVersion())
            .put("exportedAt", java.time.Instant.now().toString())
            .put("settings", settings)
        activity.runOnUiThread {
            runCatching {
                val send = Intent(Intent.ACTION_SEND).setType("application/json")
                    .putExtra(Intent.EXTRA_TITLE, "fitshield-settings.json")
                    .putExtra(Intent.EXTRA_TEXT, backup.toString(2))
                activity.startActivity(Intent.createChooser(send, "Export FitShield settings"))
            }
        }
    }

    /** Import a JSON backup via the system document picker. The Activity handles
     *  the picker result, merges it into SharedPreferences, and reloads the UI.
     *  Permission-free (Storage Access Framework): no storage permission needed. */
    @JavascriptInterface
    fun importSettings() {
        activity.runOnUiThread { (activity as? MainActivity)?.requestImportSettings() }
    }

    private companion object {
        /** ISO timestamp of the user's acceptance of the accessibility disclosure. */
        const val ACCESSIBILITY_CONSENT_KEY = "accessibilityDisclosureAcceptedAt"
    }
}
