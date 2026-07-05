#!/usr/bin/env node
"use strict";
/**
 * Compile the Android app-package dataset from the hand-authored app files
 * (data/android/*-apps.json) enriched with brand metadata from the
 * CANONICAL blocklists (data/blocklists/*.json), into
 * data/generated/android-packages.json.
 *
 * The app files are intentionally minimal: they map a brand (by its canonical
 * source domain, `brandId`) to Android package IDs. ALL display metadata —
 * display name, domains, countries, tags — is pulled from the one source of
 * truth (the blocklists) here, so it is never duplicated or allowed to drift.
 *
 * Output is DETERMINISTIC (sorted, no timestamps) so the committed asset only
 * changes when the inputs change; tools/validate-android-packages.js fails the
 * build if the committed file drifts from a fresh generation.
 *
 *   node tools/generate-android-packages.js     # writes the generated asset
 *   require(...).derive()                        # returns the canonical object
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const load = require("./lib/load");

const ANDROID_DIR = path.join(load.DATA_DIR, "android");
const GENERATED_DIR = path.join(load.DATA_DIR, "generated");
const OUTPUT_PATH = path.join(GENERATED_DIR, "android-packages.json");

// Each app file + the app-grouping category it defaults its entries to.
const APP_FILES = ["delivery-apps.json", "fast-food-apps.json"];
// App-grouping categories (drive the Settings toggles). Distinct from the
// brand's source `type`/`category`; a delivery marketplace app can wrap a brand
// the blocklist types as `fast_food`.
const APP_CATEGORIES = ["delivery", "fast_food", "restaurant", "grocery", "convenience", "coffee", "dessert", "meal_kit"];

// Map a brand's source `category` (from the blocklists) to a finer app-grouping
// category, so the Settings toggles can target coffee / dessert / grocery / etc.
// Only clear matches are remapped; everything else keeps the file default
// (delivery / fast_food). Derived from authoritative source metadata — not guessed.
const SRC_CATEGORY_TO_APP = {
  coffee: "coffee", cafe: "coffee",
  bakery: "dessert", dessert: "dessert", ice_cream: "dessert", donut: "dessert",
  frozen_yogurt: "dessert", frozen_dessert: "dessert", bubble_tea: "dessert", boba: "dessert",
  grocery: "grocery", supermarket: "grocery",
  convenience: "convenience",
  meal_kit: "meal_kit", mealkit: "meal_kit"
};

function deriveCategory(entry, fileDefault, override) {
  if (override) return override;
  if (!entry) return fileDefault;
  // Only remap on the brand's PRIMARY source category (authoritative + specific).
  // Deliberately NOT inferred from `specialties`: a delivery marketplace that
  // *also* does "grocery delivery" is still a delivery app, not a grocery app.
  const cat = String(entry.category || "").trim().toLowerCase();
  return SRC_CATEGORY_TO_APP[cat] || fileDefault;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// domain -> source brand entry, from the canonical blocklists (enabled only).
function brandIndex() {
  const map = new Map();
  for (const ds of load.loadDatasets()) {
    if (ds.error || !ds.data || !Array.isArray(ds.data.entries)) continue;
    for (const entry of ds.data.entries) {
      if (entry && entry.domain && entry.enabled !== false) {
        map.set(entry.domain, entry);
      }
    }
  }
  return map;
}

function readAppFile(file) {
  return { file, data: load.readJson(path.join(ANDROID_DIR, file)) };
}

function loadAppFiles() {
  return APP_FILES.map(readAppFile);
}

// Deterministic tag set from the brand's source metadata + app grouping.
function deriveTags(entry, category) {
  const tags = new Set([category]);
  if (entry.type) tags.add(entry.type);
  if (entry.category) tags.add(entry.category);
  (entry.specialties || []).forEach((s) => {
    const tag = String(s || "").trim().toLowerCase().replace(/\s+/g, "_");
    if (tag) tags.add(tag);
  });
  return [...tags].filter(Boolean).sort();
}

function domainsFor(entry) {
  return [...new Set([entry.domain, ...(entry.aliases || [])])].filter(Boolean).sort();
}

// Resolve every app entry against the brand index. Returns enriched brand
// records (with internal `_source`/`_sourceFile` for the validator) — used by
// both the generator and the validator so they never diverge.
function resolve() {
  const index = brandIndex();
  const brands = [];
  for (const { file, data } of loadAppFiles()) {
    const defaultCategory = data && data.defaultCategory;
    for (const app of (data && Array.isArray(data.apps) ? data.apps : [])) {
      const source = index.get(app.brandId) || null;
      const category = deriveCategory(source, defaultCategory, app.category);
      brands.push({
        brandId: app.brandId,
        packageIds: [...(app.packageIds || [])].sort(),
        packageStatus: app.packageStatus || "active",
        category,
        _sourceFile: file,
        _source: source,
        displayName: source ? source.name : null,
        domains: source ? domainsFor(source) : [],
        countryCodes: source ? [...(source.countries || [])] : [],
        tags: source ? deriveTags(source, category) : []
      });
    }
  }
  return brands;
}

// The canonical generated object (deterministic; no internal fields).
function derive() {
  const brands = resolve().sort((a, b) => a.brandId.localeCompare(b.brandId));

  const brandList = brands.map((b) => ({
    brandId: b.brandId,
    displayName: b.displayName,
    category: b.category,
    packageStatus: b.packageStatus,
    packageIds: b.packageIds,
    domains: b.domains,
    countryCodes: b.countryCodes,
    tags: b.tags
  }));

  // packageId -> brand meta, for O(1) lookup in the AccessibilityService.
  const packages = {};
  for (const b of brandList) {
    for (const pkg of b.packageIds) {
      packages[pkg] = { brandId: b.brandId, displayName: b.displayName, category: b.category };
    }
  }
  const orderedPackages = {};
  Object.keys(packages).sort().forEach((k) => { orderedPackages[k] = packages[k]; });

  return {
    _generated: true,
    _doNotEdit:
      "GENERATED from data/android/*-apps.json + data/blocklists/*.json by tools/generate-android-packages.js. " +
      "Run `npm run generate:android-packages` to regenerate. Do NOT hand-edit — the validator fails the build on drift.",
    schema: 1,
    generator: "tools/generate-android-packages.js",
    source: ["data/android/delivery-apps.json", "data/android/fast-food-apps.json", "data/blocklists/*.json"],
    categories: APP_CATEGORIES,
    counts: {
      brands: brandList.length,
      packages: Object.keys(orderedPackages).length,
      needsReview: brandList.filter((b) => b.packageStatus === "needs_review").length,
      noApp: brandList.filter((b) => b.packageStatus === "no_app").length,
      sharedApp: brandList.filter((b) => b.packageStatus === "shared_app").length
    },
    // Hash over the meaningful payload only (order-independent of formatting).
    sha256: sha256(JSON.stringify({ packages: orderedPackages, brands: brandList })),
    packages: orderedPackages,
    brands: brandList
  };
}

function generate() {
  const asset = derive();
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(asset, null, 2) + "\n");
  return asset;
}

// The SLIM subset bundled into the APK. The AccessibilityService only needs the
// packageId → brand map, so the ~2.5k-brand ported record (with domains,
// countries, tags) stays in data/generated and is NOT shipped — only the
// small package map is. Keeps the APK lean while the full port is preserved in-repo.
function bundle() {
  const full = derive();
  return {
    _generated: true,
    _doNotEdit:
      "GENERATED (bundled subset) by tools/generate-android-packages.js. Only the packageId → brand map is shipped; " +
      "the full ported record lives in data/generated/android-packages.json. Do NOT hand-edit.",
    schema: full.schema,
    generator: full.generator,
    counts: full.counts,
    packages: full.packages
  };
}

if (require.main === module) {
  const asset = generate();
  console.log(
    `Generated ${path.relative(load.ROOT, OUTPUT_PATH).split(path.sep).join("/")}: ` +
    `${asset.counts.brands} brands, ${asset.counts.packages} packages, ` +
    `${asset.counts.needsReview} needs_review, ${asset.counts.noApp} no_app, ` +
    `${asset.counts.sharedApp} shared_app (sha256 ${asset.sha256.slice(0, 12)}…)`
  );
}

module.exports = {
  derive, generate, bundle, resolve, brandIndex, loadAppFiles, deriveTags, domainsFor,
  OUTPUT_PATH, ANDROID_DIR, GENERATED_DIR, APP_FILES, APP_CATEGORIES
};
