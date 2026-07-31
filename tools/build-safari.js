#!/usr/bin/env node
"use strict";
/**
 * Build/export step for the Apple platforms — Safari on **macOS, iOS, and
 * iPadOS** (the iOS target also runs on iPad and, via iPad compatibility,
 * visionOS). NIGHTLY / experimental.
 *
 * Safari Web Extensions are not loaded from a folder like Chrome/Firefox: they
 * ship inside a native app built with Apple's `safari-web-extension-converter`
 * and Xcode, which run ONLY on macOS. So this step splits in two, exactly like
 * the Android build (tools/build-android.js):
 *
 * Always (no Apple tooling needed — runs on any OS):
 *   1. (standalone only) gate on the full validator suite.
 *   2. Stage the Safari web-extension payload into dist/apple/extension/ — the
 *      shared web files + engine bundle, with a Safari manifest that is clearly
 *      NIGHTLY (name "FitShield Nightly", version_name "<v>-nightly").
 *   3. Zip it to dist/FitShield-<version>-nightly-safari.zip.
 *   4. Write dist/apple/BUILD.txt with the exact converter command, the macOS/
 *      iOS/iPadOS steps, known limitations, and a device test checklist.
 *
 * When macOS + Xcode's converter are available:
 *   5. Run `safari-web-extension-converter` to generate the Xcode project for
 *      macOS + iOS into dist/apple/xcode/.
 * Otherwise it does NOT fake success — BUILD.txt explains the exact command to
 * run on a Mac. Building/signing the final .app/.ipa is a manual Xcode step
 * (needs an Apple Developer team), documented in docs/SAFARI.md.
 *
 * `node build.js` calls run({ validate: false }) so every build compiles the
 * Apple payload to dist/ alongside Chrome and Firefox; `npm run build:safari`
 * calls run() standalone (validates first).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const load = require("./lib/load");
const build = require("../build.js");
const { validateAll } = require("./validate-all");

const ROOT = load.ROOT;
const DIST = path.join(ROOT, "dist");
const DIST_APPLE = path.join(DIST, "apple");
const STAGE_DIR = path.join(DIST_APPLE, "extension");
const XCODE_DIR = path.join(DIST_APPLE, "xcode");

// Nightly identity. Bundle id is reverse-DNS of the project domain (ushacorp.us)
// with a `.nightly` namespace so it never collides with a future App Store build.
const APP_NAME = build.SAFARI_NIGHTLY_NAME; // "FitShield Nightly"
const BUNDLE_ID = "us.ushacorp.fitshield.nightly";

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

// True only on macOS with the converter present. `xcrun --find` resolves the
// tool from the active Xcode/Command Line Tools without running it.
function findConverter() {
  if (process.platform !== "darwin") {
    return null;
  }
  const probe = spawnSync("xcrun", ["--find", "safari-web-extension-converter"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout && probe.stdout.trim()) {
    return probe.stdout.trim();
  }
  return null;
}

// The exact converter invocation — also printed into BUILD.txt so a Mac user can
// run it by hand. macOS + iOS are the converter defaults (iOS covers iPadOS).
function converterArgs() {
  return [
    "safari-web-extension-converter",
    STAGE_DIR,
    "--project-location", XCODE_DIR,
    "--app-name", APP_NAME,
    "--bundle-identifier", BUNDLE_ID,
    "--swift",
    "--copy-resources",
    "--force",
    "--no-open",
    "--no-prompt"
  ];
}

function converterCommand() {
  return "xcrun safari-web-extension-converter \\\n" +
    `    "${rel(STAGE_DIR)}" \\\n` +
    `    --project-location "${rel(XCODE_DIR)}" \\\n` +
    `    --app-name "${APP_NAME}" \\\n` +
    `    --bundle-identifier ${BUNDLE_ID} \\\n` +
    "    --swift --copy-resources --force --no-open --no-prompt";
}

/**
 * Stage the Apple/Safari nightly payload into dist/apple/ (+ zip + BUILD.txt),
 * and wrap it into an Xcode project when run on macOS with the converter.
 *
 * @param {object} [options]
 * @param {boolean} [options.validate=true]  Run the full validator suite first.
 *   build.js passes false because it has already validated.
 * @param {boolean} [options.announce=true]  Print the standalone banner + hints.
 * @returns {Promise<{version,stageDir,zipPath,converted,hasConverter}>}
 */
async function run(options = {}) {
  const { validate = true, announce = true } = options;

  const base = JSON.parse(fs.readFileSync(path.join(load.EXTENSION_DIR, "manifest.json"), "utf8"));
  const version = base.version;
  const zipName = `FitShield-${version}-nightly-safari.zip`;
  const zipPath = path.join(DIST, zipName);

  if (validate) {
    console.log("Validating before staging the Apple (Safari nightly) payload…");
    const validation = await validateAll({ quiet: true });
    validation.reporters.forEach((r) => r.print());
    if (!validation.ok) {
      console.error(`\nSafari build aborted: ${validation.errors} validation error(s). Fix them and re-run.`);
      process.exit(1);
    }
  }

  // Clean the Apple output each run so it can't carry stale bytes.
  rmrf(DIST_APPLE);
  fs.mkdirSync(DIST_APPLE, { recursive: true });

  // Same payload as chrome/firefox (build.copyInto), then the nightly-labeled
  // Safari manifest.
  build.copyInto(STAGE_DIR);
  fs.writeFileSync(
    path.join(STAGE_DIR, "manifest.json"),
    JSON.stringify(build.safariManifest(base), null, 2) + "\n"
  );
  console.log(`Staged Apple (Safari nightly) payload -> ${rel(STAGE_DIR)}`);

  build.zipDir(STAGE_DIR, zipPath);

  // Wrap into the Xcode app when the converter is available (macOS only).
  const converter = findConverter();
  let converted = false;

  if (converter) {
    console.log(`\nConverting to an Xcode project (macOS + iOS/iPadOS) with ${converter}…`);
    fs.mkdirSync(XCODE_DIR, { recursive: true });
    const result = spawnSync("xcrun", converterArgs(), { cwd: ROOT, stdio: "inherit" });
    if (result.status === 0) {
      converted = true;
      console.log(`Generated Xcode project -> ${rel(XCODE_DIR)}`);
    } else {
      console.error("safari-web-extension-converter failed — see output above.");
    }
  } else {
    console.log("Apple converter not found (needs macOS + Xcode) — Xcode project NOT generated here.");
  }

  writeBuildTxt({ version, zipName, converted, hasConverter: !!converter });

  if (announce) {
    console.log(`\nBuilt FitShield ${version} — Apple / Safari NIGHTLY:`);
    console.log(`  Web extension : ${rel(STAGE_DIR)}`);
    console.log(`  Zip           : ${rel(zipPath)}`);
    console.log(`  Xcode project : ${converted ? rel(XCODE_DIR) : "run `npm run build:safari` on macOS (see dist/apple/BUILD.txt)"}`);
    if (!converted) {
      console.log("\nTo finish on a Mac, run the command in dist/apple/BUILD.txt (or `npm run build:safari` there).");
    }
  }

  return { version, stageDir: STAGE_DIR, zipPath, converted, hasConverter: !!converter };
}

function writeBuildTxt({ version, zipName, converted, hasConverter }) {
  const lines = [
    "FitShield Apple (Safari) — NIGHTLY build (macOS / iOS / iPadOS)",
    "==============================================================",
    "",
    "*** NIGHTLY / EXPERIMENTAL — not for the App Store, not signed here. ***",
    "",
    `Version:              ${version} (version_name "${version}-nightly")`,
    `App name:             ${APP_NAME}`,
    `Bundle identifier:    ${BUNDLE_ID}`,
    `Build date:           ${new Date().toISOString()}`,
    `Payload staged:       dist/apple/extension/`,
    `Payload zip:          dist/${zipName}`,
    `Xcode project built:  ${converted ? "YES (dist/apple/xcode/)" : "NO"}`,
    `Converter found here: ${hasConverter ? "yes (macOS + Xcode)" : "no (needs macOS + Xcode — this is not a Mac)"}`,
    "",
    "WHAT THIS IS",
    "  Safari Web Extensions ship inside a native macOS/iOS app, not as a loadable",
    "  folder. dist/apple/extension/ is the web-extension payload; Apple's",
    "  converter wraps it into an Xcode app. One run targets macOS + iOS; the iOS",
    "  app runs on iPhone, iPad (iPadOS), and visionOS (iPad compatibility).",
    "  Building/signing the final .app/.ipa is a manual Xcode step.",
    "",
    "REQUIREMENTS (Mac only)",
    "  - macOS with Xcode 14+ and Command Line Tools.",
    "  - Safari 15.4+ (macOS) / iOS 15+ to run the extension; a free Apple ID is",
    "    enough to run locally, an Apple Developer account to install on devices.",
    "",
    "STEP 1 — generate the Xcode project (run on a Mac):",
    "  " + converterCommand(),
    "",
    "  Or simply, from the repo root on a Mac:",
    "    npm run build:safari      # or `node build.js` (builds every platform)",
    "",
    "STEP 2 — open + run in Xcode:",
    "  open dist/apple/xcode/*/*.xcodeproj",
    "  - macOS:  select the macOS app scheme -> Run. Enable it in",
    "            Safari > Settings > Extensions ('Allow unsigned extensions' in",
    "            Safari's Develop menu for local runs).",
    "  - iOS / iPadOS: select the iOS app scheme + a Simulator (iPhone or iPad) or",
    "            a connected device -> Run, then enable FitShield Nightly in",
    "            Settings > Safari > Extensions.",
    "",
    "KNOWN NIGHTLY LIMITATIONS",
    "  - EXPERIMENTAL. Safari's declarativeNetRequest support is narrower than",
    "    Chromium's; the redirect-to-block-page rules may be partially applied or",
    "    capped by Safari's dynamic-rule limit. Verify blocking on-device.",
    "  - Not code-signed or notarized here; you sign locally in Xcode with your own",
    "    team. Not submitted to the App Store.",
    "  - Same privacy posture as the browser builds: local-only, no telemetry, no",
    "    network. host_permissions(<all_urls>) is for the block-page redirect only.",
    "",
    "MANUAL TEST CHECKLIST (per platform: macOS, iOS Simulator, iPad Simulator)",
    "  [ ] The wrapper app builds and runs in Xcode without signing errors",
    "  [ ] 'FitShield Nightly' appears in Safari's Extensions list and enables",
    "  [ ] The popup opens and shows the FitShield controls",
    "  [ ] Visiting doordash.com redirects to the block page (warning.html)",
    "  [ ] ubereats.com and mcdonalds.com are blocked",
    "  [ ] The block page shows the brand, timer, reason panel, and recipe columns",
    "  [ ] Continue unlocks after the timer and opens the site (temporary pass)",
    "  [ ] Normal sites load fine (e.g. wikipedia.org)",
    "  [ ] Settings/stats persist; no network requests are made",
    "  [ ] Disabling the extension stops blocking",
    ""
  ];
  fs.writeFileSync(path.join(DIST_APPLE, "BUILD.txt"), lines.join("\n"));
}

module.exports = { run, BUNDLE_ID, APP_NAME, converterArgs, DIST_APPLE };

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
