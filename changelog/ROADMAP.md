# FitShield Roadmap

Living documentation of where FitShield is and where it's heading. This file is
meant to evolve with the project — update it whenever direction changes. It
avoids speculative promises; "Future ideas" are candidates, not commitments.

_Last updated: 2026-06-29 (0.52)_

## Current version

**0.52 — Data expansion, insights & documentation infrastructure.** See
[0.52.md](0.52.md). Highlights:

- Most blocked sites / categories / countries (private, on-device).
- "Export / Import Data & Settings" with versioned backups.
- Validated curated datasets and documented schema.
- This `changelog/` folder and roadmap as the canonical project history.

## Next planned version

Themes under consideration for the next release (subject to change):

- **Wider country & category coverage.** Expand the curated datasets where it
  can be done accurately, especially the fast-food set, which currently spans a
  smaller country range than delivery. Maintain existing country-code standards;
  never invent unsupported regions.
- **Localized categories.** The most-blocked *categories* list currently shows a
  capitalized raw category; localize category display names.
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

- **0.52** — Most-blocked insights, Data & Settings backup, dataset validation,
  changelog & roadmap infrastructure.
- **0.51** — Local stats panel, currency-aware savings, Firefox + Chromium from
  one source tree, redesigned Settings, onboarding, backup & restore, extension
  icon.
- **0.50** — Recipe suggestions on the block page; fixed a blocklist entry that
  silently disabled all blocking.
- **0.49** — Localization: 80+ display languages and a searchable picker, all UI
  moved into the standard browser i18n system.
