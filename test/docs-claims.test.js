"use strict";
/**
 * Documentation claim tests — every number a reader can check, checked.
 *
 * CLAUDE.md §5: "no claim in the product or its docs that the code does not
 * honour." Prose claims decay silently, and counts decay fastest of all: a
 * skeptical buyer counts the brands, the recipes and the languages, and every
 * one of those had drifted before this file existed. README claimed 2,687
 * curated brands against 2,535 in the data, 81 alternatives against 88, and
 * "43 full recipes and 38 quick fixes" against 46 and 42 — while changelog.json
 * simultaneously claimed 81 total made up of "40 full recipes and 29 quick
 * fixes", which does not even add up to itself.
 *
 * So the numbers are asserted against the DATA, not against each other. When a
 * dataset changes, these tests fail and name the document and the number to fix.
 * That is the intended behaviour: a data change is a documentation change.
 *
 * Deliberately not asserted here: prose. This file only guards facts that can be
 * derived mechanically — counts, versions, and the permission list.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const readJson = (...parts) => JSON.parse(read(...parts));

const manifest = readJson("extension", "manifest.json");
const pkg = readJson("package.json");
const changelogJson = readJson("changelog.json");
const recipes = readJson("data", "recipes.json");
const delivery = readJson("data", "blocklists", "delivery.json");
const fastFood = readJson("data", "blocklists", "fast-food.json");

const README = read("README.md");
const ROADMAP = read("changelog", "ROADMAP.md");
const CHANGELOG_INDEX = read("changelog", "README.md");

const VERSION = manifest.version;
const CURRENT_NOTES = read("changelog", `${VERSION}.md`);

// --- derived truth ---------------------------------------------------------

const brandEntries = [...delivery.entries, ...fastFood.entries];
const BRANDS = brandEntries.length;
const CATEGORIES = new Set(brandEntries.map((e) => e.category).filter(Boolean)).size;
const COUNTRIES = new Set(brandEntries.flatMap((e) => e.countries || [])).size;

const alternatives = [...recipes.recipes, ...recipes.quickAlternatives];
const RECIPES = recipes.recipes.length;
const QUICK = recipes.quickAlternatives.length;
const ALTERNATIVES = alternatives.length;
const VEGETARIAN_OR_STRICTER = alternatives.filter((a) => a.diet === "vegan" || a.diet === "vegetarian").length;
const VEGAN = alternatives.filter((a) => a.diet === "vegan").length;
const NO_HEAT = alternatives.filter((a) => a.noCook).length;
const NO_STOVE_OR_OVEN = alternatives.filter((a) => a.noCook || a.microwave).length;

const LOCALES = fs
  .readdirSync(path.join(ROOT, "extension", "_locales"), { withFileTypes: true })
  .filter((d) => d.isDirectory()).length;

/**
 * Numbers in prose are written with thousands separators ("2,535"), so match
 * both forms rather than forcing the docs into an unnatural style.
 */
function statesNumber(text, value) {
  const plain = String(value);
  const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return new RegExp(`(?<![\\d,.])(${plain}|${grouped})(?![\\d,.])`).test(text);
}

function assertStates(text, value, where, what) {
  assert.ok(
    statesNumber(text, value),
    `${where} no longer states the real ${what} (${value}). Update ${where} — the data changed, so the documentation must.`
  );
}

// ---------------------------------------------------------------------------
// Versions agree everywhere a version is written down
// ---------------------------------------------------------------------------

test("manifest, package.json and changelog.json agree on the version", () => {
  assert.ok(
    pkg.version.startsWith(VERSION),
    `package.json ${pkg.version} does not share a prefix with manifest ${VERSION}`
  );
  assert.equal(
    changelogJson.entries[0].version,
    VERSION,
    "the newest changelog.json entry must be the version being shipped"
  );
});

test("the shipped version has canonical release notes, and they are indexed", () => {
  assert.ok(CURRENT_NOTES.length > 0, `changelog/${VERSION}.md is empty`);

  assert.ok(
    new RegExp(`\\[${VERSION.replace(".", "\\.")}\\]\\(${VERSION.replace(".", "\\.")}\\.md\\)`).test(CHANGELOG_INDEX),
    `changelog/README.md's release table has no row linking to ${VERSION}.md. ` +
      "The index existed for six releases and silently missed the seventh."
  );

  assert.ok(
    /##\s*Current version[\s\S]{0,400}?\b0\.\d+\b/.test(ROADMAP),
    "ROADMAP.md has no 'Current version' section naming a version"
  );
  const currentBlock = ROADMAP.split(/##\s*Current version/)[1].split(/\n##\s/)[0];
  assert.ok(
    currentBlock.includes(VERSION),
    `ROADMAP.md's "Current version" section does not name ${VERSION}. ` +
      "It sat on 0.54 for the whole of the 0.55 cycle."
  );
});

test("the changelog.json entry and the canonical notes describe the same release", () => {
  const entry = changelogJson.entries[0];
  assert.equal(typeof entry.title, "string");
  assert.ok(entry.changes.length > 0, "changelog.json's current entry lists no changes");
  assert.ok(
    CURRENT_NOTES.includes(entry.date),
    `changelog/${VERSION}.md does not carry the release date ${entry.date} that changelog.json states`
  );
  assert.ok(
    CHANGELOG_INDEX.includes(entry.date),
    `changelog/README.md's index does not carry the release date ${entry.date}`
  );
});

// ---------------------------------------------------------------------------
// Permissions — the promise a privacy-conscious reader checks first
// ---------------------------------------------------------------------------

test("the manifest requests exactly the three permitted permissions", () => {
  const policy = readJson("development-policy.json");
  assert.deepEqual(
    [...manifest.permissions].sort(),
    [...policy.product_invariants.permissions].sort(),
    "the permission set changed; CLAUDE.md fixes it at storage, declarativeNetRequest, alarms"
  );
  assert.equal(manifest.optional_permissions, undefined, "FitShield declares no optional permissions");
});

test("documentation names every permission the manifest actually requests", () => {
  // <all_urls> is broad. A privacy claim that lists the three tidy permissions
  // and quietly omits the host permission is the kind of half-truth this whole
  // file exists to prevent, so the docs that discuss permissions must name it.
  const extensionDoc = read("docs", "EXTENSION.md");
  for (const permission of manifest.permissions) {
    assert.ok(
      extensionDoc.includes(permission),
      `docs/EXTENSION.md does not mention the "${permission}" permission the manifest requests`
    );
  }
  for (const host of manifest.host_permissions || []) {
    assert.ok(
      extensionDoc.includes(host),
      `docs/EXTENSION.md does not disclose the "${host}" host permission`
    );
  }
});

// ---------------------------------------------------------------------------
// Counts — asserted against the datasets, never against another document
// ---------------------------------------------------------------------------

/**
 * Anchored to the phrase, not just the digits. A bare "does README contain 23?"
 * can pass on an unrelated 23 elsewhere in the file, which would let the exact
 * drift this file exists to catch slip through.
 */
function assertPhrase(pattern, value, what) {
  const grouped = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const source = pattern.replace("%d", `(?:${value}|${grouped.replace(/,/g, ",")})`);
  assert.ok(
    new RegExp(source, "i").test(README),
    `README.md no longer states the real ${what} (${value}). Expected to match /${source}/ — ` +
      "the data changed, so the documentation must."
  );
}

test("README states the real curated-brand, category and market counts", () => {
  assertPhrase("%d curated brands", BRANDS, "curated brand count");
  assertPhrase("across %d markets", COUNTRIES, "market count");
  assertPhrase("%d curated categories", CATEGORIES, "curated category count");
});

test("README states the real alternatives counts", () => {
  assertPhrase("%d alternatives", ALTERNATIVES, "total alternatives count");
  assertPhrase("%d full recipes", RECIPES, "full-recipe count");
  assertPhrase("%d quick fixes", QUICK, "quick-fix count");
});

test("README states the real number of display languages", () => {
  assertPhrase("%d display languages", LOCALES, "display-language count");
});

test("the recipe catalog's own _counts block matches its contents", () => {
  assert.deepEqual(
    recipes._counts,
    { recipes: RECIPES, quickAlternatives: QUICK, total: ALTERNATIVES },
    "data/recipes.json's _counts header disagrees with the arrays beneath it"
  );
});

test("the release notes state alternatives numbers that add up and are true", () => {
  assertStates(CURRENT_NOTES, ALTERNATIVES, `changelog/${VERSION}.md`, "total alternatives count");
  assertStates(CURRENT_NOTES, RECIPES, `changelog/${VERSION}.md`, "full-recipe count");
  assertStates(CURRENT_NOTES, QUICK, `changelog/${VERSION}.md`, "quick-fix count");
  assertStates(CURRENT_NOTES, VEGETARIAN_OR_STRICTER, `changelog/${VERSION}.md`, "vegetarian-or-stricter count");
  assertStates(CURRENT_NOTES, VEGAN, `changelog/${VERSION}.md`, "vegan count");
  assertStates(CURRENT_NOTES, NO_HEAT, `changelog/${VERSION}.md`, "no-heat-at-all count");
  assertStates(CURRENT_NOTES, NO_STOVE_OR_OVEN, `changelog/${VERSION}.md`, "no-stove-or-oven count");

  assert.equal(
    RECIPES + QUICK,
    ALTERNATIVES,
    "the split must sum to the total — changelog.json once claimed 81 = 40 + 29"
  );
});

test("the What's New entry states the same alternatives numbers as the canonical notes", () => {
  const whatsNew = changelogJson.entries[0].changes.join(" ");
  assertStates(whatsNew, ALTERNATIVES, "changelog.json", "total alternatives count");
  assertStates(whatsNew, RECIPES, "changelog.json", "full-recipe count");
  assertStates(whatsNew, QUICK, "changelog.json", "quick-fix count");
});

// ---------------------------------------------------------------------------
// Behaviour claims that are mechanically checkable
// ---------------------------------------------------------------------------

test("no shipped document presents a rule bucket as a brand category", () => {
  // The block page and the stats were handed "fastfood"/"custom" as a category
  // until 0.55. Any doc still describing that is describing a product that no
  // longer exists.
  const claimed = new Set(
    [...CURRENT_NOTES.matchAll(/\bcategory\b[^.\n]{0,80}?["“']?\b(fastfood)\b/gi)].map((m) => m[1])
  );
  assert.equal(
    claimed.size,
    0,
    `changelog/${VERSION}.md still describes "fastfood" as a category rather than a rule bucket`
  );
});

test("every category the data uses has a localized display name", () => {
  // A category with no catLabel renders through the prettifier instead of a
  // translation. README promises "22 curated categories", each named; this is
  // the half of that promise the count alone does not cover.
  const en = readJson("extension", "_locales", "en", "messages.json");
  const pascal = (id) =>
    id
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");

  const missing = [...new Set(brandEntries.map((e) => e.category).filter(Boolean))]
    .filter((id) => !Object.hasOwn(en, `catLabel${pascal(id)}`))
    .sort();

  assert.deepEqual(missing, [], `these dataset categories have no catLabel message key: ${missing.join(", ")}`);
});
