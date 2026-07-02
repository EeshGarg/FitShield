#!/usr/bin/env node
"use strict";
/**
 * Validate the Android app-package datasets and their generated output.
 *
 * Fails on:
 *  - malformed app file / schema violation (bad brandId or packageId shape,
 *    unknown category, wrong _schema)
 *  - orphaned entry: a brandId with no matching brand in blocklists/*.json
 *  - duplicate brandId (across all app files)
 *  - duplicate packageId (across all app files / brands)
 *  - packageStatus rule violation (empty packageIds require "needs_review", and
 *    "needs_review" requires empty packageIds; "active" requires ≥1 package)
 *  - non-deterministic / stale generation: data/generated/android-packages.json
 *    differs from a fresh generation (run npm run generate:android-packages)
 *  - missing source blocklist
 *
 * Guarantees every Android package maps back to exactly one blocklist brand and
 * that display metadata is never duplicated in the app files.
 */

const fs = require("fs");
const path = require("path");
const load = require("./lib/load");
const { Reporter, runCli } = require("./lib/report");
const gen = require("./generate-android-packages");

const SCHEMA_PATH = path.join(gen.ANDROID_DIR, "packages.schema.json");
const PACKAGE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
// A domain-shaped brandId: has a dot, no whitespace / scheme / path characters.
// Permissive on TLD + internationalized (IDN) domains — the authoritative check
// below is that the brandId exists as an enabled brand in the blocklists.
const BRAND_ID_RE = /^[^\s/:?#@]+\.[^\s/:?#@]+$/;

function androidPackagesAudit() {
  const reporter = new Reporter("Android app packages — brand mapping, schema, determinism");

  // Source blocklists must load (brand index depends on them).
  const datasets = load.loadDatasets();
  const brokenSource = datasets.filter((d) => d.error);
  if (brokenSource.length) {
    brokenSource.forEach((d) => reporter.fail(`source blocklist unreadable: ${d.name} (${d.error})`));
    return reporter;
  }
  const index = gen.brandIndex();

  if (!fs.existsSync(SCHEMA_PATH)) {
    reporter.fail(`schema missing: ${path.relative(load.ROOT, SCHEMA_PATH)}`);
  }

  // Load + shape-check the app files.
  let files;
  try {
    files = gen.loadAppFiles();
  } catch (error) {
    reporter.fail(`app file unreadable/invalid JSON: ${error.message}`);
    return reporter;
  }

  const seenBrand = new Map();      // brandId -> file
  const seenPackage = new Map();    // packageId -> "brandId (file)"
  let brandCount = 0;
  let packageCount = 0;
  let needsReview = 0;

  for (const { file, data } of files) {
    if (!data || data._schema !== "fitshield-android-apps/1") {
      reporter.fail(`${file}: missing/incorrect _schema (expected "fitshield-android-apps/1")`);
    }
    if (!data || !gen.APP_CATEGORIES.includes(data.defaultCategory)) {
      reporter.fail(`${file}: defaultCategory must be one of ${gen.APP_CATEGORIES.join(", ")}`);
    }
    if (!data || !Array.isArray(data.apps)) {
      reporter.fail(`${file}: "apps" must be an array`);
      continue;
    }

    data.apps.forEach((app, i) => {
      const where = `${file}[${i}]`;
      brandCount += 1;

      if (typeof app.brandId !== "string" || !BRAND_ID_RE.test(app.brandId)) {
        reporter.fail(`${where}: invalid brandId ${JSON.stringify(app.brandId)} (expected a domain like "doordash.com")`);
        return;
      }
      const brandLabel = `${app.brandId} (${file})`;

      // Duplicate brandId across all files.
      if (seenBrand.has(app.brandId)) {
        reporter.fail(`duplicate brandId "${app.brandId}" in ${file} and ${seenBrand.get(app.brandId)}`);
      } else {
        seenBrand.set(app.brandId, file);
      }

      // Orphan / missing source brand.
      if (!index.has(app.brandId)) {
        reporter.fail(`${where}: orphaned brandId "${app.brandId}" — not an enabled brand in blocklists/*.json`);
      }

      // Category (override) must be known.
      if (app.category !== undefined && !gen.APP_CATEGORIES.includes(app.category)) {
        reporter.fail(`${where}: invalid category ${JSON.stringify(app.category)}`);
      }

      // packageStatus rules.
      const status = app.packageStatus === undefined ? "active" : app.packageStatus;
      if (!["active", "needs_review"].includes(status)) {
        reporter.fail(`${where}: invalid packageStatus ${JSON.stringify(app.packageStatus)}`);
      }
      if (!Array.isArray(app.packageIds)) {
        reporter.fail(`${where}: packageIds must be an array`);
        return;
      }
      if (status === "needs_review") {
        needsReview += 1;
        if (app.packageIds.length !== 0) {
          reporter.fail(`${where}: "needs_review" must have empty packageIds (found ${app.packageIds.length})`);
        }
      } else if (app.packageIds.length === 0) {
        reporter.fail(`${where}: empty packageIds require packageStatus "needs_review" (${app.brandId})`);
      }

      // Package ID shape + global uniqueness.
      app.packageIds.forEach((pkg) => {
        if (typeof pkg !== "string" || !PACKAGE_ID_RE.test(pkg)) {
          reporter.fail(`${where}: invalid Android package id ${JSON.stringify(pkg)}`);
          return;
        }
        packageCount += 1;
        if (seenPackage.has(pkg)) {
          reporter.fail(`duplicate packageId "${pkg}" for ${brandLabel} and ${seenPackage.get(pkg)}`);
        } else {
          seenPackage.set(pkg, brandLabel);
        }
      });
    });
  }

  // Deterministic + up-to-date generation (drift check).
  const fresh = gen.derive();
  if (!fs.existsSync(gen.OUTPUT_PATH)) {
    reporter.fail(`generated asset missing: ${path.relative(load.ROOT, gen.OUTPUT_PATH)} (run npm run generate:android-packages)`);
  } else {
    let committed;
    try {
      committed = JSON.parse(fs.readFileSync(gen.OUTPUT_PATH, "utf8"));
    } catch (error) {
      reporter.fail(`generated asset invalid JSON: ${error.message}`);
    }
    if (committed) {
      if (committed._generated !== true) {
        reporter.fail("generated asset is not marked _generated:true (looks hand-edited)");
      }
      if (committed.sha256 !== fresh.sha256 ||
          JSON.stringify(committed.packages) !== JSON.stringify(fresh.packages) ||
          JSON.stringify(committed.brands) !== JSON.stringify(fresh.brands)) {
        reporter.fail("generated android-packages.json is STALE/DRIFTED — run npm run generate:android-packages");
      }
    }
  }

  // Determinism: two derivations must be byte-identical.
  if (JSON.stringify(gen.derive()) !== JSON.stringify(fresh)) {
    reporter.fail("generation is non-deterministic (two runs differ)");
  }

  reporter.note(`${brandCount} app entries → ${packageCount} package(s), ${needsReview} needs_review`);
  reporter.note(`every packageId maps to exactly one of ${index.size} enabled brands (sha256 ${fresh.sha256.slice(0, 12)}…)`);
  return reporter;
}

if (require.main === module) {
  runCli(androidPackagesAudit);
}

module.exports = androidPackagesAudit;
