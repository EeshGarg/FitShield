"use strict";
/**
 * The Android Alternatives panel, rendered.
 *
 * Two defects lived here at once, and both were invisible to a source grep.
 *
 * 1. Every ingredient line read "[object Object], [object Object], …". The panel
 *    did `(r.ingredients || []).join(", ")` over a list of
 *    `{quantity, unit, item}` objects. The one job this panel has is telling you
 *    what you could make instead of ordering, and it was telling nobody anything.
 *
 * 2. It drew `.slice(0, 24)` of an 88-entry catalog and said nothing about the
 *    other 64. A browse panel that silently hides two thirds of what it browses
 *    is not a shorter list; it is a wrong one.
 *
 * The formatting rules are the extension's, from `formatIngredient` in
 * extension/warning.js. Android cannot import that file — it is not one of the
 * modules bundled into the APK — so the rules are restated in the Android app.js
 * and THIS FILE is the gate that keeps the restatement honest: it runs the real
 * extension function over every ingredient in the shipped catalog and asserts the
 * phone renders the identical phrase. A drift in either direction fails here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { loadPage } = require("./helpers/android-webview.js");

const ROOT = path.join(__dirname, "..");
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "recipes.json"), "utf8"));
const ENTRIES = [...(CATALOG.recipes || []), ...(CATALOG.quickAlternatives || [])];
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "_locales", "en", "messages.json"), "utf8"));

/**
 * The extension's own `formatIngredient`, lifted out of extension/warning.js and
 * executed — not re-implemented. Extracting it by source range is deliberate:
 * the whole point is that the function under comparison is the shipped one, so
 * a change to it fails this test rather than quietly diverging from Android.
 */
function extensionFormatter() {
  const source = fs.readFileSync(path.join(ROOT, "extension", "warning.js"), "utf8");
  const start = source.indexOf('const FILLER_UNIT = "piece";');
  assert.ok(start > 0, "extension/warning.js no longer declares FILLER_UNIT — the Android mirror has nothing to check against");

  const functionAt = source.indexOf("function formatIngredient(", start);
  assert.ok(functionAt > start, "extension/warning.js no longer declares formatIngredient");

  // Brace-match to the end of the function so the slice cannot run long.
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", functionAt); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > 0, "could not read the end of extension formatIngredient");

  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, end)}; this.formatIngredient = formatIngredient;`, context);
  return context.formatIngredient;
}

const formatIngredient = extensionFormatter();

/** What the ingredients line for one catalog entry must say. */
function expectedLine(entry) {
  const label = EN.recipeIngredientsLabel ? EN.recipeIngredientsLabel.message : "recipeIngredientsLabel";
  const parts = (Array.isArray(entry.ingredients) ? entry.ingredients : [])
    .map(formatIngredient)
    .filter(Boolean);
  return `${label}: ${parts.join(", ")}`;
}

async function dashboard() {
  return loadPage({ page: "index.html", script: "app.js", store: { androidWelcomed: true } });
}

test("no alternative renders [object Object] where its ingredients belong", async () => {
  const page = await dashboard();
  const screen = page.text("recipeList");

  assert.ok(screen && screen.length > 0, "the Alternatives panel rendered nothing at all");
  assert.ok(
    !/\[object Object\]/.test(screen),
    "the Alternatives panel is still stringifying ingredient objects: " + JSON.stringify(screen.slice(0, 300))
  );
});

test("every ingredient reads exactly as the extension would phrase it", async () => {
  const page = await dashboard();
  const rendered = page.text("recipeList");

  // Sanity: the catalog has to contain the shapes worth checking, or agreeing
  // about nothing would pass.
  const all = ENTRIES.flatMap((e) => (Array.isArray(e.ingredients) ? e.ingredients : []));
  assert.ok(all.length > 100, `only ${all.length} ingredients in the catalog — too few to prove anything`);
  assert.ok(all.some((i) => i && i.unit === "piece"), "no 'piece' unit in the catalog; the filler-unit rule is untested");
  assert.ok(all.some((i) => i && ["slice", "clove", "leaf", "pinch", "pouch", "packet", "scoop"].includes(i.unit)),
    "no countable unit in the catalog; the pluralising rule is untested");
  assert.ok(all.some((i) => i && i.note), "no ingredient note in the catalog; the parenthetical rule is untested");

  const missing = ENTRIES.filter((entry) => !rendered.includes(expectedLine(entry)));
  assert.deepEqual(
    missing.map((e) => `${e.id}: ${expectedLine(e)}`),
    [],
    "the Android panel phrases these entries differently from extension/warning.js"
  );
});

test("the whole catalog is browsable, not the first 24 of it", async () => {
  const page = await dashboard();
  const rendered = page.text("recipeList");

  const absent = ENTRIES.filter((entry) => !rendered.includes(entry.title));
  assert.deepEqual(
    absent.map((e) => e.id),
    [],
    `${absent.length} of ${ENTRIES.length} alternatives are not on the screen — the panel is hiding part of the catalog`
  );

  // And it says how many there are, so a future cap cannot be silent.
  const count = page.text("recipeCount");
  assert.ok(count && count.includes(String(ENTRIES.length)),
    `the count line does not state the catalog size (${ENTRIES.length}); it says ${JSON.stringify(count)}`);
});

test("the search box narrows the list and says how much of it is showing", async () => {
  const page = await dashboard();
  const search = page.document.getElementById("recipeSearch");
  assert.ok(search, "index.html declares no #recipeSearch — 88 cards with no way to find one");

  const target = ENTRIES.find((e) => /\w{5,}/.test(e.title || ""));
  const term = target.title.split(/\s+/).find((w) => w.length >= 5).toLowerCase();

  search.value = term;
  await search.dispatch("input");

  const rendered = page.text("recipeList");
  assert.ok(rendered.toLowerCase().includes(term), `searching for "${term}" dropped the entry that matches it`);

  const count = page.text("recipeCount");
  assert.match(count, new RegExp(`\\d+ of ${ENTRIES.length}`),
    `the count line does not report how many of ${ENTRIES.length} matched; it says ${JSON.stringify(count)}`);

  // Clearing restores everything.
  search.value = "";
  await search.dispatch("input");
  assert.ok(page.text("recipeCount").includes(String(ENTRIES.length)));
});
