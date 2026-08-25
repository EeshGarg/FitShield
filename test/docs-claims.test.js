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
 * WHY THIS FILE GREW. The first version only asked README. It therefore watched
 * three other documents drift through a catalog change without a word:
 *
 *   - `changelog/0.55.md` listed "the 22 categories the current data uses" and
 *     named *Courier* among them. The data had 21 and no courier row — the
 *     category was retired when the courier and errand platforms were removed.
 *     A COUNT check alone would not have caught the wrong NAME, so the category
 *     list is now compared as a SET against the shipped display names.
 *   - `changelog/ROADMAP.md` said 112 markets against 111.
 *   - `SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md` — a report about verification —
 *     was itself unverified, and stated 2,535 brands, 112 countries and 22
 *     categories. Nothing asserted anything about it at all.
 *
 * Every document that states one of these numbers is now asked for it by name.
 *
 * Deliberately not asserted here: prose. This file only guards facts that can be
 * derived mechanically — counts, versions, category names, and permissions.
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
const CONTRIBUTING = read("CONTRIBUTING.md");
const ROADMAP = read("changelog", "ROADMAP.md");
const CHANGELOG_INDEX = read("changelog", "README.md");
const ACCEPTANCE_REPORT = read("SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md");
const STORE_LISTING = read("docs", "STORE_LISTING_DRAFT.md");

const VERSION = manifest.version;
const CURRENT_NOTES = read("changelog", `${VERSION}.md`);

// --- derived truth ---------------------------------------------------------

const DELIVERY_BRANDS = delivery.entries.length;
const FAST_FOOD_BRANDS = fastFood.entries.length;
const brandEntries = [...delivery.entries, ...fastFood.entries];
const BRANDS = brandEntries.length;

const CATEGORY_IDS = [...new Set(brandEntries.map((e) => e.category).filter(Boolean))].sort();
const CATEGORIES = CATEGORY_IDS.length;
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

const en = readJson("extension", "_locales", "en", "messages.json");

const pascal = (id) =>
  id
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const catKey = (id) => `catLabel${pascal(id)}`;

/** The display name the product actually prints for a category id. */
const displayName = (id) => (en[catKey(id)] || {}).message;

/** Every category the shipped data uses, by the name a user sees. */
const CURRENT_CATEGORY_NAMES = CATEGORY_IDS.map(displayName);

/**
 * Retired ids: a catLabel English still defines for a category no shipped
 * record carries. They exist because `blockedByCategory` is a lifetime map in
 * each user's own profile, so an id stops being written long before it stops
 * being READ. Derived rather than hard-coded, so this file needs no coupling to
 * the audit's own list.
 */
const CURRENT_CAT_KEYS = new Set(CATEGORY_IDS.map(catKey));
const RETIRED_CAT_KEYS = Object.keys(en)
  .filter((k) => k.startsWith("catLabel") && !CURRENT_CAT_KEYS.has(k))
  .sort();

/**
 * The italicised category list in the release notes, and the count it states.
 *
 * Anchored to "from the blocklist:" so the window cannot reach backwards into
 * the paragraph above, which names *Fastfood* and *Custom* — the rule buckets
 * 0.55 stopped presenting as categories. A loose window swept those up and
 * reported them as wrongly-listed categories, which would have been a false
 * accusation rather than a caught defect.
 */
function categoryListBlock(notes) {
  const match = notes.match(
    /from the blocklist:([\s\S]{0,900}?)—\s*the (\d+) categories the current data uses/
  );

  if (!match) {
    return null;
  }

  return {
    names: new Set([...match[1].matchAll(/\*([A-Z][A-Za-z' ]*?)\*/g)].map((m) => m[1].trim())),
    statedCount: Number(match[2])
  };
}

/**
 * Numbers in prose are written with thousands separators ("2,535"), so match
 * both forms rather than forcing the docs into an unnatural style.
 */
function statesNumber(text, value) {
  const plain = String(value);
  const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  /*
   * The boundary has to reject a number that is part of a LARGER number
   * ("2,505" inside "12,505" or "2,5050") while accepting one that merely ends
   * a clause ("...to 2,505, and the markets..." or "...2,505.").
   *
   * The first version of this excluded any adjacent "." or ",", so a count at
   * the end of a sentence read as absent and the assertion passed on the wrong
   * evidence — the exact failure mode this file exists to prevent, one helper
   * down. A separator only continues a number when a digit follows it.
   */
  return new RegExp(`(?<!\\d)(?<!\\d[.,])(${plain}|${grouped})(?!\\d)(?![.,]\\d)`).test(text);
}

function assertStates(text, value, where, what) {
  assert.ok(
    statesNumber(text, value),
    `${where} no longer states the real ${what} (${value}). Update ${where} — the data changed, so the documentation must.`
  );
}

/**
 * Anchored to the phrase, not just the digits. A bare "does this doc contain
 * 23?" can pass on an unrelated 23 elsewhere in the file, which would let the
 * exact drift this file exists to catch slip through.
 */
function assertPhrase(text, where, pattern, value, what) {
  const grouped = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const source = pattern.replace("%d", `(?:${value}|${grouped})`);
  assert.ok(
    new RegExp(source, "i").test(text),
    `${where} no longer states the real ${what} (${value}). Expected to match /${source}/ — ` +
      "the data changed, so the documentation must."
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

test("the acceptance report states the permission list the manifest requests", () => {
  for (const permission of manifest.permissions) {
    assert.ok(
      ACCEPTANCE_REPORT.includes(permission),
      `SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md claims a permission set that omits "${permission}"`
    );
  }
});

// ---------------------------------------------------------------------------
// Counts — asserted against the datasets, never against another document
// ---------------------------------------------------------------------------

test("README states the real curated-brand, category and market counts", () => {
  assertPhrase(README, "README.md", "%d curated brands", BRANDS, "curated brand count");
  assertPhrase(README, "README.md", "across %d markets", COUNTRIES, "market count");
  assertPhrase(README, "README.md", "%d curated categories", CATEGORIES, "curated category count");
});

test("README states the real alternatives counts", () => {
  assertPhrase(README, "README.md", "%d alternatives", ALTERNATIVES, "total alternatives count");
  assertPhrase(README, "README.md", "%d full recipes", RECIPES, "full-recipe count");
  assertPhrase(README, "README.md", "%d quick fixes", QUICK, "quick-fix count");
});

test("README states the real number of display languages", () => {
  assertPhrase(README, "README.md", "%d display languages", LOCALES, "display-language count");
});

test("CONTRIBUTING states the real number of locales", () => {
  assertPhrase(CONTRIBUTING, "CONTRIBUTING.md", "%d locales", LOCALES, "locale count");
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
// ROADMAP — it drifted to 112 markets with nothing watching it
// ---------------------------------------------------------------------------

test("ROADMAP states the real market count", () => {
  assertPhrase(ROADMAP, "changelog/ROADMAP.md", "%d markets are represented", COUNTRIES, "market count");
});

test("ROADMAP's current-version highlights state the real catalog shape", () => {
  const currentBlock = ROADMAP.split(/##\s*Current version/)[1].split(/\n##\s/)[0];
  assertPhrase(currentBlock, "ROADMAP.md's Current version section", "%d brands", BRANDS, "curated brand count");
  assertPhrase(currentBlock, "ROADMAP.md's Current version section", "%d markets", COUNTRIES, "market count");
  assertPhrase(
    currentBlock,
    "ROADMAP.md's Current version section",
    "%d\\s+curated\\s+categories",
    CATEGORIES,
    "curated category count"
  );
});

test("ROADMAP states the real number of category message keys", () => {
  const totalCatKeys = CURRENT_CAT_KEYS.size + RETIRED_CAT_KEYS.length;
  assertPhrase(ROADMAP, "changelog/ROADMAP.md", "all %d category keys", totalCatKeys, "category message-key count");
  // `\s+` rather than a hand-rolled newline alternation: the phrase wraps, and
  // where it wraps is a typography decision that must not break an assertion.
  assertPhrase(ROADMAP, "changelog/ROADMAP.md", "the %d\\s+the data uses", CATEGORIES, "current category count");
  assertPhrase(ROADMAP, "changelog/ROADMAP.md", "%d retired ids", RETIRED_CAT_KEYS.length, "retired category count");
});

// ---------------------------------------------------------------------------
// The acceptance report — a report about verification, itself unverified
// ---------------------------------------------------------------------------

test("the acceptance report states the real catalog shape", () => {
  assertPhrase(ACCEPTANCE_REPORT, "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md", "%d brands", BRANDS, "curated brand count");
  assertPhrase(
    ACCEPTANCE_REPORT,
    "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
    "%d delivery",
    DELIVERY_BRANDS,
    "delivery blocklist size"
  );
  assertPhrase(
    ACCEPTANCE_REPORT,
    "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
    "%d fast food",
    FAST_FOOD_BRANDS,
    "fast-food blocklist size"
  );
  assertPhrase(
    ACCEPTANCE_REPORT,
    "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
    "across %d countries",
    COUNTRIES,
    "country count"
  );
  assertPhrase(
    ACCEPTANCE_REPORT,
    "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
    "%d curated categories",
    CATEGORIES,
    "curated category count"
  );
});

test("the acceptance report's two blocklist sizes sum to its brand count", () => {
  assert.equal(
    DELIVERY_BRANDS + FAST_FOOD_BRANDS,
    BRANDS,
    "the delivery and fast-food files must account for every brand the report counts"
  );
});

test("the acceptance report states the real alternatives counts", () => {
  assertPhrase(
    ACCEPTANCE_REPORT,
    "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
    "%d alternatives",
    ALTERNATIVES,
    "total alternatives count"
  );
  assertPhrase(ACCEPTANCE_REPORT, "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md", "%d recipes", RECIPES, "full-recipe count");
  assertPhrase(
    ACCEPTANCE_REPORT,
    "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
    "%d quick alternatives",
    QUICK,
    "quick-alternative count"
  );
});

test("the acceptance report states the real number of validators and test files", () => {
  /*
   * The audit count is worth pinning for its own sake: an audit dropped from
   * validate-all stops running silently, and the summary line keeps saying
   * PASS. The report names the number, so the report is where it gets checked.
   */
  const validateAll = read("tools", "validate-all.js");
  const block = validateAll.match(/const AUDITS = \[([\s\S]*?)\n\];/);
  assert.ok(block, "tools/validate-all.js no longer declares an AUDITS array");
  const audits = [...block[1].matchAll(/require\("\.\/([a-zA-Z0-9-]+)"\)/g)].map((m) => m[1]);
  assert.ok(audits.length > 0, "no audits parsed out of validate-all.js");

  assertPhrase(
    ACCEPTANCE_REPORT,
    "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
    "\\*\\*%d audits\\*\\*",
    audits.length,
    "validator count"
  );

  const testFiles = fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.js")).length;
  assertPhrase(
    ACCEPTANCE_REPORT,
    "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
    "%d test files",
    testFiles,
    "test-file count"
  );
});

test("the acceptance report states the real number of retired category labels", () => {
  assertPhrase(
    ACCEPTANCE_REPORT,
    "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
    "The %d \"orphaned\" category labels",
    RETIRED_CAT_KEYS.length,
    "retired category-label count"
  );
});

test("the store listing's '2,500+ curated brands' floor is still true", () => {
  // A "+" claim is not exempt from being checked: it becomes false the moment
  // the catalog drops below the number it rounds down to.
  const match = STORE_LISTING.match(/([\d,]+)\+\s*curated brands/i);
  assert.ok(match, "docs/STORE_LISTING_DRAFT.md no longer makes a '<n>+ curated brands' claim to check");
  const floor = Number(match[1].replace(/,/g, ""));
  assert.ok(
    BRANDS >= floor,
    `docs/STORE_LISTING_DRAFT.md claims ${match[1]}+ curated brands but the data holds ${BRANDS}`
  );
});

// ---------------------------------------------------------------------------
// Category NAMES — the count was right in one doc while the names were wrong
// ---------------------------------------------------------------------------

test("every category the data uses has a localized display name", () => {
  // A category with no catLabel renders through the prettifier instead of a
  // translation. README promises curated categories, each named; this is the
  // half of that promise the count alone does not cover.
  const missing = CATEGORY_IDS.filter((id) => !Object.hasOwn(en, catKey(id))).sort();
  assert.deepEqual(missing, [], `these dataset categories have no catLabel message key: ${missing.join(", ")}`);
});

test("the release notes name exactly the categories the data uses", () => {
  /*
   * The defect this exists for: the notes listed 22 italicised category names
   * including *Courier*, when the data had 21 and no courier row. The count and
   * the names are two separate claims, and only the count was ever asserted.
   *
   * So the list is parsed and compared as a SET. Adding a category, removing
   * one, or renaming one all fail here and name the difference.
   */
  const block = categoryListBlock(CURRENT_NOTES);
  assert.ok(
    block,
    `changelog/${VERSION}.md no longer contains the "the <n> categories the current data uses" list. ` +
      "If the wording moved, move this assertion with it — do not delete it."
  );

  assert.equal(
    block.statedCount,
    CATEGORIES,
    `changelog/${VERSION}.md says the data uses ${block.statedCount} categories; it uses ${CATEGORIES}`
  );

  const listedSet = block.names;
  const expectedSet = new Set(CURRENT_CATEGORY_NAMES);

  const named = [...listedSet].filter((n) => !expectedSet.has(n)).sort();
  const unnamed = [...expectedSet].filter((n) => !listedSet.has(n)).sort();

  assert.deepEqual(
    named,
    [],
    `changelog/${VERSION}.md names ${named.join(", ")} as a current category, but no shipped record carries it. ` +
      "*Courier* survived here for a whole release after the courier rows were removed."
  );
  assert.deepEqual(
    unnamed,
    [],
    `changelog/${VERSION}.md's category list omits ${unnamed.join(", ")}, which the data does use`
  );
  assert.equal(
    listedSet.size,
    CATEGORIES,
    `changelog/${VERSION}.md lists ${listedSet.size} distinct category names for ${CATEGORIES} categories`
  );
});

test("no retired category is presented as a current one in the release notes list", () => {
  const block = categoryListBlock(CURRENT_NOTES);
  assert.ok(block, "the category list sentence must exist for this assertion to mean anything");

  const listed = block.names;
  const currentNames = new Set(CURRENT_CATEGORY_NAMES);

  const retiredNames = RETIRED_CAT_KEYS.map((k) => (en[k] || {}).message).filter((n) => n && !currentNames.has(n));

  const offenders = retiredNames.filter((n) => listed.has(n)).sort();
  assert.deepEqual(
    offenders,
    [],
    `changelog/${VERSION}.md lists retired categor(ies) ${offenders.join(", ")} among the current ones. ` +
      "A retired id keeps its display name for lifetime stats; it is not a category the catalog still uses."
  );
});

test("every retired category still has a display name for existing profiles", () => {
  // The mirror of the test above, and the reason retired labels are kept at all:
  // blockedByCategory is a lifetime map, so a retired id is still READ long
  // after it stops being written. Losing the label downgrades a localized name
  // to prettified English, and only for users who already have history.
  const nameless = RETIRED_CAT_KEYS.filter((k) => !(en[k] || {}).message);
  assert.deepEqual(nameless, [], `these retired category keys have no English display name: ${nameless.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Behaviour claims that are mechanically checkable
// ---------------------------------------------------------------------------

test("no document promises an estimate the settings page does not render", () => {
  /*
   * README said "estimated money and calorie figures are still available…off by
   * default" for the whole of 0.55, while the release notes on the same commit
   * said "Calories avoided is gone". Both could not be true, and the code
   * agreed with the release notes: Settings renders exactly one estimate, a
   * cost, and no calorie figure at all.
   *
   * Asserted against the markup rather than against either document, so the
   * question is settled by what the product does.
   */
  const settingsHtml = read("extension", "settings.html");
  const settingsJs = read("extension", "settings.js");

  const estimateToggles = [...settingsHtml.matchAll(/id="(show[A-Za-z]*Estimates?[A-Za-z]*)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(estimateToggles)],
    ["showEstimates"],
    "the estimate controls changed; this assertion and the docs that describe them must change together"
  );

  // The rendered value is alternativesMade x avgMealCost. A calorie figure
  // would need avgMealCalories to reach a DOM write; it never does.
  assert.ok(
    /estimateValueEl\.textContent\s*=\s*formatSavings\(/.test(settingsJs),
    "the single estimate is no longer rendered as a formatted cost"
  );
  assert.ok(
    !/avgMealCalories[\s\S]{0,200}?textContent/.test(settingsJs),
    "settings.js now writes a calorie figure to the page; the docs say there is none"
  );

  const claimsCalorieEstimate = /calorie (figure|estimate)s? (are|is) (still )?(available|shown|displayed)/i;
  for (const [where, text] of [
    ["README.md", README],
    [`changelog/${VERSION}.md`, CURRENT_NOTES],
    ["SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md", ACCEPTANCE_REPORT]
  ]) {
    assert.ok(
      !claimsCalorieEstimate.test(text),
      `${where} claims a calorie estimate is available, but the settings page renders none`
    );
  }
});

test("Android's block screen matches on the brand but not on the person", () => {
  /*
   * Two claims the store listing draft has to get exactly right, because an
   * allergen claim on a store page is a promise about someone's safety.
   *
   * The Android screen calls selectAlternative with the brand's own fields and
   * an EMPTY settings object — Android has no kitchen, diet or allergen
   * preferences to pass. So it is matched to the site, never to the user, and
   * the draft says so. The draft used to say the opposite of the first half:
   * that Android fell through to a fixed pick, which stopped being true when
   * the screen was reconnected.
   */
  const androidBlock = read("android", "app", "src", "main", "assets", "web", "block.js");

  assert.ok(
    /R\.selectAlternative\(/.test(androidBlock),
    "android block.js no longer calls selectAlternative; the store draft claims it does"
  );
  assert.ok(
    !/selectRecipes/.test(androidBlock.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")),
    "android block.js reaches for selectRecipes again — the shared module does not export it"
  );

  // The settings argument is the personalisation channel. It is `{}` here, and
  // the listing must not promise otherwise.
  assert.ok(
    /selectAlternative\(\s*\{[\s\S]*?\},\s*\{\s*\}\s*,/.test(androidBlock),
    "android block.js now passes user settings to the selector — re-check what the store listing may claim"
  );

  assert.ok(
    /never put an allergen-matching claim/i.test(STORE_LISTING),
    "docs/STORE_LISTING_DRAFT.md dropped its allergen-claim prohibition for Android"
  );
});

test("the Android statistics divergence is documented exactly while it exists", () => {
  /*
   * 0.55 deleted "Blocked visits", "Estimated savings" and "Calories avoided"
   * from the extension, for a stated reason: an interruption says nothing about
   * whether an order would have happened, and a displayed recipe card is not a
   * calorie anyone avoided. The Android app still renders all three.
   *
   * That is an Android defect, not a docs one — but a docs lane can at least
   * refuse to let it be silent. This assertion is deliberately BIDIRECTIONAL:
   *
   *   - while Android still shows the tiles, docs/ANDROID.md must carry the
   *     divergence row and changelog/0.55.md must scope its claim to the
   *     extension;
   *   - once Android is fixed, this test fails on the now-false documentation,
   *     so the row cannot outlive the bug either.
   *
   * Neither half can rot quietly, which is the whole point.
   */
  const androidMarkup = read("android", "app", "src", "main", "assets", "web", "index.html");
  const androidDoc = read("docs", "ANDROID.md");

  const showsCalories = /id="calories"/.test(androidMarkup);
  const documented = /Android still shows the three statistics 0\.55 deleted as dishonest/.test(androidDoc);
  const scoped = /This applies to the browser extension\./.test(CURRENT_NOTES);

  if (showsCalories) {
    assert.ok(
      documented,
      "Android still renders a 'Calories avoided' tile, but docs/ANDROID.md no longer records it as a divergence"
    );
    assert.ok(
      scoped,
      `Android still renders a 'Calories avoided' tile, but changelog/${VERSION}.md claims the figure is gone ` +
        "without scoping that to the extension"
    );
  } else {
    assert.ok(
      !documented,
      "Android no longer shows the removed statistics — delete the divergence row in docs/ANDROID.md"
    );
    assert.ok(
      !scoped,
      `Android no longer shows the removed statistics — drop the Android caveat from changelog/${VERSION}.md`
    );
  }
});

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

test("no brand is split across both blocklists, as the release notes claim", () => {
  /*
   * The two blocklist files ARE the two switches the popup offers, so a brand
   * with domains in both cannot be governed by one switch. mcdonalds.co.kr sat
   * in delivery while fourteen siblings sat in fast food, and turning "Fast
   * food sites" off unblocked delivery platforms.
   *
   * Asserted as behaviour rather than as a number in prose: no second-level
   * label may appear in both files.
   */
  const stem = (domain) => String(domain).split(".")[0];
  const deliveryStems = new Set(delivery.entries.map((e) => stem(e.domain)));
  const straddling = [...new Set(fastFood.entries.map((e) => stem(e.domain)))]
    .filter((s) => deliveryStems.has(s))
    .sort();

  assert.deepEqual(
    straddling,
    [],
    `these brands have domains in BOTH blocklists, so neither popup switch governs them alone: ${straddling.join(", ")}`
  );
});

test("the brands the release notes name as still blocked are still blocked", () => {
  /*
   * The removals section names specific brands whose food arm survived the
   * cull, as evidence that coverage was checked rather than assumed. That
   * evidence is only worth printing if it stays true — and it did not: an
   * earlier draft named minorfood.com, which a later data pass removed, so the
   * release notes claimed a site still interrupts when it no longer existed.
   *
   * Naming a brand in a user-facing document is therefore a commitment, and
   * this is the assertion that holds anyone to it.
   */
  const blocked = new Set(brandEntries.map((e) => e.domain));
  const stillBlocked = ["lineman.co.th", "eatfit.in", "jumiafood.com", "bhc.co.kr"];

  const gone = stillBlocked.filter((d) => !blocked.has(d));
  assert.deepEqual(
    gone,
    [],
    `changelog/${VERSION}.md names ${gone.join(", ")} as still interrupting, but the catalog no longer carries it. ` +
      "Either restore the record or stop citing it as evidence."
  );

  // Markdown hard-wraps at 80 columns, so a two-word brand name is routinely
  // split across a line break. Compare on collapsed whitespace, or this fails
  // on typography rather than on substance.
  //
  // Both documents make the claim, and the report is where minorfood.com went
  // stale, so both are held to it.
  const documents = [
    [`changelog/${VERSION}.md`, CURRENT_NOTES.replace(/\s+/g, " ")],
    ["SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md", ACCEPTANCE_REPORT.replace(/\s+/g, " ")]
  ];

  for (const [where, flat] of documents) {
    for (const domain of stillBlocked) {
      const entry = brandEntries.find((e) => e.domain === domain);
      assert.ok(
        flat.includes(entry.name),
        `${where} cites ${domain} but not under its own brand name "${entry.name}"`
      );
    }
  }
});

test("the sites the release notes say stopped being blocked are actually gone", () => {
  // The other half of the same promise. A user told "this no longer blocks
  // messaging" and then blocked at LINE has been told something false.
  const blocked = new Set(brandEntries.map((e) => e.domain));
  const removed = [
    "line.me",
    "cult.fit",
    "tokmanni.fi",
    "jumia.ci",
    "jumia.co.ke",
    "jumia.ma",
    "jumia.sn",
    "dada.cn",
    "shansong.com",
    "uupt.com",
    "gokada.ng",
    "sendme.ng",
    "pickndrop.co.ke"
  ];

  const stillThere = removed.filter((d) => blocked.has(d));
  assert.deepEqual(
    stillThere,
    [],
    `changelog/${VERSION}.md tells users these are no longer blocked, but the catalog still carries them: ${stillThere.join(", ")}`
  );
});

test("the brands the release notes move to Grocery are filed as grocery", () => {
  /*
   * The Android section tells a user that if they turned the Grocery pill off,
   * these specific brands stop being blocked. That is only true while the
   * brands are actually filed under grocery, and the Android grouping is
   * regenerated from the blocklists — so a later re-classification could
   * silently make the release notes wrong in the direction that costs a user
   * blocking they thought they had.
   */
  const bundle = readJson("data", "generated", "android-packages.json");
  const byName = new Map(bundle.brands.map((b) => [b.displayName, b]));
  const named = ["ICA", "Żabka", "Iceland", "Rema 1000", "Conad", "Esselunga", "Eroski", "IGA", "Giant", "Kiwi"];

  const wrong = [];
  for (const name of named) {
    const brand = byName.get(name);
    if (!brand) {
      wrong.push(`${name} (no longer in the Android bundle)`);
    } else if (brand.category !== "grocery") {
      wrong.push(`${name} (filed as ${brand.category})`);
    }
  }

  assert.deepEqual(
    wrong,
    [],
    `changelog/${VERSION}.md names these as having moved to the Grocery pill, but they are not filed there: ${wrong.join(", ")}`
  );
});

test("every Android app grouping has a pill, and every pill has apps", () => {
  // The Convenience pill was a control that could never match anything: no
  // blocklist row was ever `convenience`. The release notes say it is gone, so
  // the two sides are held together here as well as in the Android lane's own
  // test — a dead customer-facing control is a documentation problem too.
  const bundle = readJson("data", "generated", "android-packages.json");
  const grouped = new Set(bundle.brands.map((b) => b.category));
  const markup = fs.readFileSync(
    path.join(ROOT, "android", "app", "src", "main", "assets", "web", "index.html"),
    "utf8"
  );
  const pills = new Set([...markup.matchAll(/data-cat="([a-z_]+)"/g)].map((m) => m[1]));

  const groupingWithoutPill = [...grouped].filter((c) => !pills.has(c)).sort();
  const pillWithoutApps = [...pills].filter((c) => !grouped.has(c)).sort();

  assert.deepEqual(
    groupingWithoutPill,
    [],
    `these app groupings have no pill, so a user cannot turn them off: ${groupingWithoutPill.join(", ")}`
  );
  assert.deepEqual(
    pillWithoutApps,
    [],
    `these pills match no app, so they are dead controls: ${pillWithoutApps.join(", ")}`
  );
});

test("no shipped record still carries the retired courier category", () => {
  // The release notes say the category retired with the removals. It is a
  // one-line check and it is the exact claim that shipped wrong last time.
  const couriers = brandEntries.filter((e) => e.category === "courier").map((e) => e.domain);
  assert.deepEqual(couriers, [], `these records still carry the retired "courier" category: ${couriers.join(", ")}`);
});

test("the release notes disclose the catalog shape a user's blocking depends on", () => {
  // A release that changes WHAT IS BLOCKED has to say so. These are the two
  // numbers a user can check against their own experience of the product.
  assertStates(CURRENT_NOTES, BRANDS, `changelog/${VERSION}.md`, "curated brand count");
  assertStates(CURRENT_NOTES, COUNTRIES, `changelog/${VERSION}.md`, "market count");
});

test("every brand in the catalog can still be answered with an alternative", () => {
  /*
   * The acceptance report claims "craving coverage is now N of N brands". That
   * is a claim about the SELECTOR, so it is verified by running the selector
   * over every brand rather than by grepping the number out of a document.
   *
   * It was false once and invisible: recipes.js read the rule bucket
   * "fastfood", which the taxonomy does not contain, so the category tier was
   * dead for every fast-food brand while the tests stayed green.
   */
  const previousSelf = global.self;
  global.self = global.self || global;
  try {
    delete require.cache[require.resolve("../extension/recipes.js")];
    const engine = require("../extension/recipes.js");
    engine.primeCatalog(recipes);

    const unanswered = [];
    const cravingless = [];

    for (const entry of brandEntries) {
      const info = {
        domain: entry.domain,
        name: entry.name,
        type: entry.type,
        category: entry.category,
        specialties: entry.specialties || [],
        countries: entry.countries || []
      };

      const cravings = engine.deriveCravings(info, recipes.taxonomy);
      if ((cravings.primary || []).length + (cravings.secondary || []).length === 0) {
        cravingless.push(entry.domain);
      }

      const chosen = engine.selectAlternative(info, {}, {});
      if (!chosen || !chosen.entry) {
        unanswered.push(entry.domain);
      }
    }

    assert.deepEqual(
      cravingless.slice(0, 10),
      [],
      `${cravingless.length} brand(s) derive no craving at all, so the category tier is dead for them`
    );
    assert.deepEqual(
      unanswered.slice(0, 10),
      [],
      `${unanswered.length} brand(s) produce no alternative, so the block page has nothing to offer`
    );

    assertPhrase(
      ACCEPTANCE_REPORT,
      "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md",
      `Craving coverage is now %d of ${BRANDS.toLocaleString("en-US")} brands`,
      BRANDS,
      "craving-coverage count"
    );
  } finally {
    if (previousSelf === undefined) {
      delete global.self;
    } else {
      global.self = previousSelf;
    }
  }
});
