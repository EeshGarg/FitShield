package com.usha.fitshield

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * The one notification FitShield posts that is not the ongoing foreground
 * notice: "protection is off, tap to turn it back on".
 *
 * It exists for the case the OS will not let us fix by ourselves. After a
 * restart FitShield tries to bring the tunnel back silently, and can only do
 * that while Android still holds the user's VPN consent. When it does not, the
 * honest options are a notification or silence — and silence is how a blocker
 * gets uninstalled: the user believes they are protected, orders anyway, and
 * only finds out afterwards that nothing had been running since the reboot.
 *
 * It is never posted for a user who turned FitShield off (see [BootRestore]),
 * it auto-cancels on tap, and it is cancelled the moment the tunnel comes up.
 */
internal object RestoreNotice {

    const val CHANNEL_ID = "fitshield_restore"

    /**
     * 3, not 2. AppBlockKeepAliveService holds 2 as its FOREGROUND notification,
     * so the two collided in both directions: posting this notice replaced the
     * keep-alive's ongoing notification, and [dismiss] cancelled it outright —
     * cancelling the notification a foreground service is running on. The notice
     * itself fared no better, since the keep-alive re-posts id 2 on every start
     * and would erase the one prompt telling the user their protection did not
     * come back after a reboot.
     *
     * KEEP DISTINCT: 1 = FitShieldVpnService, 2 = AppBlockKeepAliveService,
     * 3 = this. test/android-controls.test.js fails if two of them ever match.
     */
    const val NOTIF_ID = 3

    /** Extra on the tap intent: MainActivity runs the enable flow when set. */
    const val EXTRA_RESTORE_VPN = "com.usha.fitshield.RESTORE_VPN"

    fun post(context: Context, afterReboot: Boolean = true) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Protection stopped",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).also {
                    it.description = "Tells you when site blocking is off after a restart."
                }
            )
        }
        val tap = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .putExtra(EXTRA_RESTORE_VPN, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = android.app.Notification.Builder(context, CHANNEL_ID)
            .setContentTitle("FitShield site blocking is off")
            .setContentText(BootRestore.noticeText(afterReboot))
            .setStyle(
                android.app.Notification.BigTextStyle().bigText(BootRestore.noticeBigText(afterReboot))
            )
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()

        // POST_NOTIFICATIONS is a runtime permission on Android 13+. If the user
        // declined it, notify() is a no-op — nothing here can force it.
        runCatching { manager.notify(NOTIF_ID, notification) }
    }

    fun clear(context: Context) {
        runCatching {
            context.getSystemService(NotificationManager::class.java)?.cancel(NOTIF_ID)
        }
    }
}
