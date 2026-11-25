# FitShield — Google Play release checklist

_Android app: `com.FitShield.UshaCorporation`. This is the operational checklist for cutting
a Play Store build. Pairs with [ANDROID.md](ANDROID.md) (how the app works),
[PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md) (disclosures
and the Data safety answers) and [STORE_LISTING_DRAFT.md](STORE_LISTING_DRAFT.md)
(copy and assets)._

> **Why this file was rebuilt (2026-08-26).** The previous version was prose with
> ✅ marks and no evidence: it asserted that things were true rather than
> recording how anyone could tell. It drifted exactly as you would expect — the
> dataset section quoted 1,545 packages over 1,474 brands with 38 `needs_review`
> against a catalog that had moved to 1,511 over 1,445 with 36, and it stated a
> target API level that Play stops accepting five days from this rewrite.
>
> Every line below is now one of two things, and the format is enforced:
>
> - **a checkbox with machine evidence** — a named test or tool that fails when
>   the claim stops being true. `test/play-release.test.js` exists for this
>   purpose; `tools/android-audit.js` runs inside `npm run validate`.
> - **a checkbox marked `HUMAN`** — something this repository physically cannot
>   do (it needs the Play Console, a signing key, a device, or a person), with
>   the exact action written out.
>
> **1.0 (2026-11-25).** Google Play rejected versionCode 8 (0.56): _"Use of
> VpnService is not a permitted use case."_ FitShield 1.0 removes `VpnService`
> entirely, together with the boot receiver and the `INTERNET` permission.
> Android now blocks food-delivery and fast-food **apps** only (through the
> opt-in AccessibilityService); Android no longer blocks websites — that stays
> with the Chrome/Firefox extension. The exact Console steps for the
> resubmission are in [PLAY_1.0_RESUBMISSION.md](PLAY_1.0_RESUBMISSION.md).
>
> A line with neither fails `test/play-release.test.js` ›
> _"every checklist line carries evidence or is marked HUMAN"_. That is the
> whole point: prose is how the numbers rotted last time.

**Play policy statements below were re-read from Google's own documentation on
2026-08-26.** Each carries its source. Re-check before each submission — Play
policy moves and this file is a snapshot.

---

## 0. Gates that decide whether a submission is even accepted

These five get a submission rejected, blocked, or — in the last case — quietly
uninstallable months after it ships. Everything else in this file is downstream
of them.

- [ ] **Developer account type.** `HUMAN — Play Console.` As of 1.0 the app
      declares no `VpnService`, so Google's organization-account requirement for
      VPN apps no longer applies. A personal account created after 13 November
      2023 must still run a closed test with 12 testers opted in for 14
      continuous days before it can apply for production access; an account that
      is not subject to that requirement may publish straight to production.
      Source: [App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465).

- [x] **Target API level.** Play requires **API 36 (Android 16) for new apps and
      updates submitted from 31 August 2026**; API 35 is accepted only until
      then, with an extension available to 1 November 2026.
      Source: [Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878).
      The repository sets **`compileSdk 36` / `targetSdk 36`**, so the deadline is
      met whenever the submission lands. `tools/android-audit.js` fails the build
      below 36.
      _Evidence: `test/play-release.test.js` › "the checklist states the SDK level the build actually sets"
      and "the checklist names the target-API deadline in force" — the doc cannot
      claim one level while `android/app/build.gradle` sets another._

- [ ] **A release AAB, not an APK.** Play has required an Android App Bundle for
      new apps since August 2021 — Google's own size limits page still carries
      the tell, capping APK downloads "only applicable to apps created before
      August 2021". FitShield is a new app, so an APK is not an upload format it
      has.
      Source: [Download size limits](https://support.google.com/googleplay/android-developer/answer/9859152).
      `node tools/build-android.js --bundle --versionCode=<int>` produces the
      signed bundle at `dist/android/FitShield-<version>-<versionCode>.aab`, and
      fails rather than reporting success if it comes out unsigned. §3 has the
      signing steps it still needs from you.
      _Evidence: `test/play-release.test.js` › "the checklist does not claim a release-bundle command the tooling does not have"._

- [x] **No `VpnService` anywhere in the manifest, for every artifact on every
      track.** Play's rejection of versionCode 8 said exactly this: remove the
      service element "for all artifacts across all release tracks". 1.0
      removes the service, `BIND_VPN_SERVICE`, the boot receiver and `INTERNET`.
      Any earlier release still live on a track keeps the violation until it is
      replaced or deactivated — see
      [PLAY_1.0_RESUBMISSION.md](PLAY_1.0_RESUBMISSION.md). No VpnService
      declaration form is filed or needed.
      _Evidence: `test/play-release.test.js` — the manifest tests assert the declared permission set and the absence of the VPN service._

- [ ] **Register the package name for Android developer verification.**
      `HUMAN — Play Console home page.` From **30 September 2026**, an app not
      tied to a verified developer identity will not install on certified Android
      devices in Brazil, Indonesia, Singapore and Thailand, with more countries
      following. Play auto-registers most apps, so this is usually a check rather
      than a task — but check it, and note that it covers **sideloaded APKs too**,
      which matters here because the debug APK is handed to testers directly.
      Sources: [Registering Play package names](https://support.google.com/googleplay/android-developer/answer/16984799)
      and [Android developer verification](https://developer.android.com/developer-verification/guides).

---

## 1. Build configuration

- [x] **`applicationId com.FitShield.UshaCorporation`** — the Play identity, and
      the listing this ships to. It can never change after first publish; it was
      changed from `com.usha.fitshield` before any publish, when the listing moved
      to a new app in the Console, and that is the only window in which it could
      have been.
      The **`namespace` stays `com.usha.fitshield`** on purpose. That is the code
      package — the R class, every Kotlin `package` line, the component names the
      manifest points at and the test harness entry point all live under it, and
      AGP keeps the two separate so a store identity can change without renaming
      a source file. So the installed component is
      `com.FitShield.UshaCorporation/com.usha.fitshield.MainActivity`, and both
      strings appearing in the bundle is correct rather than a leftover.
      Note the case: an applicationId is compared literally.
      _Evidence: `test/play-release.test.js` › "the applicationId the checklist names is the one the build sets"._
- [x] **`minSdk 26`** (Android 8.0).
      _Evidence: `test/play-release.test.js` › "the checklist states the minSdk the build sets"._
- [x] **`compileSdk 36` / `targetSdk 36`**, and they agree with each other.
      `tools/android-audit.js` fails the build if either drops below 36.
      _Evidence: `test/play-release.test.js` › "the checklist states the SDK level the build actually sets"._
- [x] **API 36 bump — done 2026-08-26.** Versions checked against Google's own
      compatibility table ([About AGP](https://developer.android.com/build/releases/about-agp)):
      | File | Now holds | Was | Why |
      | --- | --- | --- | --- |
      | `android/app/build.gradle` | `compileSdk 36`, `targetSdk 36` | `35`, `35` | the Play gate |
      | `android/build.gradle` | AGP `8.9.1` | `8.6.0` | **AGP 8.9.1 is the minimum that supports `compileSdk 36`** |
      | `android/gradle/wrapper/gradle-wrapper.properties` | Gradle `8.11.1` | `8.7` | AGP 8.9 requires it |
      | `tools/android-audit.js` | `< 36` fails | `< 35` fails | so the gate keeps meaning something |
      Android 16's headline behaviour change for a target-36 app is that
      **edge-to-edge can no longer be opted out of**. FitShield already runs
      edge-to-edge deliberately, so this cost nothing. `window.statusBarColor` /
      `navigationBarColor` are no-ops from API 35+; the app sets them transparent,
      which is what the system now does anyway.
      _Evidence: `test/android-release-hardening.test.js` › "the audit accepts this build's API level and would reject a lower one"._
- [x] **`minifyEnabled false`** — deliberate. FitShield ships readable, auditable
      code and R8 is not a Play requirement. State this in the reviewer notes so
      it does not read as an oversight.
      _Evidence: `test/play-release.test.js` › "release hygiene: no debug artefacts, minification stated honestly"._
- [x] **AGP 8.9.1 / Gradle 8.11.1 / Kotlin 1.9.24 / JDK 17** — the versions the
      repository actually pins.
      _Evidence: `test/play-release.test.js` › "the checklist states the toolchain versions the repository pins"._
- [x] **16 KB memory page sizes.** Required for updates from **1 February 2027**
      for apps targeting API 35+ on 64-bit devices. Google's own wording: _"If
      your app only uses code written in the Java programming language or in
      Kotlin, including all libraries or SDKs, then your app already supports
      16 KB devices."_ FitShield has **no native code at all** — no `.so`, no
      `jniLibs`, no `externalNativeBuild`, no NDK block, and its three
      dependencies are AndroidX. So it is compliant by construction, not by
      configuration.
      Source: [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes).
      _Evidence: `test/play-release.test.js` › "the app carries no native code, so the 16 KB page-size rule is satisfied by construction"._
- [x] **64-bit support.** Required since August 2019 for any app containing
      native code. FitShield contains none, so there is nothing to provide and
      nothing to get wrong — the same fact that settles the 16 KB rule settles
      this one.
      _Evidence: `test/play-release.test.js` › "the app carries no native code, so the 16 KB page-size rule is satisfied by construction"._
- [ ] **Check the bundle size against Play's 200 MB base-module limit.**
      `HUMAN — measure your own output.` It will not be close: the app ships no
      native code, no media, and its largest assets are 83 locale files and two
      JSON datasets. Worth measuring once so the number is known rather than
      assumed.
- [ ] **Run the Play pre-launch report on a 16 KB device image anyway.**
      `HUMAN — Play Console, internal testing track.` Compliance by construction
      is not the same as tested.

## 2. Versioning

- [x] **One `versionName` across every platform.** `tools/build-android.js`
      injects `-PfitshieldVersionName` from the canonical
      `extension/manifest.json`, so the Android build cannot drift from the
      extension.
      _Evidence: `test/play-release.test.js` › "the Android build takes its versionName from the canonical manifest"._
- [ ] **`versionCode` strictly increases on every upload.** `HUMAN — supplied per
      release as `-PfitshieldVersionCode=<int>`.` It defaults to `1` and the
      default exists only for a bare `gradlew` run; **never upload a build that
      used the default twice.** Play rejects a re-used `versionCode` and there
      is no way to reclaim one.
- [ ] **Record the `versionName` ↔ `versionCode` pair** in
      `changelog/<versionName>.md` at upload time (1.0 ↔ 9; 0.56 ↔ 8 was the
      rejected build and is burned). `HUMAN — the pair is only
      known once you choose it.`
- [x] The version is stated identically in `extension/manifest.json`,
      `package.json`, `changelog.json` and `changelog/<version>.md`.
      _Evidence: `test/docs-claims.test.js` › "manifest, package.json and changelog.json agree on the version"._

## 3. Signing and the release bundle

**What the repository does automatically:** nothing that touches a key. Release
signing is read at build time from a gitignored `android/keystore.properties`
(or `-P` properties, or environment variables). If none is present, the release
build is left **unsigned** — a deliberate safe default, not a failure.

- [x] **No keystore, password or upload key is committed, and cannot be.**
      `.gitignore` covers `keystore.properties`, `android/keystore.properties`,
      `*.jks`, `*.keystore`, `*.apk` and `*.aab`.
      _Evidence: `test/play-release.test.js` › "no signing material is tracked, and the ignore rules that keep it out are present"._
- [ ] **Create the upload keystore once, and store it outside the repository.**
      `HUMAN — only you can hold this key.`
      ```
      keytool -genkeypair -v -keystore fitshield-upload.jks -alias fitshield \
        -keyalg RSA -keysize 2048 -validity 10000
      ```
      Back it up somewhere you will still have in five years. Without Play App
      Signing, losing it means you can never update the app again.
- [ ] **Write `android/keystore.properties`** (gitignored) with exactly these
      four keys. `HUMAN — it holds your passwords.`
      ```
      storeFile=/absolute/path/to/fitshield-upload.jks
      storePassword=...
      keyAlias=fitshield
      keyPassword=...
      ```
      Equivalent `-P` form:
      `-PFITSHIELD_STORE_FILE=… -PFITSHIELD_STORE_PASSWORD=… -PFITSHIELD_KEY_ALIAS=… -PFITSHIELD_KEY_PASSWORD=…`
      _Evidence for the key names: `test/play-release.test.js` › "the four signing property names the checklist gives are the four the build reads"._
- [ ] **Enable Play App Signing** in the Console. `HUMAN — Play Console.`
      Your keystore then becomes the *upload* key and Google holds the app
      signing key, which is the only configuration where losing your key is
      recoverable.
- [ ] **Build the release bundle.** `HUMAN — supply the key; the command is in the repository.`
      ```bash
      node tools/build-android.js --bundle --versionCode=<strictly-increasing-int>
      # -> dist/android/FitShield-<version>-<versionCode>.aab
      ```
      It regenerates the rules, re-bundles the shared web assets, runs the
      Android audit, then runs `:app:bundleRelease` with the canonical
      `versionName` and the `versionCode` you gave it. `--versionCode` is
      required and never defaulted: Play rejects a re-used one and there is no
      way to reclaim it. **An unsigned bundle fails the command** — it reads the
      JAR signature block out of the `.aab` it just produced and exits 1 when it
      is absent, rather than reporting success over a file Play will refuse.
      `npm run toolchain:android` installs the JDK and the Android SDK (API 36
      platform + build-tools 36) into `~/.fitshield-toolchain`, so the whole gap
      between this repository and a Play-ready artefact is one signing key that
      only you can hold.
      _Evidence: `test/android-release-hardening.test.js` › "an unsigned bundle fails the build instead of reporting success" and "the bundle command refuses to guess a versionCode"._
- [ ] **Verify the bundle is signed** before uploading. `HUMAN — run it against
      your own output.`
      ```
      jarsigner -verify app/build/outputs/bundle/release/app-release.aab   # expect "jar verified"
      ```
      An unsigned bundle is what you get when `keystore.properties` was missing
      or mistyped, and Play's error message for it is not obvious.

## 4. Release hygiene — no development artefacts ship

- [x] **WebView remote debugging is off in release.**
      `setWebContentsDebuggingEnabled(true)` is guarded by `BuildConfig.DEBUG` in
      both `MainActivity` and `BlockActivity`.
      _Evidence: `tools/android-audit.js` (fails an unguarded call) and `test/play-release.test.js` › "release hygiene: no debug artefacts, minification stated honestly"._
- [x] **No package names or blocking decisions reach release logcat.** WebView
      console logging and any per-event logging are inside `if (BuildConfig.DEBUG)`.
      _Evidence: `test/play-release.test.js` › "release hygiene: no debug artefacts, minification stated honestly"._
- [x] **The manifest never forces `android:debuggable="true"`.** AGP sets it false
      for release.
      _Evidence: `tools/android-audit.js` and `test/play-release.test.js` › "release hygiene: no debug artefacts, minification stated honestly"._
- [x] **No dev URLs, `localhost`, `10.0.2.2` or other development endpoints in
      `src/main/`.** This line used to credit `tools/android-audit.js`, which has
      never looked for one — an assertion citing nothing, which is the failure
      this rewrite exists for. It is now actually checked.
      _Evidence: `test/play-release.test.js` › "no development endpoint is reachable from the shipped source set"._
- [x] **Instrumented tests live in `src/androidTest/`** and are not packaged into
      a release build.
      _Evidence: `test/play-release.test.js` › "instrumented tests stay out of the shipped source set"._

## 5. Permissions

Every permission the app declares, why it exists, and what the user sees. This
table is checked against the manifest — adding a permission without adding a row
fails the test, and so does the reverse.

| Permission | Why | What the user sees |
| --- | --- | --- |
| `FOREGROUND_SERVICE` | the optional keep-alive runs as a foreground service | an ongoing notification, *if* notification permission was granted — see below |
| `FOREGROUND_SERVICE_SPECIAL_USE` | required on Android 14+ for the `specialUse` FGS type the keep-alive declares | — |
| `POST_NOTIFICATIONS` | the opt-in keep-alive's foreground-service notification (Android 13+) | nothing — see below |
| `SYSTEM_ALERT_WINDOW` | optional "display over other apps", so the block screen launches reliably over a blocked app | user-granted in system settings, explained in-app |

**Not requested, as of 1.0:** `INTERNET` (the app has no network code and makes
no connection at all), `RECEIVE_BOOT_COMPLETED` (there is nothing to restore —
the accessibility service is re-bound by Android itself, and no connection
filter exists), and `BIND_VPN_SERVICE` (no `VpnService`). They were removed
together with the VPN service for Play policy compliance.

**`POST_NOTIFICATIONS` is requested at runtime, at the moment it can be
justified.** If the user declines, or turns notifications off later, the
dashboard says so rather than leaving it to be discovered, and the only thing
that changes is that the opt-in keep-alive's quiet notice does not appear; app
blocking itself is unaffected.

_Evidence: `test/play-release.test.js` › "the docs say whether the app can actually post a notification"; `test/android-release-hardening.test.js` › "POST_NOTIFICATIONS is requested at runtime, not merely declared"._

**`SYSTEM_ALERT_WINDOW` never actually draws an overlay, and saying so is worth
more than justifying one.** The app holds the permission only for the
side effect that holding it grants: on Android 10+ an app with "display over
other apps" may start an activity from the background, which is what lets the
pause screen appear over a blocked app. FitShield never constructs a
`TYPE_APPLICATION_OVERLAY` window and never calls `WindowManager.addView` — the
only place the permission is touched at all is a `Settings.canDrawOverlays()`
check in `WebAppBridge`, used to tell the user whether the feature will be
reliable. Nothing is ever drawn on top of another app's UI.

**Expect the permission profile itself to draw attention.**
`AccessibilityService` + "display over other apps" + a foreground service is
still a combination a reviewer will look at twice. Get in front of it in the
reviewer notes: each is user-initiated and individually revocable, the
accessibility service cannot read window content (it receives only the
foreground package name), the overlay permission draws nothing, the foreground
service is opt-in and does no work, and the app requests no network permission
at all, so it cannot transmit anything. The individual justifications are in §7.

One more is an **OS gate declared on the service**, not requested from the user:

| Gate | On | What the user sees |
| --- | --- | --- |
| `BIND_ACCESSIBILITY_SERVICE` | `FitShieldAccessibilityService` | opt-in in system Accessibility settings |

- [x] **The manifest declares exactly those four `uses-permission` entries and no
      others**, and the audit's allowlist agrees with this table.
      _Evidence: `test/play-release.test.js` › "the permission table names exactly the permissions the manifest declares"._
- [x] **Package visibility is a scoped `<queries>` for MAIN/LAUNCHER, not
      `QUERY_ALL_PACKAGES`.** This matters twice: it is the narrower request, and
      `QUERY_ALL_PACKAGES` would trigger a Play declaration form that FitShield
      then does not have to file.
      _Evidence: `test/play-release.test.js` › "the permission table names exactly the permissions the manifest declares"._
- [x] **No overlay window is ever created**, so the "display over other apps"
      permission is held for the background-activity-launch exemption alone.
      _Evidence: `test/play-release.test.js` › "the overlay permission draws nothing, which is the strongest thing to tell a reviewer"._
- [x] **None of Play's other declaration-triggering permissions is present** —
      no SMS or call log, no `MANAGE_EXTERNAL_STORAGE`, no background location,
      no `READ_MEDIA_*`, no exact alarms, no `USE_FULL_SCREEN_INTENT`, no body
      sensors, no Health Connect, and no advertising ID. That is what makes §7's
      declaration list as short as it is.
      Source: [Permissions and APIs that access sensitive information](https://support.google.com/googleplay/android-developer/answer/16585319).
      _Evidence: `test/play-release.test.js` › "no permission is present that would pull in a further Play declaration form"._

## 6. Behaviour to verify on a device each release

These cannot be asserted from a repository. Each needs a phone.

- [ ] **A fresh install blocks nothing until the user turns it on.** `HUMAN — device.`
      Nothing is blocked before consent: app blocking is gated by the
      accessibility service, a system opt-in shown after the in-app disclosure.
      `appBlockingEnabled` itself defaults **true** — the default grants nothing
      on its own, because with no accessibility service there is nothing to act
      on it.
- [ ] **Enable/disable cycles and Accessibility toggles.** `HUMAN — device.` The
      main "Enable FitShield" switch controls app blocking.
- [ ] **Upgrade from 0.56 keeps the user's settings.** `HUMAN — device.` Install
      0.56, change a few settings, install 1.0 over it: preferences, schedules
      and per-app allows survive, and no VPN entry or VPN key remains.
- [ ] **Reboot with app blocking on.** `HUMAN — device.` Android re-binds the
      accessibility service itself; confirm blocking is back without opening
      FitShield.
- [ ] **Battery optimisation on and off**, with and without the opt-in keep-alive.
      `HUMAN — device.`
- [ ] **Keep-alive is off by default**, and when on does no work. `HUMAN — device.`
      Its quiet `IMPORTANCE_MIN` notification only appears if notification
      permission happens to have been granted — test on a fresh Android 13+
      install, where it will not have been.
- [ ] **No false blocks.** A non-food app must never be interrupted, and there
      must be no accessibility/overlay loop. `HUMAN — device.` This is also the
      first halt criterion in the rollout plan.
- [ ] **Websites are not blocked by the Android app, and the UI does not claim
      they are.** `HUMAN — device.` Open a blocked brand's website in a browser:
      it loads. Site blocking on Android is available only through the
      extension on Firefox for Android.

## 7. Play Console declarations

Everything here is `HUMAN — Play Console`. The wording is drafted so it can be
pasted, and the parts that quote the app are checked against the app.

### 7.1 `VpnService` — removed, nothing to declare

FitShield 1.0 contains no `VpnService`. If a `VpnService` declaration form was
ever filed for this app, withdraw it or let it lapse — see
[PLAY_1.0_RESUBMISSION.md](PLAY_1.0_RESUBMISSION.md).

- [ ] **Replace or deactivate every earlier artifact that still declares the
      service.** `HUMAN — Play Console.` Google's rejection applies to "all
      artifacts across all release tracks", so a still-live versionCode 8 (or
      earlier) release on production, open, closed or internal testing keeps the
      violation. Upload 1.0 (versionCode 10) to those tracks or retire the old
      releases.

### 7.2 `AccessibilityService` declaration

Mandatory, and one of the two most scrutinised declarations on the store.
Source: [Permissions and APIs that access sensitive information](https://support.google.com/googleplay/android-developer/answer/16585319).

- [x] **`isAccessibilityTool` is deliberately not claimed.** That flag is only for apps whose
      core function is to directly support people with disabilities. FitShield is
      not one, so the flag is correctly absent from
      `res/xml/accessibility_service_config.xml` and must stay absent.
      _Evidence: `test/play-release.test.js` › "the accessibility service reads only what the disclosure says it reads"._
- [ ] **Submit the Permission Declaration Form with a demo video.**
      `HUMAN — Play Console, and the video has to be recorded on a device.`
      Show, in order: the app-blocking panel with the disclosure text visible → tapping
      through to system Accessibility settings → enabling FitShield → opening a
      blocked food app → the pause screen appearing. Google wants to see the
      disclosure and the consent, not just the feature.
- [ ] **Purpose to declare.** `HUMAN — Play Console.` Paste:
      _"Detects when a food-delivery or fast-food app the
      user has explicitly selected comes to the foreground, so FitShield can show
      its pause screen. It reads only the foreground package name
      (`canRetrieveWindowContent="false"`) — never screen content, text fields,
      messages or passwords. Nothing is transmitted; the package name is used
      in-memory and is not logged in release builds. The service is off until the
      user enables it in system Accessibility settings and stops completely when
      disabled."_
- [ ] **The disclosure a user reads in system Accessibility settings is
      English-only.** `HUMAN — routed to the localization lane.`
      `accessibility_description` and `accessibility_summary` live in
      `res/values/strings.xml` and there is no `res/values-<lang>/` directory at
      all, while the app itself bundles **83** translated locales for its WebView
      UI. So the one screen where Android asks a user to grant a powerful
      permission — and the only text Google's prominent-disclosure rule can be
      satisfied by at that moment — is in a language most of the app's users did
      not choose. The strings are three short sentences; translating them into
      the locales already shipped is the whole fix.
      _Evidence: `test/play-release.test.js` › "the accessibility disclosure is available in the languages the app ships"._
- [ ] **Confirm the in-app prominent disclosure meets all five of Google's
      conditions.** It must be in the app (not only the listing), shown during
      normal use rather than buried in settings, describe the data accessed,
      explain how it is used and shared, and **require affirmative user action for
      consent**. FitShield's disclosure text is present and accurate — the
      app-blocking panel states _"It only reads which app comes to the front —
      never screen content"_ before the button that opens Accessibility settings,
      and `accessibility_description` repeats it inside the system settings screen
      — but it is passive text inside a collapsed panel, with no explicit consent
      step. **A dedicated confirm-before-you-continue disclosure step has been
      routed to the Android lane**; re-check this box against the shipped build.
      _Evidence: `test/play-release.test.js` › "the accessibility disclosure the docs quote is the text the app shows"._

### 7.3 Foreground service types

`specialUse` is reviewed by hand, and the reviewer reads the free-form subtype
string from the manifest.
Source: [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
and [Foreground service requirements](https://support.google.com/googleplay/android-developer/answer/13392821).

- [ ] **Declare the `specialUse` keep-alive service** on the App content page.
      `HUMAN — Play Console.` Quote the manifest's own justification verbatim:
      - `AppBlockKeepAliveService` — _"Keeps on-device food-app blocking
        responsive in the background"_
      The keep-alive is the weaker thing to justify, because "stay resident"
      is close to the thing FGS review exists to catch. Strengthen it in the form:
      it is **opt-in and off by default**, it exists only because some OEM battery
      managers pause the accessibility service after long idle, it posts an
      `IMPORTANCE_MIN` notification, and it performs no work of any kind while
      running. If the reviewer pushes back, the feature can be dropped without
      breaking app blocking on stock Android.
- [x] **Every `specialUse` service in the manifest (now only the keep-alive) carries a
      `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` property**, and the strings quoted above
      are the strings the manifest holds.
      _Evidence: `test/play-release.test.js` › "every specialUse foreground service declares the subtype the checklist quotes"._

### 7.4 Data safety

- [ ] **Fill in the Data safety form.** `HUMAN — Play Console.` Use the exact
      answers in
      [PRIVACY_POLICY_ANDROID_NOTES.md § Data safety — the exact answers](PRIVACY_POLICY_ANDROID_NOTES.md#data-safety--the-exact-answers).
      Short version: **no data collected, none shared**, everything on-device.
      Because collection is answered No, Play does not ask the encryption-in-
      transit or deletion-request follow-ups at all.
- [ ] **Host the privacy policy at a public URL and link it.** `HUMAN — you need
      somewhere to host it.` The content is
      [PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md); the
      listing points at fitshield.net.
- [x] **The Data safety answers match what the app actually stores and shows.**
      Android keeps settings and one counter — ordering pages interrupted — plus
      a per-app count (`blockedByApp`), in the app's private `SharedPreferences`.
      No savings figure and no calorie figure are computed or stored, and nothing
      is uploaded.
      _Evidence: `test/play-release.test.js` › "the Data safety answers match the statistics the app actually keeps"._

### 7.5 The rest of the App content page

- [ ] **Ads: No.** `HUMAN — Play Console.` There are none.
- [ ] **Advertising ID: No.** `HUMAN — Play Console.` The app declares no
      `AD_ID` permission and links no ad SDK.
- [ ] **In-app purchases: none.** `HUMAN — Play Console.`
- [ ] **Content rating questionnaire (IARC).** `HUMAN — Play Console.` Expect
      Everyone / PEGI 3.
- [ ] **Target audience: adults, not child-directed.** `HUMAN — Play Console.`
- [ ] **Government apps: No.** `HUMAN — Play Console.`
- [ ] **Health apps declaration: No.** `HUMAN — Play Console.` FitShield accesses
      no health or fitness data, requests no Health Connect or body-sensor
      permission, and makes no medical claim. If the Console's phrasing gives you
      pause, the deciding fact is that the app reads no health data of any kind.
- [ ] **Financial features: none. News: no.** `HUMAN — Play Console.`
- [ ] **App access instructions for reviewers.** `HUMAN — Play Console.` No
      account exists, so give the reviewer the path instead — the exact text is in
      [STORE_LISTING_DRAFT.md § Play Console declaration notes](STORE_LISTING_DRAFT.md#play-console-declaration-notes).
      Add: _"The release build has no minification. This is deliberate — the
      project ships auditable source."_

## 8. Store listing and assets

- [ ] **Copy** — use [STORE_LISTING_DRAFT.md](STORE_LISTING_DRAFT.md). `HUMAN — Play Console.`
- [ ] **8 phone screenshots**, captured on a real device. `HUMAN — device.` The
      shot list is in the draft.
- [ ] **Feature graphic, 1024×500.** `HUMAN — design.`
- [ ] **App icon, 512×512, for the store listing.** `HUMAN — design.`
- [x] **The app ships its own launcher icon.** An adaptive icon
      (`res/mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml`) over a
      white background, with the FitShield "F" as a vector foreground and a
      `<monochrome>` layer for Android 13+ themed icons, plus `android:icon` /
      `android:roundIcon` on `<application>`. The green is sampled from
      `extension/icons/icon-128.png`, so the two platforms wear the same mark.
      `minSdk 26` makes the `-v26` bucket reachable on every supported device,
      so no PNG density fallbacks are needed. The 512×512 store-listing icon
      above is separate and still `HUMAN — design.`
      _Evidence: `test/android-release-hardening.test.js` › "the app ships its own launcher icon, not Android's placeholder" and "the launcher icon is the mark the browser build already uses"._
- [x] **No prohibited claims anywhere in the listing** — no medical,
      addiction-treatment or guaranteed-weight-loss language, and no claim of a
      prevented order, avoided calories or money saved, because the app cannot
      observe any of them.
      _Evidence: `test/play-release.test.js` › "the store listing promises only statistics the Android app renders" and `test/docs-claims.test.js` › "Android's block screen matches on the brand but not on the person"._

## 9. App-blocking coverage (numbers, re-derived)

Stated as of **2026-11-25**, from `data/generated/android-packages.json`. These
are asserted against the data, never against another document — the previous
version of this file quoted a catalog that had moved on twice.

| Figure | Count |
| --- | --- |
| Curated brands in the blocklists | 2,505 |
| Brands with an Android port record | 2,505 |
| Brands that carry at least one app package | 1,446 |
| Unique Android package IDs bundled | 1,512 |
| Brands verified as having no app (`no_app`) | 757 |
| Brands whose only app is a shared platform storefront (`shared_app`) | 266 |
| Brands still `needs_review` | 36 |

- [x] Those seven numbers are the data's own.
      _Evidence: `test/play-release.test.js` › "the coverage table states the counts the generated Android bundle holds"._
- [x] `shared_app` and `needs_review` brands carry **no** package IDs, so they are
      **not** blocked as apps, and Android no longer blocks websites, so on Android
      they are not blocked at all (the browser extension still blocks their
      sites). Do not describe app coverage as if it were catalog coverage.
      _Evidence: `test/play-release.test.js` › "the coverage table states the counts the generated Android bundle holds"._

## 10. Rollout

- [ ] **Internal testing** first — up to 100 testers, install path and every §6
      behaviour on at least three OEMs. `HUMAN — Play Console.`
- [ ] **Closed testing.** `HUMAN — Play Console.` Whether it is mandatory depends on
      the account (see §0); do it anyway — the pre-launch report and real devices
      are the only place the accessibility flow gets exercised.
- [ ] **Production, staged:** 10% → three clean days → 50% → three days → 100%.
      `HUMAN — Play Console.`
- [ ] **Halt criteria**, decided before launch, not during: any false block of a
      non-food app, an accessibility loop,
      or crash-free below 99%. `HUMAN — judgement.`
- [ ] **Review the pre-launch report** on each track. `HUMAN — Play Console.`
- [ ] **Keep the upload keystore backed up.** `HUMAN — you.` Repeated here because
      it is the one mistake with no recovery.

## 11. History: the VPN-era limitations, and why they are gone

Before 1.0 this section tracked two defects of the connection filter (IPv6-only
networks were dropped; protection did not return after a reboot) and their
fixes. FitShield 1.0 removed the `VpnService`, `Tun2Filter`, `BootReceiver` and
every boot-restore path, so neither concern exists any more: there is no filter
to drop IPv6 and no filter to restore. The historical record is in
[`changelog/0.56.md`](../changelog/0.56.md) and
[`changelog/1.0.md`](../changelog/1.0.md).

---

## 12. What you personally have to do

Condensed from the `HUMAN` lines above, in the order they block each other. The
resubmission-specific steps are in [PLAY_1.0_RESUBMISSION.md](PLAY_1.0_RESUBMISSION.md).

1. **Generate and back up the upload keystore**, then write
   `android/keystore.properties`. If that file already exists on your machine,
   this step is done — it is gitignored, so nobody but you can tell, and nothing
   here has opened it.
2. **Build and sign the AAB** with `node tools/build-android.js --bundle
   --versionCode=10`, and verify it with `jarsigner -verify`.
3. **Upload it to every track** that still holds a `VpnService` artifact, or
   retire those releases.
4. **Complete the remaining declarations**: `AccessibilityService` (with a demo
   video), foreground service `specialUse` (the keep-alive), and Data safety.
   Remove any `VpnService` declaration.
5. **Host the privacy policy** somewhere public and link it.
6. **Capture the phone screenshots and the feature graphic**, with none that
   show website blocking or "Site blocking (VPN)".
7. **Run the §6 device checks.**
8. **Roll out in stages** and watch the pre-launch report.

Everything here needs your Play Console, your signing key, your phone or your
judgement, and none of it is attempted by the repository. This checklist is
preparation; the submission is yours.
