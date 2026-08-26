package com.usha.fitshield

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hosts the FitShield web UI in a WebView. The UI is the SAME web codebase used
 * by the browser extension; it talks to the host through fitshield.* implemented
 * by android-shim.js over the [WebAppBridge] (exposed as `Android`).
 *
 * Assets are served from https://appassets.androidplatform.net/assets/... via
 * WebViewAssetLoader so fetch() of the bundled _locales works under a normal
 * https origin (file:// fetch is blocked in modern WebView).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge: draw the app gradient behind the status/nav bars and make
        // both transparent (One UI weather style). Content is kept clear of the
        // bars by CSS safe-area insets in the WebView (viewport-fit=cover).
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        // Debug builds only: allow chrome://inspect remote WebView debugging so
        // the UI is inspectable during development. Never enabled in release.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        webView = WebView(this)
        webView.setBackgroundColor(Color.TRANSPARENT)   // let the app gradient show behind the bars
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) Log.d("FitShieldWeb", "${m.messageLevel()} ${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }
        webView.addJavascriptInterface(WebAppBridge(this), "Android")
        webView.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")

        handleRestoreRequest(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleRestoreRequest(intent)
    }

    /**
     * The "protection is off after your restart" notification was tapped. The
     * consent dialog can only be raised from an Activity, which is the whole
     * reason that notification exists — so raise it now.
     */
    private fun handleRestoreRequest(intent: Intent?) {
        if (intent?.getBooleanExtra(RestoreNotice.EXTRA_RESTORE_VPN, false) != true) return
        intent.removeExtra(RestoreNotice.EXTRA_RESTORE_VPN)   // one tap, one dialog
        RestoreNotice.clear(this)
        requestVpnEnable()
    }

    /**
     * Called from the bridge when the user taps Enable.
     *
     * Notification permission comes FIRST, and this is not cosmetic. On Android
     * 13+ POST_NOTIFICATIONS is a runtime grant, and it was declared in the
     * manifest and never requested — so it was denied, always. Losing the ongoing
     * foreground notice would only be untidy; losing the "protection is off after
     * your restart" notice is the difference between a user being told and a user
     * finding out by ordering. That notice is posted into the void without this.
     *
     * The system dialog is asked for once and never nagged: if the user declines,
     * [WebAppBridge.notificationsEnabled] reports it and the dashboard explains
     * what stops working, with a link to the system setting.
     */
    fun requestVpnEnable() {
        if (requestNotificationPermission()) return   // resumed from onRequestPermissionsResult
        continueVpnEnable()
    }

    /**
     * @return true when a permission dialog was raised and the VPN flow should
     *   wait for its answer.
     */
    private fun requestNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        val permission = android.Manifest.permission.POST_NOTIFICATIONS
        if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) return false
        // Android shows this dialog once; after a denial the call is a silent
        // no-op and onRequestPermissionsResult still fires, so the VPN flow
        // continues either way and the user is never asked twice by us.
        return runCatching {
            ActivityCompat.requestPermissions(this, arrayOf(permission), REQUEST_NOTIFICATIONS)
            true
        }.getOrDefault(false)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Granted or not, the user asked for protection — carry on and let the
        // dashboard say what a denial costs.
        if (requestCode == REQUEST_NOTIFICATIONS) continueVpnEnable()
    }

    private fun continueVpnEnable() {
        val consent = VpnService.prepare(this)
        if (consent != null) {
            startActivityForResult(consent, REQUEST_VPN)
        } else {
            startVpn()
        }
    }

    /** Called from the bridge when the user taps Import: open a JSON document. */
    fun requestImportSettings() {
        val pick = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "text/*"))
        runCatching { startActivityForResult(pick, REQUEST_IMPORT) }
            .onFailure { toast("No file picker available") }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_VPN && resultCode == Activity.RESULT_OK) {
            startVpn()
        } else if (requestCode == REQUEST_IMPORT && resultCode == Activity.RESULT_OK) {
            data?.data?.let { importSettingsFrom(it) }
        }
    }

    /** Read a FitShield JSON backup and merge its settings into the SAME
     *  SharedPreferences the web UI + VpnService use, then reload the UI. Values
     *  are stored in the JSON-encoded string form the web shim expects. */
    private fun importSettingsFrom(uri: Uri) {
        val result = runCatching {
            val text = contentResolver.openInputStream(uri)?.use {
                it.readBytes().toString(Charsets.UTF_8)
            } ?: throw IllegalStateException("empty")

            val backup = JSONObject(text)
            require(backup.optString("_type") == "fitshield-settings-backup") { "not a FitShield backup" }
            val settings = backup.optJSONObject("settings") ?: throw IllegalStateException("no settings")

            val prefs = getSharedPreferences("fitshield", Context.MODE_PRIVATE)
            val editor = prefs.edit()
            var applied = 0
            val keys = settings.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                editor.putString(key, encodeForStore(settings.get(key)))
                applied++
            }
            editor.apply()
            applied
        }

        result.onSuccess { count ->
            toast("Imported $count settings")
            webView.reload()
        }.onFailure {
            Log.w("FitShieldWeb", "Import failed", it)
            toast("Import failed — not a valid FitShield backup")
        }
    }

    // Reproduce the JSON.stringify form the web shim stores (android-shim.js
    // JSON.parses every value): objects/arrays serialize compactly, string
    // values already carry their JSON quotes from export, numbers/bools stringify.
    private fun encodeForStore(value: Any?): String = when (value) {
        is JSONObject -> value.toString()
        is JSONArray -> value.toString()
        is String -> value
        is Boolean -> value.toString()
        is Int -> value.toString()
        is Long -> value.toString()
        is Double -> if (!value.isInfinite() && value == Math.floor(value)) value.toLong().toString() else value.toString()
        else -> value.toString()
    }

    private fun toast(message: String) {
        runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_SHORT).show() }
    }

    private fun startVpn() {
        ContextCompat.startForegroundService(
            this,
            Intent(this, FitShieldVpnService::class.java).setAction(FitShieldVpnService.ACTION_START)
        )
    }

    companion object {
        private const val REQUEST_VPN = 1001
        private const val REQUEST_IMPORT = 1002
        private const val REQUEST_NOTIFICATIONS = 1003
    }
}
