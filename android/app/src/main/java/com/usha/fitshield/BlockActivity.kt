package com.usha.fitshield

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject

/**
 * The native FitShield intervention screen, shown by [FitShieldAccessibilityService]
 * when a blocked food-delivery / fast-food app is opened. It hosts the SAME web
 * UI stack as the rest of the app (glass design system, i18n, currency, recipes,
 * ambient background) via a WebView, so it mirrors the browser extension's block
 * page. The block-specific bridge is exposed as `AndroidBlock`.
 */
class BlockActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @Volatile private var brandId: String = ""
    @Volatile private var displayName: String = ""
    @Volatile private var category: String = ""
    @Volatile private var packageId: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        readExtras(intent)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        WebView.setWebContentsDebuggingEnabled(true)
        webView = WebView(this)
        setContentView(webView)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("FitShieldWeb", "${m.messageLevel()} ${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }
        webView.addJavascriptInterface(WebAppBridge(this), "Android")
        webView.addJavascriptInterface(BlockBridge(), "AndroidBlock")
        webView.loadUrl("https://appassets.androidplatform.net/assets/web/block.html")
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        readExtras(intent)
        runCatching { webView.reload() }
    }

    private fun readExtras(intent: Intent?) {
        brandId = intent?.getStringExtra(EXTRA_BRAND_ID) ?: ""
        displayName = intent?.getStringExtra(EXTRA_DISPLAY_NAME) ?: ""
        category = intent?.getStringExtra(EXTRA_CATEGORY) ?: ""
        packageId = intent?.getStringExtra(EXTRA_PACKAGE_ID) ?: ""
    }

    /** Back button = "Not now": leave to the launcher, never back into the app. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        goHome()
    }

    private fun goHome() {
        recordSkip()   // leaving the pause without opening the app = an avoided order
        runCatching {
            startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        finish()
    }

    // Record an avoided app open (only when the user actually skips — never on
    // "Open anyway"). Contributes to blocked visits, calories, and the private
    // "most blocked apps" breakdown, keyed by display name.
    @Volatile private var recorded = false
    private fun recordSkip() {
        if (recorded) return
        recorded = true
        val prefs = getSharedPreferences("fitshield", MODE_PRIVATE)
        synchronized(prefs) {
            val visits = (prefs.getString("blockedVisits", "0")?.trim('"')?.toIntOrNull() ?: 0) + 1
            val byApp = try { JSONObject(prefs.getString("blockedByApp", "{}") ?: "{}") } catch (e: Exception) { JSONObject() }
            val label = displayName.ifEmpty { brandId }
            byApp.put(label, byApp.optInt(label, 0) + 1)
            val editor = prefs.edit()
                .putString("blockedVisits", visits.toString())
                .putString("blockedByApp", byApp.toString())
            val mealCal = prefs.getString("avgMealCalories", null)?.trim('"')?.toDoubleOrNull()?.toInt() ?: 0
            if (mealCal > 0) {
                val cal = (prefs.getString("caloriesAvoided", "0")?.trim('"')?.toIntOrNull() ?: 0) + mealCal
                editor.putString("caloriesAvoided", cal.toString())
            }
            editor.apply()
        }
    }

    // ---- bridge exposed to block.js as `AndroidBlock` -----------------------

    inner class BlockBridge {
        @JavascriptInterface
        fun getInfo(): String = JSONObject()
            .put("brandId", brandId)
            .put("displayName", displayName)
            .put("category", category)
            .put("packageId", packageId)
            .put("unlockMinutes", AppBlockPolicy.unlockMinutes(this@BlockActivity))
            .put("timerSeconds", timerSeconds())
            .toString()

        /** "Open anyway": grant a temporary unlock and open the app. */
        @JavascriptInterface
        fun unlock(minutes: Int) {
            AppBlockPolicy.unlock(this@BlockActivity, brandId, minutes)
            runOnUiThread {
                // The blocked app was sent to the background before this screen
                // was shown, so re-open it explicitly rather than relying on it
                // sitting behind us. The temporary unlock keeps the service from
                // immediately re-blocking it.
                val launch = runCatching { packageManager.getLaunchIntentForPackage(packageId) }.getOrNull()
                if (launch != null) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { startActivity(launch) }
                }
                finish()
            }
        }

        /** "Not now": go to the home screen. */
        @JavascriptInterface
        fun leave() {
            runOnUiThread { goHome() }
        }

        /** Open the FitShield dashboard. */
        @JavascriptInterface
        fun openFitShield() {
            runOnUiThread {
                runCatching {
                    startActivity(Intent(this@BlockActivity, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                finish()
            }
        }
    }

    private fun timerSeconds(): Int {
        val raw = getSharedPreferences("fitshield", MODE_PRIVATE)
            .getString("timerSeconds", null)?.trim('"')
        return (raw?.toDoubleOrNull()?.toInt() ?: 15).coerceIn(0, 300)
    }

    companion object {
        const val EXTRA_BRAND_ID = "brandId"
        const val EXTRA_DISPLAY_NAME = "displayName"
        const val EXTRA_CATEGORY = "category"
        const val EXTRA_PACKAGE_ID = "packageId"
    }
}
