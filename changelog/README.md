# FitShield Changelog

This folder is the **canonical, permanent release history** for FitShield. Each
release has its own markdown file with the full story behind it — features,
improvements, fixes, architectural notes, repository changes, licensing, and
browser-compatibility notes.

> **Single source of truth.** GitHub Releases and the in-extension *What's New*
> screen (driven by [`changelog.json`](../changelog.json)) are *summaries*. The
> complete, lasting record lives here, in `changelog/*.md`. This mirrors the
> documentation approach used on the website — avoid duplicating the history in
> more than one authoritative place.

## How this is organized

- One file per release, named after the version: `0.49.md`, `0.50.md`, …
- [`ROADMAP.md`](ROADMAP.md) — living documentation of where the project is and
  where it's heading.

## Releases

| Version | Date | Theme |
| --- | --- | --- |
| [0.52](0.52.md) | 2026-06-29 | Data expansion, insights & documentation infrastructure |
| [0.51](0.51.md) | 2026-06-27 | Stats, Firefox & a wider dashboard |
| [0.50](0.50.md) | 2026-06-26 | Recipe suggestions & blocking fixes |
| [0.49](0.49.md) | 2026-06-25 | Localization |

Releases prior to 0.49 predate this changelog system and were tracked only in
git history and store listings. New releases should each add a file here.

## Writing a new release note

When cutting a release:

1. Copy the section layout from the most recent file (overview → major features
   → improvements → fixes → architectural changes → repository changes →
   licensing → browser compatibility → known issues).
2. Fill in only what actually shipped — these are a historical record, not a
   marketing copy of the GitHub release.
3. Add a short summary entry to [`changelog.json`](../changelog.json) for the
   in-extension *What's New* screen.
4. Update the table above and [`ROADMAP.md`](ROADMAP.md).
