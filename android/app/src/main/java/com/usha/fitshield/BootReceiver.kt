package com.usha.fitshield

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Brings FitShield's connection filter back after the device restarts — and only
 * for a user who had it running.
 *
 * The gap this closes: a user turned FitShield on, their phone restarted
 * overnight, and in the morning nothing was blocked and nothing had said so.
 * For a blocker whose whole promise is being there while you are not thinking
 * about it, that is not a design choice a user would recognise.
 *
 * The decision itself is [BootRestore.decide] — a pure function, so the rule
 * that matters ("never turn protection on for someone who turned it off") is
 * executed by the test suite rather than trusted. This class is the thin adapter
 * that reads the stored instruction, asks Android whether consent is still held,
 * and carries out the answer.
 *
 * Registered for exactly two protected system broadcasts, both of which stop the
 * VpnService without the user asking:
 *  - BOOT_COMPLETED    — the device restarted
 *  - MY_PACKAGE_REPLACED — FitShield itself was updated
 * Both are on Android's exemption list for starting a foreground service from
 * the background, which is what makes the silent restore legal at all.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        // Both destroy the service without the user asking, but they are not the
        // same event and the notice must not claim the phone rebooted when it did not.
        val afterReboot = action == Intent.ACTION_BOOT_COMPLETED

        val prefs = context.getSharedPreferences("fitshield", Context.MODE_PRIVATE)
        val stored = runCatching { prefs.getString(VpnIntent.KEY, null) }.getOrNull()

        // VpnService.prepare() returns null when this package already holds the
        // user's consent (Android persists that grant across reboots as an app-op).
        // A non-null Intent means the consent dialog would have to be shown, and a
        // broadcast receiver cannot show one.
        val consentHeld = runCatching { VpnService.prepare(context) == null }.getOrDefault(false)

        when (BootRestore.decide(stored, consentHeld)) {
            BootRestore.Action.NOTHING -> Unit

            BootRestore.Action.START_TUNNEL -> runCatching {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, FitShieldVpnService::class.java)
                        .setAction(FitShieldVpnService.ACTION_BOOT_RESTORE)
                )
            }.onFailure {
                // The start itself was refused (OEM policy, restricted bucket).
                // Say so rather than leaving the user believing they are covered.
                Log.w(TAG, "boot restore could not start the service")
                RestoreNotice.post(context, afterReboot)
            }

            BootRestore.Action.ASK_TO_RESTORE -> RestoreNotice.post(context, afterReboot)
        }
    }

    private companion object {
        const val TAG = "FitShieldBoot"
    }
}
