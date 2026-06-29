# Contributing to FitShield

FitShield is a **local-first, privacy-first** browser extension that adds a
mindful pause before food-delivery and fast-food ordering. It runs on Firefox
and Chromium (Chrome, Brave, Edge) from a single source tree, on Manifest V3.

There is **no build framework and no runtime dependencies** — the extension is
plain JS/HTML/JSON. The only Node usage is for the test suite and the developer
tools in [`tools/`](tools/).

## Golden rules

- **No telemetry, no cloud, no network calls.** Everything stays on the device.
- **Don't fabricate data.** Prefer correctness over quantity; only add brands,
  countries, or translations you can verify.
- **Keep it fast.** Don't add work to popup startup, blocking, or stats.
- **Validate before you commit:** `npm run validate` (and `npm test`).

## Project layout

| Path | What it is |
| --- | --- |
| `manifest.json` | Chromium MV3 manifest (Firefox manifest is derived by `build.js`) |
| `background.js` | Service worker: rules, bypasses, stats recording |
| `blocklist.js` | Shared dataset loader + matching helpers (browser + Node) |
| `blocklists/*.json` | Curated datasets (`fast-food.json`, `delivery.json`) |
| `data/recipes.json` | Local recipe catalog for the block screen |
| `popup / settings / warning / welcome / whats-new` | UI surfaces (`.html` + `.js`) |
| `currency.js`, `i18n.js`, `languages.js`, `recipes.js`, `backup.js` | Shared modules |
| `_locales/<code>/messages.json` | Translations (83 locales, English is the source) |
| `changelog/` | Canonical release history + `ROADMAP.md` |
| `tools/` | Developer validators (not shipped) |
| `test/` | `node --test` suites |

## Common tasks

### Validate

```bash
npm run validate     # all audits (datasets, locales, docs, assets)
npm test             # unit tests + validators
```

Run a single audit with `npm run validate:datasets`, `:aliases`, `:countries`,
`:categories`, `:locales`, `:docs`, or `:assets`. See [`tools/README.md`](tools/README.md).

### Add a brand

Edit `blocklists/fast-food.json` or `blocklists/delivery.json`. Add an entry to
`entries`:

```json
{
  "domain": "example.com",
  "name": "Example",
  "aliases": ["example.co.uk"],
  "type": "fast_food",
  "countries": ["US", "CA"],
  "regions": ["NA"],
  "category": "burger",
  "specialties": ["burgers", "fries"],
  "enabled": true
}
```

- `domain` — apex only, lowercase, no `www.`/path (IDN is allowed).
- `type` — `fast_food` or `delivery`.
- `countries` — **primary market first** (the most-blocked-countries stat uses
  the first code). ISO 3166-1 alpha-2.
- `regions` — must match the continents implied by `countries`.
- `category` — one primary id (see below); put extra descriptors in
  `specialties` (searchable, not used for blocking).
- Then run `npm run validate:datasets` and `npm run validate:aliases`.

### Add / change a country

Use the correct ISO 3166-1 alpha-2 code and keep the primary market first.
`npm run validate:countries` checks the code is real and that `regions` stays
consistent. If you introduce a brand-new code, add it to `ISO_COUNTRIES` (and,
if needed, `COUNTRY_REGION`) in [`tools/lib/load.js`](tools/lib/load.js).

### Add / change a category

`category` is a single lowercase `snake_case` id. To give it a localized display
name in the stats, add a `catLabel<PascalCase>` key (e.g. `catLabelKoreanFood`)
to **every** locale (English is the source). Without one it falls back to a
clean, title-cased version of the id, so localization is optional but nice.
`npm run validate:categories` reports coverage.

### Add a recipe

Edit `data/recipes.json`:

```json
{
  "id": "kebab-case-id",
  "title": "Dish Name",
  "description": "One friendly sentence.",
  "timeMinutes": 15,
  "calories": 380,
  "ingredients": ["…"],
  "steps": ["…"],
  "tags": ["taco", "mexican"],
  "diet": "vegetarian"
}
```

`diet` is `vegetarian` or `meat`; `tags` help match the recipe to the blocked
brand's category. `npm test` covers recipe selection.

### Add a locale

1. Create `_locales/<code>/messages.json` with **exactly** the same keys as
   `_locales/en/messages.json` (English is the source of truth).
2. Add `<code>` to `SUPPORTED_LOCALES` in [`i18n.js`](i18n.js) so it can be
   picked at runtime.
3. Keep positional placeholders (`$1`, `$2`) identical to English and never use
   `$name$` placeholders.
4. `npm run validate:locales` enforces all of this.

### Build & package

```bash
npm run build        # validates, then writes dist/ + the store zips
```

`build.js` validates first and **aborts on any error**. It produces:

- `FitShield-<version>.zip` — Firefox / AMO (manifest gains `background.scripts`)
- `FitShield-<version>-chrome.zip` — Chrome Web Store (committed manifest as-is)

> Always build with `node build.js`. Don't zip by hand — the built-in writer
> forces forward-slash archive paths, which Windows' `Compress-Archive` breaks.

### Cut a release

1. Bump the version in `manifest.json` and `package.json` (keep them in sync).
2. Add an entry to `changelog.json` (the in-extension *What's New*).
3. Add `changelog/<version>.md` and update `changelog/ROADMAP.md`.
4. `npm test && npm run validate && npm run build`.

`npm run validate:docs` checks the versions and documentation are in sync.
