package com.usha.fitshield

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.SystemClock
import android.net.VpnService
import android.provider.Settings
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONArray
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
    /** When an upstream IPv6 connect last reported the network unreachable;
     *  0 while IPv6 is believed to work. */
    @Volatile private var ipv6FailedAt = 0L
    private lateinit var rules: RuleEngine

    // Local, on-device stats — written to the SAME SharedPreferences the web UI
    // reads through android-shim.js (fitshield.storage). Values are JSON-encoded
    // strings so they round-trip with the shim. A short per-apex dedupe avoids
    // over-counting the many connections a single page triggers.
    private val prefs by lazy { getSharedPreferences("fitshield", Context.MODE_PRIVATE) }
    private val lastBlocked = HashMap<String, Long>()

    // The web UI writes the always-allow list straight into these prefs, so the
    // filter watches them rather than being told. Without this the list was
    // write-only: stored, listed back to the user, and never consulted.
    private val settingsWatcher = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == null || key == ALLOWLIST_KEY || key == CUSTOM_SITES_KEY ||
            key == AppBlockPolicy.KEY_ALLOW_BRANDS
        ) applyUserLists()
    }

    /**
     * Brands the user switched to "Allowed", CACHED.
     *
     * Read here rather than per connection on purpose: [AppBlockPolicy.allowedBrands]
     * parses a JSON array out of SharedPreferences, and [shouldReset] runs for every
     * new flow the tunnel sees. The web UI writes the key and the listener above
     * refreshes this, which is exactly how the two domain lists already work — the
     * filter watches the store rather than being told.
     */
    @Volatile private var allowedBrands: Set<String> = emptySet()

    /**
     * Push the user's two domain lists into the matcher.
     *
     * Until this existed both were write-only: stored, listed back to the user,
     * and never consulted. An allow entry did not rescue a domain and a custom
     * URL did not block one, while the UI reported both as in effect.
     */
    private fun applyUserLists() {
        if (!::rules.isInitialized) return
        rules.setAllowlist(readHostList(ALLOWLIST_KEY))
        rules.setCustomSites(readHostList(CUSTOM_SITES_KEY))
        // The per-app "Allowed" list is a THIRD user list this filter has to
        // honour, and it was the one that was not read here at all.
        allowedBrands = runCatching { AppBlockPolicy.allowedBrands(this) }.getOrDefault(emptySet())
        Log.i(
            TAG,
            "User lists: ${rules.allowlist.size} allowed domains, ${rules.customSites.size} custom, " +
                "${allowedBrands.size} allowed brands"
        )
    }

    /**
     * Host names out of a stored JSON array. Entries are either plain strings
     * (the allow list) or {domain, enabled} objects (custom URLs, the shape the
     * extension uses) — and a disabled entry is not a domain to block.
     */
    private fun readHostList(key: String): List<String> {
        val hosts = ArrayList<String>()
        runCatching {
            val array = JSONArray(prefs.getString(key, "[]") ?: "[]")
            for (i in 0 until array.length()) {
                val entry = array.opt(i)
                val host = if (entry is JSONObject) {
                    if (entry.optBoolean("enabled", true)) entry.optString("domain", "") else ""
                } else {
                    entry?.toString() ?: ""
                }
                if (host.isNotBlank()) hosts.add(host)
            }
        }
        return hosts
    }

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

            // Most-blocked category, recorded from whatever the asset carries.
            //
            // This used to read
            //   `category != "delivery" && category != "fast_food" && category != "custom"`
            // which is the extension's PRE-FIX guard. extension/background.js
            // excludes only the two RULE BUCKET spellings, `fastfood` and `custom`,
            // and says so directly above its set: "The guard here used to drop
            // them, so the single largest curated delivery category could never
            // appear in 'Most blocked categories'."
            //
            // Of the three clauses above, only the FIRST ever did anything, and
            // what it did was the defect: `delivery` is a genuine curated category
            // that Settings' picker offers (369 brands, 373 blockable hosts), so
            // Android could never show it in "Most blocked categories" while the
            // picker one panel away offered it. The other two clauses were inert —
            // the curated vocabulary has 21 categories and neither `fast_food` nor
            // `custom` is among them — and the `fastfood` spelling the JS guard
            // actually exists for was never checked here at all.
            //
            // Both platforms write this same `blockedByCategory` key and the same
            // shared UI ranks it, so this was Android writing a corrupted version
            // of a shared statistic with a bug the extension had already fixed.
            //
            // There is no list here now, on purpose: the asset's `k` is produced by
            // tools/generate-android-rules.js, which applies the extension's
            // exclusion where the value is derived (STATS_EXCLUDED_CATEGORIES) and
            // emits an empty category for a bucket spelling. So this side holds no
            // category vocabulary at all and has nothing to drift.
            val category = meta?.category ?: ""
            if (category.isNotEmpty()) {
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
        applyUserLists()
        prefs.registerOnSharedPreferenceChangeListener(settingsWatcher)
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

    /**
     * Whether the user's schedule permits blocking at this moment. Consulted per
     * flow rather than cached, because a window can close while the tunnel is up
     * and the next connection is the one that has to notice.
     */
    fun blockingAllowedNow(): Boolean = runCatching { AppBlockPolicy.scheduleAllows(this) }.getOrDefault(true)

    /**
     * The filter's whole decision for a matched [apex]: the schedule must permit
     * blocking, and the brand must not be inside a temporary unlock the pause
     * screen granted. Without the second half, "Open anyway" opened an app that
     * could not reach its own servers.
     */
    fun shouldReset(apex: String): Boolean {
        // Resolved ONCE and used for both brand-scoped questions below.
        //
        // The unlock and the "Allowed" list are both keyed by BRAND, not by the host
        // that matched. BlockActivity stores the unlock under `brandId` (the entry's
        // canonical domain) and the per-app pill writes brandIds too; this used to
        // pass `apex` straight through, which is the same string for almost every
        // host and a different one for every ALIAS domain. So on the four shipped
        // brands with both an Android app and an alias, neither control reached the
        // traffic. RuleEngine.brandIdFor returns the host unchanged when there is no
        // alias, so nothing else moves — and it is a map lookup, not a parse.
        val brand = rules.brandIdFor(apex)
        return BlockDecision.shouldReset(
            apex,
            blockingAllowedNow(),
            allowedBrands.contains(brand),
            runCatching { AppBlockPolicy.unlockExpiry(this, brand) }.getOrNull(),
            System.currentTimeMillis()
        )
    }

    /**
     * Whether the network under the tunnel can actually carry IPv6.
     *
     * Answered from EVIDENCE rather than inspection: the upstream sockets are
     * protected, so they take the same path our relayed traffic takes, and
     * whether one of them can reach an IPv6 address is the only question that
     * matters. Asking ConnectivityManager instead does not work — this phone
     * held an IPv4-only Wi-Fi as the default while an idle cellular network
     * still advertised a global IPv6 address and a ::/0 route, so "does any
     * network have IPv6" answered yes while every IPv6 connection failed.
     *
     * Starts optimistic and stays that way until an upstream connect actually
     * reports the network unreachable; a failure is re-probed after
     * [IPV6_RETRY_MS] so regaining IPv6 needs nothing from the user.
     */
    fun ipv6Upstreamable(): Boolean {
        val failedAt = ipv6FailedAt
        return failedAt == 0L || SystemClock.elapsedRealtime() - failedAt >= IPV6_RETRY_MS
    }

    /** Record what an upstream IPv6 connect actually did. */
    fun noteIpv6Reachable(reachable: Boolean) {
        ipv6FailedAt = if (reachable) 0L else SystemClock.elapsedRealtime()
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
        runCatching { prefs.unregisterOnSharedPreferenceChangeListener(settingsWatcher) }
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

        /** Keys the web UI stores the two domain lists under (JSON arrays). */
        const val ALLOWLIST_KEY = "androidAllowlist"
        const val CUSTOM_SITES_KEY = "customSites"

        /** How long IPv6 stays written off after an unreachable upstream
         *  connect, before it is tried again. */
        private const val IPV6_RETRY_MS = 60_000L

        private const val NOTIF_ID = 1
        private const val DEDUPE_MS = 30000L
        private const val MTU = 1500
        private const val TUN_ADDRESS = "10.111.222.1"
        private const val TUN_ADDRESS6 = "fd00:f175:1::1"
    }
}
