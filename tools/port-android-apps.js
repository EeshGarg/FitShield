#!/usr/bin/env node
"use strict";
/**
 * Port EVERY eligible brand from the canonical blocklists into the Android app
 * datasets (data/android/*-apps.json). This is ADDITIVE: the blocklists
 * stay the authoritative source of truth and are never modified — this only
 * mirrors their brand list into the Android structure, adding Android package
 * fields on top.
 *
 *   data/blocklists/delivery.json   → data/android/delivery-apps.json   (defaultCategory delivery)
 *   data/blocklists/fast-food.json  → data/android/fast-food-apps.json  (defaultCategory fast_food)
 *
 * Rules:
 *   - one Android app entry per enabled brand (keyed by its canonical domain =
 *     brandId); no brand is skipped just because its package ID is unknown.
 *   - CONFIRMED package IDs are PRESERVED across runs (read from the existing app
 *     files) so re-running never loses a human-entered mapping and never guesses.
 *   - a recorded packageStatus on an empty-package brand ("no_app",
 *     "shared_app", "needs_review") is PRESERVED: those are human verdicts, and
 *     resetting them to needs_review would silently discard the review work.
 *   - brands with neither a confirmed package ID nor a recorded status become
 *     packageStatus:"needs_review" with empty packageIds.
 *   - a brand listed in both blocklists is ported once (delivery wins) to keep
 *     brandId globally unique.
 *   - output is deterministic (sorted by brandId), so re-running is a clean diff.
 *
 * Safe to re-run whenever the blocklists gain/lose brands (a "sync").
 */

const fs = require("fs");
const path = require("path");
const load = require("./lib/load");

// Statuses that legitimately carry empty packageIds (see validate-android-packages.js).
const EMPTY_STATUSES = new Set(["needs_review", "no_app", "shared_app"]);

const ANDROID_DIR = path.join(load.DATA_DIR, "android");
const FILES = [
  { blocklist: "delivery.json", app: "delivery-apps.json", category: "delivery" },
  { blocklist: "fast-food.json", app: "fast-food-apps.json", category: "fast_food" }
];

// Preserve confirmed brandId → packageIds from the current app files (+ any
// explicit category override) so a re-run never loses human-entered data.
function existingByBrand() {
  const map = new Map();
  for (const { app } of FILES) {
    const p = path.join(ANDROID_DIR, app);
    if (!fs.existsSync(p)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    (data.apps || []).forEach((a) => {
      if (a && a.brandId) {
        map.set(a.brandId, {
          packageIds: Array.isArray(a.packageIds) ? a.packageIds.slice() : [],
          packageStatus: a.packageStatus,
          category: a.category
        });
      }
    });
  }
  return map;
}

function port() {
  const existing = existingByBrand();
  const globallySeen = new Set();       // dedupe brandId across both files
  const summary = [];

  for (const { blocklist, app, category } of FILES) {
    const data = JSON.parse(fs.readFileSync(path.join(load.BLOCKLISTS_DIR, blocklist), "utf8"));
    const apps = [];

    (data.entries || []).forEach((entry) => {
      const brandId = entry && entry.domain;
      if (!brandId || entry.enabled === false) return;   // eligible = enabled brands
      if (globallySeen.has(brandId)) return;             // ported already (from the other file)
      globallySeen.add(brandId);

      const prev = existing.get(brandId);
      const packageIds = prev && prev.packageIds.length ? prev.packageIds.slice().sort() : [];
      const app_ = { brandId, packageIds };
      if (packageIds.length === 0) {
        app_.packageStatus = (prev && EMPTY_STATUSES.has(prev.packageStatus)) ? prev.packageStatus : "needs_review";
      }
      if (prev && prev.category) app_.category = prev.category;
      apps.push(app_);
    });

    apps.sort((a, b) => a.brandId.localeCompare(b.brandId));

    const withPkg = apps.filter((a) => a.packageIds.length).length;
    const body = JSON.stringify({
      _schema: "fitshield-android-apps/1",
      _note: `PORTED from data/blocklists/${blocklist} by tools/port-android-apps.js (additive; the blocklist stays authoritative). One entry per brand; brandId is the brand's canonical domain and all display metadata is generated from the blocklists. Confirmed packageIds and recorded packageStatus verdicts are preserved on re-run; unknown ones stay needs_review — never guess a package ID.`,
      defaultCategory: category,
      apps
    }, null, 2) + "\n";

    fs.writeFileSync(path.join(ANDROID_DIR, app), body);
    const needsReview = apps.filter((a) => a.packageStatus === "needs_review").length;
    summary.push(`${app}: ${apps.length} brands ported (${withPkg} with confirmed packages, ${needsReview} needs_review)`);
  }

  summary.forEach((s) => console.log(s));
}

if (require.main === module) {
  port();
}

module.exports = { port };
