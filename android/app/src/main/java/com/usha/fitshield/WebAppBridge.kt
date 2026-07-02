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

    // ---- storage (backs fitshield.storage) ----------------------------------

    @JavascriptInterface
    fun storageGet(key: String): String? = prefs.getString(key, null)

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

    /** Open the system Accessibility settings so the user can enable the service. */
    @JavascriptInterface
    fun openAccessibilitySettings() {
        activity.runOnUiThread {
            runCatching {
                activity.startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
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
    fun appPackageCount(): Int = runCatching {
        val raw = context.assets.open("android-packages.json").use {
            it.readBytes().toString(Charsets.UTF_8)
        }
        JSONObject(raw).optJSONObject("counts")?.optInt("packages") ?: 0
    }.getOrDefault(0)

    /** The distinct blockable brands (for per-app toggles): [{brandId, displayName, category}]. */
    @JavascriptInterface
    fun blockableApps(): String = runCatching {
        val raw = context.assets.open("android-packages.json").use {
            it.readBytes().toString(Charsets.UTF_8)
        }
        val packages = JSONObject(raw).optJSONObject("packages") ?: JSONObject()
        val seen = HashSet<String>()
        val out = JSONArray()
        val keys = packages.keys()
        while (keys.hasNext()) {
            val meta = packages.optJSONObject(keys.next()) ?: continue
            val brandId = meta.optString("brandId")
            if (brandId.isEmpty() || !seen.add(brandId)) continue
            out.put(JSONObject()
                .put("brandId", brandId)
                .put("displayName", meta.optString("displayName", brandId))
                .put("category", meta.optString("category", "")))
        }
        out.toString()
    }.getOrDefault("[]")

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
}
