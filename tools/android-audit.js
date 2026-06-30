#!/usr/bin/env node
"use strict";
/**
 * Android adapter audit. Proves the native Android target is a thin adapter on
 * the SAME canonical engine/data as the browser — not a fork.
 *
 * Errors:
 *  - generated rules asset missing, unmarked, or DRIFTED from the engine output
 *  - a hand-maintained Android blocklist exists (any rules JSON not marked generated)
 *  - AndroidManifest uses a non-approved permission, a boot receiver, an
 *    accessibility service, usage-access, or package-visibility
 *  - analytics/telemetry dependency in the Android build
 * Notes: host count, hash, dataset versions.
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");
const gen = require("./generate-android-rules");

const ANDROID_DIR = path.join(load.ROOT, "android");
const MANIFEST = path.join(ANDROID_DIR, "app", "src", "main", "AndroidManifest.xml");
const APP_GRADLE = path.join(ANDROID_DIR, "app", "build.gradle");

// The ONLY permissions the Android adapter is allowed to declare.
const APPROVED_PERMISSIONS = new Set([
  "android.permission.INTERNET",                       // forward ALLOWED DNS queries upstream
  "android.permission.FOREGROUND_SERVICE",             // run the VpnService as a foreground service
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE", // required for the specialUse FGS type (Android 14+)
  "android.permission.POST_NOTIFICATIONS"              // the required ongoing VPN notification (Android 13+)
]);

// Permissions/components that must NEVER appear (checked against the manifest
// with XML comments stripped, so documentation that names them does not trip it).
const FORBIDDEN = [
  ["boot startup (RECEIVE_BOOT_COMPLETED)", /RECEIVE_BOOT_COMPLETED/],
  ["BOOT_COMPLETED receiver", /android\.intent\.action\.BOOT_COMPLETED/],
  ["accessibility service", /accessibilityservice|BIND_ACCESSIBILITY_SERVICE/i],
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

  // 4. No analytics/telemetry dependency.
  if (fs.existsSync(APP_GRADLE)) {
    const gradle = fs.readFileSync(APP_GRADLE, "utf8");
    if (ANALYTICS.test(gradle)) {
      reporter.fail("Android build references an analytics/telemetry library");
    }
  }

  return reporter;
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
