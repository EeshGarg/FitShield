"use strict";
/**
 * Android's block screen must answer with the shared heuristic, not a fallback.
 *
 * `block.js` called `FitShieldRecipes.selectRecipes`, which had been deleted
 * from the shared module. The call sat behind `if (R && R.selectRecipes)`, so
 * nothing threw and nothing was logged — it simply fell through to
 * `recipes[brandId.length % recipes.length]`. The suggestion was chosen by the
 * CHARACTER COUNT of the brand id: Domino's was answered with a chicken
 * sandwich, Baskin-Robbins with a breakfast burrito, and McDonald's and
 * Starbucks with the identical dish because both ids are nine characters long.
 * The comment above it claimed "the SAME shared module + heuristic as the
 * extension block page".
 *
 * Two things are guarded here: the behaviour, and the shape of mistake that
 * hid it for so long.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const recipes = require("../extension/recipes.js");

const BLOCK_JS = path.join(ROOT, "android", "app", "src", "main", "assets", "web", "block.js");
const SHIM_JS = path.join(ROOT, "android", "web-src", "android-shim.js");

const catalogDoc = () => JSON.parse(fs.readFileSync(path.join(ROOT, "data", "recipes.json"), "utf8"));

function brands() {
  const out = [];

  ["delivery", "fast-food"].forEach((bucket) => {
    JSON.parse(fs.readFileSync(path.join(ROOT, "data", "blocklists", `${bucket}.json`), "utf8")).entries.forEach(
      (entry) => out.push(entry)
    );
  });

  return out;
}

// The same two-idea walk block.js performs.
function androidPicks(brand) {
  const picks = [];
  const seen = new Set();

  for (let rotation = 0; rotation < 6 && picks.length < 2; rotation++) {
    const selection = recipes.selectAlternative(
      { key: brand.domain, category: brand.category, type: brand.type, specialties: brand.specialties },
      {},
      { rotation, seed: brand.domain }
    );

    if (!selection || !selection.entry || seen.has(selection.entry.id)) {
      continue;
    }

    seen.add(selection.entry.id);
    picks.push(selection.entry);
  }

  return picks;
}

// ---------------------------------------------------------------------------
// The root cause: a truthy guard around a symbol that no longer exists
// ---------------------------------------------------------------------------

test("Android's block screen calls nothing the shared module does not export", () => {
  // Comments are stripped first. The comment above the fixed call explains the
  // old one BY NAME, so scanning raw source made this guard fail on its own
  // documentation — the same trap that kept `mbOn` alive through three locale
  // prunes, where the sentence announcing a key's death was read as evidence
  // that the key was still in use.
  //
  // The line comment pattern carries no end anchor on purpose: these files use
  // CRLF endings and "." stops at the carriage return, so an anchored match
  // never fires and every comment survives the strip.
  const stripComments = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\r\n]*/g, "");

  const source = stripComments(fs.readFileSync(BLOCK_JS, "utf8"));
  const exported = new Set(Object.keys(recipes));

  // Every `R.foo` / `FitShieldRecipes.foo` the page reaches for.
  const called = new Set(
    [...source.matchAll(/(?:\bR|FitShieldRecipes)\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  );

  const missing = [...called].filter((name) => !exported.has(name));

  assert.deepEqual(
    missing,
    [],
    `block.js reaches for ${missing.join(", ")} — not exported by extension/recipes.js, so the call silently ` +
      "falls through to whatever comes after it"
  );
});

test("the shim hands over the whole catalog, not just the recipe array", () => {
  const shim = fs.readFileSync(SHIM_JS, "utf8");

  // `.then((d) => d.recipes || [])` dropped 42 of the 88 entries AND the
  // taxonomy, which is the category-to-craving mapping the selector runs on.
  assert.ok(
    !/\.then\(\s*\(\s*d\s*\)\s*=>\s*d\.recipes\s*\|\|\s*\[\]\s*\)/.test(shim),
    "the shim is back to keeping only d.recipes — quickAlternatives and the taxonomy would be lost"
  );

  const doc = catalogDoc();
  const indexed = recipes.primeCatalog(doc);
  assert.equal(
    indexed.entries.length,
    (doc.recipes || []).length + (doc.quickAlternatives || []).length,
    "priming the catalog must keep both recipes and quickAlternatives"
  );
  assert.ok(indexed.taxonomy.categoryCravings, "the taxonomy must survive priming");
});

// ---------------------------------------------------------------------------
// The behaviour
// ---------------------------------------------------------------------------

test("a brand's suggestion matches what was blocked, not its id length", () => {
  recipes.primeCatalog(catalogDoc());
  const byDomain = new Map(brands().map((b) => [b.domain, b]));

  [
    ["dominos.com", /pizza/i],
    ["pizzahut.com", /pizza/i],
    ["kfc.com", /chicken|buffalo/i],
    ["chatime.com", /lassi|matcha|tea|smoothie|frappe/i]
  ].forEach(([domain, expected]) => {
    const brand = byDomain.get(domain);
    assert.ok(brand, `${domain} is no longer in the catalog`);

    const picks = androidPicks(brand);
    assert.ok(picks.length > 0, `${domain} produced no suggestion at all`);
    assert.ok(
      picks.some((entry) => expected.test(entry.id) || expected.test(entry.name || "")),
      `${domain} (${brand.category}) was answered with ${picks.map((p) => p.id).join(", ")}`
    );
  });
});

test("two brands whose ids are the same length get different answers", () => {
  recipes.primeCatalog(catalogDoc());
  const byDomain = new Map(brands().map((b) => [b.domain, b]));

  // The exact collision: "mcdonalds" and "starbucks" are both nine characters,
  // so the old fallback handed them the identical entry.
  const mcdonalds = byDomain.get("mcdonalds.com");
  const starbucks = byDomain.get("starbucks.com");

  assert.ok(mcdonalds && starbucks, "both brands must be listed for this guard to mean anything");
  assert.equal(
    "mcdonalds".length,
    "starbucks".length,
    "this test is only meaningful while the two ids are the same length"
  );

  const first = androidPicks(mcdonalds).map((e) => e.id);
  const second = androidPicks(starbucks).map((e) => e.id);

  assert.ok(first.length && second.length, "both brands must produce a suggestion");
  assert.notDeepEqual(first, second, `a burger chain and a coffee chain were both answered with ${first.join(", ")}`);
});

test("every listed brand gets at least one suggestion", () => {
  recipes.primeCatalog(catalogDoc());
  const empty = brands()
    .filter((brand) => androidPicks(brand).length === 0)
    .map((brand) => `${brand.domain} (${brand.category})`);

  assert.deepEqual(empty, [], `these brands would show an empty block screen: ${empty.slice(0, 10).join(", ")}`);
});
