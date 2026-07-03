#!/usr/bin/env node
"use strict";
/**
 * Build/export step for the native Android adapter (DEBUG APK).
 *
 * Always (no Android tooling needed):
 *   1. Regenerate the rules asset from the canonical engine.
 *   2. Run the Android audit (engine reuse, no fork, approved permissions).
 *   3. Stage dist/android/ (rules + BUILD.txt with the exact local command).
 *
 * When the Android SDK + Gradle are available:
 *   4. Build a DEBUG APK and copy it to dist/android/FitShield-<version>-debug.apk.
 * Otherwise it does NOT fake success — it writes BUILD.txt explaining the exact
 * command to run locally.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const load = require("./lib/load");
const gen = require("./generate-android-rules");
const genPackages = require("./generate-android-packages");
const androidAudit = require("./android-audit");

const ANDROID_DIR = path.join(load.ROOT, "android");
const DIST_ANDROID = path.join(load.ROOT, "dist", "android");
const WEB_DIR = path.join(ANDROID_DIR, "app", "src", "main", "assets", "web");

// Canonical web files reused verbatim in the Android WebView, copied (not
// hand-maintained) so they can never fork. tools/android-audit.js fails on drift.
// Sources: extension/ (shared web UI modules), engine/ (canonical data), and
// android/web-src/ (the Android-authored shim). Destinations keep the historic
// flat bundle layout inside assets/web/. index.html / app.js are
// Android-authored entry files and stay in WEB_DIR.
// KEEP IN SYNC with the WEB_COPIES list in tools/android-audit.js.
const WEB_COPIES = [
  [path.join("android", "web-src", "android-shim.js"), "android-shim.js"],
  [path.join("extension", "i18n.js"), "i18n.js"],
  [path.join("extension", "languages.js"), "languages.js"],
  [path.join("extension", "currency.js"), "currency.js"],
  [path.join("extension", "ambient.js"), "ambient.js"],
  [path.join("extension", "recipes.js"), "recipes.js"],
  [path.join("extension", "icons", "icon-128.png"), "icon-128.png"],
  [path.join("engine", "data", "recipes.json"), path.join("data", "recipes.json")]
];
// Whole directories copied recursively (all 83 locales for real localization).
const WEB_DIR_COPIES = [[path.join("extension", "_locales"), "_locales"]];

function bundleWeb() {
  WEB_COPIES.forEach(([src, dest]) => {
    const to = path.join(WEB_DIR, dest);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(load.ROOT, src), to);
  });
  WEB_DIR_COPIES.forEach(([src, dest]) => {
    const to = path.join(WEB_DIR, dest);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(path.join(load.ROOT, src), to, { recursive: true });
  });
  console.log(`Bundled ${WEB_COPIES.length} files + ${WEB_DIR_COPIES.length} dir(s) of canonical web assets.`);
}

async function main() {
  const version = load.manifest().version;
  const apkName = `FitShield-${version}-debug.apk`;

  // 1. Regenerate from canonical data via the separated engine.
  const { asset } = await gen.generate();
  console.log(`Generated ${asset.count} hosts from ${asset.engine} (canonical data v${Object.values(asset.datasetVersions).join("/")}).`);

  // 1b. Refresh the reused web files (no fork).
  bundleWeb();

  // 1c. Regenerate + bundle the Android app-package dataset (for the
  // AccessibilityService). Compiled from data/android/*-apps.json + blocklists.
  const packages = await Promise.resolve(genPackages.generate());
  const packagesAsset = path.join(WEB_DIR, "..", "android-packages.json");
  // Ship only the slim package map (the ~2.5k-brand ported record stays in-repo).
  fs.writeFileSync(packagesAsset, JSON.stringify(genPackages.bundle(), null, 2) + "\n");
  console.log(`Ported ${packages.counts.brands} brands; bundled ${packages.counts.packages} app packages (${packages.counts.needsReview} needs_review, ${packages.counts.noApp} no_app, ${packages.counts.sharedApp} shared_app).`);

  // 2. Validate the adapter (drift, fork, permissions).
  const reporter = await androidAudit();
  reporter.print();
  if (!reporter.ok) {
    console.error("\nAndroid build aborted: adapter validation failed.");
    process.exit(1);
  }

  // 3. Stage outputs.
  fs.mkdirSync(DIST_ANDROID, { recursive: true });
  fs.copyFileSync(gen.ASSET_PATH, path.join(DIST_ANDROID, "fitshield-rules.json"));

  // 4. Build the DEBUG APK if tooling is present.
  const gradle = findGradle();
  let built = false;

  if (gradle) {
    console.log(`\nBuilding debug APK with ${gradle.label}…`);
    const result = spawnSync(
      `${gradle.bin} :app:assembleDebug -PfitshieldVersionName=${version}`,
      { cwd: ANDROID_DIR, stdio: "inherit", shell: true }
    );
    if (result.status === 0) {
      const apk = newestApk(path.join(ANDROID_DIR, "app", "build", "outputs", "apk", "debug"));
      if (apk) {
        fs.copyFileSync(apk, path.join(DIST_ANDROID, apkName));
        built = true;
        console.log(`\nBuilt ${apkName} -> ${path.relative(load.ROOT, path.join(DIST_ANDROID, apkName)).split(path.sep).join("/")}`);
      } else {
        console.error("Gradle succeeded but no debug APK was found.");
      }
    } else {
      console.error("\nGradle build failed — see output above.");
    }
  } else {
    console.log("\nAndroid SDK/Gradle not found in this environment — APK NOT built here.");
    console.log("Generated + validated rules and staged dist/android/. See dist/android/BUILD.txt.");
  }

  writeBuildTxt({ version, apkName, built, hasGradle: !!gradle, asset });
  if (!built) {
    // Not an error: tooling simply absent. Exit 0 so it can run in CI/dev too.
    console.log("\nTo build locally, run the command in dist/android/BUILD.txt.");
  }
}

function buildCommand() {
  const wrapperPresent = fs.existsSync(path.join(ANDROID_DIR, "gradlew")) ||
    fs.existsSync(path.join(ANDROID_DIR, "gradlew.bat"));
  if (wrapperPresent) {
    return "cd android && ./gradlew :app:assembleDebug   # (gradlew.bat on Windows)";
  }
  // No committed wrapper: materialize one with a system Gradle, then build.
  return [
    "cd android",
    "gradle wrapper            # one-time: creates ./gradlew (needs a system Gradle)",
    "./gradlew :app:assembleDebug",
    "# APK -> android/app/build/outputs/apk/debug/app-debug.apk",
    `# copy to dist/android/FitShield-${load.manifest().version}-debug.apk (npm run build:android does this automatically once Gradle is on PATH)`
  ].join("\n  ");
}

function writeBuildTxt({ version, apkName, built, hasGradle, asset }) {
  const lines = [
    "FitShield Android — debug build",
    "================================",
    "",
    `Version:            ${version}`,
    `Build date:         ${new Date().toISOString()}`,
    `APK filename:       ${apkName}`,
    `APK built here:     ${built ? "YES" : "NO"}`,
    `Build tooling found: ${hasGradle ? "yes (Gradle)" : "no (Android SDK/Gradle absent in this environment)"}`,
    `Rules:              ${asset.count} hosts, sha256 ${asset.sha256.slice(0, 16)}… (generated from ${asset.engine} over canonical data v${Object.values(asset.datasetVersions).join("/")})`,
    "",
    "Exact build command (run on a machine with the Android SDK + Gradle):",
    "  " + buildCommand(),
    "",
    "Or, once Gradle is on PATH, simply:",
    "  npm run generate:android && npm run validate:android && npm run build:android",
    "",
    "Install on a device (USB debugging on):",
    `  adb install -r dist/android/${apkName}`,
    "",
    "KNOWN PREVIEW LIMITATIONS",
    "  - PREVIEW/TEST quality.",
    "  - Blocks by TLS SNI (443) / HTTP Host (80) at the connection layer, NOT DNS.",
    "    Works with Private DNS / NextDNS on; DNS is never intercepted or altered.",
    "  - No HTTPS block page (no MITM) — blocked sites fail to connect (RST).",
    "  - IPv6 is captured and dropped to force IPv4 fallback; IPv6-only networks",
    "    are not yet supported. QUIC (UDP/443) is dropped to force TCP (SNI-visible).",
    "  - TLS with Encrypted Client Hello (ECH) hides the SNI and can bypass.",
    "  - One active VPN at a time (conflicts with another VPN app).",
    "",
    "MANUAL DEVICE TESTING CHECKLIST",
    "  [ ] APK installs (adb install -r ...)",
    "  [ ] App opens and shows the FitShield screen + loaded host count",
    "  [ ] Tapping Enable triggers the system VPN-consent dialog",
    "  [ ] After consent, the VPN starts and the OS VPN key/indicator appears",
    "  [ ] Foreground notification is shown and understandable",
    "  [ ] doordash.com is blocked (ERR_CONNECTION_RESET), WITH Private DNS on",
    "  [ ] ubereats.com is blocked",
    "  [ ] grubhub.com is blocked",
    "  [ ] Normal sites load fine (e.g. wikipedia.org, github.com)",
    "  [ ] Internet + DNS unaffected; Private DNS setting unchanged",
    "  [ ] Disabling stops filtering (blocked sites load again)",
    "  [ ] Uninstalling stops filtering",
    "  [ ] No startup on boot",
    "  [ ] No accessibility permission requested",
    "  [ ] No usage-access requested",
    "  [ ] No location / contacts / phone / SMS / storage permission requested",
    "  [ ] Small-screen UI is usable",
    "  [ ] No unexpected network; no visited hostnames in logcat",
    "  [ ] (optional) ./gradlew connectedAndroidTest passes the engine-parity test",
    ""
  ];
  fs.writeFileSync(path.join(DIST_ANDROID, "BUILD.txt"), lines.join("\n"));
}

function findGradle() {
  const isWin = process.platform === "win32";
  const wrapper = path.join(ANDROID_DIR, isWin ? "gradlew.bat" : "gradlew");
  if (fs.existsSync(wrapper)) {
    // Invoke from the project dir; a cwd batch file/script needs an explicit
    // "./" (or ".\") prefix so the shell resolves it.
    return { bin: isWin ? ".\\gradlew.bat" : "./gradlew", label: "gradle wrapper" };
  }
  const probe = spawnSync("gradle -v", { shell: true });
  if (probe.status === 0) {
    return { bin: "gradle", label: "system gradle" };
  }
  return null;
}

function newestApk(dir) {
  if (!fs.existsSync(dir)) return null;
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".apk")) found.push(full);
    }
  })(dir);
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
