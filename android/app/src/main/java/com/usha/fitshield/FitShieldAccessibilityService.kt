package com.usha.fitshield

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * App-blocking AccessibilityService. Detects when a blocked food-delivery /
 * fast-food app comes to the foreground and shows the FitShield [BlockActivity]
 * intervention — the native counterpart of the browser extension's block page.
 *
 * Privacy: it only reads the foreground package name from window-state-changed
 * events (see res/xml/accessibility_service_config.xml, canRetrieveWindowContent
 * = false). It never reads screen content, and NEVER logs the package name.
 *
 * This runs ALONGSIDE the VPN/SNI network blocker — the VPN handles websites and
 * network traffic; this handles launching native apps. They are independent.
 */
class FitShieldAccessibilityService : AccessibilityService() {

    private var matcher: PackageBlocklist? = null
    private val self by lazy { packageName }
    private val handler = Handler(Looper.getMainLooper())

    // Loop/duplication guards: don't re-launch the block screen for the same app
    // within the cooldown, and never react to our own windows.
    private var lastPkg: String? = null
    private var lastAt = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        matcher = PackageBlocklist.fromAssets(this)
        Log.i(TAG, "app-blocking active (${matcher?.size ?: 0} packages)")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg.isEmpty() || pkg == self) return                 // never react to our own UI (loop guard)

        // Cheap opt-out before any matching work.
        if (!AppBlockPolicy.isEnabled(this)) return

        val brand = matcher?.match(pkg) ?: run {
            // Foreground app is not blocked — reset the guard so a later relaunch
            // of a blocked app is handled promptly.
            lastPkg = null
            return
        }

        if (!AppBlockPolicy.shouldBlock(this, brand)) return      // disabled category / schedule / temp unlock

        val now = SystemClock.uptimeMillis()
        if (pkg == lastPkg && now - lastAt < COOLDOWN_MS) return  // debounce repeat window events
        lastPkg = pkg
        lastAt = now

        intervene(brand)
    }

    private fun intervene(brand: PackageBlocklist.Brand) {
        // A blocked app that is already running re-launches its OWN activity
        // (BAL_ALLOW_FOREGROUND) the instant we cover it, burying a block screen
        // we start over it — so the screen just flashes and vanishes. First send
        // the blocked app to the background (home): a backgrounded app can't win
        // the foreground race. Then show the block screen over the launcher.
        // BlockActivity re-opens the app itself if the user taps "Open anyway".
        performGlobalAction(GLOBAL_ACTION_HOME)

        val intent = Intent(this, BlockActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            .putExtra(BlockActivity.EXTRA_BRAND_ID, brand.brandId)
            .putExtra(BlockActivity.EXTRA_DISPLAY_NAME, brand.displayName)
            .putExtra(BlockActivity.EXTRA_CATEGORY, brand.category)
            .putExtra(BlockActivity.EXTRA_PACKAGE_ID, brand.packageId)
        // Let the home transition settle first, otherwise the block screen can
        // land beneath the launcher mid-transition.
        handler.postDelayed({
            runCatching { startActivity(intent) }
                .onFailure { Log.w(TAG, "could not show block screen") }
        }, LAUNCH_DELAY_MS)
    }

    override fun onInterrupt() {}

    companion object {
        private const val TAG = "FitShieldA11y"
        private const val COOLDOWN_MS = 1500L
        private const val LAUNCH_DELAY_MS = 300L   // let the home transition settle
    }
}
