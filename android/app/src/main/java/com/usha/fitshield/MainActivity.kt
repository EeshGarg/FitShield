package com.usha.fitshield

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Minimal UI — PREVIEW / TEST QUALITY.
 *
 * Enable/disable the local DNS-filtering service. Enabling triggers the system
 * VPN-consent dialog; disabling stops the service cleanly. Shows how many
 * engine-derived hosts are loaded so it is obvious the rules came from the
 * canonical generated asset, not a hand-maintained list.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var status: TextView
    private lateinit var toggle: Button
    private var ruleCount = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        status = findViewById(R.id.status)
        toggle = findViewById(R.id.toggle)
        ruleCount = runCatching { RuleEngine.fromAssets(this).count }.getOrDefault(0)

        toggle.setOnClickListener {
            if (FitShieldVpnService.isRunning) disable() else enable()
        }
        render()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun enable() {
        val consent = VpnService.prepare(this)
        if (consent != null) {
            startActivityForResult(consent, REQUEST_VPN)
        } else {
            onConsented()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_VPN && resultCode == Activity.RESULT_OK) {
            onConsented()
        }
    }

    private fun onConsented() {
        ContextCompat.startForegroundService(
            this,
            Intent(this, FitShieldVpnService::class.java).setAction(FitShieldVpnService.ACTION_START)
        )
        render()
    }

    private fun disable() {
        startService(
            Intent(this, FitShieldVpnService::class.java).setAction(FitShieldVpnService.ACTION_STOP)
        )
        render()
    }

    private fun render() {
        if (FitShieldVpnService.isRunning) {
            status.text = getString(R.string.status_running)
            toggle.text = getString(R.string.disable)
        } else {
            status.text = getString(R.string.status_ready, ruleCount)
            toggle.text = getString(R.string.enable)
        }
    }

    companion object {
        private const val REQUEST_VPN = 1001
    }
}
