"use strict";
/**
 * The Android "Block which apps" pills must be able to do something.
 *
 * Settings offered eight category pills. Two of them could never match a single
 * installed app:
 *
 *   Restaurant   `SRC_CATEGORY_TO_APP` in tools/generate-android-packages.js had
 *                no `restaurant` key, so no package was ever given that grouping
 *                — even though the blocklists carry 15 restaurant brands, 9 of
 *                them with Android packages. One missing line.
 *   Convenience  no blocklist row is `convenience` at all. Nothing to map.
 *
 * `AppBlockPolicy.categoryEnabled` honoured both, so both switches wrote a
 * preference that was read back and applied to zero apps. CLAUDE.md §5: no dead
 * customer-facing control.
 *
 * The fix went two different ways on purpose. Restaurant was wired up — the data
 * was already there. Convenience was removed everywhere: the pill, the `CATS`
 * entry, the policy branch AND the `SRC_CATEGORY_TO_APP` mapping. Removing the
 * mapping matters as much as removing the pill. Left behind, the first
 * convenience brand the data lane adds would be grouped `convenience`, find no
 * branch in `categoryEnabled`, fall through its `else -> true`, and be blocked
 * unconditionally with no switch anywhere that could turn it off — a dead
 * control replaced by an unreachable one. Without the mapping such a brand keeps
 * its file default and stays controllable under an existing pill.
 *
 * So this file asserts the four lists agree in BOTH directions. One direction
 * catches a control that does nothing; the other catches an app nobody can stop
 * blocking. They are the same bug seen from either end.
 *
 * Runs under `node --test`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const gen = require("../tools/generate-android-packages.js");

const ASSET = path.join(ROOT, "android", "app", "src", "main", "assets", "android-packages.json");
const INDEX_HTML = path.join(ROOT, "android", "app", "src", "main", "assets", "web", "index.html");
const APP_JS = path.join(ROOT, "android", "app", "src", "main", "assets", "web", "app.js");
const BLOCK_JS = path.join(ROOT, "android", "app", "src", "main", "assets", "web", "block.js");
const POLICY_KT = path.join(
  ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield", "AppBlockPolicy.kt"
);

const read = (p) => fs.readFileSync(p, "utf8");

/** Categories the Settings pills OFFER the user. */
const offeredPills = () => [...read(INDEX_HTML).matchAll(/data-cat="([^"]+)"/g)].map((m) => m[1]);

/** Categories any shipped app package can actually CARRY. */
function usedCategories() {
  const packages = JSON.parse(read(ASSET)).packages;
  return new Set(Object.values(packages).map((meta) => meta.category));
}

/** Categories the `CATS` map in app.js knows how to persist. */
function catsMap() {
  const source = read(APP_JS);
  const block = /const CATS = \{([\s\S]*?)\};/.exec(source);
  assert.ok(block, "the CATS map in app.js no longer looks like an object literal — this guard cannot read it");

  return new Map([...block[1].matchAll(/([A-Za-z_][\w]*)\s*:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

/** Categories AppBlockPolicy.categoryEnabled has a branch for. */
function policyBranches() {
  const source = read(POLICY_KT);
  const fn = /private fun categoryEnabled\([\s\S]*?\n    \}/.exec(source);
  assert.ok(fn, "AppBlockPolicy.categoryEnabled no longer looks like a `when` block — this guard cannot read it");

  return new Map([...fn[0].matchAll(/"([^"]+)"\s*->\s*bool\(p,\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

// ---------------------------------------------------------------------------

test("the Android app catalog carries every category its own Settings pills offer", () => {
  const offered = offeredPills();
  const used = usedCategories();

  assert.ok(offered.length > 0, "no pills found in index.html — the scan is broken, not the page");
  assert.deepEqual(
    offered.filter((c) => !used.has(c)),
    [],
    "pills no app can ever match — a switch the user can flip that changes nothing"
  );
});

test("no app carries a category the Settings pills do not offer", () => {
  // The other half, and the more dangerous one: `categoryEnabled` answers `true`
  // for anything it has no branch for, so an unoffered category is an app that
  // is always blocked and cannot be turned off from anywhere in the UI.
  const offered = new Set(offeredPills());
  const orphaned = [...usedCategories()].filter((c) => !offered.has(c)).sort();

  assert.deepEqual(
    orphaned,
    [],
    `apps are grouped as ${orphaned.join(", ")}, which no pill offers — those apps cannot be un-blocked`
  );
});

test("the pills, the storage keys, the policy and the generator all name the same categories", () => {
  const offered = [...new Set(offeredPills())].sort();
  const cats = catsMap();
  const policy = policyBranches();
  const generated = [...gen.APP_CATEGORIES].sort();

  assert.deepEqual([...cats.keys()].sort(), offered, "index.html pills and the CATS map in app.js disagree");
  assert.deepEqual([...policy.keys()].sort(), offered, "index.html pills and AppBlockPolicy.categoryEnabled disagree");
  assert.deepEqual(generated, offered, "index.html pills and generate-android-packages APP_CATEGORIES disagree");

  // ...and each category must read and write the SAME preference key on both
  // sides of the bridge. A pill that writes `appBlockCoffee` while the policy
  // reads `appBlockCafe` is a switch that is honoured by nobody.
  const mismatched = [...cats.entries()]
    .filter(([category, key]) => policy.get(category) !== key)
    .map(([category, key]) => `${category}: app.js writes ${key}, AppBlockPolicy reads ${policy.get(category)}`);

  assert.deepEqual(mismatched, [], mismatched.join("; "));
});

test("Settings reads the stored value for every pill it draws", () => {
  // `renderAppBlocking` fetched four of the eight category keys and then used
  // `s[key] === undefined ? true : !!s[key]`, so Coffee, Dessert, Meal kit and
  // Convenience always rendered ON no matter what was stored. A user who turned
  // Coffee off and reopened Settings was shown Coffee on — while the policy,
  // which reads the stored value, was still not blocking it. The switch and the
  // behaviour disagreed, and only the switch was visible.
  // Scoped to renderAppBlocking: app.js has other storage.get calls, and an
  // unanchored match reads the wrong one and then reports the wrong thing.
  const fn = /async function renderAppBlocking\(\)[\s\S]*?\n  \}/.exec(read(APP_JS));
  assert.ok(fn, "renderAppBlocking is no longer a top-level async function — this guard cannot read it");

  const call = /await fs\.storage\.get\(\[([\s\S]*?)\]\);/.exec(fn[0]);
  assert.ok(call, "renderAppBlocking no longer reads its state in one storage.get — this guard cannot read it");

  const literals = [...call[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const spread = /\.\.\.Object\.values\(CATS\)/.test(call[1]);
  const known = new Set(literals);

  const missing = [...catsMap().values()].filter((key) => !spread && !known.has(key));

  assert.deepEqual(
    missing,
    [],
    `the pills for ${missing.join(", ")} are drawn but their stored value is never read — they render ON regardless`
  );
});

test("the block screen has one tone entry per category and no unreachable copy", () => {
  // COPY is keyed on the app grouping and `copyFor` silently falls back to
  // fast_food, so a missing entry is a category quietly wearing another one's
  // words, and a surplus entry is copy no blocked app can ever reach. The
  // `convenience` entry was the second kind.
  const block = /const COPY = \{([\s\S]*?)\n  \};/.exec(read(BLOCK_JS));
  assert.ok(block, "the COPY table in block.js no longer looks like an object literal — this guard cannot read it");

  const keys = [...block[1].matchAll(/^\s{4}([A-Za-z_][\w]*):\s*\{/gm)].map((m) => m[1]).sort();

  assert.deepEqual(
    keys,
    [...gen.APP_CATEGORIES].sort(),
    "block.js COPY and the app-grouping categories disagree — a category is borrowing fast_food's tone, " +
      "or copy exists for a category no app can be"
  );
});

test("the Restaurant pill matches real restaurant apps, not nothing", () => {
  // The regression that started this: `SRC_CATEGORY_TO_APP` had no `restaurant`
  // key, so the 15 curated restaurant brands were filed under their file default
  // and the pill matched zero packages.
  const packages = JSON.parse(read(ASSET)).packages;
  const restaurants = Object.entries(packages).filter(([, meta]) => meta.category === "restaurant");

  assert.ok(
    restaurants.length > 0,
    "no package is grouped `restaurant` — the Restaurant pill is dead again"
  );

  restaurants.forEach(([pkg, meta]) => {
    assert.equal(
      meta.foodCategory,
      "restaurant",
      `${pkg} (${meta.brandId}) is grouped restaurant but the curated data calls it ${meta.foodCategory}`
    );
  });
});

test("no dead `convenience` mapping survives anywhere", () => {
  // Removing the pill without removing the mapping would be worse than leaving
  // both: the next convenience brand would be blocked with no control at all.
  assert.ok(
    !Object.values(require("../tools/generate-android-packages.js").APP_CATEGORIES).includes("convenience"),
    "`convenience` is back in APP_CATEGORIES"
  );

  const generatorSource = read(path.join(ROOT, "tools", "generate-android-packages.js"));
  const mapping = /const SRC_CATEGORY_TO_APP = \{([\s\S]*?)\};/.exec(generatorSource);
  assert.ok(mapping, "SRC_CATEGORY_TO_APP no longer looks like an object literal — this guard cannot read it");

  const targets = new Set([...mapping[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]));
  const unoffered = [...targets].filter((c) => !new Set(offeredPills()).has(c)).sort();

  assert.deepEqual(
    unoffered,
    [],
    `SRC_CATEGORY_TO_APP can produce ${unoffered.join(", ")}, which no pill offers — a brand mapped there ` +
      "would be blocked with no way to turn it off"
  );
});

// ---------------------------------------------------------------------------
// The schema may not permit a category nothing can govern
// ---------------------------------------------------------------------------

// `convenience` outlived its pill. The validator enforces the generator's
// APP_CATEGORIES rather than this schema, so behaviour was safe — but a schema
// that still ACCEPTS the value is an invitation: the next brand given it would
// pass review, fall through `categoryEnabled`'s permissive default, and be
// blocked with no switch anywhere in Settings to turn it off.
test("the package schema permits exactly the categories the generator produces", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const gen = require("../tools/generate-android-packages.js");

  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "data", "android", "packages.schema.json"), "utf8")
  );

  const enums = [];
  (function walk(node) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node.enum) && node.enum.includes("delivery")) {
      enums.push(node.enum);
    }

    Object.values(node).forEach(walk);
  })(schema);

  assert.ok(enums.length > 0, "the schema no longer constrains the category at all");

  enums.forEach((list) => {
    assert.deepEqual(
      [...list].sort(),
      [...gen.APP_CATEGORIES].sort(),
      `the schema accepts ${list.filter((c) => !gen.APP_CATEGORIES.includes(c)).join(", ") || "(nothing extra)"} ` +
        "which the generator cannot produce and no Settings pill governs"
    );
  });
});

// ---------------------------------------------------------------------------
// The master switch
// ---------------------------------------------------------------------------
//
// `appBlockingEnabled` defaulted false while every category under it defaulted
// true, so a phone with the accessibility service granted still opened DoorDash
// normally: the feature was off behind a switch the user had never been shown.
// A master switch defaulting off silently disables everything beneath it, and
// nothing in the suite noticed, because each half was individually consistent.
//
// Both Kotlin reads and the web UI that draws the switch carry their own
// fallback. They are asserted together because the failure that matters is them
// DISAGREEING — the switch showing one state while the policy applies the other.
test("app blocking, and every category under it, defaults ON in both the policy and the UI", () => {
  const policy = read(POLICY_KT);

  const reads = [...policy.matchAll(/bool\(\s*p(?:refs\(context\))?\s*,\s*"appBlockingEnabled"\s*,\s*(true|false)\s*\)/g)]
    .map((m) => m[1]);

  assert.ok(
    reads.length >= 2,
    `expected AppBlockPolicy to read "appBlockingEnabled" in both isEnabled and shouldBlock, found ${reads.length}`
  );
  reads.forEach((value, i) => {
    assert.equal(value, "true", `AppBlockPolicy read #${i + 1} of "appBlockingEnabled" defaults ${value}, not true`);
  });

  // Every category branch defaults on too, so the master switch is not the only
  // thing this guards.
  [...policyBranches().values()].forEach((key) => {
    const branch = new RegExp(String.raw`bool\(p,\s*"${key}",\s*(true|false)\)`).exec(policy);
    assert.ok(branch, `categoryEnabled no longer reads ${key} in a form this guard can check`);
    assert.equal(branch[1], "true", `${key} defaults off, so that pill blocks nothing until it is touched`);
  });

  // app.js must render the switch ON when storage holds nothing. `!!s.x` is the
  // shape that got this wrong: falsy-when-absent, which is the opposite of the
  // policy above.
  const appJs = read(APP_JS);
  const render = /\$\("appBlockingEnabled"\)\.checked\s*=\s*([^;]+);/.exec(appJs);
  assert.ok(render, "app.js no longer assigns the appBlockingEnabled checkbox in a form this guard can read");
  assert.match(
    render[1],
    /!==\s*false/,
    `app.js renders the master switch from \`${render[1].trim()}\`, which reads absent storage as OFF ` +
      "while AppBlockPolicy reads it as ON — the switch and the behaviour would disagree"
  );
});
