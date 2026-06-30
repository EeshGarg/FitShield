# FitShield Roadmap

Living documentation of where FitShield is and where it's heading. This file is
meant to evolve with the project — update it whenever direction changes. It
avoids speculative promises; "Future ideas" are candidates, not commitments.

_Last updated: 2026-06-29 (0.52)_

## Current version

**0.52 — Data expansion, insights & documentation infrastructure.** See
[0.52.md](0.52.md). Highlights:

- Most blocked sites / categories / countries (private, on-device), with the
  country stat counting the brand's primary market.
- Fast-food country coverage expanded from 14 to 56 countries across 27 global
  brands; aliases and specialty metadata enriched; datasets validated clean.
- Localized food-category display names (28 languages + clean English fallback).
- "Export / Import Data & Settings" with versioned backups.
- This `changelog/` folder and roadmap as the canonical project history.

## Next planned version

Themes under consideration for the next release (subject to change):

- **Native Android APK (preview → real).** The `android/` adapter foundation
  exists: a local DNS-filtering `VpnService` driven by rules **generated from the
  canonical engine/data** (no fork), with validation + an on-device parity test.
  Next: complete and harden the VpnService DNS I/O (response synthesis, upstream
  forwarding, IPv6/DoH handling), add a committed Gradle wrapper + signed release,
  and verify on a real device. See [`docs/ANDROID.md`](../docs/ANDROID.md).
- **Verify Firefox for Android** on-device (extension DNR path).
- **Finish category localization.** 28 languages now have localized food-category
  names; extend native translations to the remaining locales (they currently use
  a clean English fallback).
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
