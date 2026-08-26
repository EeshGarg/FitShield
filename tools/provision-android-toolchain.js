#!/usr/bin/env node
"use strict";
/**
 * Provision a local JDK + Android SDK so `npm run build:android` can produce a
 * real APK on a machine that has neither.
 *
 *   node tools/provision-android-toolchain.js
 *
 * Everything lands in ~/.fitshield-toolchain — outside the repository, so
 * nothing large is committed — and nothing system-wide is modified: no PATH
 * edit, no registry key, no JAVA_HOME export. `tools/build-android.js` finds
 * that directory and hands Gradle its own environment.
 *
 * This is NOT a project dependency. FitShield still ships zero, and its tests
 * and validators still add none. This is the Android build toolchain, the same
 * thing a developer would install by hand, fetched to a known location so the
 * step is reproducible rather than a note in a document.
 *
 * Downloads roughly 400MB the first time (JDK 17, SDK command-line tools,
 * platform 36, build-tools 36). Re-running is cheap: anything already present
 * is left alone.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOME = path.join(os.homedir(), ".fitshield-toolchain");
const JDK_DIR = path.join(HOME, "jdk");
const SDK_DIR = path.join(HOME, "android-sdk");

// AGP 8.6 / Gradle 8.7 require JDK 17, and compileSdk is 35. Both are read
// from android/app/build.gradle; they are pinned here so a mismatch is a
// deliberate edit rather than a silent drift.
const JDK_FEATURE = 17;
const SDK_PACKAGES = ["platform-tools", "platforms;android-36", "build-tools;36.0.0"];

const isWin = process.platform === "win32";

function log(message) {
  console.log(message);
}

// A single command string, not (command, args[]) under shell:true — Node warns
// that array arguments are concatenated rather than escaped there. Paths are
// quoted at the call site.
function run(commandLine, options = {}) {
  const result = spawnSync(commandLine, { stdio: "inherit", shell: true, ...options });

  if (result.status !== 0) {
    throw new Error(`command exited ${result.status}: ${commandLine}`);
  }

  return result;
}

async function download(url, destination) {
  log(`  fetching ${path.basename(destination)} …`);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  log(`  ${Math.round(buffer.length / 1048576)}MB`);
}

// Windows ships tar and PowerShell's Expand-Archive; Linux/macOS have unzip.
function unzip(archive, into) {
  fs.mkdirSync(into, { recursive: true });

  if (isWin) {
    run(`powershell -NoProfile -Command "Expand-Archive -Path '${archive}' -DestinationPath '${into}' -Force"`);
    return;
  }

  run(`unzip -q -o "${archive}" -d "${into}"`);
}

// Both archives contain a single top-level directory whose name carries a
// version. Flattening it gives a stable path the build can rely on.
function flattenInto(temporary, target) {
  const inner = fs.readdirSync(temporary).map((name) => path.join(temporary, name));
  const dir = inner.find((entry) => fs.statSync(entry).isDirectory());

  fs.renameSync(dir || temporary, target);

  if (dir && fs.existsSync(temporary)) {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function installJdk() {
  if (fs.existsSync(path.join(JDK_DIR, "bin"))) {
    log("JDK 17: already present");
    return;
  }

  log(`JDK ${JDK_FEATURE}:`);
  const osName = isWin ? "windows" : process.platform === "darwin" ? "mac" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x64";
  const api =
    `https://api.adoptium.net/v3/assets/latest/${JDK_FEATURE}/hotspot` +
    `?architecture=${arch}&image_type=jdk&os=${osName}&vendor=eclipse`;

  const response = await fetch(api);
  const assets = await response.json();

  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error(`Adoptium has no JDK ${JDK_FEATURE} for ${osName}/${arch}`);
  }

  const archive = path.join(HOME, "jdk.zip");
  await download(assets[0].binary.package.link, archive);

  const temporary = path.join(HOME, "jdk-unpack");
  fs.rmSync(temporary, { recursive: true, force: true });
  unzip(archive, temporary);
  flattenInto(temporary, JDK_DIR);
  fs.rmSync(archive, { force: true });
  log("  installed");
}

async function installAndroidSdk() {
  const latest = path.join(SDK_DIR, "cmdline-tools", "latest");

  if (!fs.existsSync(latest)) {
    log("Android command-line tools:");
    const file = isWin
      ? "commandlinetools-win-11076708_latest.zip"
      : process.platform === "darwin"
        ? "commandlinetools-mac-11076708_latest.zip"
        : "commandlinetools-linux-11076708_latest.zip";

    const archive = path.join(HOME, "cmdline-tools.zip");
    await download(`https://dl.google.com/android/repository/${file}`, archive);

    const temporary = path.join(HOME, "cmdline-unpack");
    fs.rmSync(temporary, { recursive: true, force: true });
    unzip(archive, temporary);

    fs.mkdirSync(path.join(SDK_DIR, "cmdline-tools"), { recursive: true });
    fs.renameSync(path.join(temporary, "cmdline-tools"), latest);
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    log("  installed");
  } else {
    log("Android command-line tools: already present");
  }

  const sdkmanager = path.join(latest, "bin", isWin ? "sdkmanager.bat" : "sdkmanager");
  const env = {
    ...process.env,
    JAVA_HOME: JDK_DIR,
    ANDROID_HOME: SDK_DIR,
    ANDROID_SDK_ROOT: SDK_DIR,
    PATH: `${path.join(JDK_DIR, "bin")}${path.delimiter}${process.env.PATH || ""}`
  };

  // The licence prompt reads from stdin; the SDK will not install anything
  // until every one is accepted. This is the same acceptance a developer gives
  // in Android Studio.
  log("Accepting SDK licences…");
  spawnSync(`"${sdkmanager}" --sdk_root="${SDK_DIR}" --licenses`, {
    input: Array(50).fill("y").join(String.fromCharCode(10)) + String.fromCharCode(10),
    shell: true,
    env,
    stdio: ["pipe", "ignore", "ignore"]
  });

  log(`Installing ${SDK_PACKAGES.join(", ")} …`);
  run(`"${sdkmanager}" --sdk_root="${SDK_DIR}" ${SDK_PACKAGES.map((p) => `"${p}"`).join(" ")}`, { env });
}

// A machine that already has a usable JDK and Android SDK needs nothing from
// this script, and provisioning anyway is not merely wasteful: build-android.js
// prefers ~/.fitshield-toolchain over JAVA_HOME and ANDROID_HOME, so a
// provisioned copy SHADOWS an SDK the machine already maintains. On a CI runner
// that means a ~400MB download replacing a working toolchain with a second one.
function systemToolchain() {
  const javaHome = process.env.JAVA_HOME;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;

  return javaHome && fs.existsSync(javaHome) && sdk && fs.existsSync(sdk) ? { javaHome, sdk } : null;
}

async function provision() {
  const system = systemToolchain();

  // The HOME check keeps an already-provisioned toolchain topping itself up:
  // once this directory exists the build prefers it, so it has to stay current.
  if (system && !fs.existsSync(HOME)) {
    log("A JDK and an Android SDK are already available:");
    log(`  JAVA_HOME    ${system.javaHome}`);
    log(`  ANDROID_HOME ${system.sdk}`);
    log("");
    log("Nothing to provision. `npm run build:android` will use them directly.");
    return;
  }

  fs.mkdirSync(HOME, { recursive: true });
  log(`Provisioning the Android toolchain into ${HOME}\n`);

  await installJdk();
  await installAndroidSdk();

  log("\nDone. `npm run build:android` will now find this toolchain and build a real APK.");
  log("Nothing outside this directory was modified, and nothing was added to the repository.");
}

module.exports = provision;

if (require.main === module) {
  provision().catch((error) => {
    console.error(`\nProvisioning failed: ${error.message}`);
    process.exit(1);
  });
}
