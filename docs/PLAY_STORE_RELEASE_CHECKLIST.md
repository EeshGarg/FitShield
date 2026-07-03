# FitShield — Google Play Release Checklist

_Android app: `com.usha.fitshield`. This file is the operational checklist for
cutting a Play Store build. Keep it in sync with `android/app/build.gradle`,
`AndroidManifest.xml`, [ANDROID.md](ANDROID.md), and
[PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md)._

Status legend: ✅ done in-repo · ⚙️ requires the release operator (keystore /
Play Console) · 🔁 verify each release.

---

## 1. Build configuration

- ✅ **Target API level** — `compileSdk 35` / `targetSdk 35` (Android 15).
  Enforced by `tools/android-audit.js` (fails if either drops below 35).
- ✅ **minSdk 26** (Android 8.0) — covers ~the whole active install base.
- ✅ **AGP 8.6.0 / Gradle 8.7 / Kotlin 1.9.24 / JDK 17.**
- ✅ **No minification/obfuscation** (`minifyEnabled false`) — deliberate: the
  app is auditable, no hidden behavior. (R8 is not required for Play.)
- ✅ **`applicationId com.usha.fitshield`** — must never change after first
  publish (Play identity).

## 2. Versioning

- ✅ `versionName` is injected from the canonical `manifest.json` via
  `-PfitshieldVersionName` (one version across extension + Android).
- ✅ `versionCode` is injected via `-PfitshieldVersionCode` (defaults to `1`).
- 🔁 **`versionCode` MUST strictly increase every Play upload** (integer). Track
  it in the changelog. Suggested scheme: start at `1` and increment by one per
  uploaded build (independent of `versionName`).
- 🔁 Record the `versionName`↔`versionCode` pair for each release in
  `changelog/`.

## 3. Signing → AAB

- ✅ Release signing reads from a **gitignored** `android/keystore.properties`
  (or `-P` / env), so **no keystore or password is ever committed**. If absent,
  the release build is left unsigned (safe default).
- ⚙️ Create the upload keystore **once** and store it securely OUTSIDE the repo:
  ```
  keytool -genkeypair -v -keystore fitshield-upload.jks -alias fitshield \
    -keyalg RSA -keysize 2048 -validity 10000
  ```
- ⚙️ Create `android/keystore.properties` (gitignored) with:
  ```
  storeFile=/absolute/path/to/fitshield-upload.jks
  storePassword=...
  keyAlias=fitshield
  keyPassword=...
  ```
  (Alternatively pass `-PFITSHIELD_STORE_FILE=… -PFITSHIELD_STORE_PASSWORD=… -PFITSHIELD_KEY_ALIAS=… -PFITSHIELD_KEY_PASSWORD=…`.)
- ⚙️ **Enable Play App Signing** in the Console (recommended). Your keystore is
  then the *upload* key; Google manages the app signing key.
- ✅ **Build the AAB** (see §9 for the exact command). Output:
  `android/app/build/outputs/bundle/release/app-release.aab`.
- 🔁 Verify the AAB is signed: `jarsigner -verify app-release.aab` → `jar verified`.

## 4. Release hygiene (no dev artifacts in release)

- ✅ **WebView remote debugging** (`setWebContentsDebuggingEnabled`) is guarded
  by `BuildConfig.DEBUG` in `MainActivity` and `BlockActivity` — off in release.
  Enforced by `tools/android-audit.js`.
- ✅ **Verbose logging gated to debug:** WebView console logging and the
  per-connection RST log in `Tun2Filter` (which names the blocked host) are both
  `if (BuildConfig.DEBUG)` — **no hostnames or filtering decisions in release
  logcat**.
- ✅ No `android:debuggable="true"` in the manifest (AGP sets it false for
  release; audit-enforced).
- ✅ No hardcoded dev URLs / `localhost` / `10.0.2.2`, no mock data, no test
  flags in `src/main/`.
- ✅ Instrumented tests live in `src/androidTest/` and are **not** packaged in
  the release build.

## 5. Permissions — all justified (in-app + docs)

| Permission | Why | User-facing |
| --- | --- | --- |
| `INTERNET` | relay allowed connections to the destination the client already chose | — |
| `FOREGROUND_SERVICE` (+ `_SPECIAL_USE`) | the VpnService and the optional keep-alive run as foreground services | ongoing notification |
| `POST_NOTIFICATIONS` | the required foreground-service notification (Android 13+) | runtime prompt |
| `SYSTEM_ALERT_WINDOW` | optional "display over other apps" so the block screen launches reliably | user-granted, explained in-app |
| `BIND_VPN_SERVICE` | OS gate for the VpnService | one-time VPN consent dialog |
| `BIND_ACCESSIBILITY_SERVICE` | OS gate for the opt-in app blocker (reads only the foreground package name) | user opt-in in system Accessibility settings, explained in-app |

- ✅ Scoped `<queries>` (MAIN/LAUNCHER) — **not** `QUERY_ALL_PACKAGES`.
- ✅ Enforced allowlist in `tools/android-audit.js`.
- 🔁 In Play Console, complete the **Permissions declaration**, the
  **VpnService** usage, and the **AccessibilityService** declaration (see §7).

## 6. Behavior guarantees (🔁 verify on-device each release)

- 🔁 **No blocking unless the user enables it.** `appBlockingEnabled` defaults
  **false**; the VPN requires the one-time consent dialog; the AccessibilityService
  is a system opt-in. A fresh install blocks nothing.
- 🔁 Survives **enable/disable cycles**, **reboot** (accessibility service is
  re-bound by the OS; VPN requires manual re-enable by design), **battery
  optimization** (optional keep-alive + "unrestricted battery" helper),
  **Accessibility toggles**, and **VPN restarts**.
- 🔁 **Keep-alive is opt-in and OFF by default**; when on it shows a quiet
  `IMPORTANCE_MIN` notification and does no work.
- 🔁 Non-blocked apps are ignored (no false blocks); no accessibility/overlay loops.

## 7. Play Console declarations

- 🔁 **Data safety form** — see [PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md#data-safety):
  no data collected, shared, or transmitted off device.
- 🔁 **Privacy policy URL** — host the Android privacy notes (or the fitshield.net
  privacy page) and link it.
- 🔁 **VpnService use** — declare the local, on-device content filter (no traffic
  leaves the device to any FitShield server; no traffic inspection beyond the
  cleartext SNI/Host).
- 🔁 **AccessibilityService use** — declare the *prominent disclosure* + purpose:
  used **only** to detect when a user-selected food app is opened, to show the
  block screen. Reads only the foreground package name; no screen/message content.
  (Google requires an in-app prominent disclosure for accessibility use — the
  app-blocking panel provides this.)
- 🔁 **Foreground service types** — `specialUse` for the VpnService and the
  keep-alive; provide the subtype justification (already declared in the manifest
  `<property>`).
- 🔁 **Target audience / content rating** — not directed at children; complete
  the content-rating questionnaire (expected: Everyone/PEGI 3).
- 🔁 **Ads:** none. **In-app purchases:** none.

## 8. Store listing & assets

- 🔁 See [STORE_LISTING_DRAFT.md](STORE_LISTING_DRAFT.md) for copy, screenshots,
  and the feature graphic checklist.
- 🔁 **No prohibited claims** — no medical / addiction-treatment / guaranteed
  weight-loss language anywhere in the listing (see the draft's guardrails).

## 9. Build & test commands

```bash
# Full validation gate (datasets, locales, docs, Android audit incl. release checks)
npm run validate            # tools/validate-all.js — 9 audits
npm test                    # 73 tests

# Debug APK (for on-device testing)
npm run build:android       # regenerates + validates, then builds the debug APK

# --- Play-ready signed AAB (requires android/keystore.properties) ---
cd android
./gradlew :app:bundleRelease -PfitshieldVersionName=<name> -PfitshieldVersionCode=<int>
# -> app/build/outputs/bundle/release/app-release.aab   (upload this to Play)
jarsigner -verify app/build/outputs/bundle/release/app-release.aab   # expect "jar verified"
```

Requirements: Android SDK **API 35** platform + build-tools 35, Gradle 8.7, JDK 17.

## 10. Rollout

- 🔁 **Internal testing** → **Closed testing (beta)** → **Production** with a
  **staged rollout** (e.g. 10% → 50% → 100%), watching crash-free rate / ANRs.
- 🔁 Pre-launch report: review Play's automated device results.
- 🔁 Keep the upload keystore backed up; losing it (without Play App Signing)
  means you can never update the app.

---

## Known non-blockers / follow-ups
- IPv6-only networks: the connection filter currently drops IPv6 (forces IPv4).
  Documented in [ANDROID.md](ANDROID.md) §7.
- Reboot VPN auto-restart is intentionally manual (no `RECEIVE_BOOT_COMPLETED`).
- App-blocking package coverage is fully researched as of 0.54 (see the
  dataset in `engine/data/android/` — 1,545 verified packages covering 1,474
  brands; 777 brands verified `no_app`; 283 `shared_app` platform storefronts;
  only 38 still `needs_review`).
