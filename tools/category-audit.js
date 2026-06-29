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

  // Orphaned catLabel keys: a display name with no category using it.
  [...enKeys].filter((k) => k.startsWith("catLabel")).forEach((k) => {
    if (!expectedKeys.has(k)) {
      reporter.warn(`orphaned display name "${k}" (no category uses it)`);
    }
  });

  reporter.note(`${categories.size} distinct categories`);
  reporter.note(`localized (catLabel): ${localized.length} — ${localized.join(", ")}`);
  reporter.note(`prettifier fallback: ${prettifiedOnly.length} — ${prettifiedOnly.join(", ") || "(none)"}`);
  return reporter;
}

if (require.main === module) {
  runCli(categoryAudit);
}

module.exports = categoryAudit;
