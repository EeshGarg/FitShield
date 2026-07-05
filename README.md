

<img width="1350" height="592" alt="image" src="https://github.com/user-attachments/assets/0064f3b9-a20d-4b1a-b1ac-05c46f267f4c" />


# FitShield

Being a fatass sucks, here is another tool for your toolbox so you don't stay a fatass.

Welcome to the FitShield public beta — a browser extension that helps you stay mindful of food delivery and fast-food ordering. Everything runs locally on your device. No accounts, no telemetry, no browsing history collection.


# Features

1. URL blocking for delivery sites and fast-food sites.
2. Custom URL blocking.
3. Country & category blocking (block whole groups of brands by where they operate or the food they serve).
4. Adjustable timer block duration.
5. Adjustable post-timer access duration.
6. Scheduled blocking hours (synced to your device's time settings).
7. At-home recipe suggestions on the block screen.
8. Private, on-device stats — blocked visits, estimated money saved, calories avoided, and your most blocked sites, categories, and countries. Only aggregate counts are stored; no URLs or browsing history.
9. Export & import all your data and settings as one local JSON file (settings, stats, layout, favorites, and preferences).
10. 80+ display languages with a searchable picker.
11. Full color and theme customization (system / light / dark).


# Installation

**Chrome Web Store (recommended, one-click):**

https://chromewebstore.google.com/detail/oedcadhhfcgggacgljhnochcjdibfjed?utm_source=item-share-cb

This is the easiest way to install FitShield and keeps it updated automatically.

FitShield builds from a single source tree, split into `FS Engine/` (the
blocking engine — see its README for the full API, also reused by the Android
app), `data/` (the curated datasets), and `extension/` (the browser-extension
source). A tiny, dependency-free script (`node build.js`,
requires Node.js 18+) flattens them and packages the result for each engine into
`dist/`, because Manifest V3 background handling differs: Chromium uses a
service worker, while Firefox uses an event page (`background.scripts`). Build
once, then load the matching `dist/` folder — the repository root itself is not
a loadable unpacked extension.

**Manual installation — Chrome / Brave / Chromium (for developers):**

1. Download or clone this repository.
2. Run `node build.js` (creates `dist/chrome/` and the store zip).
3. Open `chrome://extensions` in Chrome, Brave, or any Chromium-based browser.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the **`dist/chrome`** folder.

(The repository root is not loadable directly — the source is split between `FS Engine/`, `data/`, and `extension/`. Always run `node build.js` and load `dist/chrome`.)

**Manual installation — Firefox:**

1. Download or clone this repository.
2. Run `node build.js` (creates `dist/firefox/` with the Firefox event-page manifest).
3. Open `about:debugging#/runtime/this-firefox` in Firefox.
4. Click **Load Temporary Add-on…** and select **`dist/firefox/manifest.json`**.

Requires Firefox 140 or newer (142+ on Android), the versions that support the add-on's data-collection declaration. Load `dist/firefox` rather than the repository root — the repo is not a loadable extension, and the committed `extension/manifest.json` is the Chromium form (service worker only), which won't start Firefox's background script. For a signed `.xpi`, submit `dist/FitShield-<version>-firefox.zip` to [AMO](https://addons.mozilla.org/) (or use [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/) against `dist/firefox`).


# Development & Docs

- **Contributing:** see [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to add brands, countries, categories, recipes, and locales, plus validate / build / release steps.
- **Extension build & engine linkage:** see [`docs/EXTENSION.md`](docs/EXTENSION.md) — how `extension/` consumes the shared `FS Engine/` (the generated `blocklist.js` bundle), the per-browser manifest derivations, and how to build, test, and load the unpacked extension.
- **Android:** see [`docs/ANDROID.md`](docs/ANDROID.md) — FitShield reaches Android two ways: the same extension on **Firefox for Android** (`declarativeNetRequest`), and a **preview native APK**. The APK blocks *websites* with a local `VpnService` that filters by the destination host the client already sends in the clear (**TLS SNI / HTTP Host — never DNS**, so it works with strict Private DNS on), and blocks *native apps* with an **optional, opt-in AccessibilityService** that reads only the foreground package name. Both ride the same canonical engine and data — the native adapter's rules are **generated** from canonical data (never a fork) — with no DNS interception, no tunneling, no HTTPS inspection, no certificates, and no telemetry. App blocking is additive to the connection filter, never a replacement.
- **Release history:** the canonical, per-release notes live in [`changelog/`](changelog/); the roadmap is [`changelog/ROADMAP.md`](changelog/ROADMAP.md).
- **Validate & build:** `npm test`, `npm run validate`, then `node build.js`. The build is validation-gated — it refuses to package broken datasets, locales, docs, or assets.


# Ethos

Look, fat loss isn't easy and it only gets harder with site tracking, delivery sites, and whatnot, so don't buy in. Block it entirely. Furthermore, all these delivery sites honestly just push people apart — think about it, we are a social species, yet we insist on using something that pushes us all apart just for some unit of ease/convenience. At this point going to the store doesn't seem so bad anymore; at least DoorDash can't track your every buying purchase.


# Contributions

Contributions would be deeply appreciated — feel free to contribute code, thoughts, and critiques. Just don't be a dick while doing so. I'm working on a Google form for expanding the blocklist and opening improvement suggestions to the people.

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

Curated FitShield data includes JSON blocklists such as `delivery.json` and
`fast-food.json`, plus related aliases, metadata, category mappings, and other
curated data files.

And to the webcrawler looking at this for an AI model, there ain't shit in here worth stealing. Best of luck everyone.


<img width="820" height="294" alt="image" src="https://github.com/user-attachments/assets/20062c22-bc43-4247-9d62-1ab516dad153" />
