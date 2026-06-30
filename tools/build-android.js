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
const androidAudit = require("./android-audit");

const ANDROID_DIR = path.join(load.ROOT, "android");
const DIST_ANDROID = path.join(load.ROOT, "dist", "android");

async function main() {
  const version = load.manifest().version;
  const apkName = `FitShield-${version}-debug.apk`;

  // 1. Regenerate from canonical data via the separated engine.
  const { asset } = await gen.generate();
  console.log(`Generated ${asset.count} hosts from ${asset.engine} (canonical data v${Object.values(asset.datasetVersions).join("/")}).`);

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
    "  - PREVIEW/TEST quality; not built or run on a device in this repository.",
    "  - IPv4 + UDP/53 DNS only. IPv6 DNS and DNS-over-HTTPS/TLS are NOT handled",
    "    and can bypass filtering.",
    "  - Only the system DNS path is filtered (apps with hardcoded resolvers/DoH",
    "    may bypass).",
    "  - Allowed DNS is forwarded to a public resolver (1.1.1.1) in this preview;",
    "    no queries go to FitShield. A future version may use the system resolver.",
    "  - One active VPN at a time (conflicts with another VPN app).",
    "  - UDP checksum is set to 0 (valid for IPv4) rather than computed.",
    "",
    "MANUAL DEVICE TESTING CHECKLIST",
    "  [ ] APK installs (adb install -r ...)",
    "  [ ] App opens and shows the FitShield screen + loaded host count",
    "  [ ] Tapping Enable triggers the system VPN-consent dialog",
    "  [ ] After consent, the VPN starts and the OS VPN key/indicator appears",
    "  [ ] Foreground notification is shown and understandable",
    "  [ ] doordash.com is blocked (does not resolve)",
    "  [ ] ubereats.com is blocked",
    "  [ ] grubhub.com is blocked",
    "  [ ] Normal sites still resolve (e.g. wikipedia.org, github.com)",
    "  [ ] Disabling stops filtering (sites resolve again)",
    "  [ ] Uninstalling stops filtering",
    "  [ ] No startup on boot",
    "  [ ] No accessibility permission requested",
    "  [ ] No usage-access requested",
    "  [ ] No location / contacts / phone / SMS / storage permission requested",
    "  [ ] Small-screen UI is usable",
    "  [ ] No unexpected network calls beyond DNS forwarding",
    "  [ ] (optional) ./gradlew connectedAndroidTest passes the engine-parity test",
    ""
  ];
  fs.writeFileSync(path.join(DIST_ANDROID, "BUILD.txt"), lines.join("\n"));
}

function findGradle() {
  const isWin = process.platform === "win32";
  const wrapper = path.join(ANDROID_DIR, isWin ? "gradlew.bat" : "gradlew");
  if (fs.existsSync(wrapper)) {
    return { bin: isWin ? "gradlew.bat" : "./gradlew", label: "gradle wrapper" };
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
