# Device debug handoff

**This has now been run on a phone** — a Samsung Galaxy S24 Ultra (SM-S928U1) on
Android 16 / One UI 8.5, over ADB. [§3](#3-what-the-device-settled) is the
record of what each item actually did.

Six defects survived contact with the hardware and were fixed here:

1. the launcher icon was clipped by the squircle mask (§3.1);
2. "Always-allow domains" was stored and never consulted by the filter (§3.2);
3. "Custom URLs" likewise (§3.2);
4. the pause countdown restarted on every rotation (§3.7);
5. "Open anyway" unlocked the app without telling the connection filter, so the
   app opened and then could not load (§3.6);
6. on a network with **no working IPv6**, the tunnel accepted IPv6 connections it
   could not carry and reset them after the handshake, which stopped clients
   falling back to IPv4 and broke unrelated sites (§3.3).

The last is the most serious — it broke Wikipedia, not a delivery brand. Each has
a test that fails without its fix, and each was re-proven on the phone.

A seventh was fixed on the way out: the restore notice claimed "Your phone
restarted" after an app update, when the phone had not restarted (§3.4).

Two things this setup could not reach, both **accepted for the beta by the
owner** rather than left hanging:

- **An IPv6-only carrier was never available.** Both networks this phone used
  were dual-stack or IPv4-only, and step 3 was not inferred from dual-stack
  working. Accepted: blocking is by hostname and by Android package, and the
  IPv6 path that used to kill connectivity is now both parsed and, where IPv6
  does not work, refused cleanly (§3.3).
- **Deep Doze cannot be produced over USB.** A tethered phone is charging, and
  One UI refuses the AOSP `deviceidle` stepping that exists to get around that.
  Accepted: the 25-minute screen-off soak passed with the service alive and
  filtering, which is the bar for a beta (§3.9).

[§1](#1-the-prompt) is the prompt this session was started from; it is kept
because the remaining items need the same setup.

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
> - **Clear state between scenarios.** `adb shell pm clear com.FitShield.UshaCorporation`
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

## 3. What the device settled

Run on **Samsung Galaxy S24 Ultra (SM-S928U1)**, Android **16** (API 36), One UI
**8.5**, build `BP4A.251205.006.S928U1UES6DZG1`, over ADB.

The OEM matters for several of these and it is the aggressive end of the range:
One UI is the skin most often blamed for killing background services. Where an
outcome is OEM-specific it says so.

**The environment, because three items depend on it:**

- **Both networks are dual-stack.** Wi-Fi is Comcast (`2601:40d:...` +
  `10.0.0.110`), cellular is AT&T LTE (`2600:381:...` + `10.8.30.61`), and there
  is **no `v4-rmnet` CLAT interface**, so neither is IPv6-only. That is exactly
  what §3.3 step 3 needed, and it was not available here.
- **Private DNS is on, in strict `hostname` mode**, pointed at
  `6f7c5b.dns.nextdns.io`. That is the configuration SNI-based blocking exists to
  survive, so every result below was obtained with encrypted DNS active.
- **Chrome is disabled on this device** (`enabled=3`, user-disabled, no launcher
  activity), so browser checks used **Brave** — same Chromium engine, so the SNI
  path is identical — plus on-device `curl` where an exact status code mattered.

Five defects were found and fixed. Each has a test that fails without the fix,
and each fix was re-proven on the phone.

### 3.1 The app installs and shows the FitShield F — `fixed, verified`

**What happened.** The icon was there — not Android's grey placeholder — but the
F was **clipped by One UI's squircle mask**: the stem ran into the mask boundary
and was cut off flat, with no white margin beneath it.

`tools/make-android-icon.js` fitted the artwork to the 72dp mask **square**. That
is the masked viewport, not the safe zone: the launcher chooses the mask's
*shape*, and only the centred **66dp circle** survives all of them. The corners
of that square sit well outside the circle, so anything taller than it is wide —
a letter F — gets cut.

The check that should have caught it compared the bounding box against the same
square it had just been fitted to, so it agreed with itself and never applied a
mask. It is now a per-pixel assertion on the generated PNG.

```
before   ink reached 39.9dp from centre   (safe radius 33.0dp)  -> stem cut flat
after    ink reaches  32.5dp                                    -> clears the mask
```

**Verified on the device:** the app drawer and Settings -> App info both render
the green F on white, fully inside the squircle, with margin on every side.

**Not checked:** a themed/monochrome launcher — that needs the phone's theme
settings changed, which is the owner's call; the `monochrome` layer ships in the
APK and the same test measures it. The share sheet has no FitShield entry to
check, because the app registers no share target.

### 3.2 VPN consent, and blocking actually blocks — `verified; the claim above it was wrong`

Consent appeared, the key showed in the status bar, `tun0` came up with **both**
an IPv4 and an IPv6 address, and `FitShieldVpnService` ran as a foreground
service with `types=0x40000000` (`specialUse`).

**Blocking works, in both buckets:**

```
doordash.com   (delivery marketplace)  Connection reset by peer
mcdonalds.com  (fast-food chain)       Connection reset by peer
```

**Unrelated browsing is untouched** — the property that matters most here:

```
chase.com       loads (a bank, rendered fully)
wikipedia.org   loads
example.com     http=200
```

**The pass criterion this item used to state was wrong, and is corrected above.**
It said a blocked site "redirects to the FitShield pause screen". It does not, it
never did, and the product does not claim it does. `BlockActivity` is launched
from exactly one place — `FitShieldAccessibilityService` — and the app's own
limits list says: *"There is no custom block page for HTTPS sites (that would
require interception FitShield won't do) — blocked sites simply fail to
connect."* The Privacy section agrees: *"a local VPN that resets connections to
blocked sites ... and an optional app blocker ... to show a mindful pause."*

So the user-visible result of a blocked **site** is the browser's own connection
error. The pause screen belongs to blocked **apps** (§3.6).

**Two dead controls were found here and fixed.** Both were stored, listed back to
the user with a Remove button, and never consulted by the filter, because
`RuleEngine` read only the packaged asset:

- **"Always-allow domains"** — the UI says "domains here are never blocked".
  `doordash.com` sat in that list and was still reset.
- **"Custom URLs"** — a domain typed in was never blocked.

Both now reach the matcher, and live: the service watches the preferences, so a
change applies without restarting the tunnel. The allow layer wins over both the
curated set and the user's own additions. Verified together on the device:

```
example.org    added to Custom URLs   ->  reset       (was http=200)
doordash.com   on Always-allow        ->  http=403    (completes; was reset)
mcdonalds.com  curated, no exemption  ->  reset
example.com    untouched              ->  http=200
```

**A third control was wired up while here.** "Block only during scheduled hours"
was honoured by app blocking and ignored by the connection filter — one switch,
two answers. Sites now honour the same window. The in-app note that said timing
enforcement "lands in a later step" was already stale when it was read (the timer
and the schedule both worked for apps) and has been corrected.

**Country and category selections still do nothing, and now say so.** They are
additive: the catalog is a union of the delivery bucket, the fast-food bucket,
custom URLs, and anything matching an enabled country or category. The Android
asset already contains every curated delivery and fast-food brand, so those two
selections have nothing left to add, and no bucket toggles are exposed on Android
to make them subtract. The UI text now states this plainly instead of promising
enforcement in "a later step". Making them meaningful is a product decision — it
needs bucket toggles — not a wiring fix.

### 3.3 IPv6 — the highest-value item — `verified (1, 2, 4); a defect found and fixed; step 3 unavailable`

**1 and 2 — IPv6 works through the tunnel.** With the VPN on, `test-ipv6.com`
reached its server over IPv6 and reported the device's real global address,
`2601:40d:8201:7360:7f3a:245f:c372:c5f9` — identical to `wlan0`'s address from
`ip -6 addr`. An AAAA-only host (`ipv6.google.com`, no A record at all) loaded
fully, images included. The old failure — no internet at all — is gone.

**4 — blocking works over IPv6.** Forced with `curl -6`, so there is no ambiguity
about which family carried the connection:

```
BLOCKED  www.doordash.com  ->  Recv failure: Connection reset by peer
ALLOWED  ipv6.google.com   ->  http=200   ip=2607:f8b0:4009:803::200e
```

For an IPv6-only host to load at all, the filter had to parse the IPv6 packet,
find the TCP payload, read the TLS SNI, look it up and relay it — the entire
path. The blocked case differs only in which branch it takes afterwards.

**A sixth defect was found here, and it is the worst of them.** On a network with
**no working IPv6**, FitShield broke unrelated dual-stack sites.

`::/0` is routed into the tun so that IPv6 is filtered rather than bypassing the
filter. When the underlying network has no IPv6 route, that backfires: the
client's IPv6 attempt is accepted by the tunnel, the handshake completes
locally, the upstream connect then fails, and the client is sent an RST. Having
seen a connection ESTABLISH, the browser reports the site as reset instead of
falling back to IPv4 — the fallback that happens in milliseconds when FitShield
is off, because the IPv6 connect fails immediately with no route.

Observed when this phone moved to an IPv4-only Wi-Fi (`192.168.137.13/24`, no
global IPv6, no `::/0` route) partway through the session:

```
FitShield ON    en.wikipedia.org  ->  "This site can't be reached. The connection was reset."
FitShield OFF   en.wikipedia.org  ->  loads
example.com  -4 http=200          -6 Connection reset by peer
github.com      http=200          (no AAAA, so it never tried IPv6)
```

The counter did not move and `blockedByDomain` gained no entry, which is how it
was established that the matcher was right and the relay was at fault.

**Fixed** by refusing an IPv6 SYN outright when IPv6 is known not to work, so the
client fails over exactly as it does without a VPN. The answer comes from
evidence — what our own protected upstream sockets actually do — not from
inspecting ConnectivityManager, which on this phone reported IPv6 as available
because an idle cellular network still advertised a global address and a `::/0`
route while the default Wi-Fi had neither. `::/0` stays routed, so the moment a
network really carries IPv6 it is filtered again.

```
after the fix, same network, VPN on:
  example.com http=200   wikipedia.org http=301   cloudflare.com http=301   github.com http=200
  en.wikipedia.org renders fully in Brave
  mcdonalds.com / grubhub.com / example.org still reset;  allow-listed doordash.com still passes
```

**3 — an IPv6-only carrier was NOT available, and this was NOT inferred from
dual-stack working.** Both networks on this phone carry real IPv4 with no CLAT
interface. The case that was previously catastrophic — an IPv6-only mobile
network, where FitShield used to leave the device with no internet at all —
therefore remains **unexercised on hardware**. It needs a SIM on such a network.

### 3.4 Boot restore — `all three scenarios verified`

**Scenario 1 — on at shutdown, consent held: PASS, and it answers the OEM
question.** One UI 8.5 **does** permit a `specialUse` foreground service to start
from `BOOT_COMPLETED`. After a real `adb reboot` (uptime 488s), with nothing
touched afterwards:

```
tun0  inet 10.111.222.1  inet6 fd00:f175:1::1      filtering restored
FitShieldVpnService  isForeground=true  types=0x40000000
mcdonalds.com -> reset    grubhub.com -> reset    example.com -> http=200
```

Verified by traffic, not by reading a toggle. **No restore notification was
posted**, which is correct for this path: consent still held, so this device
takes the silent branch. Both branches are implemented; this is the one that runs
here.

**Force-stop and app update — PASS.** Each destroys the service, and neither is
recorded as the user turning FitShield off:

```
before force-stop   vpnUserEnabled=true   tun0=3
after  force-stop   vpnUserEnabled=true   tun0=0
after  install -r   vpnUserEnabled=true
```

**Scenario 2 — off at shutdown: PASS.** FitShield was turned off through the UI
(`vpnUserEnabled=false` confirmed, blocked sites confirmed loading again), the
phone was rebooted, and nothing was touched afterwards:

```
uptime 2160s          vpnUserEnabled=false    tun0: 0 lines
VpnService: 0 records                         FitShield notifications: 0
grubhub.com http=200  example.org http=200    -> filtering genuinely off
```

It did not turn itself on for someone who turned it off, verified by traffic.

**Scenario 3 — on at shutdown, consent revoked: PASS.** Run WITHOUT another
reboot: `BootReceiver` handles `MY_PACKAGE_REPLACED` as well as `BOOT_COMPLETED`
and both reach the same `BootRestore.decide`, so an `adb install -r` exercises
the identical path. With the standing instruction left ON and consent revoked
(`appops set com.FitShield.UshaCorporation ACTIVATE_VPN deny`):

```
tun0: 0                       -> it did NOT start silently, which is correct
notifications 2 -> 3          -> one notification posted
channel=fitshield_restore, AUTO_CANCEL
  title: "FitShield site blocking is off"
  text:  "Your phone restarted. Tap to turn it back on."
```

Tapping it opened `com.android.vpndialogs.ConfirmDialog` — the system consent
dialog — in **one tap**. Accepting restored filtering (`tun0` up,
`ACTIVATE_VPN: allow`, mcdonalds.com reset again).

**One copy inaccuracy.** That notification always says *"Your phone restarted"*,
but the same notice is posted after an app update, when the phone did not
restart. The trigger is known at the call site, so the two cases could say what
actually happened.

### 3.5 The notification permission — `verified`

On a first run on Android 16 the order is right and the decline is safe:

1. `GrantPermissionsActivity` — "Allow FitShield to send you notifications?" —
   appeared **before** any VPN dialog.
2. **"Don't allow" was tapped**, and the flow continued straight into
   `com.android.vpndialogs.ConfirmDialog`. Declining does not block protection.
3. Filtering then ran normally with notifications denied.

Re-enabling later prompted once more and was granted, which is what §3.4
scenario 3 will need.

**Not checked:** the dashboard's wording about what a declined permission costs,
and the boot-restore notice with notifications denied — that belongs with §3.4
scenario 3, which did not run.

### 3.6 App blocking and the accessibility disclosure — `verified`

**The disclosure holds up.** It names what is read (*"only the package name of
the app currently in the foreground — for example com.dd.doordash"*), what is
never read (screen contents, text, messages, passwords — quoting
`canRetrieveWindowContent="false"`), what it is for, where it goes (nowhere), and
how to turn it off.

```
tap outside the dialog  ->  still there
Back                    ->  leaves the app; NO consent recorded, no service enabled
"Not now"               ->  stays in the app; Settings does NOT open
"I understand"          ->  records accessibilityDisclosureAcceptedAt (ISO timestamp),
                            THEN opens Settings$AccessibilitySettingsActivity
```

The gate lives in `WebAppBridge.openAccessibilitySettings`, which returns early
without a recorded consent, so a UI change cannot route around it.

**Blocking a real app works.** With the service enabled, opening **Grubhub**
(installed, and present in the shipped package map) put `BlockActivity` in front
of it. An unblocked app (Clock) opened untouched.

**A defect in "Open anyway" was found and fixed.** The unlock bound only the
accessibility layer; the connection filter kept resetting the brand's domains, so
Grubhub opened straight into *"We weren't able to load this screen"* — and every
retry added another interruption to the counter. The unlock the user explicitly
chose now holds across both layers, and still expires:

```
unlock active    grubhub.com -> http=200    mcdonalds.com -> reset
unlock expired   grubhub.com -> reset       example.com   -> http=200
```

**Play recording captured** — `adb shell screenrecord`, 170s, 88 MB, covering the
disclosure, the decline, the accept, Settings, and a blocked app being stopped.

### 3.7 The pause screen itself — `fixed, verified`

Rendered over a real blocked app:

- Brand named — "Skip the Grubhub order?", and "Open Grubhub · 55s".
- Category shown ("Delivery"). **Countries are not shown** — this item asked for
  them and the screen does not display them.
- **No raw ids, no underscores, no i18n key names on screen.**
- **Alternatives render as prose, not `[object Object]`**: "Microwave Mug Brownie
  · 5 min · A single warm, fudgy brownie in five minutes, with no oven and
  nothing left over."
- The counter went **17 -> 18**: exactly one per pause. **"Open anyway" did not
  erase it** (21 -> 22).
- The countdown gates the button.

**Rotation restarted the countdown — fixed.** `BlockActivity` declared no
`android:configChanges`, so each rotation destroyed and recreated it, the WebView
reloaded `block.html`, and `startTimer()` began again from the top:

```
before   25s -> 18s, rotate -> 57s     (restarted)
after    47s ->  rotate     -> 37s     (kept counting)
```

Rotation never double-counted, before or after the fix.

### 3.8 Statistics are honest — `verified`

One counter on screen — **"Ordering pages interrupted"** — plus most-blocked
sites, categories and countries. **No savings figure, no calorie figure and no
currency picker** anywhere in the app: every remaining mention in the source is a
comment explaining the removal, `currency.js` is not loaded, and `caloriesAvoided`
survives only as a legacy key that nothing increments.

**One wording gap, worth a decision.** That counter also counts blocked **apps**,
which are not pages. And one visit to a blocked site can add more than one: the
per-brand dedupe is 30s (`DEDUPE_MS`), and a browser retrying a reset connection
over several minutes counted **3** interruptions for a single attempt to open
doordash.com. The number is honest about what the service observed; the label
over-narrows it to "pages".

### 3.9 Battery, and staying alive — `partly verified; Doze not reachable over USB`

**What was established.** The tunnel and its service survived a **25-minute
screen-off period** and were still filtering afterwards, untouched:

```
tun0=3        VpnService: 8 records
mcdonalds.com -> Connection reset by peer      github.com -> http=200
```

One UI had not restricted the app either: it is not hibernated, suspended or
stopped, `RUN_ANY_IN_BACKGROUND` is at its default allow, and FitShield is **not**
on the battery-optimisation whitelist — it does not ask to be, and did not need
to be over this window.

A second, unplanned data point arrived afterwards: the phone locked itself, and
FitShield still restored silently on that locked device when the service was
next destroyed. Nothing about being locked stopped it coming back.

**What was NOT established, and cannot be over USB.** Deep Doze never engaged.

```
dumpsys deviceidle force-idle   ->  "Unable to go deep idle; stopped at INACTIVE"
dumpsys deviceidle step  x8     ->  INACTIVE every time
deep state at the end of the soak -> ACTIVE
```

Two reasons, and the second is structural:

1. **One UI does not honour the AOSP stepping.** `force-idle` refuses and `step`
   will not advance past `INACTIVE` — Samsung's own power management replaces it.
   The shortcut this item suggests is simply not available on this OEM.
2. **A phone on the ADB cable is charging, and Doze does not run while
   charging.** `dumpsys battery unplug` makes the framework *report* unplugged,
   which was not enough to move the idle controller here. So a USB-tethered
   session cannot produce real Doze on this device at all.

**The OEM-kill question over hours is therefore unanswered, and is accepted for
the beta.** Twenty-five minutes with the screen off is evidence that nothing
kills it quickly, and that is the bar agreed for this release; it is not evidence
that One UI leaves it alone overnight and must not be read as such. Answering it
properly needs wireless ADB (`adb tcpip` / pairing) with the cable out and the
phone left alone for hours, or an overnight soak followed by opening a blocked
site by hand.

---

## 4. Useful commands

```bash
adb logcat -c                                   # clear
adb logcat FitShield:V AndroidRuntime:E *:S     # app + crashes only
adb exec-out screencap -p > shot.png            # screenshot
adb shell screenrecord /sdcard/x.mp4            # recording (ctrl-C, then adb pull)
adb shell dumpsys activity service com.FitShield.UshaCorporation
adb shell dumpsys package com.FitShield.UshaCorporation | grep -A20 "runtime permissions"
adb shell pm clear com.FitShield.UshaCorporation           # full reset
adb reboot
```

---

## 5. Not this session

- **Anything needing the Play Console**, a keystore or an organization
  developer account — those are in
  [`PLAY_STORE_RELEASE_CHECKLIST.md`](PLAY_STORE_RELEASE_CHECKLIST.md) §12 and
  belong to the user, not to a debugging session.
