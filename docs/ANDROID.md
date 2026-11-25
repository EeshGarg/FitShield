# FitShield on Android

_Accurate as of FitShield 1.0 (2026-11-25). Update this file in the same change
as any behaviour it describes. FitShield 1.0 is the final feature release; the
project is in maintenance mode afterwards._

> **What changed in 1.0 (read this first).** Google Play rejected 0.56
> (versionCode 8): _"Use of VpnService is not a permitted use case."_ FitShield
> 1.0 removes the `VpnService` and everything that existed to serve it — the
> userspace packet filter, the boot receiver and restore notice, the generated
> host-rules asset, and the `INTERNET` and `RECEIVE_BOOT_COMPLETED` permissions.
>
> **The Android app now blocks food-delivery and fast-food _apps_ only**, through
> an opt-in `AccessibilityService` that reads only the foreground package name.
> **It does not block websites.** Website blocking is the job of the FitShield
> browser extension (Chrome, Firefox, and Firefox for Android), which is
> unchanged. History written about the VPN filter in older release notes
> (`changelog/0.53.md` – `changelog/0.57.md`) was accurate when written and is not
> rewritten.

Schedules, the pause timer, categories, per-app allow, the opt-in keep-alive,
83 locales, settings export/import and all stored data are unchanged; an
install over 0.56 keeps its preferences.

## At a glance

| | |
| --- | --- |
| **What** | A native Android app that interrupts food-delivery and fast-food **apps** (not websites) with a pause screen and a home-cooked alternative. Fully offline: no `INTERNET` permission. |
| **Where** | [`android/`](../android/README.md) — Kotlin in `android/app/src/main/java/com/usha/fitshield/`, web UI in `android/app/src/main/assets/web/` |
| **Key files** | [`FitShieldAccessibilityService.kt`](../android/app/src/main/java/com/usha/fitshield/FitShieldAccessibilityService.kt) (foreground package) → [`AppBlockPolicy.kt`](../android/app/src/main/java/com/usha/fitshield/AppBlockPolicy.kt) (decision) → [`BlockActivity.kt`](../android/app/src/main/java/com/usha/fitshield/BlockActivity.kt) (pause screen); [`WebAppBridge.kt`](../android/app/src/main/java/com/usha/fitshield/WebAppBridge.kt) connects the WebView UI to `SharedPreferences` |
| **Data** | [`data/android/*.json`](../data/README.md) → generated `android-packages.json` (brand → package ids) |
| **Build** | `npm run build:android` (debug APK), `node tools/build-android.js --bundle --versionCode=N` (signed AAB) — see [§6](#6-build) |
| **Diagrams** | runtime flow: [ARCHITECTURE.md](../ARCHITECTURE.md#3-android-runtime) |

---

## 1. Two ways FitShield reaches Android

| Path | What it is | What it blocks |
| --- | --- | --- |
| **A. Firefox for Android** | the same extension, via `declarativeNetRequest` (Firefox 142+) | **websites**, in that browser |
| **B. Native Android app** | a native adapter: a WebView UI plus Kotlin | **apps** (food-delivery and fast-food), by package name |

The native app shares the extension's UI code, catalog and locales; it does not
bundle the extension's blocking engine and has no host matcher of its own.

```
data/blocklists/*.json ─┬─▶ FS Engine/ ─▶ extension (website blocking)
                        │
data/android/*.json ────┴─▶ tools/generate-android-packages.js
                              ─▶ data/generated/android-packages.json
                              ─▶ android/app/src/main/assets/android-packages.json
                                 (brandId -> packageIds; read by PackageBlocklist.kt)
```

Native sources live in `android/app/src/main/java/com/usha/fitshield/`:

| File | Role |
| --- | --- |
| `MainActivity.kt` | WebView host: loads the shared UI, import/export, permission screens |
| `WebAppBridge.kt` | the `@JavascriptInterface` the UI talks to (preferences, statistics, permission status) |
| `FitShieldAccessibilityService.kt` | foreground-package detection and launch of the pause screen |
| `PackageBlocklist.kt` | package id → brand lookup from the bundled dataset |
| `AppBlockPolicy.kt` | enable flag, per-category toggles, per-app allow, unlocks, schedule decision |
| `Schedule.kt` | the schedule window arithmetic |
| `BlockActivity.kt` | the pause screen (a WebView on the shared design system) |
| `AppBlockKeepAliveService.kt` | the opt-in, off-by-default `specialUse` foreground service |

---

## 2. UI architecture — one web UI, a `fitshield.*` platform layer

The UI is the same web codebase as the extension. It calls a platform-agnostic
`fitshield.*` façade: `browser-shim.js` delegates to `chrome.*` in the
extension, `android-shim.js` delegates to `WebAppBridge` in the app. Engine and
platform are the two boundaries; UI code targets those names, not raw APIs.

- **Main toggle.** On Android the "Enable FitShield" switch controls **app
  blocking** (preference `appBlockingEnabled`). It defaults to on, which grants
  nothing by itself: with no accessibility service there is nothing to act on it.
- **Controls kept:** per-category toggles, searchable per-app allow list,
  schedule, pause timer, temporary-unlock duration, keep-alive, theme, language,
  settings export/import, statistics.
- **Controls gone:** the site-blocking status row, "Always-allow domains",
  "Custom URLs" and the domain tester — they only ever fed the connection filter.
- **Statistics** are one counter — ordering pages interrupted — plus a per-app
  count (`blockedByApp`; the counter is `blockedVisits`), kept in the app's private
  `SharedPreferences`. No savings and no calorie figure is computed or stored.

### Intentional Android deviations from the extension

- No website blocking on Android (see above); the extension blocks sites.
- No block page for websites, no country-based site policy, no Custom URLs.
- The pause screen suggests an alternative matched to the blocked **brand**; it
  does not know the user's diet, allergens or kitchen (the Android app asks for
  none), and it shows title, total time and description rather than the
  extension's full recipe card.
- A temporary pass is scoped to the single brand that was opened; the pause
  screen does not state its duration.
- Schedule boundaries match the extension exactly: inclusive start, exclusive
  end, and `start == end` means all day (`Schedule.withinWindow`).
- `timerSeconds` is held to 10–900 and the pass length to 1–240 minutes, the same
  ranges the extension's core enforces.

---

## 3. App blocking (AccessibilityService)

When a blocked food-delivery or fast-food app comes to the foreground,
FitShield shows a native pause screen ([BlockActivity]) that mirrors the browser
block page.

**Data pipeline (one source of truth, no duplication):**

```
data/blocklists/*.json  (canonical brands)
        +
data/android/delivery-apps.json + fast-food-apps.json  (brandId -> packageIds only)
        │  tools/generate-android-packages.js (deterministic)
        ▼
data/generated/android-packages.json ── bundled ──▶ assets/android-packages.json
        │ tools/validate-android-packages.js          │ PackageBlocklist.kt (O(1) lookup)
```

- Each entry references a brand by its canonical source domain (`brandId`), so
  every package maps to exactly one blocklist brand; display metadata is
  generated from the blocklists, never re-authored.
- A package ID that is not confidently known uses `packageStatus:"needs_review"`
  with empty `packageIds` (**never guessed**). Terminal statuses: `active`
  (confirmed packages), `no_app` (verified no official Android app) and
  `shared_app` (the brand's official app is another blocked brand's package).
- **Coverage:** 2,505 curated brands; 1,512 unique package IDs across 1,446
  brands; 757 `no_app`; 266 `shared_app`; 36 `needs_review`. These are re-derived
  from the data by `test/play-release.test.js`; the full table is in
  [PLAY_STORE_RELEASE_CHECKLIST.md §9](PLAY_STORE_RELEASE_CHECKLIST.md#9-app-blocking-coverage-numbers-re-derived).
  `shared_app` and `needs_review` brands carry no package, so on Android they are
  not blocked at all — do not describe app coverage as catalog coverage.
- `tools/port-android-apps.js` (`npm run port:android-apps`) mirrors every
  enabled brand into the app files, preserving confirmed package IDs.
- **Categories** come from each brand's source `category` (coffee / dessert /
  grocery / restaurant / meal_kit, else the file default delivery / fast_food)
  and drive the per-category toggles. The groupings, the pills, the `CATS` map in
  `web/app.js` and `AppBlockPolicy.categoryEnabled` are held to each other by
  `test/android-controls.test.js`.

**Runtime flow:**

1. `FitShieldAccessibilityService` receives `TYPE_WINDOW_STATE_CHANGED` and reads
   **only the foreground package name** (`canRetrieveWindowContent="false"`).
2. `PackageBlocklist.match(pkg)` finds the brand; `AppBlockPolicy` checks the
   enable flag, the category toggle, the per-app allow, the schedule window and
   any active temporary unlock.
3. To block, the service first sends the blocked app home
   (`performGlobalAction(GLOBAL_ACTION_HOME)`) and then launches `BlockActivity`
   — otherwise a running app would re-launch itself over the pause screen.
4. `BlockActivity` shows the brand, the reason, the schedule status, the
   interruption count, a quick alternative, a reflection countdown, a localized
   "Learn more" link to fitshield.net, and **Not now** / **Open anyway** /
   **Open FitShield**.
5. **Not now** goes to the launcher. **Open anyway** grants a temporary unlock
   and re-opens the app by its launch intent. The interruption is counted when
   the pause appears, so "Open anyway" does not escape the count. A narrowly
   scoped `<queries>` (MAIN/LAUNCHER only, **not** `QUERY_ALL_PACKAGES`) lets the
   launch intent resolve.

**Loop and battery safety:** own-package events are ignored; a per-package
cooldown debounces repeats; the service exits early when app blocking is off;
`BlockActivity` is its own task, excluded from recents.

**Overlay permission (opt-in):** `SYSTEM_ALERT_WINDOW` lets the pause screen
launch reliably over a blocked app (background-activity-launch exemption). It is
optional, and FitShield never draws an overlay window.

**Background protection (opt-in, OFF by default):** the accessibility service is
system-bound and re-bound by Android, including after a restart, so app blocking
needs no help. For phones that aggressively freeze idle apps, an opt-in "Extra
reliability" toggle starts `AppBlockKeepAliveService`, a `START_STICKY`
`specialUse` foreground service that only shows a quiet `IMPORTANCE_MIN`
notification. It does no work and reads nothing.

Force-stopping the app makes Android drop the AccessibilityService; app blocking
stays off until the user re-enables it in system Accessibility settings. The
dashboard says so rather than failing silently.

---

## 4. Privacy

- **No network at all.** The manifest does not request `INTERNET`; the app
  cannot open a connection. No telemetry, no accounts, no analytics.
- The `AccessibilityService` is opt-in, reads only the foreground package name,
  and uses it in memory; nothing is logged in release builds or transmitted.
- Settings and statistics live in private `SharedPreferences`;
  `android:allowBackup="false"` keeps them off Google's cloud backup.
- Content stays behavioural: FitShield is a decision-friction tool, not a medical
  or weight-loss product.

The Data safety answers and the accessibility disclosure wording are in
[PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md).

---

## 5. Permissions

### Native app (Android OS permissions)

| Permission | Why |
| --- | --- |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` | the optional keep-alive service (Android 14+ requires the type) |
| `POST_NOTIFICATIONS` | the keep-alive's quiet notification (Android 13+) |
| `SYSTEM_ALERT_WINDOW` | optional; lets the pause screen launch over a blocked app |
| `BIND_ACCESSIBILITY_SERVICE` (on the `<service>`) | the OS gate for the opt-in app-blocking service |

Not requested: `INTERNET`, `RECEIVE_BOOT_COMPLETED`, `BIND_VPN_SERVICE`,
`QUERY_ALL_PACKAGES`, `PACKAGE_USAGE_STATS`, location, contacts, phone, SMS,
storage, camera, microphone. `tools/android-audit.js` and
`test/play-release.test.js` hold the manifest to this list.

### Browser path

The extension requests exactly `storage`, `declarativeNetRequest` and `alarms`.

---

## 6. Build

### Browser

`node build.js` → `dist/chrome/`, `dist/firefox/` and the store zips. The build is
validation-gated (it includes the Android audit).

### Native Android app

- `npm run validate:android` — the Android audit (also part of `npm run validate`
  and `npm test`).
- `npm run build:android` — validates, stages `dist/android/` (`BUILD.txt` with the
  exact local command and a device-test checklist) and, if the Android toolchain
  is present, builds a **debug** APK to `dist/android/FitShield-<version>-debug.apk`.
  It never fakes success when tooling is absent. `npm run toolchain:android`
  provisions a JDK and the Android SDK.
- `node tools/build-android.js --bundle --versionCode=<int>` builds the signed
  release AAB (`dist/android/FitShield-<version>-<versionCode>.aab`) and fails
  rather than report success if it comes out unsigned. Release signing is
  described in [PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md) §3.
- **Version:** every output uses the single `extension/manifest.json` version
  (`-PfitshieldVersionName` is injected), so the platforms never diverge.
  Recorded pairs: 0.54 ↔ 1, 0.56 ↔ 8 (rejected), **1.0 ↔ 10** (an earlier 1.0 build used 9 and is superseded; never reuse 9 or 10).
- Install a debug build: `adb install -r dist/android/FitShield-<version>-debug.apk`.

### Manual device test checklist (native app)

- [ ] Installs over 0.56 with the user's settings intact; no VPN entry remains.
- [ ] Enable FitShield; open the app-blocking panel; read the disclosure; enable
      the accessibility service; open a blocked food app → the pause screen
      appears and stays.
- [ ] Not now / Open anyway (timer, then a temporary unlock scoped to that app).
- [ ] A non-food app is never interrupted; no accessibility/overlay loop.
- [ ] Schedule on/off, per-app allow, keep-alive on/off, battery optimisation.
- [ ] A browser opens a blocked brand's website normally (Android does not block
      websites).
- [ ] Reboot with app blocking on: blocking is back without opening FitShield.

---

## 7. Security

**Trust assumptions.** The OS enforces the accessibility permission model; the
device is not rooted.

**Threat notes.** The app is cooperative, not enforced: a user can disable the
accessibility service, force-stop or uninstall. That is by design — FitShield is a
decision-friction tool, and it says so. The service reads no screen content and
the app has no network permission, so there is nothing to exfiltrate and no
remote surface to attack. Release builds are not minified, deliberately: the
project ships auditable source.

**Platform limitations.** Coverage is curated: only brands with a confirmed app
package are blocked as apps, and the app cannot block a brand it has no package
for. OEM battery managers may pause the accessibility service; the opt-in
keep-alive and the battery-optimisation shortcut exist for that.

---

## 8. Release documentation

Every release is recorded in [`../changelog/`](../changelog/) (canonical) and
summarised in `changelog.json`. Play submission steps are in
[PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md); the exact 1.0
resubmission actions are in [PLAY_1.0_RESUBMISSION.md](PLAY_1.0_RESUBMISSION.md).

On-device verification that this repository cannot do: the accessibility
app-block flow on a physical phone, across OEMs and Android versions.

> Maintainer note: `data/generated/android-packages.json` and the bundled
> `android-packages.json` are **generated** — never hand-edit them. After editing
> `data/android/*.json`, run `npm run generate:android-packages` (refreshes
> `data/generated/`), then `npm run build:android` (refreshes the bundled copy;
> `npm run validate:android` fails on drift until you do).
