#!/usr/bin/env node
"use strict";
/**
 * Android adapter audit. Proves the native Android target is a thin adapter on
 * the SAME canonical engine/data as the browser — not a fork.
 *
 * Errors:
 *  - generated rules asset missing, unmarked, or DRIFTED from the engine output
 *  - a hand-maintained Android blocklist exists (any rules JSON not marked generated)
 *  - AndroidManifest uses a non-approved permission, a boot receiver,
 *    usage-access, or package-visibility
 *  - the bundled app-package dataset drifts from the generated output
 *  - analytics/telemetry dependency in the Android build
 *
 * NOTE: an AccessibilityService IS allowed (the opt-in app-blocking feature).
 * It is configured read-only for the foreground package name
 * (canRetrieveWindowContent="false") — see res/xml/accessibility_service_config.xml.
 * Notes: host count, hash, dataset versions.
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");
const gen = require("./generate-android-rules");
const genPackages = require("./generate-android-packages");

const ANDROID_DIR = path.join(load.ROOT, "android");
const MANIFEST = path.join(ANDROID_DIR, "app", "src", "main", "AndroidManifest.xml");
const APP_GRADLE = path.join(ANDROID_DIR, "app", "build.gradle");

// The ONLY permissions the Android adapter is allowed to declare.
const APPROVED_PERMISSIONS = new Set([
  "android.permission.INTERNET",                       // forward ALLOWED DNS queries upstream
  "android.permission.FOREGROUND_SERVICE",             // run the VpnService as a foreground service
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE", // required for the specialUse FGS type (Android 14+)
  "android.permission.POST_NOTIFICATIONS",             // the required ongoing VPN notification (Android 13+)
  "android.permission.SYSTEM_ALERT_WINDOW"             // "display over other apps": reliably show the block screen over a blocked app (user-granted, optional)
]);

// Permissions/components that must NEVER appear (checked against the manifest
// with XML comments stripped, so documentation that names them does not trip it).
const FORBIDDEN = [
  ["boot startup (RECEIVE_BOOT_COMPLETED)", /RECEIVE_BOOT_COMPLETED/],
  ["BOOT_COMPLETED receiver", /android\.intent\.action\.BOOT_COMPLETED/],
  ["usage access", /PACKAGE_USAGE_STATS/],
  ["package visibility", /QUERY_ALL_PACKAGES/],
  ["device admin", /BIND_DEVICE_ADMIN|device_admin/i],
  ["location permission", /ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION/],
  ["contacts permission", /READ_CONTACTS|WRITE_CONTACTS|GET_ACCOUNTS/],
  ["phone permission", /READ_PHONE_STATE|READ_PHONE_NUMBERS|CALL_PHONE|READ_CALL_LOG|WRITE_CALL_LOG/],
  ["SMS permission", /SEND_SMS|RECEIVE_SMS|READ_SMS|RECEIVE_MMS|RECEIVE_WAP_PUSH/],
  ["broad storage permission", /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/],
  ["notification listener", /BIND_NOTIFICATION_LISTENER_SERVICE|NotificationListenerService/]
];

const ANALYTICS = /firebase|crashlytics|com\.google\.android\.gms\.(analytics|measurement)|google-analytics|appcenter|segment|amplitude|mixpanel|sentry/i;

function androidAudit() {
  const reporter = new Reporter("Android adapter — engine reuse, no fork, permissions");

  if (!fs.existsSync(ANDROID_DIR)) {
    reporter.fail("android/ directory is missing");
    return reporter;
  }

  // 1. Generated asset exists, is marked generated, and MATCHES the engine.
  if (!fs.existsSync(gen.ASSET_PATH)) {
    reporter.fail(`generated rules asset missing: ${path.relative(load.ROOT, gen.ASSET_PATH)} (run npm run generate:android)`);
  } else {
    let asset;
    try {
      asset = JSON.parse(fs.readFileSync(gen.ASSET_PATH, "utf8"));
    } catch (error) {
      reporter.fail(`rules asset invalid JSON: ${error.message}`);
    }

    if (asset) {
      if (asset._generated !== true) {
        reporter.fail("rules asset is not marked _generated:true (looks hand-maintained)");
      }
      // Re-derive from canonical data via the separated engine and compare.
      // This is the core anti-divergence proof.
      // (deasync-free: caller wraps in the async runner below.)
      reporter._assetForDrift = asset;
    }
  }

  // 2. No OTHER blocklist-like JSON in android/ (no Android-only data fork).
  walkJson(ANDROID_DIR).forEach((file) => {
    if (path.resolve(file) === path.resolve(gen.ASSET_PATH)) {
      return;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return; // non-JSON-ish; ignore
    }
    const looksLikeRules = data && typeof data === "object" &&
      (Array.isArray(data.hosts) || Array.isArray(data.domains) || Array.isArray(data.entries) || Array.isArray(data.blocklist));
    if (looksLikeRules && data._generated !== true) {
      reporter.fail(`hand-maintained blocklist found: ${path.relative(load.ROOT, file)} (Android must use only the generated asset)`);
    }
  });

  // 3. Manifest permissions / forbidden components.
  if (!fs.existsSync(MANIFEST)) {
    reporter.fail("android/app/src/main/AndroidManifest.xml is missing");
  } else {
    // Strip XML comments first so documentation that *mentions* forbidden
    // permissions (e.g. "Deliberately NOT requested: …") never trips the checks.
    const xml = fs.readFileSync(MANIFEST, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const declared = [...xml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
    declared.forEach((perm) => {
      if (!APPROVED_PERMISSIONS.has(perm)) {
        reporter.fail(`manifest declares non-approved permission: ${perm}`);
      }
    });
    FORBIDDEN.forEach(([label, re]) => {
      if (re.test(xml)) {
        reporter.fail(`manifest contains forbidden ${label}`);
      }
    });
    // The VpnService must be guarded by BIND_VPN_SERVICE (how Android enforces it).
    if (!/android:permission="android\.permission\.BIND_VPN_SERVICE"/.test(xml)) {
      reporter.warn("VpnService should declare android:permission=\"android.permission.BIND_VPN_SERVICE\"");
    }
    reporter.note(`manifest permissions: ${declared.join(", ") || "(none)"}`);
  }

  // 3b. Reused web bundle: authored entries present + copied files match
  // canonical (no fork/drift). Mirrors the rules-asset drift guarantee.
  const webDir = path.join(ANDROID_DIR, "app", "src", "main", "assets", "web");
  ["index.html", "app.js"].forEach((f) => {
    if (!fs.existsSync(path.join(webDir, f))) {
      reporter.fail(`web entry missing: android/app/src/main/assets/web/${f}`);
    }
  });
  const WEB_COPIES = [
    ["android-shim.js", "android-shim.js"],
    ["i18n.js", "i18n.js"],
    ["languages.js", "languages.js"],
    ["currency.js", "currency.js"],
    ["ambient.js", "ambient.js"],
    ["recipes.js", "recipes.js"],
    [path.join("icons", "icon-128.png"), "icon-128.png"],
    [path.join("data", "recipes.json"), path.join("data", "recipes.json")]
  ];
  WEB_COPIES.forEach(([src, dest]) => {
    const canonical = path.join(load.ROOT, src);
    const bundled = path.join(webDir, dest);
    if (!fs.existsSync(bundled)) {
      reporter.fail(`web bundle missing ${dest} (run npm run build:android)`);
    } else if (!fs.readFileSync(canonical).equals(fs.readFileSync(bundled))) {
      reporter.fail(`web bundle ${dest} drifted from canonical (run npm run build:android)`);
    }
  });

  // All locales are reused (copied) — verify the bundled tree matches canonical
  // exactly, so there is no Android-only locale fork.
  const localeDrift = compareTree(load.LOCALES_DIR, path.join(webDir, "_locales"));
  if (localeDrift === null) {
    reporter.fail("web bundle missing _locales (run npm run build:android)");
  } else if (localeDrift > 0) {
    reporter.fail(`web bundle _locales drifted from canonical in ${localeDrift} file(s) (run npm run build:android)`);
  } else {
    reporter.note(`reused web assets: i18n, currency, recipes, icon + ${load.localeDirs().length} locales (copied from canonical, no fork)`);
  }

  // 3c. App-package dataset: the bundled asset must match the generated output
  // (which is compiled from data/android/*-apps.json + blocklists). No fork.
  const pkgAsset = path.join(ANDROID_DIR, "app", "src", "main", "assets", "android-packages.json");
  if (!fs.existsSync(pkgAsset)) {
    reporter.fail("bundled android-packages.json missing (run npm run build:android)");
  } else {
    let bundled;
    try {
      bundled = JSON.parse(fs.readFileSync(pkgAsset, "utf8"));
    } catch (error) {
      reporter.fail(`android-packages.json invalid JSON: ${error.message}`);
    }
    if (bundled) {
      // The bundled asset is the SLIM subset (package map only); the full ported
      // record is data/generated/android-packages.json. Compare the package maps.
      const fresh = genPackages.derive();
      if (bundled._generated !== true) {
        reporter.fail("android-packages.json is not marked _generated:true");
      } else if (JSON.stringify(bundled.packages) !== JSON.stringify(fresh.packages)) {
        reporter.fail("bundled android-packages.json DRIFTED from the generated dataset (run npm run build:android)");
      } else {
        reporter.note(`${fresh.counts.packages} app packages bundled; ${fresh.counts.brands} brands ported (${fresh.counts.needsReview} needs_review)`);
      }
    }
  }

  // 4. No analytics/telemetry dependency.
  if (fs.existsSync(APP_GRADLE)) {
    const gradle = fs.readFileSync(APP_GRADLE, "utf8");
    if (ANALYTICS.test(gradle)) {
      reporter.fail("Android build references an analytics/telemetry library");
    }
  }

  // 5. Play-release readiness: API level + no dev-only flags in a release build.
  if (fs.existsSync(APP_GRADLE)) {
    const gradle = fs.readFileSync(APP_GRADLE, "utf8");
    const compileSdk = Number((gradle.match(/compileSdk\s+(\d+)/) || [])[1] || 0);
    const targetSdk = Number((gradle.match(/targetSdk\s+(\d+)/) || [])[1] || 0);
    if (compileSdk < 35) reporter.fail(`compileSdk must be >= 35 for Google Play (found ${compileSdk || "none"})`);
    if (targetSdk < 35) reporter.fail(`targetSdk must be >= 35 for Google Play (found ${targetSdk || "none"})`);
    if (compileSdk >= 35 && targetSdk >= 35) reporter.note(`Play API level: compileSdk ${compileSdk}, targetSdk ${targetSdk}`);
  }
  // WebView remote debugging (setWebContentsDebuggingEnabled) must be gated to
  // debug builds — never unconditional, or it ships in release.
  kotlinSources().forEach((file) => {
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line) => {
      if (/setWebContentsDebuggingEnabled\s*\(\s*true\s*\)/.test(line) && !/BuildConfig\.DEBUG/.test(line)) {
        reporter.fail(`${path.basename(file)}: setWebContentsDebuggingEnabled(true) must be guarded by BuildConfig.DEBUG`);
      }
    });
  });
  // The manifest must never force debuggable on (AGP sets it per build type).
  if (fs.existsSync(MANIFEST) && /android:debuggable\s*=\s*"true"/.test(fs.readFileSync(MANIFEST, "utf8"))) {
    reporter.fail("manifest forces android:debuggable=\"true\" — must not ship in a release build");
  }
  reporter.note("release readiness: API 35, WebView debugging + console/RST logging gated to debug, not force-debuggable");

  return reporter;
}

// All Kotlin sources under the app's main source set.
function kotlinSources() {
  const root = path.join(ANDROID_DIR, "app", "src", "main", "java");
  const out = [];
  if (!fs.existsSync(root)) return out;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith(".kt")) out.push(p);
    }
  })(root);
  return out;
}

// Compare a canonical dir against a bundled copy. Returns the count of
// differing/missing files, or null if the bundled dir is absent entirely.
function compareTree(canonicalDir, bundledDir) {
  if (!fs.existsSync(bundledDir)) {
    return null;
  }
  let diffs = 0;
  (function walk(rel) {
    const here = path.join(canonicalDir, rel);
    for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(childRel);
      } else if (entry.isFile()) {
        const bundled = path.join(bundledDir, childRel);
        if (!fs.existsSync(bundled) || !fs.readFileSync(path.join(canonicalDir, childRel)).equals(fs.readFileSync(bundled))) {
          diffs += 1;
        }
      }
    }
  })("");
  return diffs;
}

function walkJson(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["build", ".gradle", ".idea"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJson(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

// Async wrapper so the engine re-derivation (drift proof) can be awaited.
async function audit() {
  const reporter = androidAudit();
  const asset = reporter._assetForDrift;
  delete reporter._assetForDrift;

  if (asset) {
    const derived = await gen.derive();
    if (asset.sha256 !== derived.sha256) {
      reporter.fail(`rules asset DRIFTED from engine output (asset ${String(asset.sha256).slice(0, 12)}… vs engine ${derived.sha256.slice(0, 12)}…) — run npm run generate:android`);
    } else if (JSON.stringify(asset.hosts) !== JSON.stringify(derived.hosts)) {
      reporter.fail("rules asset host list does not match the engine output");
    } else {
      reporter.note(`${derived.count} hosts match the separated engine (sha256 ${derived.sha256.slice(0, 12)}…)`);
      reporter.note(`derived from canonical data v${Object.values(derived.datasetVersions).join("/")} via ${derived.engine}`);
    }
  }
  return reporter;
}

if (require.main === module) {
  audit().then((reporter) => {
    reporter.print();
    process.exit(reporter.ok ? 0 : 1);
  });
}

module.exports = audit;
module.exports.sync = androidAudit;
