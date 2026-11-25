"use strict";

/*
 * Regression guard for the removal of VpnService.
 *
 * Google Play rejected FitShield (versionCode 8): "Use of VpnService is not a
 * permitted use case". Website blocking on Android was dropped; app blocking via
 * the AccessibilityService stays. These tests pin the new reality so a VPN, a
 * network permission or a boot receiver cannot creep back in.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = path.join(ROOT, "android", "app", "src", "main");
const JAVA = path.join(MAIN, "java");
const ASSETS = path.join(MAIN, "assets");

const audit = require("../tools/android-audit.js");
const build = require("../tools/build-android.js");
const kotlinRunner = require("./helpers/kotlin-runner.js");

const stripXmlComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, "");
const stripKotlinComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, " ");

function walk(dir, accept, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

const MANIFEST = stripXmlComments(fs.readFileSync(path.join(MAIN, "AndroidManifest.xml"), "utf8"));
const KOTLIN = walk(JAVA, (f) => f.endsWith(".kt"));

const FIXTURE_HEAD = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n';
const FIXTURE_TAIL = "\n</manifest>";

// --- the manifest -----------------------------------------------------------

test("the manifest declares no VpnService, BIND_VPN_SERVICE, INTERNET, RECEIVE_BOOT_COMPLETED or boot receiver", () => {
  for (const [label, re] of [
    ["VpnService", /VpnService/],
    ["BIND_VPN_SERVICE", /BIND_VPN_SERVICE/],
    ["INTERNET", /android\.permission\.INTERNET\b/],
    ["RECEIVE_BOOT_COMPLETED", /RECEIVE_BOOT_COMPLETED/],
    ["BOOT_COMPLETED action", /BOOT_COMPLETED/],
    ["BootReceiver", /BootReceiver/],
    ["android.net.VpnService action", /android\.net\.VpnService/]
  ]) {
    assert.ok(!re.test(MANIFEST), `AndroidManifest.xml mentions ${label}`);
  }
});

test("the declared permissions are exactly the four the product needs", () => {
  const declared = [...MANIFEST.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(declared, [
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.SYSTEM_ALERT_WINDOW"
  ]);
  assert.deepEqual([...audit.APPROVED_PERMISSIONS].sort(), declared, "the audit allowlist and the manifest disagree");
});

// --- the sources ------------------------------------------------------------

test("no Kotlin source imports or uses VpnService, and the VPN-era sources are gone", () => {
  assert.ok(KOTLIN.length > 0, "found no Kotlin sources to check");
  for (const file of KOTLIN) {
    const source = stripKotlinComments(fs.readFileSync(file, "utf8"));
    assert.ok(!/android\.net\.VpnService/.test(source), `${path.basename(file)} imports android.net.VpnService`);
    assert.ok(!/\bVpnService\b/.test(source), `${path.basename(file)} references VpnService`);
    assert.ok(!/BIND_VPN_SERVICE|permission\.INTERNET|RECEIVE_BOOT_COMPLETED|BOOT_COMPLETED/.test(source),
      `${path.basename(file)} references a permission or broadcast that was removed with the VPN`);
  }
  for (const gone of [
    "FitShieldVpnService", "Tun2Filter", "IpPacket", "RuleEngine", "HostMatch",
    "BootReceiver", "RestorePolicy", "RestoreNotice", "BlockDecision"
  ]) {
    assert.ok(!fs.existsSync(path.join(JAVA, "com", "usha", "fitshield", `${gone}.kt`)), `${gone}.kt is back`);
  }
  assert.ok(!fs.existsSync(path.join(ASSETS, "fitshield-rules.json")), "the VPN rules asset is back");
});

test("the native bridge exposes no vpn / rules methods", () => {
  const bridge = stripKotlinComments(fs.readFileSync(path.join(JAVA, "com", "usha", "fitshield", "WebAppBridge.kt"), "utf8"));
  const exposed = [...bridge.matchAll(/@JavascriptInterface\s+fun\s+(\w+)/g)].map((m) => m[1]);
  assert.ok(exposed.length > 5, "could not read the bridge's exposed methods");
  for (const name of ["vpnEnabled", "vpnIsEnabled", "vpnEnable", "vpnDisable", "ruleCount", "privateDnsActive", "checkHost", "getRulesMetadata"]) {
    assert.ok(!exposed.includes(name), `the bridge still exposes ${name}`);
  }
});

test("nothing in the shipped web assets or the shim calls a vpn bridge method", () => {
  const files = [
    ...walk(ASSETS, (f) => /\.(js|html)$/.test(f)),
    path.join(ROOT, "android", "web-src", "android-shim.js")
  ];
  assert.ok(files.length > 3, "found no web assets to check");
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const hit = /\b(vpnEnabled|vpnIsEnabled|vpnEnable|vpnDisable|privateDnsActive|checkHost|getRulesMetadata|ruleCount)\s*\(/.exec(source);
    assert.ok(!hit, `${path.relative(ROOT, file)} still calls ${hit && hit[1]}()`);
  }
});

// --- the audit refuses what Google refused ---------------------------------

test("android-audit rejects a manifest that declares a VpnService", () => {
  const vpn = FIXTURE_HEAD +
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>\n' +
    '<application><service android:name=".FitShieldVpnService" android:permission="android.permission.BIND_VPN_SERVICE">' +
    '<intent-filter><action android:name="android.net.VpnService"/></intent-filter></service></application>' + FIXTURE_TAIL;
  const failures = audit.manifestViolations(vpn).join("\n");
  assert.match(failures, /VpnService/);
  assert.match(failures, /BIND_VPN_SERVICE/);
});

test("android-audit rejects INTERNET, RECEIVE_BOOT_COMPLETED and a boot receiver", () => {
  const manifest = FIXTURE_HEAD +
    '<uses-permission android:name="android.permission.INTERNET"/>\n' +
    '<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>\n' +
    '<application><receiver android:name=".BootReceiver"><intent-filter>' +
    '<action android:name="android.intent.action.BOOT_COMPLETED"/></intent-filter></receiver></application>' + FIXTURE_TAIL;
  const failures = audit.manifestViolations(manifest).join("\n");
  assert.match(failures, /INTERNET/);
  assert.match(failures, /RECEIVE_BOOT_COMPLETED/);
  assert.match(failures, /boot receiver/);
  assert.match(failures, /non-approved permission: android\.permission\.INTERNET/);
});

test("android-audit accepts a manifest with only the four approved permissions, and ignores comments", () => {
  const ok = FIXTURE_HEAD +
    "<!-- Deliberately NOT requested: INTERNET, BIND_VPN_SERVICE, VpnService, RECEIVE_BOOT_COMPLETED -->\n" +
    [...audit.APPROVED_PERMISSIONS].map((p) => `<uses-permission android:name="${p}"/>`).join("\n") + FIXTURE_TAIL;
  assert.deepEqual(audit.manifestViolations(ok), []);
});

test("android-audit rejects Kotlin that brings the VPN back", () => {
  const bad = "import android.net.VpnService\nclass X : VpnService() { fun go() = VpnService.prepare(null) }";
  assert.ok(audit.sourceViolations("X.kt", bad).length >= 2);
  assert.deepEqual(audit.sourceViolations("Y.kt", "// VpnService was removed\nclass Y"), [], "a comment must not trip the audit");
});

test("the real tree passes the audit's VPN rules", () => {
  const reporter = audit.sync();
  const vpnErrors = reporter.errors.filter((e) => /Vpn|VPN|INTERNET|BOOT|boot receiver|non-approved/i.test(e));
  assert.deepEqual(vpnErrors, []);
});

// --- the release bundle check ----------------------------------------------

/** A minimal zip holding one DEFLATE-compressed entry. */
function zipWith(name, data) {
  const zlib = require("node:zlib");
  const nameBuf = Buffer.from(name);
  const body = zlib.deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, nameBuf, body]);
  const centralPart = Buffer.concat([central, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

test("the bundle check fails an AAB whose manifest names VpnService / BIND_VPN_SERVICE / INTERNET, and passes a clean one", () => {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-aab-"));
  try {
    const dirty = path.join(dir, "dirty.aab");
    const clean = path.join(dir, "clean.aab");
    const nowhere = path.join(dir, "no-merged-manifest.xml");
    fs.writeFileSync(dirty, zipWith("base/manifest/AndroidManifest.xml",
      Buffer.from("\n\x1bcom.x.FitShieldVpnService\x20android.permission.BIND_VPN_SERVICE\x20android.permission.INTERNET")));
    fs.writeFileSync(clean, zipWith("base/manifest/AndroidManifest.xml",
      Buffer.from("android.permission.FOREGROUND_SERVICE android.permission.POST_NOTIFICATIONS")));

    const bad = build.bundleForbiddenViolations(dirty, nowhere).join("\n");
    assert.match(bad, /VpnService/);
    assert.match(bad, /BIND_VPN_SERVICE/);
    assert.match(bad, /INTERNET/);
    assert.deepEqual(build.bundleForbiddenViolations(clean, nowhere), []);

    // A bundle whose manifest cannot be read must not pass by not looking.
    const empty = path.join(dir, "empty.aab");
    fs.writeFileSync(empty, zipWith("something/else.txt", Buffer.from("x")));
    assert.ok(build.bundleForbiddenViolations(empty, nowhere).length > 0);

    // ...and a violation turns into a failing exit code.
    const outcome = build.bundleOutcome({ hasGradle: true, gradleStatus: 0, bundleFound: true, signed: true, forbidden: ["VpnService"] });
    assert.equal(outcome.exitCode, 1);
    assert.equal(build.bundleOutcome({ hasGradle: true, gradleStatus: 0, bundleFound: true, signed: true }).exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- pure logic that survives, executed -------------------------------------

test("the schedule window logic still decides the same way (executed Kotlin)", (t) => {
  const why = kotlinRunner.unavailable();
  if (why) return t.skip(why);

  const cases = [
    // enabled, start, end, now -> active
    ["false", "18:00", "23:00", 0, true],   // scheduling off: always active
    ["true", "18:00", "23:00", 17 * 60 + 59, false],
    ["true", "18:00", "23:00", 18 * 60, true],   // inclusive start
    ["true", "18:00", "23:00", 23 * 60, false],  // exclusive end
    ["true", "22:00", "06:00", 23 * 60, true],   // overnight
    ["true", "22:00", "06:00", 12 * 60, false],
    ["true", "08:00", "08:00", 3 * 60, true],    // start == end is the whole day
    ["true", "nope", "23:00", 3 * 60, true]      // malformed fails toward blocking
  ];
  const answers = kotlinRunner.run(cases.map(([e, s, en, now]) => `sched ${e} ${s} ${en} ${now}`));
  cases.forEach(([e, s, en, now, expected], i) => {
    assert.equal(answers[i], String(expected), `sched ${e} ${s}-${en} at ${now}`);
  });
});
