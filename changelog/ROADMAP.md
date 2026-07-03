# FitShield Roadmap

Living documentation of where FitShield is and where it's heading. This file is
meant to evolve with the project — update it whenever direction changes. It
avoids speculative promises; "Future ideas" are candidates, not commitments.

_Last updated: 2026-07-03 (0.54)_

## Current version

**0.54 — Play-ready, with complete app coverage.** See [0.54.md](0.54.md).
Highlights:

- **Complete app-coverage research:** every tracked brand now has a verified
  Android app status — **1,545 verified packages covering 1,474 brands**, 777
  brands verified `no_app`, 283 `shared_app` platform storefronts, only 38
  still `needs_review` (never guessed; every ID confirmed on a live store
  listing).
- **Accuracy cleanup:** 10 corrupted blocklist imports removed, including
  registry namespaces (`com.ao`, `uk.com`, …) that could have over-blocked
  entire country domain spaces. Fast-food dataset v1.2; 2,575 generated hosts.
- **Repo separation:** shared engine in `engine/`, browser extension in
  `extension/`, Android app in `android/` — shipped packages byte-identical in
  structure; the root is no longer a loadable unpacked extension (build first).
- **First Play-upload build:** signed AAB at `versionName 0.54` /
  `versionCode 1`, with the launch paperwork finalized under `docs/`.

## Next planned version (0.55)

Themes under consideration (subject to change):

- **Google Play rollout.** Console-side execution: account + declarations
  (Data safety, VpnService, AccessibilityService, foreground services),
  listing assets (screenshots, feature graphic), internal → closed → staged
  production rollout per
  [PLAY_STORE_RELEASE_CHECKLIST.md](../docs/PLAY_STORE_RELEASE_CHECKLIST.md).
- **Android hardening.** IPv6 support in the connection filter (instead of
  drop), broader device/OEM testing, instrumented-test runs in CI.
- **Data quality pass.** Resolve the 38-brand `needs_review` tail; audit the
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
    (`engine/data/android/*-apps.json` + blocklists → `engine/data/generated/android-packages.json`,
    deterministic, validated: no orphans/dupes, packageStatus rules, drift) — no
    duplicated metadata, built to scale to thousands of packages. The block screen
    reuses the shared design system (`fitshield.css`), i18n, stats, recipes and
    Aero glass, with a reflection timer, per-category toggles, schedule awareness
    and temporary unlock. Verified on-device: detection → block, loop-safe
    Not-now/unlock/re-block, non-blocked apps ignored, VPN coexists. See
    [`docs/ANDROID.md`](../docs/ANDROID.md) §3b.

## Carried-forward themes (not yet scheduled)

- **Finish category localization.** 28 languages now have localized food-category
  names; extend native translations to the remaining locales (they currently use
  a clean English fallback). Same for the Android block screen's category copy.
- **Continue country coverage.** Expand beyond the 27 global brands to confident
  major regional chains, and broaden delivery coverage where accurate. Maintain
  ISO 3166-1 alpha-2 standards; never invent unsupported regions.
- **Stats time range.** Optional "this week / this month / all time" framing for
  the stats, still computed entirely on-device.

## Future ideas

Candidates, not commitments:

- Localized recipe content.
- Richer metadata fields (normalized brand, parent company, confidence) if and
  when they earn their place — kept clean, avoiding schema bloat.
- Per-brand notes surfaced on the block screen.
- Export formats beyond JSON (e.g. a human-readable summary).
- Optional weekly on-device recap (no network, no telemetry).

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
