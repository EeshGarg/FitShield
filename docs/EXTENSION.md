# The browser extension — build, engine linkage, and packaging

How the Chrome/Firefox extension in [`extension/`](../extension/) consumes the
shared [FS Engine](../FS%20Engine/README.md) and the canonical
[`data/`](../data/) sets, and how to build, test, and load it.

## Source layout vs. the shipped package

The repo keeps three concerns apart; the packager flattens them back into the
one flat layout the runtime (and the store listings) expect:

```
repo                                  packaged zip / dist/<browser>/
├── FS Engine/   engine code only  →  blocklist.js        (generated bundle)
├── data/        canonical datasets→  blocklists/*.json, data/recipes.json, …
├── extension/   browser source    →  manifest.json, *.js, *.html, _locales/, icons/
└── changelog.json                 →  changelog.json
```

Despite that split, **`extension/` loads unpacked in Chromium with no build**,
because the artifacts it needs at runtime (`blocklist.js`, `blocklists/`,
`data/recipes.json`, `changelog.json`) are committed there. What must not be
loaded is the repository **root**.

```
npm run sync         # refresh extension/'s committed runtime artifacts (dev loading)
node build.js        # validates everything, then stages + zips both targets
```

| Browser | Load unpacked from | Store artifact |
| --- | --- | --- |
| Chrome / Brave / Edge (dev, no build) | `extension/` | — |
| Chrome / Brave / Edge (store-shaped) | `dist/chrome/` | `dist/FitShield-<version>-chrome.zip` |
| Firefox (about:debugging → Load Temporary Add-on) | `dist/firefox/manifest.json` | `dist/FitShield-<version>-firefox.zip` (AMO) |

Every `node build.js` run writes both: `dist/chrome/` and `dist/firefox/`, each
with its own manifest derivation and its own zip.

`extension/` loads directly because its runtime artifacts (`blocklist.js`,
`blocklists/`, `data/recipes.json`, `changelog.json`) are committed there,
synced from canonical `FS Engine/` + `data/` by `npm run sync`. Firefox still
needs the build (its manifest gains `background.scripts`, derived by `build.js`).

## How the extension consumes the engine

The engine is authored as CommonJS modules in `FS Engine/` and is **never
hand-copied** in the extension. `build.js` (`bundleEngine`) wraps the modules in
a tiny module registry and emits one deterministic classic script,
**`blocklist.js`**. That bundle is committed at `extension/blocklist.js` by
`npm run sync` (dev loading) and written to the package root by `build.js`
(store artifact) — both from the one `bundleEngine`. Loading it defines the
`FitShieldBlocklist` global — the same API as `require("./FS Engine")`
(byte-for-byte the same logic; `test/engine-bundle.test.js` proves the parity).

Three consumers, one engine, one data model:

- **`background.js`** (service worker / Firefox event page) —
  in Chromium it `importScripts` both `blocklist.js` and `fitshield-core.js`,
  each guarded by a `typeof` check so the call is skipped when the global is
  already defined; in Firefox the derived manifest loads both ahead of it via
  `background.scripts`, and the guards make the worker path a no-op. It calls
  `FitShieldBlocklist.loadBlocklists()` (which fetches the packaged
  `blocklists/*.json`) and turns the entries + user settings into
  `declarativeNetRequest` redirect rules pointing at `warning.html`.
- **`settings.html`** — loads `blocklist.js` with a plain `<script>` tag and
  uses the same metadata API (`getAvailableCountries`, `getAvailableCategories`,
  …) to render the country/category pickers from the live dataset.
- **`warning.html` / `popup.html`** — talk to the background worker over
  `runtime.sendMessage`, so every block decision, bypass, and stat flows
  through the single engine-backed state in the worker.

The JSON dataset contract (entry fields, matching semantics, defensive
parsing) is documented in the [FS Engine README](../FS%20Engine/README.md) —
that contract, not any file in `extension/`, is the source of truth for what a
blocklist entry means.

## Manifest strategy

The committed [`extension/manifest.json`](../extension/manifest.json) is the
**Chromium MV3 base form**: `background.service_worker` only, plus the
Firefox-only `browser_specific_settings` block. `build.js` derives the two
shipped forms:

- **Chrome**: strips `browser_specific_settings` (Chromium warns on unknown
  keys).
- **Firefox**: adds `background.scripts`, which is exactly `build.BACKGROUND_SCRIPTS`
  with `background.js` last — today
  `["blocklist.js", "fitshield-core.js", "blocklist-records.js", "background.js"]`
  (Firefox has no background service workers). Stated as the
  contract rather than as a copied literal, because this list was published here
  with two entries while three shipped, and the audit that is supposed to enforce
  it compares against `build.BACKGROUND_SCRIPTS`, so a copied literal drifts
  silently. Order matters and
  `background.js` must be last: it references both `FitShieldBlocklist` (the
  engine bundle) and `FitShieldCore` (the shared decision layer — schema,
  schedules, passes, stats), so both have to be evaluated before it. On
  Chromium the same two files are pulled in by `background.js`'s own
  `importScripts` call. The single source of truth is `BACKGROUND_SCRIPTS` in
  `build.js`; `test/tools.test.js` fails if this list drifts from it.

Other manifest facts the audit (below) enforces: MV3, `default_locale: en`
with every `__MSG_*__` key present, exactly the three permissions the runtime
uses (`storage`, `declarativeNetRequest`, `alarms`), `<all_urls>` host
permissions for the redirect rules, `warning.html` in
`web_accessible_resources` (it is the DNR redirect target), `options_ui`
pointing at `settings.html`, all four icon sizes present, no inline scripts
anywhere, and version agreement between `manifest.json`, `package.json`, and
`changelog.json`.

The manifest declares an explicit `content_security_policy.extension_pages`
rather than relying on the MV3 default. It is **tighter** than the default, not
looser: on top of `script-src 'self'` it pins `connect-src 'self'` (the runtime
makes no network requests, so nothing legitimate needs an outside origin),
`frame-src`/`child-src` to `'none'`, and `form-action`/`base-uri` to `'none'`.
`tools/extension-audit.js` warns whenever a custom policy is present, on purpose
— it is a prompt to re-read the policy, not a defect.

## Validating and testing

```
npm test                     # full suite (node --test) — includes every audit
npm run validate             # all audits, human-readable report
npm run validate:extension   # just the extension package audit
npm run validate:sw          # just the service-worker ↔ engine linkage audit
node build.js                # validation-gated packaging (refuses on errors)
```

- `tools/service-worker-audit.js` guards the MV3 worker's engine linkage:
  `background.js` must load the engine with `importScripts("blocklist.js")` (the
  generated bundle) and **never** the raw `FS Engine/` CommonJS modules (which
  throw `require is not defined` as classic worker scripts); and the bundle,
  evaluated as a classic script with no `require`/`module`/`importScripts`, must
  define `FitShieldBlocklist` with every function `background.js` calls.
  `extension/blocklist.js` is itself a **committed generated artifact** (so
  `extension/` loads raw) — drift between it and canonical `FS Engine/` is caught
  by the sync audit rather than by this one.
- `tools/extension-audit.js` checks the manifest correctness above **and the
  package graph**: it recomputes the staged file set from `build.js`'s own
  FILES/DIRS mapping and verifies every `<script src>`/`<link>`/`<img>` in the
  pages, every runtime `fetch()` target (`blocklists/*.json`,
  `data/recipes.json`, `changelog.json`, `_locales/en/messages.json`), and
  every manifest-referenced resource resolves inside the package — and that no
  `extension/*.js|html` source is left unshipped.
- `test/blocking.test.js` runs the real `background.js` against the real
  generated engine bundle in a sandbox, so the engine-powered block decision
  flow (JSON datasets → rule catalog → dynamic DNR rules → warning URL) is
  exercised end-to-end on every `npm test`.
- `test/engine-bundle.test.js` proves the bundled `blocklist.js` exposes the
  exact `FitShieldBlocklist` API of the engine sources.

## Making changes

- Engine behavior → edit `FS Engine/` (see its README's change rules — the
  Android matcher must stay in parity).
- Datasets → edit `data/` and run `npm run validate` (never hand-edit staged
  output or the packaged `blocklist.js`).
- Extension UI/runtime → edit `extension/`; if you add a runtime file, add it
  to `build.js` FILES — the extension audit fails the build if you forget.

## Debugging block page failures

The block page (`warning.html`) is a `chrome-extension://` page the browser
navigates to when `declarativeNetRequest` redirects a blocked ordering site. It
loads six same-origin scripts, in order — `ambient.js`, `browser-shim.js`,
`i18n.js`, `fitshield-core.js`, `recipes.js`, `warning.js` — and gets **all** of
its data from the background
worker over `runtime.sendMessage` (the worker is the only holder of engine
state). So a broken block page almost always traces to one of a few links in
that chain. Work through them in order:

0. **"Service worker registration failed" / the extension won't load at all.**
   The loaded folder is missing the engine bundle. `extension/` normally carries
   committed `blocklist.js`, `blocklists/`, `data/recipes.json`, and
   `changelog.json` (synced from canonical), so it loads directly — but if those
   are stale or absent, run **`npm run sync`** and reload `extension/`. Or build
   and Load Unpacked from **`dist/chrome/`** (`node build.js`; Firefox uses
   `dist/firefox/manifest.json`). Either way `background.js`'s
   `importScripts("blocklist.js")` must resolve to the generated engine bundle.
   Do **not** try to "fix" this by pointing `importScripts` at the `FS Engine/`
   sources — they are CommonJS and throw `require is not defined` in a worker;
   `npm run validate:sw` fails the build if anyone does. If `extension/`'s
   committed copies drift from canonical, `npm run validate:sync` /
   `npm test` fail with a `npm run sync` fix. See §How the extension consumes the
   engine above.
1. **The page renders blank / raw keys / no recipes.** First run
   `node --test test/block-page.test.js` — the render smoke test drives the real
   worker + page scripts and will localize the failure (brand, block reason,
   recipes, stats, locale). If it passes but the browser doesn't, the break is
   browser-only (CSP, redirect, or a resource that is staged but not
   web-accessible), not logic.
2. **"Why you're seeing this" / brand line is missing.** The page called
   `getBlockContext` — the single message it uses to fetch everything about the
   interruption — and the worker threw. Almost always the
   worker failed to load the engine or its datasets: confirm `blocklist.js` is at
   the package root and `blocklists/*.json` are present (`npm run validate:extension`).
   The engine bundle is generated by `build.js` — never hand-edited — so a stale
   or missing bundle means "rebuild," not "patch the page."
3. **The alternative card never appears.** `recipes.js` fetches `data/recipes.json`
   from the package root. If the dataset moved in `data/` without `build.js`
   remapping it back to `data/recipes.json`, the fetch 404s. `verifyStage` in
   `build.js` now fails the build in this case.
4. **Everything is default-styled / wrong language.** `theme` (a stored color
   object) and `uiLanguage` are read from `chrome.storage.local`; a shape change
   in what `settings.js` writes will silently fall back to the defaults baked
   into `warning.html`. This degrades gracefully — it is not a hard break.
5. **A missing `data-i18n` key** renders as the raw key (e.g. `warningTitle`).
   `tools/locale-parity.js` enforces key parity, and the render smoke test
   asserts localized strings resolve.

The guardrails that make this class of bug fail *at build time* rather than in
production: `build.js`'s `verifyStage` (block page + engine bundle + datasets
must be in the staged output), `tools/extension-audit.js` (whole package graph
closed), and `test/block-page.test.js` (packaged closure + full render). If you
change how the block page loads anything, keep those green.
