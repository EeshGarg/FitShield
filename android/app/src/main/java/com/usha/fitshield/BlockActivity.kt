package com.usha.fitshield

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
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
    // Curated food metadata (see PackageBlocklist.Brand). Distinct from `category`,
    // which is the coarse app grouping the Settings pills switch on.
    @Volatile private var foodCategory: String = ""
    @Volatile private var foodType: String = ""
    @Volatile private var specialties: List<String> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge: draw the block screen's gradient behind the status/nav
        // bars and make both transparent (One UI weather style). Content clears
        // the bars via CSS safe-area insets (block.html sets viewport-fit=cover).
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        readExtras(intent)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        webView = WebView(this)
        webView.setBackgroundColor(Color.TRANSPARENT)   // let the app gradient show behind the bars
        setContentView(webView)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) Log.d("FitShieldWeb", "${m.messageLevel()} ${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }
        webView.addJavascriptInterface(WebAppBridge(this), "Android")
        webView.addJavascriptInterface(BlockBridge(), "AndroidBlock")

        // The interruption happened the moment this screen appeared. Recording it
        // here rather than on the way out is the difference between a counter
        // that means "ordering pages interrupted" — which is what the tile now
        // says — and one that quietly means "times you gave up", which is what it
        // used to be: it incremented only inside the skip path, so tapping
        // "Open anyway" erased the interruption from the user's own record, in
        // the flattering direction.
        //
        // Only for a genuinely NEW instance. This activity declares no
        // configChanges, so a rotation destroys and recreates it, and counting
        // in onCreate unconditionally would score one pause twice for anyone who
        // turns their phone. A non-null savedInstanceState is the system telling
        // us this is a recreation of a pause already counted.
        if (savedInstanceState == null) recordInterruption()

        webView.loadUrl("https://appassets.androidplatform.net/assets/web/block.html")
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        readExtras(intent)
        // A reused activity is still a fresh pause over a fresh app open, so the
        // once-only latch reopens with the new extras.
        recorded = false
        recordInterruption()
        runCatching { webView.reload() }
    }

    private fun readExtras(intent: Intent?) {
        brandId = intent?.getStringExtra(EXTRA_BRAND_ID) ?: ""
        displayName = intent?.getStringExtra(EXTRA_DISPLAY_NAME) ?: ""
        category = intent?.getStringExtra(EXTRA_CATEGORY) ?: ""
        packageId = intent?.getStringExtra(EXTRA_PACKAGE_ID) ?: ""
        foodCategory = intent?.getStringExtra(EXTRA_FOOD_CATEGORY) ?: ""
        foodType = intent?.getStringExtra(EXTRA_FOOD_TYPE) ?: ""
        specialties = intent?.getStringArrayListExtra(EXTRA_SPECIALTIES)?.toList() ?: emptyList()
    }

    /** Back button = "Not now": leave to the launcher, never back into the app. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        goHome()
    }

    private fun goHome() {
        runCatching {
            startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        finish()
    }

    /**
     * Record that a blocked app open was interrupted, once per pause.
     *
     * Two things this deliberately does NOT do.
     *
     * It does not wait to see what the user chooses. The pause is the observed
     * event; whether they walk away or push through is a different question, and
     * this app has no counter for it. Counting only the walk-aways, which is what
     * the previous `recordSkip()` did, made the one number on the screen
     * under-report every time the user did the thing FitShield was trying to
     * interrupt.
     *
     * And it no longer adds an assumed per-meal calorie figure to
     * `caloriesAvoided`. No calorie was ever measured here — a pause is not a
     * meal, and a meal is not a number this app can see. Values already stored
     * are left untouched; the user's own "Reset statistics & estimates" is the
     * only thing that clears them.
     */
    @Volatile private var recorded = false
    private fun recordInterruption() {
        if (recorded) return
        recorded = true
        val prefs = getSharedPreferences("fitshield", MODE_PRIVATE)
        synchronized(prefs) {
            val visits = (prefs.getString("blockedVisits", "0")?.trim('"')?.toIntOrNull() ?: 0) + 1
            val byApp = try { JSONObject(prefs.getString("blockedByApp", "{}") ?: "{}") } catch (e: Exception) { JSONObject() }
            val label = displayName.ifEmpty { brandId }
            byApp.put(label, byApp.optInt(label, 0) + 1)
            prefs.edit()
                .putString("blockedVisits", visits.toString())
                .putString("blockedByApp", byApp.toString())
                .apply()
        }
    }

    // ---- bridge exposed to block.js as `AndroidBlock` -----------------------

    inner class BlockBridge {
        /**
         * Everything block.js reads off `meta`. Every key here is consumed by
         * android/app/src/main/assets/web/block.js, and every `meta.*` block.js
         * reads is a key here — test/android-block.test.js asserts that contract
         * in both directions, because the two halves are in different languages
         * and nothing else can see across the bridge.
         *
         * It used to stop at `category` (the app grouping), so `meta.type` and
         * `meta.specialties` were `undefined` on every real device while the test
         * suite fed the selector blocklist entries and reported the fix working.
         */
        @JavascriptInterface
        fun getInfo(): String = JSONObject()
            .put("brandId", brandId)
            .put("displayName", displayName)
            .put("category", category)
            .put("foodCategory", foodCategory)
            .put("foodType", foodType)
            .put("specialties", org.json.JSONArray(specialties))
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
        // Default 60s to match the extension's reflection timer and the value the
        // dashboard shows when the user hasn't customized it.
        return (raw?.toDoubleOrNull()?.toInt() ?: 60).coerceIn(0, 300)
    }

    companion object {
        const val EXTRA_BRAND_ID = "brandId"
        const val EXTRA_DISPLAY_NAME = "displayName"
        const val EXTRA_CATEGORY = "category"
        const val EXTRA_PACKAGE_ID = "packageId"
        const val EXTRA_FOOD_CATEGORY = "foodCategory"
        const val EXTRA_FOOD_TYPE = "foodType"
        const val EXTRA_SPECIALTIES = "specialties"
    }
}
