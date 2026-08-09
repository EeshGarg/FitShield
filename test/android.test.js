"use strict";

// Proves the Android adapter consumes the SAME canonical engine output as the
// browser — no fork, no drift. Runs under `node --test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const gen = require("../tools/generate-android-rules");
const androidAudit = require("../tools/android-audit");
const { apkOutcome } = require("../tools/build-android");

// `npm run build:android` used to exit 0 no matter what happened to the APK.
// "No Android SDK on this machine" and "the APK build is broken" are completely
// different facts, and reporting both as success means any CI job wired to this
// script goes green over a broken build — the one thing a build gate exists to
// prevent. Absent tooling is still a clean skip; anything that RAN and produced
// no APK is a failure.
test("the Android build reports a real Gradle failure instead of exiting clean", () => {
  assert.equal(apkOutcome({ hasGradle: false, gradleStatus: null, apkFound: false }).exitCode, 0,
    "no toolchain here is a skip, not a failure");

  assert.equal(apkOutcome({ hasGradle: true, gradleStatus: 1, apkFound: false }).exitCode, 1,
    "a Gradle build that failed must fail the command");

  assert.equal(apkOutcome({ hasGradle: true, gradleStatus: 0, apkFound: false }).exitCode, 1,
    "Gradle reporting success while producing no APK must fail the command");

  const built = apkOutcome({ hasGradle: true, gradleStatus: 0, apkFound: true });
  assert.equal(built.exitCode, 0);
  assert.equal(built.built, true);
});

test("committed Android rules asset matches the separated engine output", async () => {
  const derived = await gen.derive();
  const asset = JSON.parse(fs.readFileSync(gen.ASSET_PATH, "utf8"));
  assert.equal(asset._generated, true, "asset must be marked generated");
  assert.equal(asset.sha256, derived.sha256, "asset sha256 drifted from engine — run npm run generate:android");
  assert.deepEqual(asset.hosts, derived.hosts, "asset host list drifted from engine");
});

test("Android semantics fixture matches the engine's block/allow decisions", async () => {
  const derived = await gen.deriveFixture();
  const fixture = JSON.parse(fs.readFileSync(gen.FIXTURE_PATH, "utf8"));
  assert.deepEqual(fixture.cases, derived.cases, "fixture drifted — run npm run generate:android");
  // Sanity: look-alikes and suffix tricks must NOT be blocked (anchored matching).
  const byHost = Object.fromEntries(fixture.cases.map((c) => [c.host, c.blocked]));
  assert.equal(byHost["doordash.com"], true);
  assert.equal(byHost["fake-doordash.com"], false);
  assert.equal(byHost["doordash.com.evil.com"], false);
});

test("android-audit passes (engine reuse, no fork, approved permissions)", async () => {
  const reporter = await androidAudit();
  assert.equal(reporter.errors.length, 0, `android-audit errors:\n${reporter.errors.join("\n")}`);
});

// The APK does NOT bundle fitshield-core.js — the Android decision layer is the
// Kotlin AppBlockPolicy, not the shared core (docs/ANDROID.md §2e row 1). A page
// script that starts using FitShieldCore would therefore find it undefined at
// runtime and fail silently in the WebView, which is exactly the failure the
// extension already hit once on its restore path. Either bundle core or do not
// depend on it; this test refuses the middle state.
test("no Android web asset depends on FitShieldCore unless core is bundled", () => {
  const path = require("node:path");
  const ROOT = path.join(__dirname, "..");
  const webDir = path.join(ROOT, "android", "app", "src", "main", "assets", "web");
  const coreIsBundled = fs.existsSync(path.join(webDir, "fitshield-core.js"));

  const sources = [
    ...fs.readdirSync(webDir).filter((f) => f.endsWith(".js")).map((f) => path.join(webDir, f)),
    ...fs.readdirSync(path.join(ROOT, "android", "web-src"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => path.join(ROOT, "android", "web-src", f))
  ];

  const dependants = sources
    .filter((file) => /\bFitShieldCore\b/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.basename(file));

  if (coreIsBundled) {
    return; // core ships: depending on it is fine, and §2e row 1 needs updating.
  }

  assert.deepEqual(dependants, [],
    `these Android scripts use FitShieldCore but the APK does not bundle it: ${dependants.join(", ")}`);
});
