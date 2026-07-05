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

Because of that split, **`extension/` is not directly loadable** — it has no
`blocklist.js`, no `blocklists/`, and no `changelog.json`. Always build first
and load the staged folder:

```
node build.js        # validates everything, then stages + zips both browsers
```

| Browser | Load unpacked from | Store artifact |
| --- | --- | --- |
| Chrome / Brave / Edge | `dist/chrome/` | `dist/FitShield-<version>-chrome.zip` |
| Firefox (about:debugging → Load Temporary Add-on) | `dist/firefox/manifest.json` | `dist/FitShield-<version>-firefox.zip` (AMO) |

## How the extension consumes the engine

The engine is authored as CommonJS modules in `FS Engine/` and is **never
duplicated** in the extension. `build.js` (`bundleEngine`) wraps the modules in
a tiny module registry and emits one deterministic classic script,
**`blocklist.js`**, at the package root. Loading it defines the
`FitShieldBlocklist` global — the same API as `require("./FS Engine")`
(byte-for-byte the same logic; `test/engine-bundle.test.js` proves the parity).

Three consumers, one engine, one data model:

- **`background.js`** (service worker / Firefox event page) —
  `importScripts("blocklist.js")` in Chromium; in Firefox the derived manifest
  loads `blocklist.js` ahead of it via `background.scripts`. It calls
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
- **Firefox**: adds `background.scripts: ["blocklist.js", "background.js"]`
  (Firefox has no background service workers; the engine bundle must load
  first because `background.js` references the global).

Other manifest facts the audit (below) enforces: MV3, `default_locale: en`
with every `__MSG_*__` key present, exactly the three permissions the runtime
uses (`storage`, `declarativeNetRequest`, `alarms`), `<all_urls>` host
permissions for the redirect rules, `warning.html` in
`web_accessible_resources` (it is the DNR redirect target), `options_ui`
pointing at `settings.html`, all four icon sizes present, no inline scripts
anywhere (the MV3 default CSP is kept), and version agreement between
`manifest.json`, `package.json`, and `changelog.json`.

## Validating and testing

```
npm test                     # full suite (node --test) — includes every audit
npm run validate             # all audits, human-readable report
npm run validate:extension   # just the extension package audit
node build.js                # validation-gated packaging (refuses on errors)
```

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
