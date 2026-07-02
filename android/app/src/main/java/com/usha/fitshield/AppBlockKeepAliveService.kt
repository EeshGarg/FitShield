package com.usha.fitshield

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * Optional "background protection" foreground service — OFF by default, opt-in
 * from the app-blocking panel.
 *
 * It does no work and reads nothing. It exists only to run a quiet, low-importance
 * ongoing notification so that aggressive OEM battery managers keep the app
 * process resident and the [FitShieldAccessibilityService] responsive after long
 * idle periods. App blocking itself is done entirely by the accessibility service
 * (which is already system-bound and self-recovering) — this is belt-and-suspenders
 * for devices that freeze idle apps.
 *
 * START_STICKY so the system re-creates the service (and the process) if it is
 * killed, keeping the process warm.
 */
class AppBlockKeepAliveService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification())
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        val channelId = "fitshield_keepalive"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(channelId, "App blocking", NotificationManager.IMPORTANCE_MIN)
                    .apply { setShowBadge(false) }
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, channelId)
            .setContentTitle("FitShield app blocking is active")
            .setContentText("Keeping the mindful pause ready in the background.")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val NOTIF_ID = 2   // FitShieldVpnService uses 1

        fun start(context: Context) {
            val i = Intent(context, AppBlockKeepAliveService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
            else context.startService(i)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AppBlockKeepAliveService::class.java))
        }
    }
}
