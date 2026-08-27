package com.usha.fitshield

/**
 * Whether FitShield should be filtering, and what to do about it after the
 * device restarts.
 *
 * Pure by design — no Android imports, no storage, no service. The two rules
 * below are the ones a user would notice being broken, so they are written as
 * functions the test suite can compile and execute rather than as branches
 * buried in a BroadcastReceiver:
 *
 *  - **Never turn protection on for someone who turned it off.** The stored
 *    value is the user's own last instruction, and only the user changes it.
 *  - **Never lose the instruction because the OS took the service away.** A
 *    reboot, a low-memory kill and an app update all destroy the service without
 *    the user asking for anything; if any of those wrote "off", protection would
 *    quietly stay off forever afterwards, which is the exact failure this
 *    machinery exists to end.
 */
internal object VpnIntent {

    /**
     * SharedPreferences key. It lives in the same "fitshield" store the web UI
     * reads through android-shim.js, in the same JSON-encoded string form, so
     * nothing about it is a second source of truth.
     */
    const val KEY = "vpnUserEnabled"

    enum class Event {
        /** The tunnel came up because the user asked for it. */
        USER_ENABLED,

        /** The user turned FitShield off in the app. */
        USER_DISABLED,

        /** Android revoked the VPN (consent withdrawn, or another VPN took over). */
        CONSENT_REVOKED,

        /** The service went away without the user asking — reboot, kill, update. */
        SERVICE_DESTROYED,

        /** `VpnService.Builder.establish()` returned null. */
        ESTABLISH_FAILED,

        /** We brought the tunnel back after a restart. */
        BOOT_RESTORE_STARTED
    }

    /**
     * The value to persist for [event], or null to leave the stored instruction
     * exactly as the user left it.
     */
    fun record(event: Event): Boolean? = when (event) {
        Event.USER_ENABLED -> true
        Event.USER_DISABLED -> false
        Event.CONSENT_REVOKED -> false
        Event.SERVICE_DESTROYED -> null
        Event.ESTABLISH_FAILED -> null
        Event.BOOT_RESTORE_STARTED -> null
    }

    /** The stored form: the same bare JSON literal android-shim.js parses. */
    fun encode(on: Boolean): String = if (on) "true" else "false"

    /** Absent, malformed or anything but true reads as OFF. */
    fun decode(stored: String?): Boolean = stored?.trim()?.trim('"') == "true"
}

/**
 * What a restart should do. Called from [BootReceiver] with the stored
 * instruction and whether Android still holds the user's VPN consent.
 */
internal object BootRestore {

    enum class Action {
        /** The user had FitShield off. Do nothing at all — no service, no notification. */
        NOTHING,

        /** Consent is still held: bring the tunnel back without bothering anyone. */
        START_TUNNEL,

        /**
         * The user wanted protection but Android will not let it start unattended
         * (consent needs re-granting). Silence would be the worst answer, so one
         * notification says protection is off and one tap restores it.
         */
        ASK_TO_RESTORE
    }

    /**
     * What the restore notice should say, given what actually woke us.
     *
     * The same notice is posted after a reboot AND after an app update, because
     * both destroy the service without the user asking. It always claimed "Your
     * phone restarted", which is simply untrue after an update — the user is
     * told their phone rebooted when it did not. The trigger is known at the
     * call site, so it says which one happened.
     */
    fun noticeText(afterReboot: Boolean): String =
        if (afterReboot) "Your phone restarted. Tap to turn it back on."
        else "FitShield was updated. Tap to turn it back on."

    /** The expanded form of [noticeText]. */
    fun noticeBigText(afterReboot: Boolean): String =
        (if (afterReboot) "Your phone restarted and " else "FitShield was updated and ") +
            "Android needs your confirmation before FitShield can filter connections " +
            "again. Tap to turn site blocking back on."

    fun decide(storedIntent: String?, consentAlreadyGranted: Boolean): Action {
        if (!VpnIntent.decode(storedIntent)) return Action.NOTHING
        return if (consentAlreadyGranted) Action.START_TUNNEL else Action.ASK_TO_RESTORE
    }
}
