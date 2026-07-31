# FitShield on Safari (macOS / iOS / iPadOS) — NIGHTLY

> **Nightly / experimental.** These builds are unsigned, not on the App Store,
> and Safari's blocking APIs are narrower than Chromium's — treat this as a
> preview. The manifest ships as **“FitShield Nightly”** (`version_name
> <version>-nightly`) so it is unmistakable in Safari's Extensions pane and the
> wrapper app.

FitShield is a single web-extension source tree. Safari Web Extensions can't be
loaded from a folder like Chrome/Firefox — they run inside a **native app** built
with Apple's `safari-web-extension-converter` and **Xcode**, which are
**macOS-only**. So the Safari path has two halves:

| Runs on any OS (`npm run build:safari`) | Runs on macOS only |
| --- | --- |
| Validate → stage `dist/apple/extension/` (nightly manifest) → zip → write `dist/apple/BUILD.txt` | `safari-web-extension-converter` → Xcode project → build/sign/run the app |

One converter run produces **both** a macOS app and an iOS app; the iOS app runs
on **iPhone, iPad (iPadOS), and visionOS** (via iPad compatibility), so every
Apple desktop and mobile OS with Safari Web Extensions is covered.

The payload half runs on **every `node build.js`** (alongside Chrome and
Firefox), so `dist/apple/` is always current; `npm run build:safari` is the same
thing on its own (and, on a Mac, also runs the Xcode wrap).

## Identity

| | |
| --- | --- |
| App name | `FitShield Nightly` |
| Bundle identifier | `us.ushacorp.fitshield.nightly` (reverse-DNS of `ushacorp.us`, `.nightly` namespace) |
| Manifest name | `FitShield Nightly` · `version_name` `<version>-nightly` |

The `.nightly` bundle namespace keeps this build distinct from any future App
Store build, so both can be installed side by side.

## Requirements (Mac only)

- macOS with **Xcode 14+** and the Command Line Tools (`xcode-select --install`).
- **Safari 15.4+** (macOS) / **iOS 15+** to run the extension.
- A **free Apple ID** is enough to build and run locally; an **Apple Developer**
  account is needed to install on physical devices.

## One-click (recommended, on a Mac)

Double-click **[`scripts/install-safari.command`](../scripts/install-safari.command)**
in Finder (or run `bash scripts/install-safari.command`). It checks your setup,
builds + validates the payload, runs Apple's converter, and opens the Xcode
project ready to Run. First time only: `chmod +x scripts/install-safari.command`.

Safari's security model keeps the last two clicks yours: press **Run** in Xcode,
then enable **FitShield Nightly** in Safari → Settings → Extensions. The manual
build below is what that script automates.

## Build

### 1. Stage the payload (any OS)

```bash
node build.js          # builds Chrome + Firefox + Apple, all into dist/
# or just the Apple target:
npm run build:safari
# or every platform including Android:
npm run build:all
```

Any of these validates, stages `dist/apple/extension/`, writes
`dist/FitShield-<version>-nightly-safari.zip`, and writes `dist/apple/BUILD.txt`
(the exact converter command + a device checklist). On **macOS with Xcode** it
also runs the converter automatically and writes the Xcode project to
`dist/apple/xcode/`. Off macOS it stops after staging and says so — it never
fakes a build.

### 2. Generate the Xcode project (macOS)

If you're on a Mac, `npm run build:safari` already did this. To run it by hand:

```bash
xcrun safari-web-extension-converter \
    "dist/apple/extension" \
    --project-location "dist/apple/xcode" \
    --app-name "FitShield Nightly" \
    --bundle-identifier us.ushacorp.fitshield.nightly \
    --swift --copy-resources --force --no-open --no-prompt
```

`--copy-resources` copies the web files into the project (self-contained);
macOS + iOS are the converter defaults.

### 3. Build, sign, and run in Xcode (macOS)

```bash
open dist/apple/xcode/*/*.xcodeproj
```

- **macOS:** pick the macOS app scheme → **Run**. In Safari, enable the extension
  under **Settings → Extensions**. For local unsigned runs, turn on
  **Develop → Allow Unsigned Extensions** (Safari resets this each launch).
- **iOS / iPadOS:** pick the iOS app scheme and an **iPhone or iPad Simulator**
  (or a connected device) → **Run**, then enable **FitShield Nightly** under
  **Settings → Safari → Extensions**, and allow it on **All Websites**.

Signing is done locally with your own team in Xcode (Signing & Capabilities). No
signing or notarization happens in this repo.

## Known nightly limitations

- **Blocking is experimental on Safari.** FitShield blocks with
  `declarativeNetRequest` redirect rules (2,500+ dynamic rules). Safari's DNR
  support is narrower than Chromium's and its dynamic-rule ceiling is lower, so
  blocking may be **partial or capped**. Verify on-device against a few brands
  (`doordash.com`, `ubereats.com`, `mcdonalds.com`) before relying on it.
- **Unsigned / not distributed.** You sign locally; nothing here is submitted to
  the App Store.
- **Same privacy posture as the browser builds.** Local-only, no telemetry, no
  network. `host_permissions: <all_urls>` exists solely so the block-page
  redirect can cover every ordering site.

## Feature parity — enforced, not assumed

The Safari payload ships the **exact same feature set** as the Chrome build:
every UI surface (popup, settings, block page, welcome, what's-new, diagnostics),
the same generated `blocklist.js` engine bundle, the same blocklists, recipes,
locales, and icons. It reuses `build.js`'s `copyInto` and only swaps in the
Safari manifest (`build.safariManifest`) — there is no Safari fork of code or
data. Two guards keep it honest:

- **`test/apple-parity.test.js`** stages both the Chrome and Apple payloads and
  asserts they are **byte-for-byte identical except `manifest.json`**, and that
  the Safari manifest differs from Chrome's only by the nightly markers
  (`name` + `version_name`).
- **`tools/extension-audit.js`** pins the Safari manifest derivation (nightly
  name, `version_name`, gecko stripped, service-worker background).

So Safari can never quietly fall behind the browser builds. The one difference is
inherent to the platform, not the payload: Safari's `declarativeNetRequest`
support is narrower, so on-device blocking is experimental (hence *nightly*). See
[`ARCHITECTURE.md`](../ARCHITECTURE.md) and [`docs/EXTENSION.md`](EXTENSION.md).
