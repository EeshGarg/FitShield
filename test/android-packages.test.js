"use strict";

// Proves the Android app-package dataset is correct, deterministic, and always
// maps back to the canonical blocklists — with no duplicated brand metadata.
// Runs under `node --test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const gen = require("../tools/generate-android-packages");
const validate = require("../tools/validate-android-packages");
const load = require("../tools/lib/load");

function blocklistDomains() {
  const set = new Set();
  for (const ds of load.loadDatasets()) {
    (ds.data.entries || []).forEach((e) => { if (e.enabled !== false) set.add(e.domain); });
  }
  return set;
}

function appEntries() {
  return gen.loadAppFiles().flatMap(({ file, data }) =>
    (data.apps || []).map((app) => ({ file, app })));
}

test("validator passes with no errors", () => {
  const reporter = validate();
  assert.equal(reporter.errors.length, 0, `errors:\n${reporter.errors.join("\n")}`);
});

test("committed generated asset matches a fresh generation (deterministic, no drift)", () => {
  const fresh = gen.derive();
  const committed = JSON.parse(fs.readFileSync(gen.OUTPUT_PATH, "utf8"));
  assert.equal(committed._generated, true);
  assert.equal(committed.sha256, fresh.sha256, "asset drifted — run npm run generate:android-packages");
  assert.deepEqual(committed.packages, fresh.packages);
  assert.deepEqual(committed.brands, fresh.brands);
});

test("generation is deterministic across runs", () => {
  assert.equal(JSON.stringify(gen.derive()), JSON.stringify(gen.derive()));
});

test("every brandId maps to exactly one enabled blocklist brand (no orphans)", () => {
  const domains = blocklistDomains();
  for (const { file, app } of appEntries()) {
    assert.ok(domains.has(app.brandId), `${file}: orphaned brandId ${app.brandId}`);
  }
});

test("brandIds are globally unique", () => {
  const seen = new Set();
  for (const { app } of appEntries()) {
    assert.ok(!seen.has(app.brandId), `duplicate brandId ${app.brandId}`);
    seen.add(app.brandId);
  }
});

test("package IDs are globally unique and well-formed", () => {
  const re = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
  const seen = new Set();
  for (const { app } of appEntries()) {
    for (const pkg of app.packageIds || []) {
      assert.match(pkg, re, `bad package id ${pkg}`);
      assert.ok(!seen.has(pkg), `duplicate packageId ${pkg}`);
      seen.add(pkg);
    }
  }
});

test("packageStatus rules: empty packageIds iff needs_review", () => {
  for (const { file, app } of appEntries()) {
    const status = app.packageStatus || "active";
    if (status === "needs_review") {
      assert.equal((app.packageIds || []).length, 0, `${file}: ${app.brandId} needs_review must be empty`);
    } else {
      assert.ok((app.packageIds || []).length > 0, `${file}: ${app.brandId} active must have a package`);
    }
  }
});

test("categories are valid", () => {
  for (const b of gen.derive().brands) {
    assert.ok(gen.APP_CATEGORIES.includes(b.category), `bad category ${b.category} for ${b.brandId}`);
  }
});

test("app files carry NO duplicated brand metadata (only mapping fields)", () => {
  const allowed = new Set(["brandId", "packageIds", "packageStatus", "category"]);
  for (const { file, app } of appEntries()) {
    for (const key of Object.keys(app)) {
      assert.ok(allowed.has(key), `${file}: ${app.brandId} has forbidden field "${key}" (metadata must come from blocklists)`);
    }
  }
});

test("generated brand metadata is sourced from the blocklists (enriched, not authored)", () => {
  const byDomain = new Map();
  for (const ds of load.loadDatasets()) {
    (ds.data.entries || []).forEach((e) => byDomain.set(e.domain, e));
  }
  for (const b of gen.derive().brands) {
    const src = byDomain.get(b.brandId);
    assert.ok(src, `no source for ${b.brandId}`);
    assert.equal(b.displayName, src.name, `displayName mismatch for ${b.brandId}`);
    assert.ok(b.domains.includes(src.domain), `domains missing source domain for ${b.brandId}`);
    assert.deepEqual(b.countryCodes, src.countries || [], `countries mismatch for ${b.brandId}`);
  }
});

test("packages map: every package resolves to a known brand + real blocklist brand", () => {
  const domains = blocklistDomains();
  const asset = gen.derive();
  const brandIds = new Set(asset.brands.map((b) => b.brandId));
  for (const [pkg, meta] of Object.entries(asset.packages)) {
    assert.ok(brandIds.has(meta.brandId), `${pkg} → unknown brand ${meta.brandId}`);
    assert.ok(domains.has(meta.brandId), `${pkg} → brand not in blocklists ${meta.brandId}`);
  }
});

test("known mapping sanity: DoorDash + McDonald's resolve correctly", () => {
  const asset = gen.derive();
  assert.equal(asset.packages["com.dd.doordash"].brandId, "doordash.com");
  assert.equal(asset.packages["com.dd.doordash"].displayName, "DoorDash");
  assert.equal(asset.packages["com.mcdonalds.app"].brandId, "mcdonalds.com");
});

test("schema file exists and is valid JSON", () => {
  const schemaPath = path.join(gen.ANDROID_DIR, "packages.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
});
