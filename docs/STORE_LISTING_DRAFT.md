# FitShield — Google Play Store Listing Draft

> [!NOTE]
> **Copy re-checked against the Android build on 2026-08-26.** The 0.55 rewrite
> removed the pre-0.55 product's claims — two fixed recipe cards, an
> all-or-nothing bypass, "calories avoided" as a headline — but it described the
> *extension's* feature set on a page that sells the *phone app*, and the two had
> already diverged. Three bullets promised things the Android build does not do:
> a four-part statistics row where the phone keeps one counter, ingredient
> quantities and allergen labelling on the pause screen where the phone shows a
> title, a duration and a sentence, and passes that "say how long for" where the
> phone states a scope but never a duration. All three are corrected below.
>
> **This page sells the Android app.** Where the extension does more, the listing
> says nothing rather than borrowing the extension's behaviour. Anything asserted
> here about the phone is checked by `test/play-release.test.js`.
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
> • 2,500+ curated brands across delivery, fast food, coffee, dessert, grocery
> and meal kits — every one of them blockable as a **site**, and the ones that
> have their own Android app blockable as an **app** as well
> • Add your own domains for anything the catalog misses
> • Schedules for the hours that actually catch you out, reflection timers, and
> temporary passes scoped to the one brand you opened, not a blanket switch-off
> • 88 at-home alternatives — the pause screen suggests one matched to the brand
> you were about to order from, with how long it takes, instead of just a wall
> • One honest number: ordering pages interrupted. Plus a private breakdown of
> what you were blocked from most — computed on your phone, shown only to you,
> never uploaded. No invented savings, no invented calories
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
> catalog, same blocking engine, same respect for your privacy. The extension
> also knows your diet and kitchen preferences; the phone app deliberately does
> not ask for them. Learn more at fitshield.net.

(Behavioral framing only — verify no "lose weight", "addiction", "diet",
"health" outcome claims before submitting.)

> **What may and may not be claimed for Android.**
>
> *May be:* the pause screen's suggestion is matched to the blocked brand. The
> Android screen now calls `selectAlternative` — the same entry point and the
> same argument shape `extension/warning.js` uses — with the brand's food
> category, type and specialties. It previously reached for a selector name the
> shared module no longer exported and fell through to picking by the character
> count of the brand id, which is what this note used to warn about; that is
> fixed and guarded by `test/android-block.test.js`.
>
> *May not be:* that the Android suggestion is personalised to the user — diet,
> allergens, pantry, equipment or available time. Those are the `settings`
> argument, and Android passes `{}` because the Android app has no kitchen,
> diet or allergen preferences at all. **Never put an allergen-matching claim on
> this listing**, and phrase the matching as "matched to the site you were about
> to order from" rather than to the person.
>
> *May not be, and this is newer:* that the pause screen shows **ingredient
> quantities, equipment or allergen labelling**. It shows the title, the total
> time and the description — `recipeCard()` in `android/.../web/block.js` builds
> exactly those three and nothing else. The extension's block page shows the
> full card; the phone's does not, and the two must not be described as one.
>
> *May not be, until the Android lane lands the fix:* that the in-app
> **Alternatives** panel lets you browse the catalog with ingredients and steps.
> Two things are wrong with it today, and both have been routed: it renders only
> the first 24 of the 88 entries, and its ingredient line is
> `(r.ingredients || []).join(", ")` over an array of `{quantity, unit, item}`
> objects, so a real device prints `[object Object], [object Object], …`. When
> that is fixed, add the bullet back — `test/play-release.test.js` will fail
> until this paragraph goes with it.
>
> *May not be:* that a temporary pass **says how long it lasts**. On Android the
> pass is genuinely scoped — `AppBlockPolicy.unlock()` stores an expiry against
> the single `brandId`, so it never unlocks anything else — but the pause screen
> only ever labels its button "Open <app>". The duration is real and is not
> stated. Claim the scope; do not claim the disclosure.

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

1. **Dashboard** — status card "On", with the one counter the app keeps:
   *Ordering pages interrupted*. Do not stage a shot implying more tiles exist.
2. **Block screen** — DoorDash example: brand, reason, timer, alternative, actions.
3. **App-blocking panel** — category pills + the three status indicators.
4. **Schedule & timers** — blocking options panel.
5. **Alternatives** — a card expanded. **Hold this shot** until the ingredient
   rendering is fixed; today it screenshots as `[object Object]`.
6. **Theme customization** — color pickers mid-edit, a non-default accent.
7. **Language picker** — showing localization breadth.
8. **Stats detail** — most-blocked sites / categories / countries / apps.

Overlay short captions (≤6 words) per screenshot, e.g. "Pause before you
order", "Your stats stay on-device".

- [ ] 7 phone screenshots now, 8 once shot 5 is unblocked (1080×2340 native is
      fine; Play requires at least 2)
- [ ] Optional: 7"/10" tablet set (WebView UI scales; capture if targeting tablets)

## Feature graphic checklist (1024×500, required)

- [ ] FitShield wordmark + shield/"F" icon on the brand gradient (dark green)
- [ ] One-line tagline: "Pause before you order."
- [ ] No screenshots-in-frame, no small text, no Play badges inside the graphic
- [ ] Safe margins ~60px; readable at thumbnail size

## App icon

- [ ] 512×512 PNG for the store listing
- [ ] Consistent with extension branding (icon-128.png lineage)
- [ ] **The app itself currently has no launcher icon** — no `mipmap-*` resources
      and no `android:icon` on `<application>`, so it installs with Android's
      grey placeholder. The store icon does not fix that. Design both from the
      same artwork and see
      [PLAY_STORE_RELEASE_CHECKLIST.md §8](PLAY_STORE_RELEASE_CHECKLIST.md#8-store-listing-and-assets)
      for exactly what the Android lane needs.

## Release notes — "What's new" (500 chars max per entry)

**versionName 0.55 (versionCode assigned at upload — it must strictly increase):**

> • A calmer pause screen: what was interrupted, how long is left, and one thing
> you could make instead
> • Honest statistics — one counter for ordering pages interrupted, plus a
> private breakdown of what blocked you most. No invented savings or calories
> • Temporary passes are scoped to the one app you opened, never a blanket
> switch-off
> • The pause screen suggests something matched to the brand you opened
> • Categories now name what a brand actually sells

(454 chars of the 500 allowed. Counted, not estimated — the previous draft
claimed 392 for a block that was a different length.)

**versionCode 1 · versionName 0.54 (first upload):**

> First release of FitShield for Android.
> • Blocks food-delivery & fast-food websites with a local, on-device filter — no traffic ever leaves your phone
> • Optional app blocking with a mindful pause screen, stats, and recipe ideas
> • 2,500+ curated brands, with app mappings researched by hand
> • 83 languages, dark/light themes
> • No account, no ads, no analytics — everything stays on your device

(390 chars — recounted; the draft claimed 431. "every app mapping verified by
hand" was also not true and is gone: 36 brands are still `needs_review` and one
has no port record at all, so the honest word is "researched". Add each future upload's notes above this line, newest first, and
record the versionName↔versionCode pair in `changelog/<version>.md`.
`versionName` is injected from `extension/manifest.json` by the Android build, so
it always matches the canonical version; `versionCode` is supplied per release.)

## Play Console declaration notes

Full wording and the exact form answers live in
[PLAY_STORE_RELEASE_CHECKLIST.md §7](PLAY_STORE_RELEASE_CHECKLIST.md#7-play-console-declarations)
and [PRIVACY_POLICY_ANDROID_NOTES.md](PRIVACY_POLICY_ANDROID_NOTES.md). Summary:

- **Developer account must be an organization**, not a personal one — Google
  requires it for apps approved to use `VpnService`, and it cannot be changed
  after signup. This gates everything else on this page.
- **Data safety:** no data collected, none shared, on-device only. Because
  collection is No, Play never asks the encryption-in-transit or
  deletion-request follow-ups.
- **VpnService:** declare it as a **local firewall / content filter**, not a VPN.
  No tunnel, no endpoint, no inspection beyond the cleartext destination host,
  no DNS changes.
- **AccessibilityService:** reads the foreground package name only; user opt-in;
  `isAccessibilityTool` deliberately not claimed. A demo video is required.
- **Foreground services:** `specialUse` ×2 (VPN filter, optional keep-alive) with
  the manifest `<property>` justifications quoted verbatim.
- **Ads:** none. **Advertising ID:** none. **IAP:** none. **Target audience:**
  adults, not child-directed. **Content rating:** complete IARC (expect
  Everyone). **Government apps:** no. **Health apps:** no — FitShield reads no
  health or fitness data of any kind.
- **Login credentials for review:** none needed (no account).
- **App access notes for reviewers:** "All features work without an account.
  To see app blocking: Settings → enable app blocking → enable the FitShield
  accessibility service when prompted → open any blocked food app (e.g.
  McDonald's). To see site blocking: tap Enable FitShield → accept the VPN
  consent → visit doordash.com in any browser. The release build is not
  minified; this is deliberate, as the project ships auditable source."
- **Say this before the reviewer has to ask it.** `VpnService` +
  `AccessibilityService` + display-over-other-apps + a boot receiver + a
  foreground service is, in combination, the permission profile of stalkerware.
  Volunteer the shape of it: every one of the five is user-initiated and
  individually revocable, the accessibility service is configured
  `canRetrieveWindowContent="false"` so it cannot read screen content at all, the
  VPN has no remote endpoint and relays allowed traffic byte-for-byte to the
  destination the client chose, the overlay permission draws nothing (it is held
  only so the pause screen may be launched from the background), the boot
  receiver restores only the setting the user themselves last chose, and the
  whole thing is open source with no network destination of its own.

## Closed testing instructions (for testers)

1. Join the closed track via the opt-in link (Play Console → Testing → Closed).
2. Install FitShield from Play.
3. Site blocking: tap **Enable FitShield**, accept the one-time VPN dialog, then
   try `doordash.com` in your browser → it should fail to connect
   (ERR_CONNECTION_RESET) while normal sites load. Works with Private DNS on.
4. App blocking: open **Block apps on this phone**, toggle **Enable app
   blocking**, tap **Open Accessibility settings** and enable FitShield, then
   open a blocked food app → the pause screen should appear and stay.
5. Try: "Not now", "Open anyway" (timer, then temporary unlock — it should
   unlock only the app you opened, not everything), schedule on/off, keep-alive
   toggle, battery optimization on/off. **Report whether you ever see any
   FitShield notification at all** — on Android 13+ the app has never asked
   for notification permission, so you probably will not, and we need to know
   which devices that bites on.
6. **Reboot the phone and then check both halves of blocking separately.** Both
   should come back on their own. Then turn FitShield **off**, reboot again, and
   confirm it stays off — it must never switch itself on for someone who turned
   it off.
7. Report: device model, Android version, and any case where a *non-food* app
   was blocked (should never happen) or a block screen flashed and vanished.

## Production rollout plan

1. **Internal testing** (up to 100 testers) — the team, 1–2 weeks: verify AAB
   install path, all §6 checklist behaviors on ≥3 OEMs (Samsung, Pixel, one
   budget device).
2. **Closed beta** — 2+ weeks: watch the pre-launch report, ANR/crash-free
   ≥99.5%. Play's "12 testers opted in for 14 continuous days" rule applies only
   to *personal* accounts created after 13 November 2023, and `VpnService`
   forces an organization account, so it does not apply here. Do a closed beta
   anyway — real devices are the only place the VPN-consent and accessibility
   flows get exercised.
3. **Production, staged:** 10% → 3 days clean → 50% → 3 days → 100%.
4. **Halt criteria:** any false-positive blocking of non-food apps, VPN
   breaking general connectivity, accessibility loop, or crash-free <99%.
5. Each release: bump `versionCode`, tag `versionName` in `changelog/`, rebuild
   AAB with the exact command in the release checklist §9.

---

_Keep this draft in sync with the app: if UI copy or features change, re-read
the description for accuracy before each submission._
