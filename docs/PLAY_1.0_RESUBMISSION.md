# FitShield 1.0 — Google Play resubmission

_What to do in the Play Console after the 1.0 build. Menu names below are
described generically because the Console's layout changes; look for the
equivalent. Nothing here can be done from the repository._

**Why this is needed.** Play rejected `com.FitShield.UshaCorporation`
versionCode 8 (0.56): _"Use of VpnService is not a permitted use case. Remove the
relevant service element from the app manifest, for all artifacts across all
release tracks."_ Version 1.0 (versionCode 10) has no `VpnService`, no
`BIND_VPN_SERVICE`, no boot receiver and no `INTERNET` permission. The Android app
now blocks apps only; it no longer blocks websites. A rejection of an artifact
does not remove other artifacts that still contain the service, which is why step
(a) matters.

You do **not** need to file an appeal. Fix the artifacts, then send the changes
for review.

## Before you start: build the artifact

1. `node tools/build-android.js --bundle --versionCode=10` (needs your upload
   keystore, see [PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md) §3).
   Output: `dist/android/FitShield-1.0-10.aab`.
2. Verify it is signed: `jarsigner -verify dist/android/FitShield-1.0-10.aab`.
3. Optional sanity check that the bundle has no VPN service: open the AAB in
   Android Studio's APK Analyzer, or run `bundletool dump manifest` on it, and
   confirm there is no `android.net.VpnService` action, no
   `BIND_VPN_SERVICE`, and no `INTERNET` or `RECEIVE_BOOT_COMPLETED`.

Upload versionCode 10. The highest code recorded in this repository before 1.0
is 8 (0.56, the rejected build); versionCode 9 was an earlier 1.0 build that was
superseded by 10 and must not be reused, whether or not it was ever uploaded.

**The verified 1.0 artifact** (built and signed 2026-11-25, `jar verified`, signed
by the existing FitShield upload certificate):

| | |
| --- | --- |
| File | `FitShield-1.0-10.aab` (3,075,626 bytes) |
| versionName / versionCode | 1.0 / 10 |
| SHA-256 | `e284ebe970378e8eb46f60b016bae94f22fcb772c7d3683b7d5c522af956332a` |

Upload exactly this file. A rebuild produces a different checksum (signatures and
timestamps differ), so if you rebuild, record the new checksum here before
uploading.

## (a) Replace or retire every release that contains the VpnService

Play's message covers **all release tracks**. Go through each track and make sure
no live or draft release still carries a bundle with the service:

1. Open the release pages for **Production**, **Open testing**, **Closed
   testing** (every closed track, including any custom ones) and **Internal
   testing**.
2. For each track, look at the current release and the release history. Any
   bundle with versionCode 8 (or any earlier code that contained the VPN service)
   is a problem.
3. Either **create a new release on that track and upload `FitShield-1.0-10.aab`**
   (this supersedes the old bundle for testers on that track), or **deactivate /
   retire** the old release and the track if you no longer use it.
4. Check the App bundle explorer (under the app's release or app-bundle section)
   to see which versionCodes are still active and on which tracks. After the
   replacement, no active artifact should be an old one. Older bundles that are
   no longer on any track are not a problem.
5. A bundle uploaded earlier but never rolled out to a track may still be listed
   in the library; leaving it unused is fine, but you may delete drafts that
   reference it.

## (b) App content declarations

1. **VpnService declaration.** If a VpnService declaration form was ever filed for
   this app, it no longer applies. Withdraw it if the Console offers that, or
   leave it; the new bundle does not use the API.
2. **Accessibility API declaration.** FitShield uses an AccessibilityService for a
   non-accessibility purpose (`isAccessibilityTool` is deliberately **not**
   claimed). Confirm the declaration is filed and current: the core
   functionality description, the prominent in-app disclosure text, and the demo
   video. The wording to use is in
   [PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md) §7.2 and
   [PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md). The video
   should show: the disclosure in the app, enabling the service in system
   Accessibility settings, opening a blocked food app, and the pause screen. Do
   not mention website blocking in it.
3. **Foreground service declaration.** The opt-in keep-alive uses a
   `specialUse` foreground service. Confirm it is declared with the manifest's
   justification: _"Keeps on-device food-app blocking responsive in the
   background"_. There is now only one `specialUse` service (the VPN one is gone),
   so remove or ignore any entry that describes a connection filter.
4. **Other forms** (ads: none, advertising ID: none, target audience, content
   rating, health apps: no) are unchanged.

## (c) Data safety

The answers remain: **no data collected, none shared.** That is now even easier to
defend, because the app no longer requests `INTERNET` and cannot make a network
connection. Re-open the Data safety form and confirm:

- the only statistics on the device are a count of pauses and a per-app count,
  stored on-device only and never sent anywhere (so "app activity" stays not
  collected, not shared);
- "Does your app collect or share any of the required user data types?" is **No**;
- nothing in the form mentions web browsing history or network activity (the old
  connection filter is gone);
- the privacy policy URL still resolves, and the policy text matches
  [PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md). If your hosted
  policy still describes a local VPN or connection filter on Android, update it:
  Android 1.0 has none.

## (d) Store listing and screenshots

Use [STORE_LISTING_DRAFT.md](STORE_LISTING_DRAFT.md), which has been rewritten for
1.0. In the Console:

1. Short and full description: remove any sentence claiming the app blocks
   **websites** on Android, and any mention of a VPN, Private DNS or a connection
   filter. The app blocks food-delivery and fast-food **apps**. It may say that
   website blocking is available in the FitShield browser extension.
2. Screenshots and feature graphic: remove or replace every image that shows
   website blocking, a "Site blocking (VPN)" row, the VPN consent dialog, or the
   always-allow domain or custom URL screens. Capture fresh ones from the 1.0
   build.
3. "What's new" for versionCode 10: use the 1.0 text in the draft.
4. Check any translated listings for the same claims.

## (e) Send for review

1. Open the **Publishing overview** (or the equivalent "changes not yet sent for
   review" page) and check that it lists the new release(s), the declaration
   updates and the listing changes.
2. Send the changes for review.
3. After approval, roll out in stages as described in
   [PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md) §10.

## After you submit

Record the pair `versionName 1.0 ↔ versionCode 10` (already noted in
`changelog/1.0.md`). Do not reuse versionCodes 9 or 10 for any other upload; if this
bundle is rejected and you rebuild, use 11.

If Play rejects 1.0 for a different reason, read the message, fix it in the
repository (FitShield is in maintenance mode, so fixes are welcome), and upload
the next versionCode.
