package com.usha.fitshield

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.provider.Settings
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramSocket
import java.net.Socket

/**
 * Local connection-filtering VpnService — PREVIEW / TEST QUALITY.
 *
 * FitShield blocks food-delivery / fast-food connections by the destination host
 * the client sends in the clear (TLS SNI on 443, HTTP Host on 80), NOT by DNS.
 * This is what makes blocking work even under strict Private DNS / NextDNS, where
 * all DNS is encrypted and never reaches us. The actual packet handling lives in
 * [Tun2Filter]; this service owns the tunnel lifecycle, notification and stats.
 *
 * What it is NOT: not a commercial VPN, no tunnelling of traffic to any FitShield
 * server, no HTTPS interception, no decryption, no certificates, no MITM, no
 * content inspection, no telemetry. DNS is never intercepted or altered — the
 * system resolver / Private DNS keeps working exactly as configured. Allowed
 * connections are relayed byte-for-byte to the same IP the client chose. See
 * docs/ANDROID.md.
 *
 * The service also owns the user's standing instruction ([VpnIntent.KEY]): it is
 * the only place that can know whether the tunnel went down because the user
 * asked or because the OS took it away. [BootReceiver] reads it after a restart.
 */
class FitShieldVpnService : VpnService() {

    private var tunnel: ParcelFileDescriptor? = null
    private var worker: Thread? = null
    private var filter: Tun2Filter? = null
    @Volatile private var active = false
    private lateinit var rules: RuleEngine

    // Local, on-device stats — written to the SAME SharedPreferences the web UI
    // reads through android-shim.js (fitshield.storage). Values are JSON-encoded
    // strings so they round-trip with the shim. A short per-apex dedupe avoids
    // over-counting the many connections a single page triggers.
    private val prefs by lazy { getSharedPreferences("fitshield", Context.MODE_PRIVATE) }
    private val lastBlocked = HashMap<String, Long>()

    private fun readObj(key: String): JSONObject = try {
        JSONObject(prefs.getString(key, "{}") ?: "{}")
    } catch (e: Exception) {
        JSONObject()
    }

    private fun recordBlock(apex: String) {
        val now = System.currentTimeMillis()
        synchronized(lastBlocked) {
            if (now - (lastBlocked[apex] ?: 0L) < DEDUPE_MS) return
            lastBlocked[apex] = now
        }
        synchronized(prefs) {
            val visits = (prefs.getString("blockedVisits", "0")?.toIntOrNull() ?: 0) + 1
            val byDomain = readObj("blockedByDomain")
            byDomain.put(apex, byDomain.optInt(apex, 0) + 1)

            // Same private breakdown the extension keeps (curated brand metadata
            // only): most-blocked category (excluding the delivery/fast_food/custom
            // buckets) and primary operating country. Every one of these is a
            // count of something this service observed.
            val meta = rules.metaFor(apex)
            val editor = prefs.edit()
                .putString("blockedVisits", visits.toString())
                .putString("blockedByDomain", byDomain.toString())

            val category = meta?.category ?: ""
            if (category.isNotEmpty() && category != "delivery" && category != "fast_food" && category != "custom") {
                val byCategory = readObj("blockedByCategory")
                byCategory.put(category, byCategory.optInt(category, 0) + 1)
                editor.putString("blockedByCategory", byCategory.toString())
            }

            val country = meta?.country ?: ""
            if (country.isNotEmpty()) {
                val byCountry = readObj("blockedByCountry")
                byCountry.put(country, byCountry.optInt(country, 0) + 1)
                editor.putString("blockedByCountry", byCountry.toString())
            }

            // Nothing adds to `caloriesAvoided` any more. It used to gain an
            // assumed per-meal figure on every block, which made a number nobody
            // measured grow forever and put it on the home screen as an outcome.
            // Any value already on the device is left exactly where it is — see
            // the STATS reset list in app.js — but no more are manufactured.

            editor.apply()
        }
    }

    override fun onCreate() {
        super.onCreate()
        rules = RuleEngine.fromAssets(this)
        Log.i(TAG, "Loaded ${rules.count} blockable hosts from the generated asset")
    }

    /**
     * Persist (or deliberately leave alone) the user's standing instruction.
     *
     * The decision of which events may write is [VpnIntent.record], kept pure so
     * the suite can execute it. The one that matters is SERVICE_DESTROYED: a
     * reboot, a low-memory kill and an app update all destroy this service
     * without the user asking for anything, and if any of them wrote "off" then
     * protection would stay off forever afterwards with nobody having chosen it.
     */
    private fun recordIntent(event: VpnIntent.Event) {
        val value = VpnIntent.record(event) ?: return
        synchronized(prefs) {
            prefs.edit().putString(VpnIntent.KEY, VpnIntent.encode(value)).apply()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            recordIntent(VpnIntent.Event.USER_DISABLED)
            stop()
            return Service.START_NOT_STICKY
        }
        start(fromBoot = intent?.action == ACTION_BOOT_RESTORE)
        return Service.START_STICKY
    }

    /**
     * Android revoked the tunnel — the user withdrew VPN consent, or another VPN
     * app took over. Either way FitShield is not filtering because of something
     * the user did outside the app, so the standing instruction becomes "off"
     * and no restart will quietly bring it back.
     */
    override fun onRevoke() {
        recordIntent(VpnIntent.Event.CONSENT_REVOKED)
        stop()
        super.onRevoke()
    }

    private fun start(fromBoot: Boolean = false) {
        if (active) return
        startForeground(NOTIF_ID, buildNotification())

        // Detect Private DNS only to describe it neutrally in the UI. Blocking now
        // works at the CONNECTION layer (TLS SNI / HTTP Host), so it is effective
        // regardless of Private DNS — and FitShield never touches the encrypted DNS
        // path: DNS keeps flowing to the user's provider untouched.
        privateDnsActive = isPrivateDnsActive()

        val builder = Builder()
            .setSession("FitShield")
            .setMtu(MTU)
            .addAddress(TUN_ADDRESS, 32)
            .addRoute("0.0.0.0", 0)                 // capture all IPv4 → filter by SNI/Host
            .addAddress(TUN_ADDRESS6, 128)
            .addRoute("::", 0)                       // capture all IPv6 → filtered on the same terms (Tun2Filter/IpPacket)
            .setBlocking(true)
        // Deliberately NO addDnsServer: FitShield does not intercept or change DNS.
        val pfd = builder.establish()

        if (pfd == null) {
            Log.e(TAG, "establish() returned null (VPN consent not granted?)")
            recordIntent(VpnIntent.Event.ESTABLISH_FAILED)
            // A restart that could not finish must not end in silence: the user
            // asked for protection, so tell them it is off and offer the one tap
            // that fixes it. A user-initiated start already has the app on screen.
            if (fromBoot) RestoreNotice.post(this)
            stopSelf()
            return
        }

        tunnel = pfd
        active = true
        isRunning = true
        recordIntent(if (fromBoot) VpnIntent.Event.BOOT_RESTORE_STARTED else VpnIntent.Event.USER_ENABLED)
        RestoreNotice.clear(this)
        worker = Thread({ run(pfd) }, "fitshield-filter").also { it.start() }
    }

    private fun run(pfd: ParcelFileDescriptor) {
        val f = Tun2Filter(
            this,
            rules,
            FileInputStream(pfd.fileDescriptor),
            FileOutputStream(pfd.fileDescriptor)
        ) { apex -> recordBlock(apex) }
        filter = f
        try {
            f.loop()
        } catch (e: Exception) {
            if (active) Log.e(TAG, "filter loop stopped", e)
        }
    }

    /** Exposed to [Tun2Filter] so relayed upstream sockets bypass our own tunnel. */
    fun protectSocket(s: Socket): Boolean = protect(s)
    fun protectSocket(s: DatagramSocket): Boolean = protect(s)

    /** True when the system has Private DNS set to Automatic or a hostname. */
    private fun isPrivateDnsActive(): Boolean {
        return try {
            val mode = Settings.Global.getString(contentResolver, "private_dns_mode")
            mode != null && mode != "off"
        } catch (e: Exception) {
            false
        }
    }

    private fun stop() {
        active = false
        isRunning = false
        filter?.shutdown()
        filter = null
        worker?.interrupt()
        worker = null
        try { tunnel?.close() } catch (_: Exception) {}
        tunnel = null
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        // Deliberately no recordIntent here. onDestroy fires for a shutdown, a
        // low-memory kill and an app update as well as for a user's explicit
        // stop, and only the explicit stop (ACTION_STOP, above) means "off".
        stop()
        super.onDestroy()
    }

    // ---- Foreground notification --------------------------------------------

    private fun buildNotification(): Notification {
        val channelId = "fitshield_vpn"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(channelId, "FitShield", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, channelId)
            .setContentTitle("FitShield is on")
            .setContentText("Blocking delivery & fast-food connections locally. DNS is untouched.")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "FitShieldVpn"
        const val ACTION_START = "com.usha.fitshield.START"
        const val ACTION_STOP = "com.usha.fitshield.STOP"

        /** Started by [BootReceiver] after a restart, never by the UI. Distinct
         *  from ACTION_START so a failure here can speak up instead of exiting
         *  quietly, and so a restore never rewrites the user's instruction. */
        const val ACTION_BOOT_RESTORE = "com.usha.fitshield.BOOT_RESTORE"

        /** Lightweight running flag for the UI toggle (process-local). */
        @Volatile var isRunning = false
            private set

        /** True when the last enable ran with Private DNS active. FitShield does
         *  not touch DNS; surfaced neutrally in the UI. */
        @Volatile var privateDnsActive = false
            private set

        private const val NOTIF_ID = 1
        private const val DEDUPE_MS = 30000L
        private const val MTU = 1500
        private const val TUN_ADDRESS = "10.111.222.1"
        private const val TUN_ADDRESS6 = "fd00:f175:1::1"
    }
}
