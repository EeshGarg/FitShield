# data/ — the canonical datasets

Everything FitShield knows about brands, alternatives and Android app packages
lives here as JSON. The engine ([`FS Engine/`](../FS%20Engine/README.md)) ships no
data of its own; it is handed these files. Licensed under
[`DATA_LICENSE.md`](../DATA_LICENSE.md). Pipeline diagram:
[`ARCHITECTURE.md`](../ARCHITECTURE.md#4-data-pipeline).

## Contents

| Path | Kind | Purpose |
| --- | --- | --- |
| `blocklists/delivery.json` | **authored** | Delivery brands (`entries[]`). Source of truth for what is blocked in the browser **and** for the brand list Android maps packages onto. |
| `blocklists/fast-food.json` | **authored** | Fast-food / restaurant / coffee / dessert / grocery brands, same shape. |
| `alternatives/NN-*.json` | **authored** | The home-cooked alternatives (full recipes and quick fixes), grouped by craving. Ten parts so a diff stays reviewable. |
| `alternatives-taxonomy.json` | **authored** | Vocabularies the alternatives are validated against (methods, equipment, diets, allergens, regions, cravings, pantry staples) and the category and specialty → craving maps the matcher uses. |
| `recipes.json` | **generated** | The alternatives parts + taxonomy merged into one file (historical name; `recipes[]` + `quickAlternatives[]`). Fetched by the block page and the Android UI. |
| `android/delivery-apps.json`, `android/fast-food-apps.json` | **authored (ported)** | One record per brand: `brandId` (the brand's canonical domain), `packageIds[]`, and for brands with no confirmed package a `packageStatus` (`needs_review`, `no_app`, `shared_app`). Only package facts live here; display metadata is generated from the blocklists. |
| `android/packages.schema.json` | schema | JSON Schema for the generated package map. |
| `generated/android-packages.json` | **generated** | Deterministic compile of `android/*.json` + the blocklists, with counts and a SHA-256. Marked `_doNotEdit`. The slim copy bundled into the app is derived from it. |

Schemas for the blocklists and recipes are embedded in each file under
`_schema` (field-by-field descriptions); the matching semantics are in
[`FS Engine/README.md`](../FS%20Engine/README.md). **Never hand-edit a generated
file** — the validators fail on drift.

Browser packages carry only `blocklists/*.json` and `data/recipes.json`;
`android/` and `generated/` are Android-only and `build.js` refuses to stage them.

## Common changes

Full recipes with every field are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#recipes-for-common-corrections). In short:

| I want to… | Edit | Then run |
| --- | --- | --- |
| Add or correct a **brand** (domain, name, countries, category) | the right `blocklists/*.json` `entries[]` (apex domain only, primary market first in `countries`) | `npm run validate:datasets && npm run validate:aliases`, then `npm run sync` (refreshes `extension/` copies), then `npm run port:android-apps` so the brand gets an Android record |
| Add or correct an **Android app package** | `android/<file>-apps.json`: put the confirmed Play package id in `packageIds` and drop `packageStatus` (or set `no_app` / `shared_app` when verified). **Never guess** a package id — leave `needs_review` | `npm run generate:android-packages`, then `npm run build:android` (refreshes the bundled map), then `npm run validate:android-packages` |
| Add an **alternative** | a part file in `alternatives/` (or a new numbered part) | `npm run generate:alternatives`, `npm run validate:alternatives`, `npm run sync` |
| Add a country, category or tag | the blocklist entries and/or `alternatives-taxonomy.json` | `npm run validate:countries` / `validate:categories` / `validate:alternatives` |

`npm run port:android-apps` mirrors every enabled brand into `android/*.json`,
preserving confirmed package ids and recorded verdicts; run it after the brand
list changes.

## What the validators check

| Validator (`npm run …`) | Looks at |
| --- | --- |
| `validate:datasets` | Blocklist JSON validity, required fields and types, duplicate domains, IDN-aware hostname shape, unknown fields |
| `validate:aliases` | Malformed or duplicate aliases, alias/primary collisions |
| `validate:countries` | ISO 3166-1 codes, region ↔ country consistency |
| `validate:categories` | Category id format, localized `catLabel*` names, orphans |
| `validate:alternatives` | Alternatives schema, ingredient/step sanity, tags, times, category coverage; **fails if `recipes.json` is stale** |
| `validate:android-packages` | Package-map schema, orphaned brands, duplicate brand/package, `packageStatus` rules, determinism and drift against `generated/` |
| `validate:android` | The bundled `android-packages.json` matches the generated data |
| `validate:sync` | `extension/blocklists/`, `extension/data/recipes.json` match these sources |

`npm run validate` runs all of them; `npm test` includes them. Coverage numbers
quoted in docs (curated brands, packages, `no_app` / `shared_app` / `needs_review`)
are re-derived from these files by `test/docs-claims.test.js` and
`test/play-release.test.js`, so a stale number fails a test.
