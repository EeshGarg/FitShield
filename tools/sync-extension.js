#!/usr/bin/env node
"use strict";
/**
 * Sync the generated / canonical RUNTIME artifacts into extension/ so the source
 * folder loads directly as an unpacked extension — no build step, no dist/.
 *
 * Chrome (and Firefox) loads ONE self-contained folder. After the FS Engine /
 * data / extension split, the artifacts the worker and pages fetch at runtime
 * live OUTSIDE extension/: the engine is bundled from "FS Engine/", and the
 * blocklists / recipes / changelog are canonical in data/ and the repo root.
 * This script generates (the engine bundle) and copies (the datasets) those into
 * extension/ as COMMITTED artifacts, so `Load unpacked → extension/` just works.
 *
 * The runtime fetch paths this satisfies (all resolved against the extension
 * root via chrome.runtime.getURL when extension/ is the loaded folder):
 *   - blocklist.js               importScripts by background.js + <script> in settings.html
 *   - blocklists/*.json          fetched by the FS Engine loader (loadBlocklists)
 *   - data/recipes.json          fetched by recipes.js (block-page suggestions)
 *   - changelog.json             fetched by whats-new.js
 *
 * Freshness is enforced two ways so the committed copies can NEVER silently drift
 * from canonical:
 *   - tools/sync-audit.js         (in `npm run validate` and the build gate)
 *   - test/extension-synced.test  (in `npm test`)
 * Both fail with "run `npm run sync`" when a committed copy is stale.
 *
 * build.js is unaffected: the store package is still staged straight from
 * canonical (FS Engine/ + data/), never from these synced copies — so the store
 * artifact and the loadable source can't disagree.
 *
 * Line endings: the comparison is EOL-insensitive (CRLF/LF), because this repo
 * uses core.autocrlf and a byte-exact check would be flaky across platforms.
 * That only ignores line endings (irrelevant to JS/JSON); real content drift is
 * still caught.
 *
 *   node tools/sync-extension.js           # write the synced artifacts
 *   node tools/sync-extension.js --check    # report staleness, exit 1 if stale
 */

const fs = require("fs");
const path = require("path");
const build = require("../build.js");

const ROOT = path.join(__dirname, "..");
const EXTENSION_DIR = path.join(ROOT, "extension");
const DATA_DIR = path.join(ROOT, "data");

// Plain file copies: [absolute canonical source, extension-relative destination].
// Destinations mirror the runtime fetch paths exactly.
const COPIES = [
  [path.join(DATA_DIR, "blocklists", "fast-food.json"), "blocklists/fast-food.json"],
  [path.join(DATA_DIR, "blocklists", "delivery.json"), "blocklists/delivery.json"],
  [path.join(DATA_DIR, "recipes.json"), "data/recipes.json"],
  [path.join(ROOT, "changelog.json"), "changelog.json"]
];

// The generated engine bundle. build.bundleEngine() is the single source of
// truth for how the "FS Engine/" CommonJS modules become one classic script —
// these are the exact bytes build.js also writes into dist/.
const GENERATED_BUNDLE = "blocklist.js";

// CRLF/LF-insensitive text form for comparison (see the header note).
function normalize(buf) {
  return buf.toString("utf8").replace(/\r\n/g, "\n");
}

// The expected content for every synced artifact, as { dest, bytes }.
function expectedArtifacts() {
  const artifacts = [{ dest: GENERATED_BUNDLE, bytes: Buffer.from(build.bundleEngine(), "utf8") }];
  for (const [src, dest] of COPIES) {
    artifacts.push({ dest, bytes: fs.readFileSync(src) });
  }
  return artifacts;
}

// The synced destinations that are missing or differ from canonical (ignoring
// line endings). Empty array == extension/ is fully in sync.
function staleArtifacts() {
  const stale = [];
  for (const { dest, bytes } of expectedArtifacts()) {
    const target = path.join(EXTENSION_DIR, dest);
    if (!fs.existsSync(target) || normalize(fs.readFileSync(target)) !== normalize(bytes)) {
      stale.push(dest);
    }
  }
  return stale;
}

// Write every synced artifact into extension/ (creating subdirectories).
function writeArtifacts() {
  const written = [];
  for (const { dest, bytes } of expectedArtifacts()) {
    const target = path.join(EXTENSION_DIR, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    written.push(dest);
  }
  return written;
}

// The Android app bundles the SAME canonical web assets (i18n, currency,
// recipes, the recipe catalog, all 83 locales). They are copied by
// tools/build-android.js, which also needs the Android SDK — so before this,
// every ordinary locale or catalog edit left the Android bundle stale and failed
// `npm run validate` until someone ran a full Android build. Copying the assets
// here keeps both in step from one command; the SDK is still only needed to
// produce an APK.
function syncAndroidWebAssets() {
  try {
    require("./build-android.js").bundleWeb();
    return true;
  } catch (error) {
    console.warn(`Could not refresh the Android web assets: ${error.message}`);
    return false;
  }
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    const stale = staleArtifacts();
    if (stale.length === 0) {
      console.log("extension/ synced artifacts are up to date.");
      process.exit(0);
    }
    console.error(
      "extension/ is out of sync with canonical sources:\n  " +
        stale.join("\n  ") +
        "\nRun `npm run sync` to regenerate."
    );
    process.exit(1);
  }

  const written = writeArtifacts();
  console.log("Synced " + written.length + " artifact(s) into extension/:\n  " + written.join("\n  "));
  syncAndroidWebAssets();
}

module.exports = { COPIES, GENERATED_BUNDLE, expectedArtifacts, staleArtifacts, writeArtifacts, syncAndroidWebAssets, EXTENSION_DIR };
