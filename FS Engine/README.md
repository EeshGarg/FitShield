# FS Engine

FitShield's metadata-driven **domain-blocking engine**. It answers one question
— *"should this hostname be blocked, given these brand entries and this
policy?"* — deterministically, with zero dependencies, in both Node.js and
browser extensions.

The engine ships **no data of its own**. Datasets live separately (in this
repo: [`../data/`](../data/)) and are handed to the engine at load time, so the
same engine can drive any FitShield-shaped dataset.

```
FS Engine/
├── index.js       ← public API (require this; sets global FitShieldBlocklist)
├── hostnames.js   ← hostname normalization + apex/subdomain matching (pure)
├── entries.js     ← entry matching & filtering (pure, stateless)
├── metadata.js    ← countries/categories discovery + block policies (pure)
├── loader.js      ← dataset I/O + the last-loaded cache (the only stateful file)
└── package.json   ← @fitshield/engine
```

---

## Quick start

### Node.js

```js
const engine = require("./FS Engine"); // resolves via package.json → index.js

await engine.loadBlocklists();                    // reads ../data/blocklists/*
// or point it at any dataset directory:
await engine.loadBlocklists({ dataDir: "/path/to/data" });

engine.isBlockedHost("order.doordash.com");                     // true
engine.isBlockedHost("doordash.com", { country: "US" });        // filtered check
engine.domainMatches("fake-mcdonalds.com", "mcdonalds.com");    // false (label-anchored)
```

### Browser extension

The packager (`../build.js`) bundles these modules into a single classic
script, shipped as **`blocklist.js`** at the package root. Loading it (via
`importScripts("blocklist.js")` in the service worker, or ahead of
`background.js` in Firefox's `background.scripts`) defines the global. The
loader resolves its datasets through whichever WebExtension namespace is
present — `chrome.runtime.getURL` (Chrome/Brave/Edge, and also exposed by
Firefox) or `browser.runtime.getURL` — so the same bundle runs on every
supported browser:

```js
importScripts("blocklist.js");
await FitShieldBlocklist.loadBlocklists(); // fetches blocklists/* from the extension root
FitShieldBlocklist.isBlockedHost(new URL(details.url).hostname);
```

Same API surface, byte-for-byte the same logic — the bundle is generated from
these sources at build time and never hand-edited.

---

## Data contract

`loadBlocklists()` reads the files named in `BLOCKLIST_FILES`
(`blocklists/fast-food.json`, `blocklists/delivery.json`). Each file is
`{ ..., "entries": [Entry] }`; all top-level metadata (`_schema`, `_version`,
`_lastUpdated`, …) is ignored. An **Entry** is:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `domain` | string | yes | Apex domain, the brand's canonical identity (`"doordash.com"`) |
| `name` | string | yes* | Human-readable brand name (*required by the dataset schema; the engine tolerates its absence) |
| `aliases` | string[] | no | Alternate apex domains the brand owns — matched exactly like `domain` |
| `enabled` | boolean | no | `false` disables the entry; anything else (or absent) means enabled |
| `type` | string | no | Dataset-level grouping (`"fast_food"`, `"delivery"`) |
| `countries` | string[] | no | ISO 3166-1 alpha-2 codes where the brand operates |
| `regions` | string[] | no | Continent tags (`"NA"`, `"EU"`, …) |
| `category` | string | no | Primary category (`"burger"`, `"coffee"`, …) |
| `specialties` | string[] | no | Free-form searchable tags |

Every function is defensive: malformed or partial entries are skipped, never
thrown on.

## Matching semantics

These are the engine's contract, used by the browser extension and by the
tooling and tests. (Before 1.0 the Android adapter's Kotlin matcher mirrored it;
that matcher was removed with Android website blocking.)

1. **Normalization** (`normalizeHostname`): lowercase; strip scheme, path,
   query, fragment, port, trailing dots, and one leading `www.`. Full URLs are
   accepted anywhere a hostname is.
2. **Apex-or-subdomain** (`domainMatches`): `host` matches `apex` iff
   `host === apex` or `host` ends with `"." + apex`. Matching is anchored at a
   label boundary — `fake-mcdonalds.com` does **not** match `mcdonalds.com`.
3. **Aliases count** (`getEntryDomains`): an entry is matchable on its `domain`
   plus every `aliases[]` value, de-duplicated after normalization.
4. **Determinism**: no clocks, no randomness, no network beyond the dataset
   fetch. Same entries + same input ⇒ same answer, in every environment.

---

## API reference

All functions live on the object returned by `require("./FS Engine")` and on
the `FitShieldBlocklist` global. Functions marked **[defaults to cache]** take
an optional entry list and fall back to the most recently loaded datasets.

### Loading

| | |
| --- | --- |
| `BLOCKLIST_FILES` | `string[]` — dataset paths, relative to the data dir (Node) / extension root (browser). |
| `loadBlocklists(options?)` | `Promise<Entry[]>` — loads every file in `BLOCKLIST_FILES`, flattens their `entries`, caches and returns the list. `options.dataDir` (Node only) overrides the default `../data`. |
| `getLoadedEntries()` | `Entry[]` — a **copy** of the cached entries; `[]` before the first load. |

### Hostnames

| | |
| --- | --- |
| `normalizeHostname(hostname)` | `string` — normalized host (see §Matching). Accepts URLs. Returns `""` for empty input. |
| `normalizeDomain(entryOrString)` | `string` — like `normalizeHostname`, but also accepts an entry object (uses its `.domain`). |
| `domainMatches(hostname, domain)` | `boolean` — apex-or-subdomain match, label-anchored. |

### Entries — matching & filtering

| | |
| --- | --- |
| `getEntryDomains(entry)` | `string[]` — normalized, de-duplicated `domain` + `aliases`. |
| `entryMatchesHost(entry, hostname)` | `boolean` — hostname matches any of the entry's domains. |
| `getEnabledEntries(entries?)` | `Entry[]` — drops `enabled: false` entries. **[defaults to cache]** |
| `filterEntries(filters, entries?)` | `Entry[]` — AND-combined metadata filters `{ type, country, region, category, specialty }`; omitted filters match everything. **[defaults to cache]** |
| `isBlockedHost(hostname, options?)` | `boolean` — the main entry point: `options` = the same filters plus `{ onlyEnabled = true, entries }`. **[defaults to cache]** |

### Metadata & policies

| | |
| --- | --- |
| `getCountryName(code, locale?)` | `string` — display name for an ISO 3166-1 alpha-2 code. Curated short forms win for English; otherwise resolved via `Intl.DisplayNames` (complete for every ISO code in modern browsers + Node 18+), falling back to the raw code. Pass a BCP-47 `locale` to localize. |
| `getAvailableCountries(entries?, locale?)` | `[{ code, name, count }]` sorted by name — distinct countries in the data, named via `getCountryName`. **[defaults to cache]** |
| `getAvailableCategories(entries?)` | `[{ category, count, specialties }]` sorted by category. **[defaults to cache]** |
| `shouldBlockByCountry(entry, enabledCountries)` | `boolean` — entry is active in ANY enabled country. Empty/missing either side ⇒ `false`. |
| `shouldBlockByCategory(entry, enabledCategories)` | `boolean` — entry's primary `category` is enabled (specialties deliberately don't match). |
| `countryFilter(enabledCountries)` | `(entry) => boolean` — the same policy as `shouldBlockByCountry`, with the enabled-code set built once instead of once per entry. Use this when testing many entries against one list. |
| `categoryFilter(enabledCategories)` | `(entry) => boolean` — likewise for `shouldBlockByCategory`. |

---

## Consumers in this repo

- **Browser extension** — `extension/background.js` via the bundled
  `blocklist.js` global (packaged by `../build.js`).
- **Android adapter** — the native app (1.0) blocks apps only, by package name,
  from `data/android/`; it no longer consumes the engine's host matching. (The
  VPN-based site filter and its generated `fitshield-rules.json` were removed in
  1.0 for Google Play policy compliance.)
- **Tooling & tests** — validators require the engine directly
  (`require("../FS Engine")`).

## Rules for changing the engine

- The API surface is defined **only** in `index.js`; document every change in
  this README in the same commit.
- `hostnames.js` / `entries.js` / `metadata.js` must stay pure (no I/O, no
  state, no environment probes) — only `loader.js` may touch the outside world.
- Never break the browser global: `FitShieldBlocklist` and its call signatures
  are the compatibility contract with the shipped extension (the Android WebView no longer loads the engine).
- Matching-semantics changes require the audits to pass. (The Android Kotlin
  host matcher and its parity fixture were removed in 1.0.)
