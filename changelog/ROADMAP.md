# FitShield Roadmap

Living documentation of where FitShield is and where it's heading. This file is
meant to evolve with the project — update it whenever direction changes. It
avoids speculative promises; "Future ideas" are candidates, not commitments.

_Last updated: 2026-08-25 (0.55)_

## Current version

**0.55 — The block succeeded. Now what?** See [0.55.md](0.55.md). Highlights:

- **The block page became a decision, not a dashboard:** why the page was
  interrupted, how much pause is left, one alternative with *Show another* and
  Closest / Fastest / No cooking / Microwave filters, and three ways out.
- **Scoped passes** replace the all-or-nothing switch — a scope plus a duration,
  every one carrying an absolute expiry that survives restarts, worker
  suspension, sleep and clock changes. No "just this once", because the blocking
  layer cannot observe a single visit and FitShield will not add a navigation
  listener to fake one.
- **88 executable alternatives** (46 full recipes + 42 quick fixes) rebuilt from
  24 sketches, with structured quantities, separate hands-on and elapsed time,
  equipment, allergens, substitutions and storage — matched deterministically
  and locally against the blocked brand, your kitchen and your time.
- **Honest statistics:** seven counters that each name something FitShield can
  actually observe. "Calories avoided" and "blocked visits × meal cost" are gone.
- **Real categories everywhere.** The block page and the stats read a brand's
  curated category instead of an internal rule bucket, and a one-time repair
  removes the mislabeled `fastfood` / `custom` rows from existing profiles.
- **One schedule control in Settings** (presets + the multi-window editor)
  instead of two controls fighting over the same setting.
- **One brand, one switch.** Brands whose country domains were split across the
  two blocklists — so that "Fast food sites" off unblocked delivery platforms —
  now sit entirely in one. 26 brands, 191 records.
- **30 sites are no longer blocked** because you cannot order food from them:
  couriers, a messenger, a fitness app, general marketplaces and corporate
  head-office pages. The catalog is 2,505 brands across 111 markets, in 21
  curated categories.

## Next planned version (0.56)

Themes under consideration (subject to change):

- **Google Play rollout.** Console-side execution: account + declarations
  (Data safety, VpnService, AccessibilityService, foreground services),
  listing assets (screenshots, feature graphic), internal → closed → staged
  production rollout per
  [PLAY_STORE_RELEASE_CHECKLIST.md](../docs/PLAY_STORE_RELEASE_CHECKLIST.md).
  The store listing copy in
  [STORE_LISTING_DRAFT.md](../docs/STORE_LISTING_DRAFT.md) is written against
  0.55 and needs screenshots and a feature graphic before it can be submitted.
- **Android hardening.** IPv6 support in the connection filter (instead of
  drop), broader device/OEM testing, instrumented-test runs in CI.
- **Data quality pass.** Continue the `needs_review` app-status tail; audit the
  wrong-country metadata cluster the 0.54 sweep flagged (many entries tagged
  `["JP"]` that are not Japanese); periodic re-verification of delisted apps.
- **Verify Firefox for Android** on-device (extension DNR path).

## Earlier milestone detail (0.53 Android steps)

- **Native Android APK — shipped in steps.**
  - *Step 1 (UI first, done):* WebView shell on the shared `fitshield.*` platform
    abstraction (`platform/storage/i18n/blocking/stats`), reusing the real web UI
    building blocks; polished preview screen; installable debug APK. Neutral
    Private DNS messaging (no detection/pressure).
  - *Step 1b (visual + feature parity, done):* full FitShield look on mobile —
    the living `ambient.js` gradient background, translucent Aero/One-UI glass
    panels, animated gradient title + savings sheen, and press-tilt tiles (all
    reduced-motion aware). Feature parity: currency picker (reusing `currency.js`),
    most-blocked **categories + countries** (recorded on-device via a per-host
    `meta` map in the generated asset, same primary-market heuristic as the
    extension), full theme colour customization + corner radius, searchable
    language picker, settings **import** via the document picker (export already
    shipped), an optional Buy Me a Coffee link, and a one-time welcome overlay.
    Verified on-device (Samsung, Android 14).
  - *Step 2 (enforcement — connection filtering, done):* blocking now works by
    **TLS SNI / HTTP Host at the connection layer**, not DNS (`Tun2Filter.kt`).
    FitShield routes all traffic through a local userspace filter, reads the
    destination host the client sends in the clear, **resets** blocked connections
    (DoorDash, Uber Eats, …) and transparently relays everything else via
    `protect()`ed sockets. This works **with strict Private DNS / NextDNS on** —
    DNS is never intercepted or altered, so the encrypted provider is completely
    untouched (verified on-device: delivery/fast-food blocked, normal browsing +
    internet unaffected, no visited hostnames logged). No HTTPS block page (that
    would need MITM, which FitShield refuses) — blocked sites simply fail to
    connect. Remaining: IPv6 handling (currently dropped to force IPv4), an
    optional in-app block confirmation, and broader device/network testing. See
    [`docs/ANDROID.md`](../docs/ANDROID.md).
  - *Step 3 (native app blocking, done):* an **AccessibilityService** shows a
    native FitShield intervention screen (`BlockActivity`) when a blocked
    delivery/fast-food *app* is opened — the counterpart of the VPN, which covers
    websites/network traffic. The app→brand mapping is a new **generated dataset**
    (`data/android/*-apps.json` + blocklists → `data/generated/android-packages.json`,
    deterministic, validated: no orphans/dupes, packageStatus rules, drift) — no
    duplicated metadata, built to scale to thousands of packages. The block screen
    reuses the shared design system (`fitshield.css`), i18n, stats, recipes and
    Aero glass, with a reflection timer, per-category toggles, schedule awareness
    and temporary unlock. Verified on-device: detection → block, loop-safe
    Not-now/unlock/re-block, non-blocked apps ignored, VPN coexists. See
    [`docs/ANDROID.md`](../docs/ANDROID.md) §3b.

## Carried-forward themes (not yet scheduled)

- **Finish category localization.** English defines all 37 category keys — the 21
  the data uses plus 16 retired ids kept so existing lifetime stats keep a proper
  name. 18 locales are missing at least one of the 21 current keys, and those
  render the English name rather than a raw id, because both runtimes fall back
  to English. Translation, not coverage, is the gap: of the 82 non-English
  locales, 39 translate every current category name they carry and 43 translate
  some. Extend native translations to the rest, and to the Android block screen's
  category copy.
- **Continue country coverage.** 111 markets are represented across the curated
  brands today. Extend to confident major regional chains and broaden delivery
  coverage where it can be verified. Maintain ISO 3166-1 alpha-2 standards; never
  invent unsupported regions.
- **Stats time range.** Optional "this week / this month / all time" framing for
  the stats, still computed entirely on-device.

## Future ideas

Candidates, not commitments:

- Localized recipe content.
- Richer metadata fields (normalized brand, parent company, confidence) if and
  when they earn their place — kept clean, avoiding schema bloat.
- Per-brand notes surfaced on the block screen.
- Export formats beyond JSON (e.g. a human-readable summary).

*Shipped in 0.55, previously listed here:* the optional weekly on-device recap
(popup, no network, no telemetry, dismissible).

## Long-term vision

FitShield stays a **local-first, privacy-respecting** mindfulness tool for food
delivery and fast-food ordering:

- **No telemetry. No cloud storage. Everything stays on the device.**
- Curated, correct data over sheer quantity.
- Fast popup, fast stats, fast search — performance is a feature.
- Works the same on Firefox and Chromium from a single source tree.
- Documentation (this folder) grows into the project's complete historical
  record, so each release is cheap to document and easy to look back on.

The path toward 1.0 is about depth and polish on these foundations, not feature
sprawl.

## Completed milestones

- **0.55** — The moment after the block: a single-decision block page, scoped
  temporary passes with absolute expiry, an 88-entry executable alternatives
  catalog with deterministic local matching, seven observable statistics
  (calorie and prevented-order claims removed), friction presets, multi-window
  per-weekday schedules, kitchen preferences, custom alternatives, a local
  weekly recap, preview mode, a local reporting flow, curated brand categories
  on the block page and in the stats, one schedule control in Settings instead
  of two, one blocklist switch per brand instead of a split across both, and 30
  non-ordering sites removed from the catalog (2,505 brands / 111 markets / 21
  categories).
- **0.54** — Play-ready release: complete app-coverage research (1,545
  verified packages / 1,474 brands; verified `no_app` and `shared_app`
  terminal statuses; 38-brand tail), 10 corrupted blocklist imports removed,
  engine/extension/android repo separation, first signed Play-upload build
  (0.54 ↔ versionCode 1).
- **0.53** — Native Android app (preview): WebView UI on the `fitshield.*`
  abstraction, TLS-SNI/HTTP-Host connection filter (Private-DNS-safe), opt-in
  AccessibilityService app blocking with a parity block screen, 870 verified
  app→package mappings, edge-to-edge One UI styling, Play Store groundwork
  (API 35, signed AAB, debug-gated logging, launch document pack).
- **0.52** — Most-blocked insights (primary-country heuristic), fast-food country
  coverage 14 → 56, localized food categories, Data & Settings backup,
  validation-gated build with a `tools/` audit suite, `CONTRIBUTING.md`,
  changelog & roadmap infrastructure.
- **0.51** — Local stats panel, currency-aware savings, Firefox + Chromium from
  one source tree, redesigned Settings, onboarding, backup & restore, extension
  icon.
- **0.50** — Recipe suggestions on the block page; fixed a blocklist entry that
  silently disabled all blocking.
- **0.49** — Localization: 80+ display languages and a searchable picker, all UI
  moved into the standard browser i18n system.
