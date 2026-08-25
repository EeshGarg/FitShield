# FitShield — Google Play Store Listing Draft

> [!NOTE]
> **Copy rewritten against 0.55 (2026-08-09).** The earlier draft described the
> pre-0.55 product — two fixed recipe cards, a single all-or-nothing bypass, and
> "calories avoided" as a headline figure — none of which exists any more. Every
> claim below was re-checked against the shipped code and datasets.
>
> What is still outstanding before submission is **assets, not copy**: phone
> screenshots and the feature graphic have to be captured on a real device, and
> the Play Console declarations have to be filled in. Those are checklists below.
>
> The claims guardrail stands, and 0.55 tightens it: FitShield must not claim a
> prevented order, avoided calories, money saved, or any weight outcome, because
> it cannot observe any of them.

_Draft copy + asset checklists for the Play Console listing. Pairs with
[PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md) (build/process)
and [PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md)
(disclosures). Claims guardrail: **no medical, addiction-treatment, or
guaranteed weight-loss language** — FitShield is a mindfulness/friction tool._

---

## App name (30 chars max)

> **FitShield — Food Order Blocker**

(29 chars. Alternates: "FitShield: Pause Food Orders", "FitShield Food Blocker".)

## Short description (80 chars max)

> Pause before you order. Block food delivery & fast-food apps and sites — locally.

(79 chars. Alternates:
- "Block food delivery & fast-food apps/sites. A mindful pause, 100% on-device."
- "Make ordering a choice, not a reflex. Local food-app & site blocker.")

## Full description (4000 chars max)

> **Make food ordering a choice, not a reflex.**
>
> FitShield adds a mindful pause between a craving and the checkout button. Open
> a blocked delivery or fast-food app and FitShield shows a calm pause screen
> instead — telling you what it interrupted and offering one thing you could
> make instead, with the option to continue anyway once the timer ends. You stay
> in control; FitShield just adds friction.
>
> **What it does**
> • Blocks food-delivery & fast-food **websites** system-wide with a local,
> on-device connection filter (works with Private DNS / NextDNS enabled)
> • Blocks food **apps** you choose, with a pause screen instead of the app
> (opt-in Accessibility service)
> • 2,500+ curated brands across delivery, fast food, coffee, dessert, grocery,
> and meal kits — plus your own custom domains
> • Schedules for the hours that actually catch you out, reflection timers, and
> scoped temporary passes that always say what they cover and how long for
> • 88 at-home alternatives with real quantities, timings, equipment and
> allergen labelling, offered on the pause screen instead of just a wall
> • Honest local stats: pages interrupted, times you left, times you continued,
> passes used, and alternatives shown, chosen and marked as made — computed on
> your phone, shown only to you
> • 83 languages, dark/light themes with full color customization
>
> **Privacy first — everything stays on your device**
> • No account, no cloud, no ads, no analytics, no telemetry
> • The VPN is a local filter only: it never tunnels your traffic to any server,
> never decrypts HTTPS, never touches DNS, and sends nothing to FitShield —
> there are no FitShield servers
> • The optional Accessibility service reads only which app comes to the
> foreground — never screen content, messages, or passwords
> • Free and open source
>
> **You're always in control**
> • Nothing is blocked until you turn blocking on
> • Every block screen has an "open anyway" option after the pause
> • Disable or uninstall anytime — no lock-in, no guilt trips
>
> FitShield is the Android companion of the FitShield browser extension — same
> data, same features, same respect for your privacy. Learn more at
> fitshield.net.

(Behavioral framing only — verify no "lose weight", "addiction", "diet",
"health" outcome claims before submitting.)

> **Deliberately not claimed for Android:** that the pause screen's suggestion is
> matched to the blocked brand's category, or to your diet, allergens, pantry,
> equipment or available time. That matching is real in the **browser extension**
> (`selectAlternative`), but the Android block screen currently reaches for a
> selector name the shared module no longer exports and falls through to a
> deterministic fallback pick. Do not add a personalisation or allergen-matching
> claim to this listing until the Android screen is reconnected to
> `selectAlternative` and re-verified on a device.

## Category & tags

- **Category:** Lifestyle (alternative: Productivity — Lifestyle better matches
  "mindful habits" positioning and less crowded competition).
- **Tags/keywords** (for positioning; Play has no keyword field — bake into the
  description naturally): food blocker, delivery blocker, app blocker, mindful
  eating, impulse control, screen-time for food, self-control, distraction
  blocker, save money, cook at home.

## Screenshot checklist (phone, 16:9 or 9:16, 2–8 required)

Capture on a real device (Samsung, dark theme, edge-to-edge — the transparent
status/nav bars look best). Suggested set, in order:

1. **Dashboard** — status card "On", with the honest counters (pages
   interrupted / times you left / times you continued).
2. **Block screen** — DoorDash example: brand, reason, timer, alternative, actions.
3. **App-blocking panel** — category pills + the three status indicators.
4. **Schedule & timers** — blocking options panel.
5. **Recipes** — a recipe expanded (ingredients + steps).
6. **Theme customization** — color pickers mid-edit, a non-default accent.
7. **Language picker** — showing localization breadth.
8. **Stats detail** — most-blocked apps/sites breakdown.

Overlay short captions (≤6 words) per screenshot, e.g. "Pause before you
order", "Your stats stay on-device".

- [ ] 8 phone screenshots (1080×2340 native is fine)
- [ ] Optional: 7"/10" tablet set (WebView UI scales; capture if targeting tablets)

## Feature graphic checklist (1024×500, required)

- [ ] FitShield wordmark + shield/"F" icon on the brand gradient (dark green)
- [ ] One-line tagline: "Pause before you order."
- [ ] No screenshots-in-frame, no small text, no Play badges inside the graphic
- [ ] Safe margins ~60px; readable at thumbnail size

## App icon

- [ ] 512×512 PNG, matches the launcher icon (green "F" on white / adaptive)
- [ ] Consistent with extension branding (icon-128.png lineage)

## Release notes — "What's new" (500 chars max per entry)

**versionName 0.55 (versionCode assigned at upload — it must strictly increase):**

> • A calmer pause screen: what was interrupted, how long is left, and one thing
> you could make instead
> • Honest statistics — pages interrupted, times you left, times you continued,
> passes used. No invented "calories avoided"
> • Temporary passes now say exactly what they cover and how long for
> • 88 at-home alternatives with real quantities, timings and allergen labelling
> • Categories now name what a brand actually sells

(392 chars.)

**versionCode 1 · versionName 0.54 (first upload):**

> First release of FitShield for Android.
> • Blocks food-delivery & fast-food websites with a local, on-device filter — no traffic ever leaves your phone
> • Optional app blocking with a mindful pause screen, stats, and recipe ideas
> • 2,500+ curated brands, every app mapping verified by hand
> • 83 languages, dark/light themes
> • No account, no ads, no analytics — everything stays on your device

(431 chars. Add each future upload's notes above this line, newest first, and
record the versionName↔versionCode pair in `changelog/<version>.md`.
`versionName` is injected from `extension/manifest.json` by the Android build, so
it always matches the canonical version; `versionCode` is supplied per release.)

## Play Console declaration notes

(Details in [PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md).)

- **Data safety:** no data collected/shared; on-device only; deletion =
  uninstall or in-app reset.
- **VpnService:** local content filter; no tunneling/inspection/DNS changes.
- **AccessibilityService:** prominent in-app disclosure exists (app-blocking
  panel); reads foreground package name only; user opt-in.
- **Foreground services:** `specialUse` ×2 (VPN filter, optional keep-alive) with
  manifest `<property>` justifications.
- **Ads:** none. **IAP:** none. **Target audience:** 18+ general (not
  child-directed). **Content rating:** complete IARC questionnaire (expect
  Everyone).
- **Login credentials for review:** none needed (no account).
- **App access notes for reviewers:** "All features work without an account.
  To see app blocking: Settings → enable app blocking → enable the FitShield
  accessibility service when prompted → open any blocked food app (e.g.
  McDonald's). To see site blocking: tap Enable FitShield → accept the VPN
  consent → visit doordash.com in any browser."

## Closed testing instructions (for testers)

1. Join the closed track via the opt-in link (Play Console → Testing → Closed).
2. Install FitShield from Play.
3. Site blocking: tap **Enable FitShield**, accept the one-time VPN dialog, then
   try `doordash.com` in your browser → it should fail to connect
   (ERR_CONNECTION_RESET) while normal sites load. Works with Private DNS on.
4. App blocking: open **Block apps on this phone**, toggle **Enable app
   blocking**, tap **Open Accessibility settings** and enable FitShield, then
   open a blocked food app → the pause screen should appear and stay.
5. Try: "Not now", "Open anyway" (timer, then temporary unlock), schedule
   on/off, keep-alive toggle (quiet notification appears/disappears), reboot
   (accessibility survives; VPN re-enable is manual by design), battery
   optimization on/off.
6. Report: device model, Android version, and any case where a *non-food* app
   was blocked (should never happen) or a block screen flashed and vanished.

## Production rollout plan

1. **Internal testing** (up to 100 testers) — the team, 1–2 weeks: verify AAB
   install path, all §6 checklist behaviors on ≥3 OEMs (Samsung, Pixel, one
   budget device).
2. **Closed beta** — 2+ weeks or 20+ testers (Play's new-personal-account
   requirement if applicable): watch pre-launch report, ANR/crash-free ≥99.5%.
3. **Production, staged:** 10% → 3 days clean → 50% → 3 days → 100%.
4. **Halt criteria:** any false-positive blocking of non-food apps, VPN
   breaking general connectivity, accessibility loop, or crash-free <99%.
5. Each release: bump `versionCode`, tag `versionName` in `changelog/`, rebuild
   AAB with the exact command in the release checklist §9.

---

_Keep this draft in sync with the app: if UI copy or features change, re-read
the description for accuracy before each submission._
