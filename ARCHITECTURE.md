# FitShield architecture

FitShield is one product with **four separated compartments** and a build step
that recombines them into the flat artifacts each store expects. Keeping them
apart is deliberate: the blocking engine is reusable across the browser
extension and the Android app, and neither ships a copy of the other's code.

```
FS Engine/   the blocking engine — CODE ONLY, zero data, zero deps
data/        the canonical datasets — blocklists, recipes, android app maps
extension/   the Chrome/Firefox extension shell — manifest, pages, shims, _locales, icons
android/     the Android app — reuses the engine's rules + the shared web assets

build.js     recombines FS Engine + data + extension  →  dist/<browser>/ + zips
```

Deep dives: **[FS Engine/README.md](FS%20Engine/README.md)** (engine API + data
contract) and **[docs/EXTENSION.md](docs/EXTENSION.md)** (build, engine linkage,
manifests, and the block-page debugging runbook). This file is the map that ties
them together.

## Source of truth vs. generated output

| Concern | Source of truth (edit here) | Generated (never hand-edit) |
| --- | --- | --- |
| Blocking logic | `FS Engine/*.js` | `extension/blocklist.js` (synced), `dist/*/blocklist.js` |
| Datasets | `data/blocklists/*.json`, `data/recipes.json` | `data/generated/*`, `extension/blocklists/`, `extension/data/`, `dist/*/data/`, `dist/*/blocklists/` |
| Changelog | `changelog.json` (root) | `extension/changelog.json` (synced) |
| Extension shell | `extension/` (hand-authored js/html/manifest) | `dist/chrome/`, `dist/firefox/`, `dist/apple/`, `dist/*.zip` |
| Manifests | `extension/manifest.json` (Chromium base) | `dist/chrome/manifest.json`, `dist/firefox/manifest.json`, `dist/apple/extension/manifest.json` (Safari, nightly) |

`node build.js` compiles **every browser target** on each run — Chrome, Firefox,
and Apple/Safari (macOS + iOS/iPadOS, **nightly**, staged to `dist/apple/` and
wrapped into an Xcode app on macOS via `tools/build-safari.js`). All three are
the same payload with a per-browser manifest derivation (`chromeManifest` /
`firefoxManifest` / `safariManifest` in `build.js`). Android is a separate native
pipeline (`npm run build:android`); `npm run build:all` runs everything.

`dist/` is git-ignored — it is entirely reproducible with `node build.js`.
**The `extension/` folder loads directly as an unpacked extension**: the runtime
artifacts it fetches (`blocklist.js`, `blocklists/`, `data/recipes.json`,
`changelog.json`) are committed there, generated/copied from canonical
`FS Engine/` + `data/` by `npm run sync`. After editing the engine or data, run
`npm run sync`; `tools/sync-audit.js` (in `npm run validate`) and
`test/extension-synced.test.js` (in `npm test`) fail if a committed copy drifts.
The repo *root* is still not loadable — load `extension/` (fastest) or the built
`dist/chrome/` / `dist/firefox/` (store-shaped).

## How the extension consumes the engine

The engine is authored as CommonJS modules in `FS Engine/` and is **never
hand-copied** into the extension. `build.js` (`bundleEngine`) wraps those modules
into one deterministic classic script — **`blocklist.js`** — whose only public
surface is the `FitShieldBlocklist` global. That same bundle is committed at
`extension/blocklist.js` by `npm run sync` (so the source folder loads unpacked)
and written to the package root by `build.js` (so the store artifact ships it);
both come from the one `bundleEngine`, and `tools/sync-audit.js` proves the
committed copy equals it. `test/engine-bundle.test.js` proves the global is
byte-for-byte the same API as `require("./FS Engine")`.

That global **is the stable adapter boundary.** Nothing in the extension reaches
into engine internals by relative path:

- **`background.js`** (service worker / Firefox event page) loads `blocklist.js`
  and calls the engine's public API (`loadBlocklists`, `getEntryDomains`,
  `shouldBlockByCountry`, …) to turn entries + user settings into
  `declarativeNetRequest` rules.
- **`browser-shim.js`** is the *platform* adapter: it exposes a
  platform-agnostic `fitshield.*` façade over `chrome.*` so the same UI runs on
  the Android WebView (which ships `android-shim.js` instead). The engine
  (`FitShieldBlocklist`) and the platform (`fitshield`) are the two boundaries —
  UI code targets those names, not raw APIs or engine files.
- **UI pages** (`warning.html`, `popup.html`) never touch the engine directly.
  They message the background worker (`runtime.sendMessage`), so every block
  decision, bypass, and stat flows through the single engine-backed worker.

## The block page dependency chain

The block page is the surface most sensitive to the engine split, because it
depends on the engine *transitively* through the worker. The chain:

```
blocked site
  → declarativeNetRequest redirect  (background.js, rules built from the engine)
  → warning.html  (web_accessible_resource; the DNR redirect target)
      loads: ambient.js, browser-shim.js, i18n.js, recipes.js, warning.js
      fetches: data/recipes.json  (recipe alternatives),
               _locales/<lang>/messages.json  (localization)
  → warning.js  messages the worker:
      getBlockState · getBlockedSiteInfo · recordBlockedVisit ·
      recordBlockedBrand · recordRecipeChoice · startTemporaryBypass
  → background.js resolves each against FitShieldBlocklist + blocklists/*.json
```

Every hop is guarded so a future path/layout change fails loudly instead of
shipping a blank page:

- **`build.js` → `verifyStage`** re-reads the staged package and asserts
  `warning.html`, each asset it loads, `blocklist.js`, `data/recipes.json`, and
  the engine datasets are all present — the build aborts otherwise.
- **`tools/extension-audit.js`** proves the whole package graph is closed and no
  page carries an inline script (MV3 CSP).
- **`test/block-page.test.js`** checks the packaged graph *and* renders the block
  page end-to-end against the real engine-backed worker (brand, block reason,
  recipes, stats, locale, theme).

## Build & verify

```
node build.js        # validate → stage FS Engine + data + extension → dist/ + zips
npm test             # full suite (includes every audit + the block-page tests)
npm run validate     # human-readable audit report
```

See [docs/EXTENSION.md](docs/EXTENSION.md) for per-browser loading, the manifest
strategy, and what to check first when the block page misbehaves.
