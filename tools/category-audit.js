#!/usr/bin/env node
"use strict";
/**
 * Category audit. Validates category identifiers and their localized display
 * names (the `catLabel*` messages used by the "most blocked categories" stat).
 *
 * Errors: malformed category id (not lowercase snake_case), orphaned catLabel
 * key (a display name with no matching category in the data). Notes: which
 * categories have a localized name vs. fall back to the render prettifier.
 */

const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");

const ID = /^[a-z][a-z0-9_]*$/;

// Mirror of settings.js categoryDisplayName(): id -> "catLabel<PascalCase>".
function catKey(id) {
  const pascal = String(id || "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return pascal ? `catLabel${pascal}` : "";
}

function categoryAudit() {
  const reporter = new Reporter("Datasets — categories & display names");
  const datasets = load.loadDatasets().filter((d) => !d.error && Array.isArray(d.data.entries));

  const categories = new Map(); // id -> count
  datasets.forEach((ds) =>
    ds.data.entries.forEach((e) => {
      const id = typeof e.category === "string" ? e.category.trim() : "";
      if (id) {
        categories.set(id, (categories.get(id) || 0) + 1);
      }
    })
  );

  for (const id of categories.keys()) {
    if (!ID.test(id)) {
      reporter.fail(`category id "${id}" is not lowercase snake_case`);
    }
  }

  // Localized-name coverage against the English base locale.
  const en = load.loadLocale("en");
  const enKeys = en.error ? new Set() : new Set(Object.keys(en.data));
  const expectedKeys = new Set();
  const localized = [];
  const prettifiedOnly = [];

  [...categories.keys()].sort().forEach((id) => {
    const key = catKey(id);
    expectedKeys.add(key);
    if (enKeys.has(key)) {
      localized.push(id);
    } else {
      prettifiedOnly.push(id);
    }
  });

  // Orphaned catLabel keys: a display name that NO category uses and no user
  // can be holding.
  //
  // "No current category uses it" is not the same question. `blockedByCategory`
  // is a lifetime, never-decaying map in each user's own profile, and Settings
  // renders "Most blocked categories" straight from it. When the curated
  // vocabulary was consolidated from 37 ids to 22, every id below stopped being
  // written but stayed in the stats of everyone who had already been blocked on
  // one — so those display names are still reachable on a real install.
  //
  // Deleting them would not print the raw id (categoryName falls through to a
  // prettifier), which is what makes this easy to get wrong: it would silently
  // downgrade a localized name to prettified ENGLISH, and only for users with
  // history, in the one panel that is about their own past. So they stay, and
  // this list is the record of why rather than 15 warnings nobody can action.
  const RETIRED_CATEGORIES = [
    "fast_food", "meal_service", "restaurant_group", "restaurant_software",
    "pickup_ordering", "venue_ordering", "quick_commerce", "super_app",
    "logistics", "local_services", "marketplace", "ecommerce_marketplace",
    "b2b_marketplace", "food_content", "recipe",
    // Retired when the courier and errand platforms were removed: you do not
    // order food from a courier, restaurants hire one. Anyone blocked on one
    // before that still carries the id in their lifetime stats.
    "courier"
  ];
  const retiredKeys = new Set(RETIRED_CATEGORIES.map((id) => catKey(id)));
  const stillNamed = RETIRED_CATEGORIES.filter((id) => enKeys.has(catKey(id)));

  [...enKeys].filter((k) => k.startsWith("catLabel")).forEach((k) => {
    if (expectedKeys.has(k) || retiredKeys.has(k)) {
      return;
    }

    reporter.warn(`orphaned display name "${k}" (no category uses it, and it names no retired category)`);
  });

  // A retired id that has LOST its name is the real defect this guards, and it
  // is an error rather than a warning: it is a silent, history-only regression
  // that no amount of testing a fresh profile would ever surface.
  RETIRED_CATEGORIES.filter((id) => !enKeys.has(catKey(id))).forEach((id) => {
    reporter.fail(
      `retired category "${id}" has no display name — existing profiles still carry it in blockedByCategory ` +
        `and would fall back to prettified English`
    );
  });

  reporter.note(
    `${stillNamed.length} retired categor(ies) keep a display name for lifetime stats written before the 37 to 22 consolidation`
  );

  reporter.note(`${categories.size} distinct categories`);
  reporter.note(`localized (catLabel): ${localized.length} — ${localized.join(", ")}`);
  reporter.note(`prettifier fallback: ${prettifiedOnly.length} — ${prettifiedOnly.join(", ") || "(none)"}`);
  return reporter;
}

if (require.main === module) {
  runCli(categoryAudit);
}

module.exports = categoryAudit;
