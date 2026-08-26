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

## Data safety — the exact answers

_These are the answers to give in the Play Console **Data safety** form, in the
order the form asks them._

**One definition settles every row, and it is Google's own.** From the Data
safety guidance ([source](https://support.google.com/googleplay/android-developer/answer/10787469)):

> **Collection:** Transmitting data from your app off a user's device.

> **Sharing:** Transferring user data collected from your app to a third party.

> User data accessed by your app that is only processed locally on the user's
> device and not sent off device **does not need to be disclosed**.

That last sentence is the whole answer for FitShield. The app reads plenty — the
destination host of each connection, the package name of the app in front, a
running count of interruptions — and transmits none of it. Data a device keeps to
itself is not collected, no matter how personal it looks. **Answer the form
against that definition, not against instinct**, or you will over-declare and
end up with a store page implying FitShield sends somewhere the things it
specifically exists not to send.

### Section 1 — Data collection and security

| Play's question | Answer | Why this is the true answer |
| --- | --- | --- |
| Does your app collect or share any of the required user data types? | **No** | Nothing is transmitted anywhere. There are no FitShield servers, no accounts, no analytics or crash-reporting SDK, and no advertising SDK. The only network traffic the app produces is relaying the user's own already-chosen connections to the destination they already chose. |
| Is all of the user data collected by your app encrypted in transit? | **not asked** | The form only asks this after a Yes above. If you find yourself answering it, you have answered the first question wrong. |
| Do you provide a way for users to request that their data is deleted? | **not asked** | Same — only asked after a Yes. For the record: everything lives in the app's private `SharedPreferences`, the in-app **Reset & Data** panel clears it, and uninstalling removes it. |

### Section 2 — Data types

Every one of Play's data-type categories is answered **not collected, not
shared**. The rows worth being able to defend, because a reviewer will look at
the permissions and wonder:

| Data type | Answer | The thing a reviewer might expect instead |
| --- | --- | --- |
| **App activity** (app interactions, other user-generated content) | not collected, not shared | The app counts ordering pages it interrupted and keeps a most-blocked breakdown by site, app, category and country. All of it is written to private `SharedPreferences`, read back by the same device, and never sent anywhere. |
| **Web browsing history** | not collected, not shared | The connection filter reads the cleartext destination host (TLS SNI / HTTP `Host`) of each connection to decide block or allow. It is used in memory for that decision, is not written to logcat in release builds, and never leaves the device. FitShield does not build or retain a browsing history. |
| **App info and performance** (crash logs, diagnostics) | not collected, not shared | There is no crash-reporting or diagnostics SDK of any kind. |
| **Device or other IDs** | not collected, not shared | No advertising ID, no `AD_ID` permission, no device identifier is read. |
| **Personal info, financial info, health and fitness, messages, photos and videos, audio, files, calendar, contacts, location** | not collected, not shared | None of these is read at all, and no permission that would allow it is requested. The AccessibilityService is configured `canRetrieveWindowContent="false"`, so it cannot read messages or on-screen text even in principle. |

### Section 3 — Optional extras

| Play's question | Answer |
| --- | --- |
| Is your app's data handling independently validated against a global security standard? | **No** (the MASA independent security review is optional; FitShield has not had one) |
| Data deletion mechanism | Not applicable — nothing is collected. The in-app reset and uninstall both clear on-device state. |

### The one fact that makes "nothing leaves the device" airtight

The manifest sets **`android:allowBackup="false"`**. Without it, Android's
automatic cloud backup would copy the app's `SharedPreferences` — settings and
statistics — to the user's Google Drive, and a Data safety form claiming nothing
leaves the device would be wrong through no fault of the app's own code. With it,
cloud backup is off. (Android 12+ device-to-device transfer moves data phone to
phone without a server, so it does not change the answer either.)

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

**What Play requires, and where FitShield stands against it.** Google's
requirements for an AccessibilityService used for a non-accessibility purpose are
that the disclosure be *inside the app* (not only the listing or a website), be
*shown during normal use* rather than buried, *describe the data accessed*,
*explain how it is used and shared*, and *require affirmative user action for
consent*.

FitShield satisfies the first four plainly: the app-blocking panel states that
the service reads only which app comes to the front and never screen content,
directly above the button that opens Accessibility settings, and
`accessibility_description` repeats it inside the system settings screen itself.
The fifth is the weak one — today the disclosure is passive text inside a
collapsed panel, with no explicit "I understand" step. **Do not claim otherwise
on the declaration form.** A dedicated consent step is being added; check the
shipped build before answering.

FitShield does **not** set `isAccessibilityTool`. That flag is reserved for apps
whose core function is directly supporting people with disabilities, and
FitShield is not one. Its absence is correct and deliberate, not an omission.

## VPN disclosure

- FitShield uses Android's `VpnService` as a **local content filter only**, not a
  VPN tunnel. It provides **no** encryption, anonymity, IP masking, or remote
  server — and makes no such claim.
- Android shows the **one-time system VPN-consent dialog** before it can start,
  and the persistent VPN key/notification while active. Only one VPN can be
  active at a time (FitShield conflicts with other VPN apps).
- DNS and Private DNS are **untouched**; the app works with strict Private DNS
  (e.g. NextDNS) enabled.

**Answering Play's encryption question honestly.** The VpnService policy says
apps "must encrypt the data from the device to the VPN tunnel endpoint". FitShield
has no tunnel and no endpoint, so the box is the wrong shape for the app and the
right move is to say so rather than tick it:

> FitShield's `VpnService` is a local, on-device connection filter. There is no
> tunnel and no remote endpoint — no traffic is sent to any FitShield server,
> because there are none. Blocked connections are reset locally; allowed
> connections are relayed byte-for-byte to the exact destination IP the client
> already chose, over a `protect()`ed socket. FitShield never terminates,
> decrypts, re-encrypts or modifies TLS, so the user's existing end-to-end
> encryption is preserved unchanged. The app is never an endpoint.

The policy's permitted use cases include device-security apps — explicitly
naming firewalls — and parental control. **A local firewall / content filter is
the accurate description; "VPN" is not.** Say the former on the form.

## Permissions rationale (user-facing)

See the table in [PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md#5-permissions).
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

_Last verified against the implementation on 2026-08-26, and against Google's own
policy pages on the same day. Update this file in the same change as any behavior
it describes. The statements here that can be checked mechanically are checked by
`test/play-release.test.js` — the permission set, the statistics the app keeps,
the accessibility configuration, and `allowBackup="false"`._
