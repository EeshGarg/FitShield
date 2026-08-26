"use strict";
/**
 * Android's block screen must answer with the shared heuristic, driven by the
 * shape a real device produces.
 *
 * Two rounds of this, and the second is the one worth remembering.
 *
 * ROUND ONE. `block.js` called `FitShieldRecipes.selectRecipes`, which had been
 * deleted from the shared module. The call sat behind `if (R && R.selectRecipes)`,
 * so nothing threw and nothing was logged — it simply fell through to
 * `recipes[brandId.length % recipes.length]`. The suggestion was chosen by the
 * CHARACTER COUNT of the brand id: Domino's was answered with a chicken
 * sandwich, Baskin-Robbins with a breakfast burrito, and McDonald's and
 * Starbucks with the identical dish because both ids are nine characters long.
 *
 * ROUND TWO. Restoring the call was necessary and not sufficient, and the tests
 * written for round one are the reason nobody noticed. They fed
 * `selectAlternative` a blocklist entry — `{ category: "burger", type:
 * "fast_food", specialties: [...] }` — and every assertion passed. The bridge
 * never produced that shape. `AndroidBlock.getInfo()` returned no `type` and no
 * `specialties` at all, and its `category` was the APP-GROUPING category, which
 * is deliberately coarse — roughly two thirds of the catalog is `fast_food`.
 * Measured against the real bridge payload:
 *
 *   mcdonalds.com  test shape: burger   -> air-fryer-shoestring-fries, …
 *                  DEVICE:     fast_food -> microwave-nachos, microwave-mug-pizza
 *   chatime.com    test shape: tea      -> mango-lassi, iced-matcha-milk
 *                  DEVICE:     fast_food -> microwave-nachos, microwave-mug-pizza
 *
 * 963 of 1,511 packages received the identical two answers. On a phone, a
 * bubble-tea shop was answered with microwave nachos, under a green suite and a
 * commit message claiming it got a lassi.
 *
 * So every behavioural test below is driven from `data/generated/android-packages.json`
 * — the artefact the APK ships and the bridge reads — through the same walk
 * block.js performs. A test that constructs its own input cannot see a bridge
 * that stopped sending one.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const recipes = require("../extension/recipes.js");
const gen = require("../tools/generate-android-packages.js");

const BLOCK_JS = path.join(ROOT, "android", "app", "src", "main", "assets", "web", "block.js");
const SHIM_JS = path.join(ROOT, "android", "web-src", "android-shim.js");
const BLOCK_ACTIVITY = path.join(
  ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield", "BlockActivity.kt"
);

const catalogDoc = () => JSON.parse(fs.readFileSync(path.join(ROOT, "data", "recipes.json"), "utf8"));

// Comments are stripped before any source is scanned. The comment above the
// fixed call explains the old one BY NAME, so scanning raw source made an
// earlier guard fail on its own documentation — the same trap that kept `mbOn`
// alive through three locale prunes, where the sentence announcing a key's
// death was read as evidence that the key was still in use.
//
// The line-comment pattern carries no end anchor on purpose: these files use
// CRLF endings and "." stops at the carriage return, so an anchored match never
// fires and every comment survives the strip.
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\r\n]*/g, "");

// ---------------------------------------------------------------------------
// The device's shape
// ---------------------------------------------------------------------------

/**
 * Exactly what `AndroidBlock.getInfo()` hands block.js for a given package.
 *
 * BlockActivity fills its fields from PackageBlocklist.Brand, which is parsed
 * straight out of the bundled `android-packages.json` — so building the payload
 * from that file is building what the phone receives, not an idea of it.
 */
function bridgePayload(packageId, packages) {
  const meta = packages[packageId];
  assert.ok(meta, `${packageId} is not in the shipped Android app catalog`);

  return {
    brandId: meta.brandId,
    displayName: meta.displayName,
    category: meta.category,
    foodCategory: meta.foodCategory,
    foodType: meta.foodType,
    specialties: meta.specialties,
    packageId,
    unlockMinutes: 5,
    timerSeconds: 60
  };
}

/** The two-idea walk block.js performs, on a bridge payload. */
function androidPicks(meta) {
  const picks = [];
  const seen = new Set();

  for (let rotation = 0; rotation < 6 && picks.length < 2; rotation++) {
    const selection = recipes.selectAlternative(
      {
        key: meta.brandId,
        category: meta.foodCategory || meta.category,
        type: meta.foodType,
        specialties: meta.specialties
      },
      {},
      { rotation, seed: meta.brandId }
    );

    if (!selection || !selection.entry || seen.has(selection.entry.id)) {
      continue;
    }

    seen.add(selection.entry.id);
    picks.push(selection.entry);
  }

  return picks;
}

const shippedPackages = () => gen.derive().packages;

/** One representative package per brand, so each brand is exercised once. */
function packagePerBrand(packages) {
  const byBrand = new Map();

  Object.keys(packages)
    .sort()
    .forEach((pkg) => {
      if (!byBrand.has(packages[pkg].brandId)) {
        byBrand.set(packages[pkg].brandId, pkg);
      }
    });

  return byBrand;
}

// ---------------------------------------------------------------------------
// The bridge contract — the thing no JavaScript test could previously see
// ---------------------------------------------------------------------------

test("every meta.* the block screen reads is a key the Kotlin bridge sends", () => {
  // The defect in one line: block.js read `meta.type` and `meta.specialties`,
  // getInfo() sent neither, and both sides are perfectly valid on their own.
  // Nothing but this comparison can see across the WebView boundary.
  const js = stripComments(fs.readFileSync(BLOCK_JS, "utf8"));
  const kt = stripComments(fs.readFileSync(BLOCK_ACTIVITY, "utf8"));

  // The block of `.put("key", …)` calls that builds getInfo()'s JSON.
  const getInfo = /fun getInfo\(\)[\s\S]*?\.toString\(\)/.exec(kt);
  assert.ok(getInfo, "BlockActivity.getInfo() no longer looks like a JSONObject builder — this guard cannot read it");

  const sent = new Set([...getInfo[0].matchAll(/\.put\(\s*"([^"]+)"/g)].map((m) => m[1]));
  assert.ok(sent.size > 0, "getInfo() puts no keys at all");

  // Everything read off the object `info()` returns. block.js names it `meta`.
  const read = new Set([...js.matchAll(/\bmeta\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  assert.ok(read.size > 0, "block.js reads nothing off the bridge — the scan is broken, not the page");

  const missing = [...read].filter((key) => !sent.has(key)).sort();

  assert.deepEqual(
    missing,
    [],
    `block.js reads meta.${missing.join(", meta.")} — getInfo() never puts ${missing.length === 1 ? "it" : "them"}, ` +
      "so on a real device the value is undefined and whatever consumes it silently degrades"
  );
});

test("the bridge sends the curated food metadata, not only the app grouping", () => {
  const kt = stripComments(fs.readFileSync(BLOCK_ACTIVITY, "utf8"));
  const getInfo = /fun getInfo\(\)[\s\S]*?\.toString\(\)/.exec(kt)[0];

  ["foodCategory", "foodType", "specialties"].forEach((key) => {
    assert.match(
      getInfo,
      new RegExp(`\\.put\\(\\s*"${key}"`),
      `getInfo() stopped sending ${key} — the block screen falls back to the app grouping, and roughly ` +
        "two thirds of the shipped packages share one grouping value"
    );
  });
});

test("Android's block screen calls nothing the shared module does not export", () => {
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
// The behaviour, driven by what the bridge actually sends
// ---------------------------------------------------------------------------

test("a blocked app's suggestion matches what was blocked, on the device's payload", () => {
  recipes.primeCatalog(catalogDoc());
  const packages = shippedPackages();
  const byBrand = packagePerBrand(packages);

  // Brands chosen because they are the ones the app grouping flattens: every one
  // of these is `fast_food` to the Settings pills, and each wants a different
  // answer. Under the old bridge all six got microwave nachos and a mug pizza.
  [
    ["dominos.com", /pizza/i],
    ["kfc.com", /chicken|buffalo/i],
    ["subway.com", /sandwich|sub|wrap/i],
    ["chipotle.com", /bean|taco|burrito|rice|salsa|quesadilla/i],
    ["chatime.com", /lassi|matcha|tea|smoothie|frappe/i],
    ["mcdonalds.com", /fries|burger|nugget|wrap|chicken|breakfast|egg|hash/i]
  ].forEach(([brandId, expected]) => {
    const pkg = byBrand.get(brandId);
    assert.ok(pkg, `${brandId} no longer has an Android package in the shipped catalog`);

    const meta = bridgePayload(pkg, packages);
    const picks = androidPicks(meta);

    assert.ok(picks.length > 0, `${brandId} produced no suggestion at all`);
    assert.ok(
      picks.some((entry) => expected.test(entry.id) || expected.test(entry.name || "")),
      `${brandId} — grouping "${meta.category}", curated "${meta.foodCategory}" — was answered with ` +
        `${picks.map((p) => p.id).join(", ")}`
    );
  });
});

test("two brands whose ids are the same length get different answers", () => {
  recipes.primeCatalog(catalogDoc());
  const packages = shippedPackages();
  const byBrand = packagePerBrand(packages);

  // The exact collision from round one: "mcdonalds" and "starbucks" are both
  // nine characters, so the old fallback handed them the identical entry.
  const mcdonalds = byBrand.get("mcdonalds.com");
  const starbucks = byBrand.get("starbucks.com");

  assert.ok(mcdonalds && starbucks, "both brands must ship an Android package for this guard to mean anything");
  assert.equal("mcdonalds".length, "starbucks".length, "only meaningful while the two ids are the same length");

  const first = androidPicks(bridgePayload(mcdonalds, packages)).map((e) => e.id);
  const second = androidPicks(bridgePayload(starbucks, packages)).map((e) => e.id);

  assert.ok(first.length && second.length, "both brands must produce a suggestion");
  assert.notDeepEqual(first, second, `a burger chain and a coffee chain were both answered with ${first.join(", ")}`);
});

test("the app grouping does not flatten the whole catalog onto one answer", () => {
  // The measurable form of the defect. With only the grouping to go on, 980 of
  // 1,510 packages resolved to the same pair of entries and the whole catalog
  // collapsed to 129 distinct answers. This asserts a floor far below what the
  // fix achieves, so it fails on the regression and not on a data edit.
  recipes.primeCatalog(catalogDoc());
  const packages = shippedPackages();
  const total = Object.keys(packages).length;

  const answers = new Map();

  for (const pkg of Object.keys(packages)) {
    const key = androidPicks(bridgePayload(pkg, packages))
      .map((e) => e.id)
      .sort()
      .join("|");
    answers.set(key, (answers.get(key) || 0) + 1);
  }

  const biggest = [...answers.entries()].sort((a, b) => b[1] - a[1])[0];

  // Measured on the shipped catalog, both ways:
  //   grouping only (the defect) — 88 distinct, biggest cluster 963 of 1,511 (63.7%)
  //   curated (the fix)          — 167 distinct, biggest cluster 369 of 1,511 (24.4%)
  // The thresholds sit between the two with room on both sides, so this fails on
  // the regression and not on a data edit. The 369 are `fast_casual`, the widest
  // curated category there is; narrowing THAT is a dataset question, not a
  // bridge one.
  assert.ok(
    biggest[1] < total * 0.4,
    `${biggest[1]} of ${total} packages are answered with the same two ideas (${biggest[0]}) — ` +
      "the block screen is not reading the curated category"
  );
  assert.ok(
    answers.size >= 130,
    `only ${answers.size} distinct suggestions across ${total} packages — the selector is being fed a flattened category`
  );
});

test("every shipped Android package gets at least one suggestion", () => {
  recipes.primeCatalog(catalogDoc());
  const packages = shippedPackages();

  const empty = Object.keys(packages)
    .filter((pkg) => androidPicks(bridgePayload(pkg, packages)).length === 0)
    .map((pkg) => `${pkg} (${packages[pkg].brandId})`);

  assert.deepEqual(empty, [], `these apps would show an empty block screen: ${empty.slice(0, 10).join(", ")}`);
});
