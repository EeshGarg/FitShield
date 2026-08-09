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

## Working with an assistant

Automated and assisted sessions in this repository are governed by
[`CLAUDE.md`](CLAUDE.md), with the rules in machine-readable form in
[`development-policy.json`](development-policy.json) and enforced by
`npm run validate:policy`. Two rules matter most, because both were learned the
hard way:

- **A finding is work.** Severity sets the order things get fixed in, never
  whether they get fixed. An issue may not be left open because it is medium,
  editorial, UX, cleanup, or "probably already fixed". If it is safely fixable
  here, it is fixed, tested, and closed before the session ends.
- **No terminal verdicts.** Nothing concludes with NOT READY, SHIP / DO NOT SHIP,
  or an equivalent. A defect is an instruction to fix it, and a reviewer raising
  one has created work rather than ended the task.

A report is the consequence of finishing, not permission to stop: the policy
audit fails the build if the acceptance report claims completion while its own
repository-local queue is non-empty, or if it contains an unverified
"probably fixed". The only unfinished items a report may carry are the four this
machine physically cannot do — the Safari Xcode wrapper (macOS), an Android APK
(the SDK), real screen-reader validation (assistive technology), and human
subjective acceptance.

Specialist agents in [`.claude/agents/`](.claude/agents/) are mandatory for
substantial work, run in parallel, and are partitioned by **file ownership** so
two writers never touch one file.

## Project layout

The repo separates the blocking engine (`FS Engine/`, code only), the
canonical datasets (`data/`), and the browser-extension source (`extension/`);
the packaged zip stays flat (`build.js` composes it from `extension/*` +
`data/*` + the root `changelog.json`, and bundles the engine modules into the
shipped `blocklist.js`). The repository
root is **not** a loadable unpacked extension — build first, then load
`dist/chrome` or `dist/firefox` (see below).

| Path | What it is |
| --- | --- |
| `FS Engine/` | The blocking engine (`index.js` API + modules; see its README for the full API reference). Shipped to browsers as a generated single-file `blocklist.js` |
| `data/blocklists/*.json` | Curated datasets (`fast-food.json`, `delivery.json`) |
| `data/alternatives-taxonomy.json`, `data/alternatives/*.json` | The alternatives catalog (source). Generated into `data/recipes.json`. |
| `data/android/` | Android app-package mappings (brandId → packageIds) |
| `extension/manifest.json` | Chromium MV3 manifest (Firefox manifest is derived by `build.js`) |
| `extension/background.js` | Service worker: rules, bypasses, stats recording |
| `extension/popup / settings / warning / welcome / whats-new` | UI surfaces (`.html` + `.js`) |
| `extension/fitshield-core.js` | Storage schema, migrations, schedules, passes, statistics — shared by the worker, every page, and the tests |
| `extension/currency.js`, `i18n.js`, `languages.js`, `recipes.js`, `preferences.js`, `backup.js` | Shared web modules |
| `extension/_locales/<code>/messages.json` | Translations (83 locales, English is the source) |
| `android/` | Native Android adapter (see `docs/ANDROID.md`); `android/web-src/` holds the Android-authored shim |
| `changelog/` | Canonical release history + `ROADMAP.md` |
| `tools/` | Developer validators + generators (not shipped) |
| `test/` | `node --test` suites |

## Common tasks

### Validate

```bash
npm run sync         # refresh extension/ AND the Android bundle after engine/data/locale edits
npm run validate     # all audits (datasets, locales, docs, assets, extension sync)
npm test             # unit tests + validators
```

Run a single audit with `npm run validate:datasets`, `:alternatives`, `:aliases`,
`:countries`, `:categories`, `:android`, `:android-packages`, `:locales`,
`:docs`, `:assets`, `:extension`, `:sw`, or `:sync` — the same thirteen
`npm run validate` runs. See [`tools/README.md`](tools/README.md). `:sync` fails
if `extension/`'s committed artifacts have drifted from canonical — fix with
`npm run sync`.

### Add a brand

Edit `data/blocklists/fast-food.json` or `data/blocklists/delivery.json`.
Add an entry to `entries`:

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
- Then run `npm run validate:datasets` and `npm run validate:aliases`, and
  `npm run sync` so `extension/`'s committed blocklists pick up the new brand.

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

### Add an alternative (recipe or quick fix)

**Do not edit `data/recipes.json` — it is generated.** Add your entry to the
matching file in `data/alternatives/`, then run:

```bash
npm run generate:alternatives   # rebuilds data/recipes.json
npm run validate:alternatives   # the full audit, with a human-readable report
npm run sync                    # refresh the committed copy in extension/
```

Two kinds share one shape. A **recipe** goes in the `recipes` array and needs the
full detail below. A **quick alternative** goes in `quickAlternatives`, may skip
`prepMinutes`/`cookMinutes`, and is capped at four steps — if it needs more than
four, it is a recipe.

```jsonc
{
  "id": "kebab-case-id",             // stable forever; never reused or renumbered
  "title": "Naan Pizza",
  "description": "One line saying what it is.",
  "servings": 2,                     // what the quantities below actually produce
  "ingredients": [
    { "quantity": 2, "unit": "piece", "item": "naan bread", "substituteGroup": "flatbread" },
    { "quantity": 0.5, "unit": "cup", "item": "sliced mushrooms", "optional": true },
    { "quantity": 1, "unit": "piece", "item": "onion", "note": "finely chopped" }
  ],
  "steps": ["Heat the oven to 230 C / 450 F…", "…"],
  "totalMinutes": 15,                // start to eating
  "activeMinutes": 6,                // hands-on only; must be <= totalMinutes
  "prepMinutes": 5,                  // recipes only
  "cookMinutes": 10,                 // recipes only
  "difficulty": "easy",              // easy | medium
  "equipment": ["oven"],             // [] means none at all
  "method": "quick-cook",            // assembly | no-cook | microwave | quick-cook | air-fryer | one-pan | regular
  "diet": "vegetarian",              // the STRICTEST it satisfies: vegan | vegetarian | pescatarian | omnivore
  "allergens": ["gluten", "dairy"],  // from the nine tracked allergens
  "substitutions": [{ "for": "naan bread", "use": "pita or a flour tortilla" }],
  "storage": "Keeps 2 days; re-crisp in a dry pan.",
  "categories": ["pizza", "delivery"],   // blocked categories this answers
  "cravings": ["pizza"],                 // craving types this answers
  "region": "north-american",
  "noCook": false, "microwave": false, "airFryer": false,
  "onePan": true, "pantryFriendly": true,
  "calorieRange": [470, 610],        // OPTIONAL, and a range — never a single number
  "dataVersion": 2
}
```

Every vocabulary (`method`, `equipment`, `diet`, `allergens`, `region`,
`cravings`, `categories`) is defined in `data/alternatives-taxonomy.json`, along
with the blocked-category and specialty maps that decide when your entry is
offered. Adding a new craving means adding at least **two** entries that answer
it, or the "show another" button has nothing to show.

The audit will reject an entry that is not genuinely executable. In particular:

- every ingredient needs a **quantity and a unit** — "some cumin" fails;
- any step that applies heat needs a **duration**, a **temperature or heat
  level**, and a **doneness cue the cook can check**. "Bake until done" fails;
  "Bake 8–10 minutes, until the cheese is fully melted with browned spots"
  passes;
- baking or air-frying needs a **numeric** temperature;
- raw meat or fish needs an explicit **food-safety cue** — a probe temperature,
  "no pink", "juices run clear", or "cooked through";
- a `vegan` entry may not require an animal product, and a `vegetarian` entry may
  not require meat or fish. This is checked against the ingredient names, so
  "chickpeas" is never read as "chicken";
- every allergen implied by a required ingredient must be **declared**;
- an entry that depends on an uncommon ingredient must offer a **substitution**;
- a `calorieRange` narrower than 20 kcal is rejected as false precision.

Warnings (near-duplicate titles, an ingredient that looks unreferenced, a craving
with no fast option) are printed but never fail the build — they are word
matching, and a guess should not be able to stop a release.

Two semantic rules exist because these mistakes actually happened: a plant dish
may answer a chicken craving only if it says it is a substitute, and a smoothie
may not be tagged or categorised as coffee.

### Report a data problem without writing code

Settings → **Report a problem** composes the report locally, shows you verbatim
what it would say, strips paths and query strings down to a bare domain, and then
lets you copy it or open a mail draft. Nothing is transmitted by FitShield.

### Add or extend a locale

See [`docs/LOCALIZATION.md`](docs/LOCALIZATION.md) for the full workflow —
`npm run locales:status` shows what is missing, and
`node tools/locale-status.js --todo <locale>` writes a translator worklist you
can fill in and merge back safely.

1. Create `extension/_locales/<code>/messages.json`. English is the source of
   truth and must be complete; other locales may be partial. A key you leave out
   falls back to English at runtime (both via `chrome.i18n` and via `i18n.js`),
   so a partial translation renders correctly rather than blank. A key English
   does NOT have is an error, because it can never be shown.
2. Add `<code>` to `SUPPORTED_LOCALES` in [`extension/i18n.js`](extension/i18n.js)
   so it can be picked at runtime.
3. Keep positional placeholders (`$1`, `$2`) identical to English and never use
   `$name$` placeholders.
4. `npm run validate:locales` enforces all of this.

### Build & package

```bash
npm run build        # validates, then writes dist/ + the store zips
```

`build.js` validates first and **aborts on any error**. It flattens
`extension/*`, `data/*`, and the root `changelog.json` into the same package
layout as always (manifest + js/html at the zip root, `data/blocklists` at the
zip root as `blocklists/`), bundles `FS Engine/` into the packaged
`blocklist.js`, then produces:

- `FitShield-<version>-firefox.zip` — Firefox / AMO (manifest gains `background.scripts`)
- `FitShield-<version>-chrome.zip` — Chrome Web Store (committed manifest, gecko keys stripped)

To develop against a real browser, load **`extension/`** directly (Chromium) —
it carries committed runtime artifacts (`blocklist.js`, `blocklists/`,
`data/recipes.json`, `changelog.json`) synced from canonical `FS Engine/` +
`data/`. After editing the engine or data, run `npm run sync` to refresh them
(`npm run validate` / `npm test` fail on a stale copy). For a store-shaped
package or Firefox, `node build.js`, then *Load unpacked* → `dist/chrome`, or
*Load Temporary Add-on* → `dist/firefox/manifest.json`. Never load the repo root.

> Always build with `node build.js`. Don't zip by hand — the built-in writer
> forces forward-slash archive paths, which Windows' `Compress-Archive` breaks.

### Cut a release

1. Bump the version in `extension/manifest.json` and `package.json` (keep them in sync).
2. Add an entry to `changelog.json` (the in-extension *What's New*).
3. Add `changelog/<version>.md` and update `changelog/ROADMAP.md`.
4. `npm test && npm run validate && npm run build`.

`npm run validate:docs` checks the versions and documentation are in sync.
