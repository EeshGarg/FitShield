# FitShield on Android

_Accurate as of FitShield 0.52. Update this file in the same change as any
behavior it describes._

FitShield is **one product** with **one canonical dataset** and **one separated
engine**. Browsers and Android are **platform adapters** on top of that shared
core — not separate products and not forks:

```
                 canonical data  (blocklists/*.json)
                          │
              separated engine  (blocklist.js)
                          │
        ┌─────────────────┼──────────────────────────┐
        ▼                 ▼                           ▼
  browser adapter   browser adapter            android adapter
  (background.js,   (Firefox for Android,      (native APK:
   Chrome/Brave/    same extension via          VpnService local
   Edge via DNR)    declarativeNetRequest)      DNS filtering)
```

FitShield reaches Android **two** ways, both riding the same engine/data:

| Path | What it is | Blocking mechanism | Status |
| --- | --- | --- | --- |
| **A. Extension on Firefox for Android** | the exact same WebExtension as desktop | `declarativeNetRequest` (in-browser) | declared (manifest `gecko_android` 142+); on-device DNR not yet verified |
| **B. Native Android APK** | a thin native adapter | local `VpnService` DNS filtering (in this app) | **PREVIEW** — scaffolding generated + validated; not built/run on a device here |

> **The single most important rule:** Android does **not** have its own
> blocklist or matcher. Its rules are **generated from the canonical data via
> the separated engine** and validated to match it (`tools/android-audit.js`).
> Any drift fails the build.

---

## 1. Shared engine & canonical data (no fork)

- **Canonical data:** `blocklists/fast-food.json`, `blocklists/delivery.json`.
- **Separated engine:** `blocklist.js` — dataset loading + the matching
  semantics (`normalizeHostname`, `domainMatches`, `getEntryDomains`,
  `getEnabledEntries`, `isBlockedHost`). It runs unchanged in the browser
  (service worker / event page) **and** in Node (tools/tests).
- **Browser adapter:** `background.js` turns the engine's output into
  `declarativeNetRequest` redirect rules.
- **Android adapter:** the native app consumes a **generated** host list (below)
  and applies the engine's exact match rule.

Because the APK is native (Kotlin) it cannot execute the JavaScript engine
directly. The canonical pipeline bridges this **without** duplicating logic:

```
blocklists/*.json ──▶ blocklist.js (engine) ──▶ tools/generate-android-rules.js
                                                        │
                                                        ▼
                              android/app/src/main/assets/fitshield-rules.json
                                          (GENERATED — do not hand-edit)
                                                        │
                                                        ▼
                              RuleEngine.kt  (apex/subdomain match,
                                              identical to domainMatches)
```

- `tools/generate-android-rules.js` calls the **engine** (`getEnabledEntries` +
  `getEntryDomains`) over the **canonical data** and emits a deterministic,
  hash-stamped asset of every blockable apex/alias host (2,585 hosts at 0.52).
- `RuleEngine.kt` loads **only** that generated asset and implements the same
  contract as `blocklist.js` `domainMatches`: a host is blocked iff it equals an
  apex or is a subdomain of one. No second semantics.
- **Rule consistency is enforced, not hoped for:** `tools/android-audit.js`
  re-derives the host set from the engine and fails if the committed asset's
  hash/host-list differs. A generated `semantics-fixture.json` (also engine-
  produced) is checked on-device by `SemanticsParityTest.kt` so the Kotlin
  matcher must agree with the engine's block/allow decisions.
- **No duplicated blocklist, no Android-only data fork, no hand-maintained
  rules** — all three are blocked by the audit and the tests.

---

## 2. Native APK adapter

Repository layout (`android/`, tracked; build output gitignored):

```
android/
  settings.gradle, build.gradle, gradle.properties
  app/build.gradle
  app/src/main/AndroidManifest.xml
  app/src/main/assets/fitshield-rules.json          (GENERATED from canonical data)
  app/src/main/java/com/usha/fitshield/
      RuleEngine.kt             (asset-only matcher, engine semantics)
      FitShieldVpnService.kt    (local DNS filter — PREVIEW)
      MainActivity.kt           (minimal UI: consent + start/stop)
  app/src/main/res/...          (strings, theme, layout)
  app/src/androidTest/.../SemanticsParityTest.kt
  app/src/androidTest/assets/semantics-fixture.json (GENERATED)
```

**What the adapter adds (only what the browser cannot):** Android project
scaffolding, the `VpnService` DNS adapter, a minimal UI, the manifest, the
build/export step, Android-specific validation, and this documentation.
Everything else is shared.

**Preview status:** the smallest working DNS filter is now implemented — tunnel
setup, the engine-backed block/allow decision, IPv4/UDP DNS QNAME parsing,
**NXDOMAIN synthesis for blocked domains**, and **upstream forwarding for allowed
domains** (over a `protect()`-ed socket). It is reviewable but **has NOT been
built or run on a device in this repository** (no Android SDK here). IPv6 and
DNS-over-HTTPS/TLS are intentionally out of scope. This is a test-quality
foundation, not Android 1.0 — see the limitations in §7.

---

## 3. VPN design — local DNS filtering only

The native app uses Android's `VpnService` **solely as a local DNS filter**. It
is the only OS mechanism that lets an app see DNS queries system-wide without
privileged/abusive permissions.

It **does**:

- ✅ run a **local, on-device** VPN interface that only routes DNS.
- ✅ read the requested **domain name** from each DNS query.
- ✅ check it against the engine-derived rules and **sinkhole** blocked domains.
- ✅ forward **allowed** queries to the upstream resolver unchanged.

It **does not**:

- ❌ act as a commercial VPN.
- ❌ tunnel browsing through FitShield (or any) servers — there are none.
- ❌ inspect, decrypt, or proxy HTTPS or any non-DNS traffic.
- ❌ install or trust any certificate / root CA.
- ❌ perform content inspection.
- ❌ send any data off the device.

**DNS query lifecycle:**

1. **Intercepted** — the local VPN receives the device's outbound DNS query
   (UDP/53). Only the query packet is read; no other traffic is captured.
2. **Domain checked** — `RuleEngine.isBlocked(name)` walks the domain's suffixes
   against the apex set (engine semantics). Look-alikes (`fake-doordash.com`) and
   suffix tricks (`doordash.com.evil.com`) do **not** match.
3. **Blocked domain** — the query is sinkholed (no answer / `NXDOMAIN`), so the
   app/site cannot resolve it. Nothing is logged off-device.
4. **Allowed domain** — forwarded to the upstream resolver and the answer
   returned, exactly as if FitShield were not present.

**Scope difference from the browser path:** the VPN-based filter is **system-
wide** (any app/browser on the device), whereas the Firefox-for-Android
extension only blocks inside Firefox.

---

## 4. Privacy

Identical posture to the rest of FitShield — local-first, on both Android paths.

- ✅ No telemetry, analytics, crash/usage reporting, accounts, cloud, sync, ads,
  or tracking.
- ✅ No browsing-history upload. No **DNS query upload or remote logging** — DNS
  decisions happen on-device and are not transmitted or persisted off-device.
- ✅ No hidden background services beyond the foreground `VpnService` the user
  explicitly starts (with the system VPN-consent dialog).
- ✅ **No data sent to FitShield.** There are no FitShield servers. The native
  adapter forwards *allowed* DNS queries to a **public resolver
  (`1.1.1.1`, Cloudflare) in this preview** — never to FitShield, and never any
  data beyond the DNS query itself. (A future version may use the system
  resolver instead; that would require `ACCESS_NETWORK_STATE`.) The browser
  extension makes zero network requests. No analytics dependency is allowed in
  the Android build (enforced by `tools/android-audit.js`).

---

## 5. Permissions

### Native APK (Android OS permissions)

| Permission | Why it exists | Depends on it | If denied |
| --- | --- | --- | --- |
| `INTERNET` | forward **allowed** DNS queries to the upstream resolver | DNS pass-through | allowed lookups fail |
| `FOREGROUND_SERVICE` | a VPN runs as a foreground service | the filter staying active | service can't run |
| `POST_NOTIFICATIONS` | the required ongoing VPN notification (Android 13+) | user-visible "filtering on" state | no status notification |
| `BIND_VPN_SERVICE` (on the `<service>`) | the OS gate for any `VpnService` | starting the filter at all | (OS-enforced; not user-grantable) |

Plus the runtime **VPN consent dialog** Android shows before any VpnService
starts — the user must explicitly approve.

**Intentionally NOT requested (enforced by `tools/android-audit.js`):**
`RECEIVE_BOOT_COMPLETED` (no boot startup), `BIND_ACCESSIBILITY_SERVICE` (no
accessibility service), `PACKAGE_USAGE_STATS` (no usage access),
`QUERY_ALL_PACKAGES` (no package visibility), device admin. There is no boot
receiver and no accessibility service.

### Browser path
The Firefox-for-Android extension uses only WebExtension permissions
(`declarativeNetRequest`, `storage`, `alarms`, `host_permissions: <all_urls>`,
`web_accessible_resources: warning.html`) — no Android OS permissions.

---

## 6. Build

### Browser (Chrome / Firefox / Firefox for Android extension)
- Requirements: Node.js 18+, no dependencies.
- `node build.js` → `dist/chrome/`, `dist/firefox/`, and the store zips. The
  build is validation-gated (includes the Android audit, so the browser build
  fails if the Android ruleset drifts from canonical data).

### Native Android APK
- **Generate rules:** `npm run generate:android` (engine → generated asset).
- **Validate:** `npm run validate:android` (or `npm run validate` / `npm test`).
- **Build/export:** `npm run build:android` →
  - always regenerates + validates and stages `dist/android/` (rules +
    `BUILD.txt` with the exact local command + a device-test checklist);
  - **if the Android SDK + Gradle are present**, builds a **debug** APK and
    copies it to `dist/android/FitShield-<version>-debug.apk`. It never fakes
    success when tooling is absent.
- **Requirements for the APK:** Android SDK (compileSdk 34, minSdk 26) and Gradle
  (AGP 8.5.x, Kotlin 1.9.x). No Gradle wrapper is committed (the wrapper jar is a
  binary); create one once with a system Gradle, then build:
  ```
  cd android
  gradle wrapper            # one-time, needs a system Gradle
  ./gradlew :app:assembleDebug
  ```
  Or, with Gradle on PATH, just `npm run build:android`.
- **Install on a device** (USB debugging on):
  ```
  adb install -r dist/android/FitShield-<version>-debug.apk
  ```
- **Output structure:**
  ```
  dist/
    FitShield-<version>-chrome.zip
    FitShield-<version>-firefox.zip
    android/
      fitshield-rules.json
      BUILD.txt
      FitShield-<version>-debug.apk   (only when built with the SDK/Gradle)
  ```
- **Version:** all outputs use the single `manifest.json` version (`build-android`
  injects `-PfitshieldVersionName`), so the three platforms never diverge.
- **Debug signing only** — uses Android's default debug keystore. No release
  signing/keystores are configured or committed.

### Manual device test checklist (native APK)
A copy of this ships in `dist/android/BUILD.txt`:
- [ ] APK installs (`adb install -r …`); app opens and shows the loaded host count
- [ ] Enable triggers the VPN-consent dialog; after consent the VPN starts and
      the OS VPN indicator + foreground notification appear
- [ ] `doordash.com`, `ubereats.com`, `grubhub.com` are blocked (don't resolve)
- [ ] Normal sites still resolve (e.g. `wikipedia.org`, `github.com`)
- [ ] Disabling stops filtering; uninstalling stops filtering
- [ ] No boot startup; no accessibility / usage-access / location / contacts /
      phone / SMS / storage permission requested
- [ ] Small-screen UI is usable; no unexpected network calls beyond DNS forwarding
- [ ] (optional) `./gradlew connectedAndroidTest` passes `SemanticsParityTest`
      (Kotlin matcher == engine fixture)

---

## 7. Security

**Threat model.** FitShield is a self-control / mindfulness tool, not an
adversarial blocker. It assumes a cooperative user on their own device. It is
not designed to stop a determined user.

**Trust assumptions.** The OS enforces `VpnService` correctly; the device/profile
are the user's; the curated datasets are accurate (validated) but not exhaustive.

**DNS interception model (native path).** A local `VpnService` reads only DNS
queries, decides via engine-derived rules, sinkholes blocked names, and forwards
the rest. No traffic is tunnelled to a server; nothing but DNS is read.

**Limitations — be honest.**

- **Native path is PREVIEW and unverified on-device** — the IPv4/UDP DNS filter
  (NXDOMAIN + upstream forwarding) is implemented but has not been built or run
  on a device here; do not ship it as working until verified. The outbound UDP
  checksum is set to 0 (valid for IPv4) rather than computed.
- **Cooperative, not enforced** — a user can stop the VPN, uninstall, or change
  DNS; DoH/DoT or hardcoded resolvers can bypass a DNS filter.
- **Curated coverage** — only domains the engine derives are blocked.
- **No traffic protection** — FitShield provides no encryption/anonymity; it is
  not a privacy VPN and makes no such claim.
- **Browser path** blocks only inside Firefox for Android, and its on-device DNR
  behavior is not yet verified.

**Android platform limitations.** Only one active VPN at a time (FitShield
conflicts with another VPN app); foreground-service and notification policies
vary by OS version; encrypted DNS can route around a local filter.

**Known unsupported / unverified cases.** IPv6 and DNS-over-HTTPS/TLS handling in
the preview filter; on-device DNR on Firefox for Android; any non-Firefox Android
browser for the extension path.

**Future improvements.** Complete and harden the VpnService I/O (response
synthesis, upstream forwarding, IPv6, DoH handling), add a signed release/wrapper,
and verify both paths on real devices.

---

## 8. Release documentation

Every release is recorded in [`../changelog/`](../changelog/) (canonical) and
summarized in `changelog.json`. For Android, each release should answer:

- **What changed?** — the per-release `changelog/<version>.md`.
- **Why?** — rationale / design notes alongside the change.
- **How was it validated?** — `npm test`, `npm run validate` (incl. the Android
  audit), `node build.js`, `npm run build:android`, plus any on-device notes.
- **What platforms were tested?** — state Chrome/Firefox desktop, and explicitly
  whether Firefox for Android (extension) and the native APK were tested
  **on-device** or only built/validated.
- **What still requires manual verification?** — currently: native VpnService DNS
  filtering on-device, and on-device DNR on Firefox for Android.

> Maintainer note: the Android rules asset is **generated** — never hand-edit it.
> If canonical data changes, run `npm run generate:android` (and the audit/tests
> will fail until you do). Keep code and docs evolving together.
