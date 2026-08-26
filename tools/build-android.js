#!/usr/bin/env node
"use strict";
/**
 * Build/export step for the native Android adapter.
 *
 *   node tools/build-android.js                             -> debug APK
 *   node tools/build-android.js --bundle --versionCode=7     -> release AAB
 *
 * Always (no Android tooling needed):
 *   1. Regenerate the rules asset from the canonical engine.
 *   2. Run the Android audit (engine reuse, no fork, approved permissions).
 *   3. Stage dist/android/ (rules + BUILD.txt with the exact local command).
 *
 * When the Android SDK + Gradle are available:
 *   4a. default   — build a DEBUG APK  -> dist/android/FitShield-<version>-debug.apk
 *   4b. --bundle  — build a RELEASE AAB -> dist/android/FitShield-<version>-<code>.aab
 * Otherwise it does NOT fake success — it writes BUILD.txt explaining the exact
 * command to run locally.
 *
 * Play takes an Android App Bundle, not an APK, and an AAB that came out
 * UNSIGNED is not an upload — it is a file that will be rejected. So the bundle
 * path reads the signature block out of the artifact it just produced and fails
 * on its absence. Reporting success over a package that cannot be shipped is the
 * same failure `build.js` had when it validated the previous build and printed
 * PASS over a broken one.
 */

const fs = require("fs");
const os = require("os");
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
// Sources: extension/ (shared web UI modules), data/ (canonical data), and
// android/web-src/ (the Android-authored shim). Destinations keep the historic
// flat bundle layout inside assets/web/. index.html / app.js are
// Android-authored entry files and stay in WEB_DIR.
// KEEP IN SYNC with the WEB_COPIES list in tools/android-audit.js.
const WEB_COPIES = [
  [path.join("android", "web-src", "android-shim.js"), "android-shim.js"],
  [path.join("extension", "i18n.js"), "i18n.js"],
  [path.join("extension", "languages.js"), "languages.js"],
  [path.join("extension", "ambient.js"), "ambient.js"],
  [path.join("extension", "recipes.js"), "recipes.js"],
  [path.join("extension", "icons", "icon-128.png"), "icon-128.png"],
  [path.join("data", "recipes.json"), path.join("data", "recipes.json")]
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

/**
 * Parse the command line. `--bundle` switches to the release AAB, and in that
 * mode `--versionCode` is REQUIRED: Play rejects a re-used versionCode and there
 * is no way to reclaim one, so defaulting it would be handing the operator a
 * bundle that looks fine and cannot be uploaded twice.
 */
function parseArgs(argv) {
  const bundle = argv.includes("--bundle");
  const raw = (argv.find((a) => a.startsWith("--versionCode=")) || "").split("=")[1];

  if (!bundle) {
    if (raw !== undefined) {
      return { error: "--versionCode only applies to --bundle; the debug APK does not go to Play." };
    }
    return { bundle: false };
  }
  if (raw === undefined) {
    return {
      error:
        "--bundle requires --versionCode=<integer>.\n" +
        "  Play rejects a re-used versionCode and there is no way to reclaim one, so this is never defaulted.\n" +
        "  Example: node tools/build-android.js --bundle --versionCode=7"
    };
  }
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 2100000000) {
    return { error: `--versionCode must be a positive integer below 2100000000 (got "${raw}")` };
  }
  return { bundle: true, versionCode: Number(raw) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    process.exit(2);
  }

  const version = load.manifest().version;
  const apkName = `FitShield-${version}-debug.apk`;
  const aabName = `FitShield-${version}-${args.versionCode}.aab`;

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

  // 4. Build if tooling is present.
  const gradle = findGradle();
  let built = false;
  let gradleStatus = null;
  let artifactFound = false;
  let signed = false;

  const target = args.bundle
    ? { task: ":app:bundleRelease", label: "release AAB", name: aabName, outDir: ["bundle", "release"], ext: ".aab" }
    : { task: ":app:assembleDebug", label: "debug APK", name: apkName, outDir: ["apk", "debug"], ext: ".apk" };

  if (args.bundle && !releaseSigningConfigured()) {
    // Said BEFORE the build, because the build takes minutes and the answer is
    // already known. It is repeated as a failure afterwards — a warning nobody
    // scrolled back to is how an unsigned bundle reaches an upload dialog.
    console.warn(`\n${MISSING_SIGNING_HELP}`);
  }

  if (gradle) {
    console.log(`\nBuilding ${target.label} with ${gradle.label}…`);
    const properties = [`-PfitshieldVersionName=${version}`]
      .concat(args.bundle ? [`-PfitshieldVersionCode=${args.versionCode}`] : []);
    const result = spawnSync(
      `${gradle.bin} ${target.task} ${properties.join(" ")}`,
      { cwd: ANDROID_DIR, stdio: "inherit", shell: true, env: toolchainEnv() }
    );
    gradleStatus = result.status;
    if (result.status === 0) {
      const artifact = newestArtifact(
        path.join(ANDROID_DIR, "app", "build", "outputs", ...target.outDir), target.ext
      );
      artifactFound = !!artifact;
      if (artifact) {
        signed = !args.bundle || isBundleSigned(artifact);
        fs.copyFileSync(artifact, path.join(DIST_ANDROID, target.name));
        // The file is copied even when unsigned: it is still a valid local
        // "does it assemble" artefact, and deleting it would hide the evidence.
        // What it is NOT is a success, which the outcome below says plainly.
        built = signed;
        const where = path.relative(load.ROOT, path.join(DIST_ANDROID, target.name)).split(path.sep).join("/");
        console.log(`\n${signed ? "Built" : "Produced (UNSIGNED)"} ${target.name} -> ${where}`);
      } else {
        console.error(`Gradle succeeded but no ${target.label} was found.`);
      }
    } else {
      console.error("\nGradle build failed — see output above.");
    }
  } else {
    console.log(`\nAndroid SDK/Gradle not found in this environment — ${target.label} NOT built here.`);
    console.log("Generated + validated rules and staged dist/android/. See dist/android/BUILD.txt.");
  }

  writeBuildTxt({
    version, apkName, aabName, built, hasGradle: !!gradle, asset,
    bundle: args.bundle, versionCode: args.versionCode, signed
  });

  const outcome = args.bundle
    ? bundleOutcome({ hasGradle: !!gradle, gradleStatus, bundleFound: artifactFound, signed })
    : apkOutcome({ hasGradle: !!gradle, gradleStatus, apkFound: artifactFound });
  if (!built) {
    console.log("\nTo build locally, run the command in dist/android/BUILD.txt.");
  }
  if (outcome.exitCode !== 0) {
    console.error(`\n${outcome.reason}`);
    process.exit(outcome.exitCode);
  }
}

const MISSING_SIGNING_HELP = [
  "No release signing configuration found, so the bundle will come out UNSIGNED and Play will refuse it.",
  "Supply ONE of:",
  "  android/keystore.properties  (gitignored) with storeFile / storePassword / keyAlias / keyPassword",
  "  the environment variables FITSHIELD_STORE_FILE / FITSHIELD_STORE_PASSWORD /",
  "    FITSHIELD_KEY_ALIAS / FITSHIELD_KEY_PASSWORD",
  "(The -P form works too, but only when you invoke ./gradlew yourself — this script",
  " does not forward arbitrary Gradle properties, because a password on a shell",
  " command line is a password in your shell history.)",
  "See docs/PLAY_STORE_RELEASE_CHECKLIST.md §3."
].join("\n  ");

/** Whether android/app/build.gradle will find a release signing config. Mirrors
 *  the `hasReleaseSigning` expression there — keep the two in step. */
function releaseSigningConfigured() {
  const propsFile = path.join(ANDROID_DIR, "keystore.properties");
  if (fs.existsSync(propsFile) && /^\s*storeFile\s*=\s*\S/m.test(fs.readFileSync(propsFile, "utf8"))) {
    return true;
  }
  return Boolean(process.env.FITSHIELD_STORE_FILE);
}

/**
 * Decide the process exit code for the release-bundle phase.
 *
 * The extra state the APK path does not have is "produced, but unsigned". Play
 * rejects that upload, so calling it a successful build would be this command
 * lying about the one thing it was run to do.
 */
function bundleOutcome({ hasGradle, gradleStatus, bundleFound, signed }) {
  if (!hasGradle) {
    return { exitCode: 0, built: false, reason: "Android SDK/Gradle absent — bundle skipped, not failed." };
  }
  if (gradleStatus !== 0) {
    return { exitCode: 1, built: false, reason: `Android bundle FAILED: gradle :app:bundleRelease exited ${gradleStatus}.` };
  }
  if (!bundleFound) {
    return { exitCode: 1, built: false, reason: "Android bundle FAILED: Gradle reported success but produced no .aab." };
  }
  if (!signed) {
    return {
      exitCode: 1,
      built: false,
      reason: `Android bundle FAILED: the .aab is UNSIGNED and Play will reject it.\n  ${MISSING_SIGNING_HELP}`
    };
  }
  return { exitCode: 0, built: true, reason: "Release bundle built and signed." };
}

/**
 * Is this Android App Bundle signed?
 *
 * An AAB carries a v1/JAR signature: META-INF/MANIFEST.MF plus a matching
 * <NAME>.SF and a <NAME>.(RSA|DSA|EC) block. Play re-signs the APKs it generates
 * from the bundle, but it will not accept a bundle that arrives without this.
 *
 * BUNDLES ONLY. A modern APK is signed with scheme v2/v3, which lives in a
 * block before the central directory and leaves no META-INF entry at all — this
 * function would call a perfectly good debug APK unsigned. That is why the
 * caller only asks it about .aab files.
 *
 * Read from the zip central directory with Node's own Buffer — no dependency,
 * and no trusting Gradle's exit code for a fact that is in the file.
 */
function isBundleSigned(file) {
  const names = zipEntryNames(fs.readFileSync(file));
  const hasBlock = names.some((n) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(n));
  const hasSignatureFile = names.some((n) => /^META-INF\/[^/]+\.SF$/i.test(n));
  return hasBlock && hasSignatureFile;
}

/** Entry names from a zip's central directory. Empty when it cannot be read —
 *  which isBundleSigned treats as unsigned, the safe direction. */
function zipEntryNames(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return [];

  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) return [];   // zip64; not produced at these sizes

  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) return names;
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.toString("utf8", offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Decide the process exit code for the APK phase.
 *
 * "No Android tooling here" and "the APK build is broken" are completely
 * different facts, and this step used to report both as success: a Gradle run
 * that FAILED printed "Gradle build failed" and then exited 0, so any CI job
 * wired to `npm run build:android` went green over a broken APK. Same for the
 * "Gradle said OK but produced no APK" case.
 *
 * Absent tooling stays exit 0 on purpose — this environment genuinely has no
 * Android SDK, and the rules/bundle/audit steps above are still worth running
 * everywhere. Anything that actually RAN and did not produce an APK is a
 * failure.
 */
function apkOutcome({ hasGradle, gradleStatus, apkFound }) {
  if (!hasGradle) {
    return { exitCode: 0, built: false, reason: "Android SDK/Gradle absent — APK skipped, not failed." };
  }
  if (gradleStatus !== 0) {
    return {
      exitCode: 1,
      built: false,
      reason: `Android build FAILED: gradle :app:assembleDebug exited ${gradleStatus}.`
    };
  }
  if (!apkFound) {
    return {
      exitCode: 1,
      built: false,
      reason: "Android build FAILED: Gradle reported success but produced no debug APK."
    };
  }
  return { exitCode: 0, built: true, reason: "APK built." };
}

function buildCommand(bundle, versionCode) {
  const task = bundle ? ":app:bundleRelease" : ":app:assembleDebug";
  const extra = bundle ? ` -PfitshieldVersionCode=${versionCode || "<int>"}` : "";
  const wrapperPresent = fs.existsSync(path.join(ANDROID_DIR, "gradlew")) ||
    fs.existsSync(path.join(ANDROID_DIR, "gradlew.bat"));
  if (wrapperPresent) {
    return `cd android && ./gradlew ${task}${extra}   # (gradlew.bat on Windows)`;
  }
  // No committed wrapper: materialize one with a system Gradle, then build.
  return [
    "cd android",
    "gradle wrapper            # one-time: creates ./gradlew (needs a system Gradle)",
    `./gradlew ${task}${extra}`,
    bundle
      ? "# AAB -> android/app/build/outputs/bundle/release/app-release.aab"
      : "# APK -> android/app/build/outputs/apk/debug/app-debug.apk",
    bundle
      ? `# copy to dist/android/FitShield-${load.manifest().version}-${versionCode || "<int>"}.aab (node tools/build-android.js --bundle does this, and refuses an unsigned result)`
      : `# copy to dist/android/FitShield-${load.manifest().version}-debug.apk (npm run build:android does this automatically once Gradle is on PATH)`
  ].join("\n  ");
}

function writeBuildTxt({ version, apkName, aabName, built, hasGradle, asset, bundle, versionCode, signed }) {
  const artifact = bundle ? aabName : apkName;
  const lines = [
    bundle ? "FitShield Android — RELEASE bundle (Play upload)" : "FitShield Android — debug build",
    "================================================",
    "",
    `Version:            ${version}`,
    bundle ? `versionCode:        ${versionCode}` : "versionCode:        (debug default)",
    `Build date:         ${new Date().toISOString()}`,
    `Artifact filename:  ${artifact}`,
    `Built here:         ${built ? "YES" : "NO"}`,
    bundle ? `Signed:             ${signed ? "YES" : "NO — Play will reject this upload"}` : "Signed:             debug key",
    `Build tooling found: ${hasGradle ? "yes (Gradle)" : "no (Android SDK/Gradle absent in this environment)"}`,
    `Rules:              ${asset.count} hosts, sha256 ${asset.sha256.slice(0, 16)}… (generated from ${asset.engine} over canonical data v${Object.values(asset.datasetVersions).join("/")})`,
    "",
    "Exact build command (run on a machine with the Android SDK + Gradle):",
    "  " + buildCommand(bundle, versionCode),
    "",
    "Or, once Gradle is on PATH, simply:",
    bundle
      ? `  node tools/build-android.js --bundle --versionCode=${versionCode || "<int>"}`
      : "  npm run generate:android && npm run validate:android && npm run build:android",
    "",
    bundle
      ? "Upload dist/android/" + artifact + " to the Play Console. A versionCode may never be re-used."
      : "Install on a device (USB debugging on):\n  adb install -r dist/android/" + artifact,
    "",
    "KNOWN PREVIEW LIMITATIONS",
    "  - PREVIEW/TEST quality.",
    "  - Blocks by TLS SNI (443) / HTTP Host (80) at the connection layer, NOT DNS.",
    "    Works with Private DNS / NextDNS on; DNS is never intercepted or altered.",
    "  - No HTTPS block page (no MITM) — blocked sites fail to connect (RST).",
    "  - IPv6 is parsed and filtered on the same terms as IPv4 (it used to be",
    "    captured and dropped, which left an IPv6-only network with no working",
    "    connection at all). QUIC (UDP/443) is still dropped to force TCP, where",
    "    the SNI is visible — that part is deliberate.",
    "  - TLS with Encrypted Client Hello (ECH) hides the SNI and can bypass.",
    "  - One active VPN at a time (conflicts with another VPN app).",
    "",
    "MANUAL DEVICE TESTING CHECKLIST",
    "  [ ] Launcher icon is the FitShield icon, not Android's grey placeholder",
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
    "  [ ] Restart the phone with FitShield ON -> site blocking is ON again by",
    "      itself; or exactly one notification offers to restore it",
    "  [ ] Restart the phone with FitShield OFF -> still off, and NO notification",
    "  [ ] Update the app over itself -> same two outcomes as a restart",
    "  [ ] Accessibility is never enabled without the in-app consent step first,",
    "      and declining it leaves the service off",
    "  [ ] No usage-access requested",
    "  [ ] No location / contacts / phone / SMS / storage permission requested",
    "  [ ] Small-screen UI is usable",
    "  [ ] No unexpected network; no visited hostnames in logcat",
    "  [ ] (optional) ./gradlew connectedAndroidTest passes the engine-parity test",
    ""
  ];
  fs.writeFileSync(path.join(DIST_ANDROID, "BUILD.txt"), lines.join("\n"));
}

// Gradle — wrapper or system — cannot do anything without a JDK, and the wrapper
// script is COMMITTED, so `fs.existsSync(gradlew)` is true on every checkout
// including machines with no Java at all. Treating the file's presence as
// "tooling available" made this step announce "Building debug APK…", hand the
// user a JAVA_HOME stack trace, and call that a normal day.
// A locally provisioned toolchain, outside the repository so nothing large is
// committed and nothing system-wide is modified. Populated by
// `tools/provision-android-toolchain.js`. Discovering it here is what lets this
// step actually finish on a machine with no system Java or Android SDK.
const LOCAL_TOOLCHAIN = path.join(os.homedir(), ".fitshield-toolchain");

function localToolchain() {
  const jdk = path.join(LOCAL_TOOLCHAIN, "jdk");
  const sdk = path.join(LOCAL_TOOLCHAIN, "android-sdk");

  return fs.existsSync(path.join(jdk, "bin")) && fs.existsSync(sdk) ? { jdk, sdk } : null;
}

// Gradle — wrapper or system — cannot do anything without a JDK, and the
// wrapper script is COMMITTED, so `fs.existsSync(gradlew)` is true on every
// checkout including machines with no Java at all.
function hasJava() {
  if (localToolchain()) {
    return true;
  }

  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
    return true;
  }

  return spawnSync("java -version", { shell: true }).status === 0;
}

// Gradle reads JAVA_HOME and ANDROID_HOME from the environment, so pointing it
// at the local toolchain is a matter of handing the child process its own env
// rather than asking the user to export anything.
function toolchainEnv() {
  const local = localToolchain();

  if (!local) {
    return process.env;
  }

  return {
    ...process.env,
    JAVA_HOME: local.jdk,
    ANDROID_HOME: local.sdk,
    ANDROID_SDK_ROOT: local.sdk,
    PATH: `${path.join(local.jdk, "bin")}${path.delimiter}${process.env.PATH || ""}`
  };
}

function findGradle() {
  if (!hasJava()) {
    return null;
  }

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

function newestArtifact(dir, ext) {
  if (!fs.existsSync(dir)) return null;
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(ext)) found.push(full);
    }
  })(dir);
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

// bundleWeb is exported so `npm run sync` can refresh the Android web assets
// too. They are copied from the same canonical sources as the browser build, so
// leaving them to the (heavyweight, SDK-dependent) Android build meant the audit
// failed on drift after every ordinary data or locale edit.
module.exports = {
  bundleWeb, WEB_COPIES, WEB_DIR_COPIES, WEB_DIR,
  apkOutcome, bundleOutcome, parseArgs, isBundleSigned, zipEntryNames
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
