"use strict";

// Proves the Android adapter consumes the SAME canonical engine output as the
// browser — no fork, no drift. Runs under `node --test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const gen = require("../tools/generate-android-rules");
const androidAudit = require("../tools/android-audit");

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
