# FitShield Android — Privacy & Play Data Safety Notes

_Source-of-truth notes for the Google Play **Data safety** form, the privacy
policy, and the required Accessibility/VPN disclosures. Everything here is
verifiable in the code (`android/app/src/main/java/com/usha/fitshield/`) and is
enforced by `tools/android-audit.js` (no analytics dependency) and the
permission allowlist._

FitShield is **local-first**: it is a self-control / mindfulness tool that adds
friction before opening food-delivery and fast-food **apps and sites**.
Everything happens **on the device**.

---

## Summary posture

- **No accounts, no login, no cloud, no sync, no ads, no in-app purchases.**
- **No analytics, telemetry, crash reporting, or advertising SDKs** — none are
  declared as dependencies (enforced by `tools/android-audit.js`).
- **No data is collected, transmitted to FitShield, or shared with third
  parties.** There are no FitShield servers.
- All settings and statistics are stored **only** in the app's private
  `SharedPreferences` on the device.

## Data Safety

### Data collected or shared
**None.** FitShield collects no personal or device data, transmits nothing to
any FitShield server, and shares nothing with third parties.

| Play Data-safety question | Answer |
| --- | --- |
| Does your app collect or share any required user data types? | **No** |
| Is all user data encrypted in transit? | N/A — no data leaves the device |
| Do you provide a way to request data deletion? | Data is on-device only; uninstalling (or in-app reset) removes it |

### Data stored on-device only (never transmitted)
- **Settings**: which categories/apps/domains to block, schedule, timer/unlock
  durations, theme, language — plain app preferences.
- **Local statistics**: a count of ordering pages interrupted, plus a private
  "most-blocked" breakdown by app/site/category/country. No savings or calorie
  estimate is computed or stored. These are aggregate counters, computed and
  shown **on the device**; they are never uploaded.

### Network behavior (be precise)
- The optional **VpnService is a local, on-device connection filter**. It reads
  only the **cleartext destination host** the client already sends — the **TLS
  SNI** (443) or **HTTP Host** header (80) — to decide block vs allow. It **does
  not**: decrypt TLS, inspect payloads, install any certificate/MITM, intercept
  or alter DNS, tunnel traffic through any server, or send anything off-device.
- **Blocked** connections get a TCP reset locally. **Allowed** connections are
  relayed **byte-for-byte to the exact destination IP the client chose**, over a
  `protect()`ed socket — i.e. normal internet, as if FitShield were absent.
- **Nothing is logged off-device, and no hostnames or filtering decisions are
  written to logcat in release builds** (debug-only, gated by `BuildConfig.DEBUG`).

## Accessibility Service disclosure (required prominent disclosure)

FitShield includes an **opt-in `AccessibilityService`** used **solely** to power
the user-requested app-blocking feature:

- **What it does:** when the user has enabled app blocking and turned the service
  on in **system Accessibility settings**, it detects when a **food app the user
  chose to block** comes to the foreground and shows the FitShield pause screen.
- **What it reads:** **only the foreground app's package name**
  (`android:canRetrieveWindowContent="false"` in
  `res/xml/accessibility_service_config.xml`). It does **not** read screen
  content, text fields, messages, passwords, or any other on-screen data.
- **What leaves the device:** **nothing.** The package name is used in-memory to
  look up the block decision and is never logged (release) or transmitted.
- **Opt-in & reversible:** off until the user enables it; disabling it in
  Accessibility settings fully stops it.

This matches Google Play's AccessibilityService policy: the app has a clear
accessibility-adjacent purpose (helping users avoid impulse ordering), makes a
**prominent in-app disclosure** (the app-blocking panel explains exactly this),
and requests no more than the foreground package name.

## VPN disclosure

- FitShield uses Android's `VpnService` as a **local content filter only**, not a
  VPN tunnel. It provides **no** encryption, anonymity, IP masking, or remote
  server — and makes no such claim.
- Android shows the **one-time system VPN-consent dialog** before it can start,
  and the persistent VPN key/notification while active. Only one VPN can be
  active at a time (FitShield conflicts with other VPN apps).
- DNS and Private DNS are **untouched**; the app works with strict Private DNS
  (e.g. NextDNS) enabled.

## Permissions rationale (user-facing)

See the table in [PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md#5-permissions--all-justified-in-app--docs).
Every permission is either an OS gate (`BIND_VPN_SERVICE`,
`BIND_ACCESSIBILITY_SERVICE`), a foreground-service requirement, or an optional
user-granted convenience (`SYSTEM_ALERT_WINDOW`). No location, contacts, phone,
SMS, storage, camera, microphone, usage-access, or `QUERY_ALL_PACKAGES`
permission is requested.

## Content / claims guardrails

FitShield is a **mindfulness / friction tool**, not a medical or weight-loss
product. The app and its store listing **must not**:
- make medical, health-treatment, or addiction-treatment claims;
- promise or guarantee weight loss or specific health outcomes;
- present the app as a substitute for professional advice.

Positioning stays behavioral: *pause before you order; make it a choice, not a
reflex.*

---

_Last verified against the implementation on the `android-extension-parity`
branch. Update this file in the same change as any behavior it describes._
