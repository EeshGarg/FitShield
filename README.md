

<img width="1350" height="592" alt="image" src="https://github.com/user-attachments/assets/0064f3b9-a20d-4b1a-b1ac-05c46f267f4c" />


# FitShield

FitShield interrupts impulsive food-delivery and fast-food ordering, then offers
something you could realistically make instead.

That is the whole product. When you open an ordering page, FitShield replaces it
with a short pause and one concrete alternative, and gives you three ways
forward: leave, make the alternative, or continue to the site on purpose. It is
not a fitness app, a calorie tracker, or a meal planner, and it does not try to
become one.

Everything runs locally on your device. No account, no server, no telemetry, no
browsing history collection.


# What it does

**Interrupt**

1. Blocking for delivery platforms and fast-food ordering sites (2,687 curated brands).
2. Custom URL blocking, and per-site exceptions.
3. Country and category blocking — whole groups of brands by where they operate or what they serve.
4. Schedules: multiple windows a day, different hours per weekday, and overnight windows. Presets for evenings, late night, and workday lunch.
5. Friction presets (light / standard / strict) with every underlying value editable.

**Then offer something to do**

6. 81 alternatives — 43 full recipes and 38 quick fixes — with exact quantities, servings, temperatures, timings, equipment, allergens, and substitutions.
7. Deterministic local matching against the blocked brand's own category and specialties, your diet, allergens, pantry, equipment, and available time.
8. Show another, plus Closest / Fastest / No cooking / Microwave filters.
9. Your own custom alternatives, stored locally and included in your backup.

**Then get out of the way**

10. Scoped temporary passes: once, 10 minutes, 30 minutes, until the tab closes, or pause everything for 30 minutes or until tomorrow.
11. Honest local statistics — pages interrupted, times you left, times you continued, passes used, alternatives viewed / chosen / marked as made. Only aggregate counts, never a URL or any browsing history.
12. An optional weekly summary, and a preview mode that shows exactly what an interruption looks like without recording anything.
13. Export and import everything as one local JSON file.
14. 80+ display languages with a searchable picker.
15. Full colour and theme customization (system / light / dark).

Estimated money and calorie figures are still available, but they are clearly
labelled as estimates, are off by default, and are never the headline number.
FitShield cannot see whether you ordered, cooked, or ate anything, and it does
not claim to.


# Installation

**Chrome Web Store (recommended, one-click):**

https://chromewebstore.google.com/detail/oedcadhhfcgggacgljhnochcjdibfjed?utm_source=item-share-cb

This is the easiest way to install FitShield and keeps it updated automatically.

FitShield builds from a single source tree, split into `FS Engine/` (the
blocking engine — see its README for the full API, also reused by the Android
app), `data/` (the curated datasets), and `extension/` (the browser-extension
source). A tiny, dependency-free script (`node build.js`, requires Node.js 18+)
flattens them and, on every run, packages **all** browser targets into `dist/`:
`dist/chrome/` (Chromium service worker), `dist/firefox/` (event-page
`background.scripts`), and `dist/apple/` (Safari for macOS / iOS / iPadOS —
**nightly**, wrapped into an Xcode app on macOS). Android is a separate native
pipeline (`npm run build:android`); `npm run build:all` runs everything. Build
once, then load the matching `dist/` folder — the repository root itself is not
a loadable unpacked extension.

**Manual installation — Chrome / Brave / Chromium (for developers):**

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome, Brave, or any Chromium-based browser.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the **`extension/`** folder.

The `extension/` folder loads directly — it ships the committed runtime
artifacts (the engine bundle, blocklists, recipes, changelog) that Chrome
fetches. If you edit `FS Engine/` or `data/`, run `npm run sync` to refresh
those committed copies (a stale copy fails `npm run validate` / `npm test`).

For a store-shaped package instead, run `node build.js` and load the generated
**`dist/chrome/`** folder. (The repository *root* is not loadable — the source
is split between `FS Engine/`, `data/`, and `extension/`; load `extension/` or
`dist/chrome`, never the root.)

**Manual installation — Firefox:**

1. Download or clone this repository.
2. Run `node build.js` (creates `dist/firefox/` with the Firefox event-page manifest).
3. Open `about:debugging#/runtime/this-firefox` in Firefox.
4. Click **Load Temporary Add-on…** and select **`dist/firefox/manifest.json`**.

Requires Firefox 140 or newer (142+ on Android), the versions that support the add-on's data-collection declaration. Load `dist/firefox` rather than the repository root — the repo is not a loadable extension, and the committed `extension/manifest.json` is the Chromium form (service worker only), which won't start Firefox's background script. For a signed `.xpi`, submit `dist/FitShield-<version>-firefox.zip` to [AMO](https://addons.mozilla.org/) (or use [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/) against `dist/firefox`).

**Installation — Safari (macOS / iOS / iPadOS / visionOS) — nightly:**

Safari support is a **nightly / experimental** preview — unsigned, not on the App Store, and Safari's blocking APIs are narrower than Chromium's. It ships the **same feature payload** as the Chrome build (a byte-for-byte parity test enforces this); only the manifest is Safari-flavored. Safari Web Extensions run inside a native app built with Apple's converter + **Xcode**, which are **macOS-only**.

*One-click (recommended, on a Mac):* double-click **[`scripts/install-safari.command`](scripts/install-safari.command)** in Finder — it checks your setup, builds + validates the payload, runs Apple's converter, and opens the Xcode project ready to Run. (First time: `chmod +x scripts/install-safari.command`, or just run `bash scripts/install-safari.command`.) Then press **Run** in Xcode and enable **FitShield Nightly** in Safari → Settings → Extensions.

*Manual build:*

1. `node build.js` (any OS) stages the Apple payload to `dist/apple/extension/`, zips it, and writes `dist/apple/BUILD.txt` alongside the Chrome and Firefox outputs — every build. (`npm run build:safari` does just the Apple target; `npm run build:all` also builds Android.)
2. On a Mac, `npm run build:safari` additionally runs Apple's `safari-web-extension-converter` and writes the Xcode project to `dist/apple/xcode/`. Open it (`open dist/apple/xcode/*/*.xcodeproj`), **Run** the macOS or iOS scheme (the iOS app runs on iPhone, iPad, and visionOS), then enable **FitShield Nightly** in Safari's Extensions settings.

The exact converter command, per-platform run steps, and known limitations are in [`docs/SAFARI.md`](docs/SAFARI.md).


# Development & Docs

- **Contributing:** see [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to add brands, countries, categories, recipes, and locales, plus validate / build / release steps.
- **Architecture map:** see [`ARCHITECTURE.md`](ARCHITECTURE.md) — the four separated compartments (`FS Engine/`, `data/`, `extension/`, `android/`), what is source-of-truth vs. generated, and the block-page dependency chain that ties them together.
- **Extension build & engine linkage:** see [`docs/EXTENSION.md`](docs/EXTENSION.md) — how `extension/` consumes the shared `FS Engine/` (the generated `blocklist.js` bundle), the per-browser manifest derivations, how to build/test/load the unpacked extension, and a runbook for debugging block-page failures.
- **Android:** see [`docs/ANDROID.md`](docs/ANDROID.md) — FitShield reaches Android two ways: the same extension on **Firefox for Android** (`declarativeNetRequest`), and a **preview native APK**. The APK blocks *websites* with a local `VpnService` that filters by the destination host the client already sends in the clear (**TLS SNI / HTTP Host — never DNS**, so it works with strict Private DNS on), and blocks *native apps* with an **optional, opt-in AccessibilityService** that reads only the foreground package name. Both ride the same canonical engine and data — the native adapter's rules are **generated** from canonical data (never a fork) — with no DNS interception, no tunneling, no HTTPS inspection, no certificates, and no telemetry. App blocking is additive to the connection filter, never a replacement.
- **Safari (nightly):** see [`docs/SAFARI.md`](docs/SAFARI.md) — the **nightly / experimental** macOS + iOS/iPadOS build. `npm run build:safari` stages the same web-extension payload (nightly-labeled manifest) on any OS and, on a Mac, wraps it into an Xcode app via Apple's `safari-web-extension-converter`. No code or data fork — it reuses the shared engine bundle and datasets; only the manifest differs. Blocking on Safari is experimental (narrower `declarativeNetRequest` support).
- **Release history:** the canonical, per-release notes live in [`changelog/`](changelog/); the roadmap is [`changelog/ROADMAP.md`](changelog/ROADMAP.md).
- **Storage, migrations & privacy:** see [`docs/STORAGE.md`](docs/STORAGE.md) — every key FitShield stores, the migration table, the backup format, and the complete list of what is never stored.
- **Validate & build:** `npm test`, `npm run validate`, then `node build.js`. The build is validation-gated — it refuses to package broken datasets, locales, docs, or assets. `npm run validate:alternatives` prints the alternatives-catalog report on its own.


# Ethos

Ordering apps are built to remove every second of friction between an impulse and
a checkout. That is a deliberate design choice, and it works. FitShield is the
opposite design choice: put a small, honest amount of friction back, and use it to
ask one question — *is this what you actually want right now?*

Three principles follow from that:

**Interruption, not prohibition.** The override is always one screen away and
always will be. A tool you cannot get out of is a tool you uninstall. Strict mode
is stricter, never irreversible.

**An answer, not just a wall.** Blocking an ordering page without offering
anything is just a nuisance at 10pm when you are hungry. That is why the
alternatives have real quantities and real timings, and why frozen dumplings,
tinned soup, and a rotisserie chicken sandwich are in there next to the cooking.
FitShield is competing with convenience, so it has to be convenient.

**No shame, and no invented numbers.** FitShield does not know whether you
ordered, cooked, or ate anything, so it does not pretend to. It counts what it can
see and says exactly that. There are no streaks to break, no scores to fail, and
nothing in this product will ever tell you what kind of person you are.

Local-first is part of the same idea. Your ordering habits are not something that
needs to leave your machine to be useful to you.


# Contributions

Contributions are genuinely welcome — code, data, and critique alike. The most
useful contributions are usually blocklist corrections and alternatives that
actually work in a real kitchen.

- **Missing or wrongly-categorised site, or a bad alternative:** use the built-in
  reporting flow in Settings → Report a problem. It shows you exactly what it
  would say before anything leaves your device.
- **Code and data:** see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the dataset
  formats, the validation rules, and the build steps.

Be civil in issues and pull requests. That is the whole code of conduct.

FitShield is completely free and open source. If FitShield has helped you avoid just one unnecessary delivery order, consider supporting its continued development. Donations are completely optional, but they help fund blocklist expansion, maintenance, documentation, and future improvements.

Buy Me a Coffee ☕:

[![Buy Me a Coffee](https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=%E2%98%95&slug=eeshgarg&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff)](https://buymeacoffee.com/eeshgarg)


# Licensing

Source Code: `LICENSE`

Curated Data: `DATA_LICENSE.md`

Branding: `BRANDING_LICENSE.md`

The FitShield name, logos, FitJack mascot, trademarks, service marks, trade dress,
and all branding assets remain the exclusive property of Usha Corporation / Eesh Garg and
are not included under either the software or data licenses.

Curated FitShield data includes the JSON blocklists (`delivery.json`,
`fast-food.json`), the alternatives catalog (`data/alternatives-taxonomy.json`
and `data/alternatives/`, generated into `data/recipes.json`), and the related
aliases, metadata, and category mappings.

The three licences cover different things and are not interchangeable: the code
is GPL-3.0-or-later, the curated data is under `DATA_LICENSE.md`, and the name,
logos, and mascot are under `BRANDING_LICENSE.md` and are not open source. A fork
may reuse the code and, under the data licence's terms, the data — but not the
FitShield branding.


<img width="820" height="294" alt="image" src="https://github.com/user-attachments/assets/20062c22-bc43-4247-9d62-1ab516dad153" />
