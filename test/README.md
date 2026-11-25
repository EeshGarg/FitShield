# test/ — the test suite

Zero dependencies: tests use only `node:test`, `node:assert` and other Node
built-ins (Node 22 is the floor; 24 is what development uses). One file per
concern, named `<topic>.test.js`; shared fixtures live in `helpers/`.
`npm test` is `node --test`, which runs every `*.test.js`. The suite also
includes every validator in `tools/` (via `tools.test.js`), so it is the single
gate; `npm run validate` prints the same audits as a readable report.

## Running

```bash
npm test                                   # everything
node --test test/schedule.test.js          # one file
node --test --test-name-pattern="idempotent" test/core-schema.test.js   # one test
node --test test/docs-claims.test.js test/governance.test.js test/tools.test.js   # docs + governance gate
```

Run from the repository root. `tools.test.js` runs the full validator suite and
takes a minute or more; run focused files while iterating.

## What is where

| Area | Files |
| --- | --- |
| **Decision layer** (`extension/fitshield-core.js`) | `core-schema`, `schedule`, `passes`, `passes-concurrency`, `preferences`, `stats-semantics`, `currency`, `backup`, `recipes`, `block-category-metadata` |
| **Engine and datasets** | `blocklist`, `blocklist-records`, `blocklist-quality`, `matching`, `engine-bundle`, `catalog-verification`, `android-packages` |
| **Background worker** (real `background.js` in a sandbox) | `blocking`, `block-page`, `resilience`, `scenarios`, `diagnostics` |
| **Pages and UI** | `page-scripts` (script load order), `popup-status`, `popup-passes`, `preferences-panels`, `settings-blocklist`, `ui-hardening`, `layout-contract`, `accessibility`, `announcement-readiness` |
| **Localization** | `locales` |
| **Android** | `android`, `android-block`, `android-controls`, `android-alternatives`, `android-performance`, `android-shim`, `android-stats-honesty`, `android-no-vpn`, `android-release-hardening`, `play-release` |
| **Packaging and sync** | `package-integrity`, `extension-synced`, `build-gate`, `firefox-gate`, `verify-unpacked` |
| **Security and privacy** | `security`, `security-verification` |
| **Docs, governance, tooling** | `docs-claims`, `doc-links`, `governance`, `tools`, `validator-contract`, `validate-all-skip` |

Several tests assert **behaviour** by running real code rather than grepping
source: the worker and block page against the real engine bundle, the Android
UI in a WebView stand-in, and the Kotlin schedule logic compiled and executed.
Source-text assertions are kept only where the text itself is the contract.

## helpers/

| File | What it gives a test |
| --- | --- |
| `background-harness.js` | One headless `background.js` in a `vm` sandbox with stubbed `chrome` and `fetch`, plus fault-injection seams; shared by every worker-level suite. |
| `android-webview.js` | Used by `android-alternatives`, `android-performance`, `android-release-hardening`, `android-stats-honesty` and `play-release`. A small DOM and bridge stand-in that runs the real Android `app.js` / `block.js`, `index.html`, `extension/i18n.js` and the real locales, so tests read what the screen would say. |
| `kotlin-runner.js` + `NativeLogicHarness.kt` | Used by `android-no-vpn.test.js`. Compiles `Schedule.kt` with the Kotlin compiler found in the Gradle cache and runs it on the JDK from `npm run toolchain:android`. **Skips with a message** when neither is present (run `npm run toolchain:android` then `npm run build:android` once). `NativeLogicHarness.kt` is test scaffolding and never ships. |
| `packets.js` | Crafted IP packets for the connection-filter tests of the removed VPN path. No test in this folder imports it any more. |

## Real-browser checks and prerequisites

Some checks drive an actual Chromium or Firefox. All of them **warn and skip**
(and say so) when the browser is absent; none needs a download or a package.

| Check | Where | Needs |
| --- | --- | --- |
| Computed accessibility tree | `npm run validate:a11y` (`tools/browser-a11y-audit.js`) | a built `dist/chrome/` (`node build.js`) and Chrome/Chromium; set `FS_CHROME` to its binary if not auto-discovered |
| Announcement order for screen readers | `npm run validate:announce` | same as above |
| Built Firefox package blocks a real brand | `npm run validate:firefox` (`tools/firefox-audit.js`) | a built `dist/firefox/` and Firefox; set `FS_FIREFOX` |
| Framing/CSP and page behaviour in Chrome | `security-verification.test.js`, `layout-contract.test.js` | Chrome/Chromium; they `skip` without one |
| Kotlin logic (`Schedule.kt`) | `android-no-vpn.test.js` via `kotlin-runner.js` | JDK + Kotlin compiler (above) |

CI (`.github/workflows/verify.yml`) runs the suite on Node 22 and 24, builds both
packages, runs the validators through a guard that requires every audit to have
actually run, and builds a debug APK. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md#5-invariants-and-where-each-is-enforced)
for which invariant each test or tool protects, and
[`../tools/README.md`](../tools/README.md) for the validators.

## Writing or changing a test

- Prefer asserting behaviour (run the code) over matching its source text; a
  green grep over broken behaviour is what this suite exists to avoid.
- Do not loosen or delete a failing test to get green. If a test is genuinely
  wrong, say precisely why and replace it with one that asserts the real
  contract (see [`../CLAUDE.md`](../CLAUDE.md) §6).
- A new validator rule needs a deliberately broken probe in
  `validator-contract.test.js`, so the rule cannot quietly stop being enforced.
- No new dependencies, test harnesses included.
