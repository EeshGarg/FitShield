# FitShield developer tools

Developer-only validators, generators, and packagers for the curated datasets,
localization, documentation, and build assets. **Nothing here is bundled into the
extension** — these files are not in `build.js`'s file list, so they never affect
popup startup, memory, or blocking. They use Node built-ins only (no
dependencies).

## Run everything

```bash
npm test                # the test suite
npm run validate        # node tools/validate-all.js — all 15 audits
```

`validate` exits non-zero if any audit reports an error; warnings never fail a
build. `build.js` runs it automatically before packaging.

## Validators (all 15 run by `npm run validate`)

| Command | Tool | Checks |
| --- | --- | --- |
| `npm run validate:datasets` | `validate-datasets.js` | JSON validity, required fields, field types, duplicate domains, hostname shape (IDN-aware), unknown fields, schema keys |
| `npm run validate:alternatives` | `alternatives-audit.js` | recipe/quick-fix schema, ingredient and step sanity, equipment and dietary tags, time estimates, category coverage |
| `npm run validate:aliases` | `alias-audit.js` | malformed/duplicate aliases, alias↔primary collisions, www-variant warnings |
| `npm run validate:countries` | `country-audit.js` | ISO 3166-1 alpha-2 codes, unknown/duplicate codes, region↔country consistency |
| `npm run validate:categories` | `category-audit.js` | category id format, localized-name (`catLabel*`) coverage, orphaned display names |
| `npm run validate:android` | `android-audit.js` | the generated rules asset still matches the engine, no Android data fork, no unapproved permissions or analytics |
| `npm run validate:android-packages` | `validate-android-packages.js` | package-map schema, orphaned brands, duplicate brand/package, `packageStatus`, determinism, drift |
| `npm run validate:locales` | `locale-parity.js` | identical key sets, empty messages, `$name$` placeholders, positional-placeholder parity, duplicate keys, unreferenced keys (warning) |
| `npm run validate:hybrids` | `locale-hybrid-audit.js` | strings that are neither translated nor English but a mangled mix (`"Take one минута."`, `"блокироватьing"`); `--apply` removes them so they fall back to English |
| `npm run validate:policy` | `policy-audit.js` | development governance: CLAUDE.md and development-policy.json agree, every required agent definition is registered, no instruction file re-introduces a terminal verdict or a deferral bucket, and the acceptance report cannot claim completion while its local queue is non-empty |
| `npm run validate:docs` | `changelog-validator.js` | manifest↔package version sync, `changelog.json` current entry, `changelog/<version>.md` + `ROADMAP.md` presence |
| `npm run validate:assets` | `assets-check.js` | manifest keys, referenced icons exist, required runtime files/dirs present |
| `npm run validate:extension` | `extension-audit.js` | the staged package is closed — every manifest, page, and runtime reference resolves |
| `npm run validate:sw` | `service-worker-audit.js` | the worker's `importScripts` targets exist and the engine functions it calls are present in the bundle |
| `npm run validate:sync` | `sync-audit.js` | `extension/`'s committed artifacts (engine bundle, blocklists, recipes, changelog) match canonical `FS Engine/` + `data/`, so the folder loads unpacked; stale copy → `npm run sync` |
| `npm run validate:a11y` | `browser-a11y-audit.js` | loads the built package in Chromium and reads the **computed accessibility tree** (`Accessibility.getFullAXTree`) — the tree a screen reader consumes, not the DOM. Every control has a name, no unresolved i18n key reaches a label, nothing focusable is hidden from assistive technology, and no heading level is skipped. Warns and skips when no browser is installed; set `FS_CHROME` to point at one. |
| `npm run validate:announce` | `announcement-audit.js` | reads the accessibility tree in ORDER — what a screen reader is handed, not just whether a name exists. Checks reading order, that a label and its value announce as one statement, that the countdown speaks on milestones only and says what it is counting, that the pause ending is announced, that sliders carry their unit, and that no decorative glyph is inside a name. |
| `npm run validate:safari` | `safari-audit.js` | Safari pre-flight for the staged Apple payload: the declared `strict_min_version` covers every API the package actually uses (MV3 service worker and `storage.session` both need 16.4), and no shipped source calls an API Safari does not implement — those are `undefined` there, so the feature silently does nothing rather than failing. Wrapping still needs macOS + Xcode. |
| `npm run validate:firefox` | `firefox-audit.js` | installs the built Firefox package in real Firefox over WebDriver BiDi, then asks for a blocked site and asserts the browser redirects to the block page — event page booting, dynamic rules installing, Firefox matching one, block page rendering, all in one check. Also fails on any console error or unresolved i18n key. Warns and skips without Firefox; set `FS_FIREFOX`. |

## Generators (write committed artifacts)

| Command | Tool | Writes |
| --- | --- | --- |
| `npm run sync` | `sync-extension.js` | `extension/`'s runtime artifacts **and** the Android web assets. Run after editing `FS Engine/` or `data/`. |
| `npm run toolchain:android` | `provision-android-toolchain.js` | fetches JDK 17 + the Android SDK (platform 35, build-tools 35) into `~/.fitshield-toolchain`, outside the repo. Nothing system-wide is changed and nothing is committed; `build-android.js` finds it and hands Gradle its own environment. Idempotent — anything already present is left alone. |
| `npm run capture` | `capture-surfaces.js` | screenshots every surface into `dist/acceptance/` — both palettes, at the sizes where layouts break. Shrinks human acceptance from installing a build and clicking through twice to opening one folder; the judgement calls it supports are listed in `docs/ACCEPTANCE.md`. |
| `npm run generate:alternatives` | `build-alternatives.js` | `data/recipes.json` from the `data/alternatives/*.json` parts |
| `npm run generate:android` | `generate-android-rules.js` | `android/…/fitshield-rules.json` + the on-device semantics fixture |
| `npm run generate:android-packages` | `generate-android-packages.js` | `data/generated/android-packages.json` → the bundled package map |
| `npm run port:android-apps` | `port-android-apps.js` | mirrors every enabled brand into the app files, preserving confirmed package IDs |

Generated files are validated against their source, so forgetting to regenerate
fails `npm run validate` and `npm test` rather than shipping silently.

## Packagers and helpers

| Command | Tool | Does |
| --- | --- | --- |
| `npm run build` | `../build.js` | validation-gated `dist/chrome/`, `dist/firefox/`, and the store zips |
| `npm run build:android` | `build-android.js` | stages `dist/android/` and builds a debug APK when the SDK + Gradle are present |
| `npm run build:safari` | `build-safari.js` | stages the Safari wrapper source |
| `npm run verify:unpacked` | `verify-unpacked.js` | loads a built package and proves the engine blocks a real brand |
| `npm run locales:status` | `locale-status.js` | translation coverage per locale; `--todo <locale>` writes a worklist |
| `npm run locales:prune` | `locale-prune.js` | finds (and removes) unreachable locale keys: those no source file references, and those English has dropped but translations still carry |

## Module form

Every audit is also a module: `require("./tools/alias-audit")()` returns a
`Reporter` (`.name`, `.errors`, `.warnings`, `.notes`) without exiting, which is
how the test suite drives them.

## Layout

```
tools/
  lib/
    report.js   # Reporter class + CLI runner
    load.js     # paths, loaders, locale dirs, ISO country set,
                # country→region map, isApexDomain()
  validate-all.js               # runs the 15 audits above
  validate-datasets.js  alternatives-audit.js  alias-audit.js
  country-audit.js      category-audit.js      locale-parity.js
  locale-hybrid-audit.js  policy-audit.js
  changelog-validator.js  assets-check.js      extension-audit.js
  service-worker-audit.js  sync-audit.js       android-audit.js
  browser-a11y-audit.js    provision-android-toolchain.js
  safari-audit.js          capture-surfaces.js
  firefox-audit.js         announcement-audit.js
  validate-android-packages.js
  sync-extension.js     build-alternatives.js
  generate-android-rules.js  generate-android-packages.js
  port-android-apps.js
  build-android.js      build-safari.js        verify-unpacked.js
  locale-status.js      locale-prune.js
```

## Adding a check

1. Add it to the relevant audit (or create a new `*.js` that exports a function
   returning a `Reporter`).
2. If new, register it in `validate-all.js` and add a `package.json` script.
3. Reference data (ISO codes, region map, locale dirs) lives in `lib/load.js` —
   update it there so every tool stays consistent.
4. `test/validator-contract.test.js` feeds each documented rule a deliberately
   broken probe; add one there so the rule cannot quietly stop being enforced.

See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for how to add brands, countries,
categories, recipes, and locales.
