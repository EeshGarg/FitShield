# android/ — the native Android app

A thin native adapter: Kotlin hosts a WebView that runs the same web UI as the
browser extension, plus an opt-in `AccessibilityService` that notices when a
blocked **food-delivery or fast-food app** reaches the foreground and shows a
pause screen. It blocks **apps only** (by package name) — no websites, no VPN, no
network (`INTERNET` is not requested). Behaviour, permissions, privacy and the
device test checklist are in [`docs/ANDROID.md`](../docs/ANDROID.md); the runtime
flow diagram is in [`ARCHITECTURE.md`](../ARCHITECTURE.md#3-android-runtime).

Package `com.usha.fitshield` (the Play application id is `com.FitShield.UshaCorporation`; see
`app/build.gradle`). `minSdk 26`, `targetSdk 36`, Gradle project rooted here.

## Layout

```
android/
├── build.gradle, settings.gradle, gradle.properties, gradlew(.bat), gradle/   Gradle project + wrapper
├── keystore.properties          LOCAL, git-ignored: release signing (never commit)
├── web-src/android-shim.js      the ONE Android-authored shared UI file (canonical copy)
└── app/
    ├── build.gradle             versionName injected from extension/manifest.json; versionCode per release
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml
        │   ├── java/com/usha/fitshield/   Kotlin sources (below)
        │   ├── res/                       strings, themes, launcher icon (generated), accessibility_service_config.xml
        │   └── assets/
        │       ├── android-packages.json  GENERATED: brandId -> packageIds (from data/)
        │       └── web/                   the WebView UI bundle (below)
        └── androidTest/…/PackageMatcherTest.kt   instrumented test, run on a device/emulator
```

`android/app/build/`, `.gradle/` and `local.properties` are build output and are
git-ignored.

## Kotlin, file by file

All under `app/src/main/java/com/usha/fitshield/`.

| File | Role |
| --- | --- |
| `MainActivity.kt` | Hosts the WebView on `https://appassets.androidplatform.net/assets/…` via `WebViewAssetLoader`; wires the bridge; settings import/export; notification-permission request. |
| `WebAppBridge.kt` | The `@JavascriptInterface` object exposed to the UI as `Android`: key/value storage over `SharedPreferences "fitshield"`, permission and consent status, opening system settings, `blockableApps()`, keep-alive toggle, export/import. |
| `FitShieldAccessibilityService.kt` | Receives `TYPE_WINDOW_STATE_CHANGED`, reads **only** the foreground package name, applies loop/cooldown guards, sends the blocked app home and launches `BlockActivity`. |
| `PackageBlocklist.kt` | Loads `assets/android-packages.json`; `match(packageName)` returns the brand (O(1) map lookup). |
| `AppBlockPolicy.kt` | `shouldBlock(brand)`: master switch, per-app allow list, category toggle, schedule window, temporary unlock — read from the same `SharedPreferences` the UI writes. Also records unlocks. |
| `Schedule.kt` | Pure schedule arithmetic (`withinWindow`, `parseMinutes`). Imports nothing from Android so the Node test suite can compile and run it. |
| `BlockActivity.kt` | The pause screen: a second WebView (`block.html`) with its own `BlockBridge` (`getInfo`, `unlock`, `leave`, `openFitShield`) and the interruption counter. |
| `AppBlockKeepAliveService.kt` | Opt-in, off-by-default `specialUse` foreground service with a minimal notification, for phones that freeze idle apps. Does no work. |

## The web UI bundle (`app/src/main/assets/web/`)

| Files | Origin |
| --- | --- |
| `index.html`, `app.js`, `block.html`, `block.js`, `fitshield.css`, `theme.js` | **Authored here** — the Android main screen and pause screen. |
| `android-shim.js` | **Copied** from `android/web-src/android-shim.js`. Implements the platform-agnostic `fitshield.*` façade over the `Android` bridge (the extension's `browser-shim.js` plays the same role over `chrome.*`). |
| `i18n.js`, `languages.js`, `ambient.js`, `recipes.js`, `icon-128.png`, `data/recipes.json`, `_locales/` (83 locales) | **Copied** from `extension/` and `data/`. |

Never edit a copied file in `assets/web/`; edit its source and run
**`npm run sync`** (`tools/sync-extension.js`, which calls `bundleWeb()`, defined in
`tools/lib/android-web.js` and re-exported by `tools/build-android.js`; `npm run build:android` runs the same copy).
The copy list is `WEB_COPIES` / `WEB_DIR_COPIES` in that file. Drift is caught by
`tools/android-audit.js` (`npm run validate:android`) and `test/android-shim.test.js`.

`assets/android-packages.json` is likewise generated: edit `data/android/*.json`,
then run `npm run build:android`, which regenerates `data/generated/android-packages.json`
and writes the slim bundled map (see [`data/README.md`](../data/README.md)).
(`npm run generate:android-packages` refreshes only `data/generated/`, with no SDK needed; `npm run build:android` also refreshes the bundled copy.)

## Build commands

Run from the repository root.

| Command | Does |
| --- | --- |
| `npm run toolchain:android` | One-time: fetches a JDK 17 and the Android SDK into `~/.fitshield-toolchain` (outside the repo; nothing system-wide). |
| `npm run validate:android` | Android audit: permissions, no data fork, web bundle drift, dangling i18n keys. Also part of `npm run validate` and `npm test`. |
| `npm run build:android` | Validates, stages `dist/android/` and, when the toolchain is present, builds a **debug** APK `dist/android/FitShield-<version>-debug.apk`. Never fakes success without tooling. |
| `node tools/build-android.js --bundle --versionCode=N` | Signed release AAB (`FitShield-<version>-<N>.aab`); needs `android/keystore.properties`; refuses an unsigned or non-compliant bundle. `N` is never defaulted and must strictly increase. |
| `npm run icon:android` | Regenerates the adaptive-icon layers from `brand/fitshield-f-512.png` ([`brand/README.md`](../brand/README.md)). |
| `adb install -r dist/android/FitShield-<version>-debug.apk` | Install a debug build. |

Release steps: [`docs/PLAY_STORE_RELEASE_CHECKLIST.md`](../docs/PLAY_STORE_RELEASE_CHECKLIST.md)
and [`docs/PLAY_1.0_RESUBMISSION.md`](../docs/PLAY_1.0_RESUBMISSION.md).

## Where the tests live

Everything runs under `node --test` from the repo root — see
[`test/README.md`](../test/README.md). The `test/android-*.test.js` files drive
the real web assets in a small WebView stand-in; `Schedule.kt` is compiled and
executed by the Kotlin harness when a JDK is available. `PackageMatcherTest.kt`
here is the only on-device test. What no machine here can do — the accessibility
flow on a physical phone — is listed in `docs/ANDROID.md` §8.
