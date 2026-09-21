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

- [ ] **Developer account must be an ORGANIZATION, not a personal account.**
      `HUMAN — Play Console, before anything else.` Google requires an
      organization account for "apps approved to use the `VpnService` class"
      (alongside financial, health and government apps). FitShield uses
      `VpnService`, so this applies. An organization account needs a **D-U-N-S
      number**, and **you cannot convert a personal account to an organization
      account later** — choosing wrong at signup means starting over with a new
      account and a new $25 fee.
      Source: [Play Console requirements](https://support.google.com/googleplay/android-developer/answer/10788890).
      - Side effect, and a welcome one: the "12 testers opted in for 14
        continuous days" closed-testing requirement applies **only to personal
        accounts created after 13 November 2023**. An organization account is
        exempt and may publish straight to production.
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

- [ ] **`VpnService` declaration form completed and approved.** `HUMAN — Play
      Console.` Mandatory for every app that uses `VpnService`; §7 has the exact
      answers to give. Source:
      [Understanding Google Play's VpnService policy](https://support.google.com/googleplay/android-developer/answer/12564964).

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
      `changelog/<versionName>.md` at upload time. `HUMAN — the pair is only
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
- [x] **No hostnames or filtering decisions reach release logcat.** WebView
      console logging and `Tun2Filter`'s per-connection RST log — which names the
      blocked host — are both inside `if (BuildConfig.DEBUG)`.
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
| `INTERNET` | relay allowed connections to the destination the client already chose | — |
| `FOREGROUND_SERVICE` | the VpnService and the optional keep-alive run as foreground services | an ongoing notification, *if* notification permission was granted — see below |
| `FOREGROUND_SERVICE_SPECIAL_USE` | required on Android 14+ for the `specialUse` FGS type both services declare | — |
| `POST_NOTIFICATIONS` | the foreground-service notification, the opt-in keep-alive notice, and the boot-restore notice (Android 13+) | nothing — see below |
| `SYSTEM_ALERT_WINDOW` | optional "display over other apps", so the block screen launches reliably over a blocked app | user-granted in system settings, explained in-app |
| `RECEIVE_BOOT_COMPLETED` | bring the connection filter back after a restart or an app update — and only for a user who had it on | protection is simply still there |

`RECEIVE_BOOT_COMPLETED` is worth a sentence to a reviewer, because a boot
receiver that starts a foreground service is a pattern Play looks at. FitShield's
starts nothing unless the stored instruction — written only by an explicit
enable or disable in the app — says the user had the filter on, and unless
Android still holds their VPN consent. If consent has lapsed it posts one
notification instead of starting anything. `BOOT_COMPLETED` and
`MY_PACKAGE_REPLACED` are both protected system broadcasts and both sit on
Android's exemption list for starting a foreground service from the background,
so the restore is legal rather than a loophole.

**`POST_NOTIFICATIONS` is requested at runtime, at the moment it can be
justified.** `MainActivity.requestVpnEnable()` asks for it immediately before
the VPN consent dialog — the first time the user turns filtering on — and
continues into the consent flow whether the answer is yes or no, so a decline
never blocks protection. Android shows that dialog once; FitShield never asks
again.

If the user declines, or turns notifications off later, the dashboard says what
stops working rather than leaving it to be discovered:
`WebAppBridge.notificationsEnabled()` reports the state and the app-blocking
panel explains that the boot-restore notice cannot appear, with a button to the
system setting. The order of seriousness is worth keeping in the reviewer notes:

- the foreground-service notification not appearing is cosmetic — the service
  still runs, and the OS still shows the VPN key and a Task Manager entry;
- the opt-in keep-alive's quiet notice not appearing is harmless;
- **the boot-restore notice not appearing is not.** It is the entire fallback
  for a restart where VPN consent has lapsed, so a device that refused
  notification permission must be told the fallback is unavailable.

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

**Expect the permission profile itself to draw attention.** `VpnService` +
`AccessibilityService` + "display over other apps" + a boot receiver + a
foreground service is, in combination, the exact shape of stalkerware, and a
reviewer who pattern-matches on it is doing their job. Get in front of it in the
reviewer notes: every one of the five is user-initiated and individually
revocable, the accessibility service cannot read window content, the VPN has no
remote endpoint, the overlay permission draws nothing, the boot receiver only
restores a setting the user themselves last set, and the app is open source with
no network destination of its own. The individual justifications are in §7; this
paragraph is about the picture they make together.

Two more are **OS gates declared on the services**, not requested from the user:

| Gate | On | What the user sees |
| --- | --- | --- |
| `BIND_VPN_SERVICE` | `FitShieldVpnService` | the one-time system VPN consent dialog |
| `BIND_ACCESSIBILITY_SERVICE` | `FitShieldAccessibilityService` | opt-in in system Accessibility settings |

- [x] **The manifest declares exactly those six `uses-permission` entries and no
      others**, and the audit's allowlist agrees with this table.
      _Evidence: `test/play-release.test.js` › "the permission table names exactly the permissions the manifest declares"._
- [x] **Package visibility is a scoped `<queries>` for MAIN/LAUNCHER, not
      `QUERY_ALL_PACKAGES`.** This matters twice: it is the narrower request, and
      `QUERY_ALL_PACKAGES` would trigger a Play declaration form that FitShield
      then does not have to file.
      _Evidence: `test/play-release.test.js` › "the permission table names exactly the permissions the manifest declares"._
- [ ] **Nothing requests `POST_NOTIFICATIONS`, so on Android 13+ it is denied
      and the boot-restore notice cannot be seen.** `HUMAN — routed to the Android
      lane.` See the note above for why this matters more than a missing
      foreground-service notification would.
      _Evidence: `test/play-release.test.js` › "the docs say whether the app can actually post a notification"._
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
      Nothing is blocked before consent, and both halves are gated by a
      permission only the user can grant: site blocking needs the one-time VPN
      consent dialog, and app blocking needs the accessibility service, which is
      a system opt-in shown after the in-app disclosure.
      `appBlockingEnabled` itself defaults **true** as of 0.56 — every
      `appBlock*` category already did, and the master switch defaulting false
      meant a user who enabled FitShield and granted accessibility still had
      every food app open normally, with no visible reason why. The default
      grants nothing on its own: with no accessibility service there is nothing
      to act on it.
- [ ] **Enable/disable cycles, VPN restarts, Accessibility toggles.** `HUMAN — device.`
- [ ] **Reboot, twice.** `HUMAN — device.` Once with the filter **on** — it must
      come back by itself — and once with it **off**, which must stay off. Then
      revoke VPN consent (Settings → VPN → forget FitShield) and reboot again:
      the app must post a single notification offering one tap rather than
      starting anything or staying silent. Also reboot with app blocking on, and
      confirm both halves are back rather than just the accessibility one.
- [ ] **Battery optimisation on and off**, with and without the opt-in keep-alive.
      `HUMAN — device.`
- [ ] **Keep-alive is off by default**, and when on does no work. `HUMAN — device.`
      Its quiet `IMPORTANCE_MIN` notification only appears if notification
      permission happens to have been granted — test on a fresh Android 13+
      install, where it will not have been.
- [ ] **No false blocks.** A non-food app must never be interrupted, and there
      must be no accessibility/overlay loop. `HUMAN — device.` This is also the
      first halt criterion in the rollout plan.
- [ ] **Blocking works with strict Private DNS on** (e.g. NextDNS). `HUMAN — device.`
      The filter reads TLS SNI / HTTP Host and never touches DNS, so it should —
      but "should" is why this line exists.
- [ ] **An IPv6-only network still has working internet, and is still filtered.**
      `HUMAN — device.` Both halves matter: the filter now parses IPv6 rather
      than dropping it, so a mobile network with no IPv4 must neither go dark nor
      let a blocked brand through.

## 7. Play Console declarations

Everything here is `HUMAN — Play Console`. The wording is drafted so it can be
pasted, and the parts that quote the app are checked against the app.

### 7.1 `VpnService` declaration

Mandatory for every app using `VpnService`.
Source: [VpnService policy](https://support.google.com/googleplay/android-developer/answer/12564964).

- [ ] **Declare the use case.** `HUMAN — Play Console.` The policy's permitted non-VPN uses are parental
      control and enterprise management, app usage tracking, device security
      (anti-virus, MDM, **firewall**), network tools, web browsing apps, and
      carrier apps. FitShield's honest fit is **a local firewall / content
      filter** — say that, not "VPN".
- [ ] **Answer the encryption question precisely.** `HUMAN — Play Console.` The policy says apps "must
      encrypt the data from the device to the VPN tunnel endpoint". FitShield has
      no tunnel endpoint, and the right answer is to say so rather than to tick a
      box: _"FitShield's `VpnService` is a local, on-device connection filter with
      no tunnel and no remote endpoint. No traffic is sent to any FitShield
      server — there are none. Blocked connections are reset locally; allowed
      connections are relayed byte-for-byte to the exact destination IP the
      client already chose, over a `protect()`ed socket, so the app never
      terminates, decrypts, re-encrypts or modifies TLS. End-to-end encryption is
      preserved unchanged because FitShield is never an endpoint."_
- [ ] **State what is read.** `HUMAN — Play Console.` Only the cleartext destination host the client
      already sends — TLS SNI on 443, HTTP `Host` on 80. No payload inspection,
      no certificate installation, no MITM, no DNS interception or forwarding.
- [ ] **Document the VPN use in the store listing itself.** `HUMAN — Play Console.` The policy
      requires separately from the form. The full description in
      [STORE_LISTING_DRAFT.md](STORE_LISTING_DRAFT.md) carries this.

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

- [ ] **Declare both `specialUse` services** on the App content page.
      `HUMAN — Play Console.` Quote the manifest's own justifications verbatim:
      - `FitShieldVpnService` — _"Local on-device TLS-SNI/HTTP-Host connection
        filtering for mindful food-ordering blocking"_
      - `AppBlockKeepAliveService` — _"Keeps on-device food-app blocking
        responsive in the background"_
      The keep-alive is the weaker of the two to justify, because "stay resident"
      is close to the thing FGS review exists to catch. Strengthen it in the form:
      it is **opt-in and off by default**, it exists only because some OEM battery
      managers pause the accessibility service after long idle, it posts an
      `IMPORTANCE_MIN` notification, and it performs no work of any kind while
      running. If the reviewer pushes back, the feature can be dropped without
      breaking app blocking on stock Android.
- [x] **Every `specialUse` service in the manifest carries a
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
      a private most-blocked breakdown, in the app's private `SharedPreferences`.
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

Stated as of **2026-08-26**, from `data/generated/android-packages.json`. These
are asserted against the data, never against another document — the previous
version of this file quoted a catalog that had moved on twice.

| Figure | Count |
| --- | --- |
| Curated brands in the blocklists | 2,505 |
| Brands with an Android port record | 2,504 |
| Brands that carry at least one app package | 1,445 |
| Unique Android package IDs bundled | 1,511 |
| Brands verified as having no app (`no_app`) | 757 |
| Brands whose only app is a shared platform storefront (`shared_app`) | 266 |
| Brands still `needs_review` | 36 |

- [x] Those seven numbers are the data's own.
      _Evidence: `test/play-release.test.js` › "the coverage table states the counts the generated Android bundle holds"._
- [ ] **One curated brand has no Android port record at all: Sweetgreen
      (`sweetgreen.com`).** `HUMAN — routed to the data lane.` It is neither
      mapped, nor marked `no_app`, nor flagged `needs_review` — it is simply
      absent from `data/android/fast-food-apps.json`, which is why the port
      record count is 2,504 against 2,505 brands. Until it is added, the honest
      claim is "2,504 of 2,505", not "every brand".
      _Evidence: `test/play-release.test.js` › "the checklist names every curated brand missing an Android port record" — when the gap is filled this line has to go._
- [x] `shared_app` and `needs_review` brands carry **no** package IDs, so they are
      **not** blocked as apps. Site blocking still covers them. Do not describe
      app coverage as if it were catalog coverage.
      _Evidence: `test/play-release.test.js` › "the coverage table states the counts the generated Android bundle holds"._

## 10. Rollout

- [ ] **Internal testing** first — up to 100 testers, install path and every §6
      behaviour on at least three OEMs. `HUMAN — Play Console.`
- [ ] **Closed testing.** `HUMAN — Play Console.` Not mandatory on an organization
      account (see §0), but do it anyway: the pre-launch report and real devices
      are the only place the VPN-consent and accessibility flows get exercised.
- [ ] **Production, staged:** 10% → three clean days → 50% → three days → 100%.
      `HUMAN — Play Console.`
- [ ] **Halt criteria**, decided before launch, not during: any false block of a
      non-food app, the VPN breaking general connectivity, an accessibility loop,
      or crash-free below 99%. `HUMAN — judgement.`
- [ ] **Review the pre-launch report** on each track. `HUMAN — Play Console.`
- [ ] **Keep the upload keystore backed up.** `HUMAN — you.` Repeated here because
      it is the one mistake with no recovery.

## 11. Two things this file used to call "known non-blockers"

They were not non-blockers. An earlier version of this checklist listed both
under that heading, which is how a defect gets to look like a decision:

> - IPv6-only networks: the connection filter currently drops IPv6 (forces IPv4).
> - Reboot VPN auto-restart is intentionally manual.

The first meant a user on an IPv6-only carrier lost **all** connectivity while
FitShield was on — not filtered, none. The second meant a user turned protection
on, their phone restarted overnight, and in the morning nothing was blocked and
nothing had said so. Neither is something a user would recognise as a design
choice, so neither was one.

**Both are fixed in the code as of 2026-08-26**, and the fixes are bound to tests
so that this section cannot drift in either direction — it cannot keep claiming a
limitation the code no longer has, and it cannot quietly drop one that comes back.

- [x] **IPv6 is filtered, not dropped.** `Tun2Filter` parses IPv6 packets and
      applies the same SNI/Host decision to them. Deleting the `::/0` route was
      the tempting fix and the wrong one: it would have restored connectivity by
      letting IPv6 bypass the filter entirely, turning a visible failure into an
      invisible one where a blocked brand reachable over IPv6 simply is not
      blocked. QUIC (UDP/443) is still dropped deliberately and separately, so
      browsers fall back to TCP where the SNI is visible.
      _Evidence: `test/play-release.test.js` › "the docs describe IPv6 exactly as the filter handles it" — bidirectional._
- [x] **Protection comes back after a restart, for the user who asked for it.**
      `BootReceiver` handles `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`, reads
      the stored instruction, and starts the filter only when that says the user
      had it on **and** Android still holds VPN consent. Otherwise it posts one
      notification rather than starting anything. The decision is a pure function
      (`BootRestore.decide`) so the rule that matters — never turn protection on
      for someone who turned it off — is executed by tests rather than trusted.
      _Evidence: `test/play-release.test.js` › "the docs describe the reboot behaviour the app actually has" — bidirectional._
- [ ] **Confirm both on a device before submitting.** `HUMAN — device.` The §6
      reboot and IPv6 lines are where. Code that is right in the repository and
      wrong on a phone is the failure mode a VPN app has most of.

---

## 12. What you personally have to do

Condensed from the `HUMAN` lines above, in the order they block each other.

1. **Register an organization Play developer account** with a D-U-N-S number.
   Not a personal account — `VpnService` makes that a hard requirement, and it
   cannot be changed later.
2. **Generate and back up the upload keystore**, then write
   `android/keystore.properties`. If that file already exists on your machine,
   this step is done — it is gitignored, so nobody but you can tell, and nothing
   here has opened it.
3. **Decide the target API level**, which is really deciding the submission date:
   the build targets API 36, so the 31 August 2026 deadline is met whenever the
   submission lands.
4. **Build and sign the AAB by hand** with the §3 command, and verify it with
   `jarsigner -verify`.
5. **Complete four declarations**: `VpnService`, `AccessibilityService` (with a
   demo video), foreground service `specialUse` ×2, and Data safety.
6. **Host the privacy policy** somewhere public and link it.
7. **Commission the icon artwork — twice.** The 512×512 store icon, and the
   **launcher icon the app does not currently have at all** (§8). Without the
   second one FitShield installs as a grey Android silhouette.
8. **Capture the phone screenshots and the feature graphic.**
9. **Run the §6 device checks** on at least three OEMs.
10. **Roll out in stages** and watch the pre-launch report.

Steps 3 and 7 have repository halves — the API-36 bump in §1 and the launcher
icon resources in §8 — both written out for the lanes that own those files.
Everything else needs your Play Console, your signing key, your phone or your
judgement, and none of it is attempted here. This checklist is preparation; the
submission is yours.
