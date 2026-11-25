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

  // The dashboard toggle is the single control, backed by the shim. Absent
  // storage must read as ON, like the policy above. (The behaviour itself is
  // executed in android-shim.test.js; this pins the spelling of the default.)
  const shimSource = read(path.join(ROOT, "android", "web-src", "android-shim.js"));
  assert.match(
    shimSource,
    /storageGet\("appBlockingEnabled"\);\s*if \(raw === null \|\| raw === undefined\) return Promise\.resolve\(true\);/,
    "the shim must read absent appBlockingEnabled as ON, matching AppBlockPolicy.isEnabled"
  );
});

// ---------------------------------------------------------------------------
// Notification ids
// ---------------------------------------------------------------------------
//
// Only the keep-alive service posts a notification now (the boot-restore notice went
// with the VPN), but ids must stay distinct if another is ever added.
test("every Android notification id is distinct", () => {
  const dir = path.join(__dirname, "..", "android", "app", "src", "main", "java", "com", "usha", "fitshield");
  const ids = new Map();

  fs.readdirSync(dir).filter((f) => f.endsWith(".kt")).forEach((file) => {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const m = /(?:private\s+)?const\s+val\s+NOTIF_ID\s*=\s*(\d+)/.exec(src);
    if (m) ids.set(file.replace(/\.kt$/, ""), Number(m[1]));
  });

  assert.ok(ids.size >= 1, `expected at least one NOTIF_ID holder, found ${[...ids.keys()].join(", ") || "none"}`);

  const seen = new Map();
  const clashes = [];
  [...ids.entries()].forEach(([owner, id]) => {
    if (seen.has(id)) clashes.push(`${seen.get(id)} and ${owner} both post notification id ${id}`);
    else seen.set(id, owner);
  });

  assert.deepEqual(clashes, [], clashes.join("; "));
});

// ---------------------------------------------------------------------------
// Value RANGES the three layers must agree on
// ---------------------------------------------------------------------------
//
// The same defect as the `appBlockingEnabled` default above, applied to a range
// instead of a boolean, and nothing asserted any clamp at all.
//
// extension/fitshield-core.js is the source of truth and EXPORTS the numbers
// (MIN/MAX_TIMER_SECONDS, MIN/MAX_PASS_DURATION_MINUTES), so this reads them from
// it rather than restating them — a test that hard-codes 900 proves only that
// someone typed 900 twice. Android disagreed with core at the top of both:
//
//   timerSeconds   index.html had min="10" and no max, and app.js clamped with
//     `Math.max(10, …)` — a floor and nothing above it. So the dashboard accepted
//     600, stored 600 and showed 600 back, and then BlockActivity applied
//     `.coerceIn(0, 300)` and counted down for five minutes. The user set a value,
//     the product kept it, and nothing honoured it.
//   passDurationMinutes / appUnlockMinutes   the same open top against
//     AppBlockPolicy.unlockMinutes' `.coerceIn(1, 240)`.
//
// ARCHITECTURE.md on the neighbouring case: when the two places a setting lives
// disagree, "the switch shows one state and the behaviour is the other, which is
// strictly worse than either being wrong on its own."
const core = require("../extension/fitshield-core.js");
const BLOCK_ACTIVITY_KT = path.join(
  ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield", "BlockActivity.kt"
);

/** The `LIMITS` table app.js clamps every numeric setting with. */
function appJsLimits() {
  const block = /const LIMITS = \{([\s\S]*?)\};/.exec(read(APP_JS));
  assert.ok(block, "the LIMITS table in app.js no longer looks like an object literal — this guard cannot read it");
  return new Map(
    [...block[1].matchAll(/([A-Za-z_][\w]*)\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)]
      .map((m) => [m[1], [Number(m[2]), Number(m[3])]])
  );
}

/** `min` / `max` on one numeric input in index.html. */
function inputRange(id) {
  const tag = new RegExp(String.raw`<input id="${id}"[^>]*>`).exec(read(INDEX_HTML));
  assert.ok(tag, `index.html no longer has an <input id="${id}">`);
  const min = /min="(\d+)"/.exec(tag[0]);
  const max = /max="(\d+)"/.exec(tag[0]);
  assert.ok(min, `<input id="${id}"> has no min, so the dashboard accepts a value below the product's range`);
  assert.ok(
    max, `<input id="${id}"> has no max, so the dashboard accepts a value the storage layer silently truncates — ` +
      "the user sets a number, sees it kept, and gets a different one"
  );
  return [Number(min[1]), Number(max[1])];
}

test("the pause timer's range is the same number in core, the dashboard input, the dashboard clamp and Kotlin", () => {
  const expected = [core.MIN_TIMER_SECONDS, core.MAX_TIMER_SECONDS];
  assert.deepEqual(expected, [10, 900], "core's own timer range moved; every assertion below is relative to it");

  assert.deepEqual(
    appJsLimits().get("timerSeconds"), expected,
    "app.js clamps timerSeconds to a different range than extension/fitshield-core.js"
  );
  assert.deepEqual(
    inputRange("timerSeconds"), expected,
    "the Timer duration input accepts a range the rest of the product does not honour"
  );

  // The Kotlin that actually runs the countdown. This is the half that was wrong:
  // `coerceIn(0, 300)` against a UI with no maximum at all.
  const coerce = /timerSeconds[\s\S]{0,1600}?\.coerceIn\((\d+),\s*(\d+)\)/.exec(read(BLOCK_ACTIVITY_KT));
  assert.ok(coerce, "BlockActivity no longer coerces timerSeconds in a form this guard can read");
  assert.deepEqual(
    [Number(coerce[1]), Number(coerce[2])], expected,
    `BlockActivity counts down within ${coerce[1]}..${coerce[2]} while the dashboard offers ${expected.join("..")} — ` +
      "a value the user set, that was stored and shown back, and that the pause screen does not honour"
  );
});

test("the pass/unlock duration's range is the same number everywhere too", () => {
  const expected = [core.MIN_PASS_DURATION_MINUTES, core.MAX_PASS_DURATION_MINUTES];
  assert.deepEqual(expected, [1, 240], "core's own pass-duration range moved; every assertion below is relative to it");

  const limits = appJsLimits();
  assert.deepEqual(
    limits.get("appUnlockMinutes"), expected,
    "appUnlockMinutes is the same duration under another key (AppBlockPolicy falls back from one to the other), " +
      "so it has to carry the same range"
  );
  assert.deepEqual(inputRange("appUnlockMinutes"), expected, "the Temporary unlock input accepts a range nothing honours");

  const coerce = /unlockMinutes[\s\S]{0,600}?\.coerceIn\((\d+),\s*(\d+)\)/.exec(read(POLICY_KT));
  assert.ok(coerce, "AppBlockPolicy.unlockMinutes no longer coerces in a form this guard can read");
  assert.deepEqual([Number(coerce[1]), Number(coerce[2])], expected, "AppBlockPolicy truncates a duration the UI accepts");
});

// No clamp may be a bare floor again. `Math.max(10, …)` is what shipped the
// timer defect: correct-looking, and silent about everything above it.
test("every numeric setting the dashboard writes goes through the shared clamp", () => {
  // The LIMITS table itself names all three keys, so it is removed first —
  // otherwise this matches `timerSeconds: [10, 900]` and asserts nothing about the
  // code that stores the value.
  const source = read(APP_JS).replace(/const LIMITS = \{[\s\S]*?\};/, " ");
  ["timerSeconds", "appUnlockMinutes"].forEach((key) => {
    const assignment = new RegExp(String.raw`${key}:\s*([^,\n]+)`).exec(source);
    assert.ok(assignment, `app.js no longer writes ${key} in a form this guard can read`);
    assert.match(
      assignment[1], /clampLimit\(/,
      `app.js writes ${key} as \`${assignment[1].trim()}\`, which does not go through the clamp that carries ` +
        "the product's range — a bare Math.max is a floor with no ceiling, which is the shape that shipped this bug"
    );
  });
});
