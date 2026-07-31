#!/usr/bin/env node
"use strict";
/**
 * Assemble the canonical alternatives catalog.
 *
 *   data/alternatives-taxonomy.json  (vocabularies + category mappings)
 * + data/alternatives/*.json         (authored entries, grouped by craving)
 * ----------------------------------------------------------------------
 * = data/recipes.json                (single generated file the runtime loads)
 *
 * The catalog is authored in parts because one 60-entry file is unreviewable in
 * a diff; it is SHIPPED as one file because the block page must be able to fetch
 * everything it needs in a single request, before a countdown that lasts twenty
 * seconds. The generated file keeps the historical name and its `recipes` array,
 * so the Android WebView and any older reader keep working.
 *
 *   node tools/build-alternatives.js           # write data/recipes.json
 *   node tools/build-alternatives.js --check   # exit 1 if it is stale
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const TAXONOMY_FILE = path.join(DATA_DIR, "alternatives-taxonomy.json");
const PARTS_DIR = path.join(DATA_DIR, "alternatives");
const OUTPUT_FILE = path.join(DATA_DIR, "recipes.json");

function partFiles() {
  if (!fs.existsSync(PARTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(PARTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(PARTS_DIR, name));
}

// Field order is fixed so the generated file has a stable, reviewable diff no
// matter what order the author wrote the keys in.
const FIELD_ORDER = [
  "id",
  "kind",
  "title",
  "description",
  "servings",
  "ingredients",
  "steps",
  "totalMinutes",
  "activeMinutes",
  "prepMinutes",
  "cookMinutes",
  "difficulty",
  "equipment",
  "method",
  "diet",
  "allergens",
  "substitutions",
  "storage",
  "categories",
  "cravings",
  "region",
  "noCook",
  "microwave",
  "airFryer",
  "onePan",
  "pantryFriendly",
  "calorieRange",
  "dataVersion"
];

const INGREDIENT_ORDER = ["quantity", "unit", "item", "note", "optional", "substituteGroup"];

function orderKeys(entry, order) {
  const out = {};

  order.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(entry, key)) {
      out[key] = entry[key];
    }
  });

  // Anything unexpected is kept at the end rather than silently dropped, so a
  // new field shows up in review instead of vanishing.
  Object.keys(entry)
    .filter((key) => !order.includes(key))
    .sort()
    .forEach((key) => {
      out[key] = entry[key];
    });

  return out;
}

function normalizeEntry(entry, kind) {
  const withKind = { ...entry, kind };

  if (Array.isArray(withKind.ingredients)) {
    withKind.ingredients = withKind.ingredients.map((ingredient) =>
      ingredient && typeof ingredient === "object" ? orderKeys(ingredient, INGREDIENT_ORDER) : ingredient
    );
  }

  return orderKeys(withKind, FIELD_ORDER);
}

function buildCatalog() {
  const taxonomySource = JSON.parse(fs.readFileSync(TAXONOMY_FILE, "utf8"));
  const recipes = [];
  const quickAlternatives = [];

  for (const file of partFiles()) {
    const part = JSON.parse(fs.readFileSync(file, "utf8"));
    (part.recipes || []).forEach((entry) => recipes.push(normalizeEntry(entry, "recipe")));
    (part.quickAlternatives || []).forEach((entry) => quickAlternatives.push(normalizeEntry(entry, "quick")));
  }

  return {
    _generated: "Built by tools/build-alternatives.js — edit data/alternatives-taxonomy.json and data/alternatives/*.json, then run `npm run generate:alternatives`.",
    _license: taxonomySource._license,
    _version: taxonomySource._version,
    _schema: taxonomySource._schema,
    _counts: {
      recipes: recipes.length,
      quickAlternatives: quickAlternatives.length,
      total: recipes.length + quickAlternatives.length
    },
    taxonomy: taxonomySource.taxonomy,
    recipes,
    quickAlternatives
  };
}

function serialize(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function isStale() {
  if (!fs.existsSync(OUTPUT_FILE)) {
    return true;
  }

  const current = fs.readFileSync(OUTPUT_FILE, "utf8").replace(/\r\n/g, "\n");
  return current !== serialize(buildCatalog());
}

function write() {
  const catalog = buildCatalog();
  fs.writeFileSync(OUTPUT_FILE, serialize(catalog));
  return catalog._counts;
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (isStale()) {
      console.error(
        "data/recipes.json is out of date with data/alternatives-taxonomy.json + data/alternatives/.\n" +
          "Run `npm run generate:alternatives`."
      );
      process.exit(1);
    }
    console.log("data/recipes.json is up to date.");
    process.exit(0);
  }

  const counts = write();
  console.log(
    `Wrote data/recipes.json — ${counts.recipes} recipes + ${counts.quickAlternatives} quick alternatives ` +
      `(${counts.total} total) from ${partFiles().length} part file(s).`
  );
}

module.exports = { buildCatalog, serialize, isStale, write, partFiles, OUTPUT_FILE, TAXONOMY_FILE, PARTS_DIR };
