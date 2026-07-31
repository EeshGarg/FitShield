# FitShield developer tools

Developer-only validators for the curated datasets, localization, documentation,
and build assets. **Nothing here is bundled into the extension** — these files
are not in `build.js`'s file list, so they never affect popup startup, memory,
or blocking. They use Node built-ins only (no dependencies).

## Run everything

```bash
npm run validate        # node tools/validate-all.js
```

Exits non-zero if any audit reports an error (warnings never fail). `build.js`
runs this automatically before packaging, and `npm test` runs it too.

## Individual audits

| Command | Tool | Checks |
| --- | --- | --- |
| `npm run validate:datasets`   | `validate-datasets.js`   | JSON validity, required fields, field types, duplicate domains, hostname shape (IDN-aware), unknown fields, schema keys |
| `npm run validate:aliases`    | `alias-audit.js`         | malformed/duplicate aliases, alias↔primary collisions, www-variant warnings |
| `npm run validate:countries`  | `country-audit.js`       | ISO 3166-1 alpha-2 codes, unknown/duplicate codes, region↔country consistency |
| `npm run validate:categories` | `category-audit.js`      | category id format, localized-name (`catLabel*`) coverage, orphaned display names |
| `npm run validate:locales`    | `locale-parity.js`       | identical key sets, empty messages, `$name$` placeholders, positional-placeholder parity, duplicate keys |
| `npm run validate:docs`       | `changelog-validator.js` | manifest↔package version sync, `changelog.json` current entry, `changelog/<version>.md` + `ROADMAP.md` presence |
| `npm run validate:assets`     | `assets-check.js`        | manifest keys, referenced icons exist, required runtime files/dirs present |
| `npm run validate:sync`       | `sync-audit.js`          | `extension/`'s committed runtime artifacts (engine bundle, blocklists, recipes, changelog) match canonical `FS Engine/` + `data/` so the source folder loads unpacked; stale copy → `npm run sync` |

Not a validator, but related: **`npm run sync`** (`sync-extension.js`)
regenerates those committed `extension/` artifacts. Run it after editing
`FS Engine/` or `data/`; `validate:sync` (in `npm run validate`) and
`test/extension-synced.test.js` (in `npm test`) fail if you forget.

Each tool is also a module: `require("./tools/alias-audit")()` returns a
`Reporter` (`.ok`, `.errors`, `.warnings`, `.notes`) without exiting.

## Layout

```
tools/
  lib/
    report.js   # Reporter class + CLI runner
    load.js     # paths, loaders, ISO country set, country→region map, isApexDomain()
  validate-datasets.js
  alias-audit.js
  country-audit.js
  category-audit.js
  locale-parity.js
  changelog-validator.js
  assets-check.js
  validate-all.js   # runs all of the above
```

## Adding a check

1. Add it to the relevant audit (or create a new `*.js` that exports a function
   returning a `Reporter`).
2. If new, register it in `validate-all.js` and add a `package.json` script.
3. Reference data (ISO codes, region map) lives in `lib/load.js` — update it
   there so every tool stays consistent.

See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for how to add brands, countries,
categories, recipes, and locales.
