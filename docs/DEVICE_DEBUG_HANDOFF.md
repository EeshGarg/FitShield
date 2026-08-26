# Device debug handoff

Everything below has been built and reasoned about, and **none of it has been
run on a phone.** That is the whole point of this session: a device is plugged
in over ADB, and the job is to find out which of these claims survive contact
with it.

Paste the prompt in [§1](#1-the-prompt) into a fresh session. The rest of this
file is the detail that prompt refers to.

---

## 1. The prompt

> A physical Android device is connected over ADB. FitShield has never been run
> on real hardware — every Android claim in this repository comes from unit
> tests, static analysis and reasoning. Your job is to find out which of them
> are true.
>
> Read `CLAUDE.md` and `development-policy.json` first; they are binding. A
> finding is work: you fix it, you never report it and stop. Terminal verdicts
> are forbidden. "Probably fixed" is forbidden.
>
> Start by confirming the device is actually there and what it is:
>
> ```bash
> adb devices -l
> adb shell getprop ro.build.version.release
> adb shell getprop ro.build.version.sdk
> adb shell getprop ro.product.manufacturer
> adb shell getprop ro.product.model
> ```
>
> Record the Android version and OEM in your report. Several of the things you
> are checking are OEM-specific — battery-optimisation killers, background-start
> restrictions and boot-broadcast behaviour vary a lot between manufacturers,
> and "it worked on a Pixel" is not the same claim as "it works".
>
> Build and install:
>
> ```bash
> npm run build:android        # produces dist/android/FitShield-0.55-debug.apk
> adb install -r dist/android/FitShield-0.55-debug.apk
> adb logcat -c                # clear before each scenario, so the log is the scenario
> ```
>
> Then work through `docs/DEVICE_DEBUG_HANDOFF.md` §3 in order. Every item there
> names what was asserted, why it could not be settled off-device, and what
> would count as a pass. Take them in order — the first three establish that the
> app works at all, and the later ones assume it does.
>
> Rules for this session, because a device makes it easy to fool yourself:
>
> - **Watch the screen, do not only read logcat.** A silent failure that logs
>   nothing is exactly the class of bug this session exists to catch. Screenshot
>   with `adb exec-out screencap -p > shot.png` and actually look at the image.
> - **Clear state between scenarios.** `adb shell pm clear com.usha.fitshield`
>   resets the app; re-granting VPN consent is part of what you are testing, so
>   do not skip it to save time.
> - **A defect you find is work.** Fix it in the repository, add a test that
>   fails without the fix, and prove the fix on the device again. Where you
>   cannot fix it in code — an OEM restriction, a Play policy question — write
>   down exactly what the user has to do.
> - **Say what you did not test.** If a scenario needs an IPv6-only carrier, a
>   second SIM or a fourteen-hour wait, say so plainly rather than marking it
>   passed.
>
> When you are done: `npm test`, `npm run validate`, `node build.js` and
> `npm run build:android` must all be green, and update
> `docs/DEVICE_DEBUG_HANDOFF.md` §3 with what each item actually did — that file
> is the record, and it should stop saying "unverified" for anything you
> verified. No verdict at the end; report what happened.

---

## 2. What is already known to be true

So the session does not re-derive it:

- The APK builds here (`npm run build:android`), and a signed AAB builds with
  `node tools/build-android.js --bundle --versionCode=<int>`.
- 2,505 curated brands reach the phone as 1,511 app packages plus a rules
  asset; the packaged data hash-matches the repository's canonical files.
- `targetSdk` / `compileSdk` are 36, `minSdk` 26.
- Six `uses-permission` entries, no `QUERY_ALL_PACKAGES`, `allowBackup="false"`.
- The launcher icon is generated from `brand/fitshield-f-512.png` by
  `tools/make-android-icon.js` and is present in the APK at
  `res/drawable-nodpi-v4/ic_launcher_foreground.png`.

---

## 3. What only the device can settle

Each item: **the claim**, **why it is unverified**, **what a pass looks like**.

### 3.1 The app installs and shows the FitShield F — `unverified`

**Claim.** The adaptive icon renders as the green FitShield "F" on a white
field, correctly inside every launcher mask.

**Why unverified.** Adaptive icons are composited by the launcher. The
foreground was checked to sit inside the 72dp safe zone arithmetically, and the
PNG was inspected as an image, but no launcher mask was ever applied to it.

**Pass.** The home screen, app drawer, Settings → Apps, the share sheet and the
recents switcher all show the F — not Android's grey placeholder, not a white
square, not a letter clipped by a circular mask. Check a themed/monochrome
launcher too if the device offers one. Screenshot each.

### 3.2 VPN consent, and blocking actually blocks — `unverified`

**Claim.** Enabling filtering shows the system VPN consent dialog; afterwards a
blocked ordering site redirects to the FitShield pause screen.

**Why unverified.** `VpnService.prepare()`, the consent dialog and the tunnel
have never run.

**Pass.** Consent appears, the VPN key shows in the status bar, and opening a
listed brand in Chrome lands on the pause screen naming that brand. Try one
from each bucket — a delivery marketplace and a fast-food chain. Then confirm
an unlisted site loads normally: `example.com` and a bank, say. **A blocker
that breaks unrelated browsing is worse than one that misses a site.**

### 3.3 IPv6 — the highest-value item — `unverified`

**Claim.** IPv6 packets are parsed rather than dropped, so the tunnel no longer
kills connectivity on IPv6-capable networks, and blocking works over IPv6.

**Why unverified.** `IpPacket.kt` is unit-tested against crafted packets,
including extension-header chains and 500 seeded random ones. No real IPv6
traffic has ever passed through it.

**Pass.** With the VPN on:
1. On normal Wi-Fi, browsing works and blocking works.
2. Confirm the device is actually getting IPv6 — `adb shell ip -6 addr` should
   show a global address, and `test-ipv6.com` should report IPv6 connectivity.
3. **If a mobile carrier that is IPv6-only is available, use it.** That is the
   case that was completely broken before; the previous behaviour was *no
   internet at all* while FitShield was on. If no such network is available,
   say so — do not infer it from dual-stack working.
4. A blocked brand reachable over IPv6 still hits the pause screen.

### 3.4 Boot restore — `unverified`

**Claim.** If filtering was on when the device shut down, it comes back after a
reboot: silently when VPN consent still holds, otherwise as one tap-to-restore
notification.

**Why unverified.** Whether `VpnService.prepare()` returns null after a real
reboot, and whether a given OEM permits a `specialUse` foreground service to
start from `BOOT_COMPLETED`, can only be observed. **Both outcomes are
implemented** because neither could be assumed — find out which one this device
takes.

**Pass.** Three scenarios, each from a clean `adb reboot`:
1. **On at shutdown, consent held** → filtering is on afterwards, without the
   user doing anything. Verify by loading a blocked site, not by reading a
   toggle.
2. **Off at shutdown** → still off. It must never turn itself on for someone
   who turned it off.
3. **On at shutdown, consent revoked** (revoke via Settings → Network → VPN) →
   the restore notification appears and one tap leads to the consent dialog.

Also `adb shell am force-stop com.usha.fitshield` followed by a reboot, and an
app update (`adb install -r` over the top). All three land in `onDestroy`, and
none of them may be recorded as the user turning FitShield off.

### 3.5 The notification permission — `unverified`

**Claim.** `POST_NOTIFICATIONS` is requested immediately before the VPN consent
dialog, and declining never blocks protection.

**Why unverified.** The runtime permission flow has never been shown.

**Pass.** On a first run on Android 13+, the notification prompt appears before
the VPN dialog; **declining still leads into the VPN consent flow**, and the
dashboard then says what a declined permission costs. The boot-restore notice
in §3.4 scenario 3 depends on this being granted — check that path with it
denied too, and confirm the app says so rather than silently failing.

### 3.6 App blocking and the accessibility disclosure — `unverified`

**Claim.** The accessibility disclosure is modal, cannot be swiped away, names
what is read, and consent is recorded before Settings opens. Afterwards,
opening a blocked *app* shows the pause screen.

**Why unverified.** No AccessibilityService has ever been bound.

**Pass.** The disclosure cannot be dismissed by tapping outside or by Back;
declining does not open Settings; accepting does. Then install a blocked app —
a delivery app is easiest — and confirm opening it shows the pause screen with
the right brand, and that "Open anyway" unlocks it for the configured minutes.
Confirm an unblocked app is untouched.

**Play needs a screen recording of this flow for the declaration**, so capture
it while you are here: `adb shell screenrecord /sdcard/a11y.mp4`.

### 3.7 The pause screen itself — `unverified`

**Claim.** It names the brand, shows a category and countries, counts the
interruption exactly once, offers a credible alternative, and the countdown
unlocks Continue.

**Why unverified.** Rendered only in a synthetic DOM and a WebView harness.

**Pass.** Brand name, no raw ids with underscores, no literal i18n key names on
screen (`statusBlockedVisits` and friends were doing exactly that until
recently — look for any word that reads like a variable). The alternative shows
ingredients as text, **not `[object Object]`**. The interruption count goes up
by exactly one per pause — including when you press "Open anyway", which used
to erase it. Rotate the device mid-countdown and confirm it does not
double-count or restart.

### 3.8 Statistics are honest — `unverified`

**Claim.** One counter — ordering pages interrupted — plus most-blocked
breakdowns. No savings figure, no calorie figure, no currency picker.

**Pass.** Confirm none of those three appear anywhere in the app. This is the
claim the release notes now make publicly, so it needs to be true on screen.

### 3.9 Battery, and staying alive — `unverified`

**Claim.** The foreground services keep running.

**Why unverified.** OEM battery management is the single most device-specific
thing here, and several manufacturers kill background services aggressively
regardless of what the manifest says.

**Pass.** Leave the app running with the screen off for a few hours, then check
filtering still works. `adb shell dumpsys deviceidle force-idle` forces Doze if
you cannot wait. If the OEM kills it, that is a real finding: record which
manufacturer, and what the app should tell the user to do about it.

---

## 4. Useful commands

```bash
adb logcat -c                                   # clear
adb logcat FitShield:V AndroidRuntime:E *:S     # app + crashes only
adb exec-out screencap -p > shot.png            # screenshot
adb shell screenrecord /sdcard/x.mp4            # recording (ctrl-C, then adb pull)
adb shell dumpsys activity service com.usha.fitshield
adb shell dumpsys package com.usha.fitshield | grep -A20 "runtime permissions"
adb shell pm clear com.usha.fitshield           # full reset
adb reboot
```

---

## 5. Not this session

- **Safari.** Experimental, explicitly out of scope.
- **Anything needing the Play Console**, a keystore or an organization
  developer account — those are in
  [`PLAY_STORE_RELEASE_CHECKLIST.md`](PLAY_STORE_RELEASE_CHECKLIST.md) §12 and
  belong to the user, not to a debugging session.
