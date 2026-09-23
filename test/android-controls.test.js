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

// ---------------------------------------------------------------------------
// Notification ids
// ---------------------------------------------------------------------------
//
// RestoreNotice and AppBlockKeepAliveService were both id 2, and 2 is the id the
// keep-alive runs its FOREGROUND notification on. So the keep-alive erased the
// one prompt that tells a user their protection did not come back after a
// reboot, and RestoreNotice.dismiss() cancelled a live foreground service's
// notification. Neither is visible in isolation: each file was self-consistent.
test("every Android notification id is distinct", () => {
  const dir = path.join(__dirname, "..", "android", "app", "src", "main", "java", "com", "usha", "fitshield");
  const ids = new Map();

  fs.readdirSync(dir).filter((f) => f.endsWith(".kt")).forEach((file) => {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const m = /(?:private\s+)?const\s+val\s+NOTIF_ID\s*=\s*(\d+)/.exec(src);
    if (m) ids.set(file.replace(/\.kt$/, ""), Number(m[1]));
  });

  assert.ok(ids.size >= 3, `expected at least three NOTIF_ID holders, found ${[...ids.keys()].join(", ") || "none"}`);

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
  assert.deepEqual(limits.get("passDurationMinutes"), expected, "app.js clamps passDurationMinutes to the wrong range");
  assert.deepEqual(
    limits.get("appUnlockMinutes"), expected,
    "appUnlockMinutes is the same duration under another key (AppBlockPolicy falls back from one to the other), " +
      "so it has to carry the same range"
  );
  assert.deepEqual(inputRange("passMinutes"), expected, "the Site open time input accepts a range nothing honours");
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
  ["timerSeconds", "passDurationMinutes", "appUnlockMinutes"].forEach((key) => {
    const assignment = new RegExp(String.raw`${key}:\s*([^,\n]+)`).exec(source);
    assert.ok(assignment, `app.js no longer writes ${key} in a form this guard can read`);
    assert.match(
      assignment[1], /clampLimit\(/,
      `app.js writes ${key} as \`${assignment[1].trim()}\`, which does not go through the clamp that carries ` +
        "the product's range — a bare Math.max is a floor with no ceiling, which is the shape that shipped this bug"
    );
  });
});

// ---------------------------------------------------------------------------
// "Most blocked categories": one exclusion set, not two
// ---------------------------------------------------------------------------
//
// FitShieldVpnService.kt skipped recording unless
// `category != "delivery" && category != "fast_food" && category != "custom"`.
// That is the extension's PRE-FIX guard: `delivery` and `fast_food` are genuine
// curated categories, delivery is the largest in the datasets, both are offered
// by Settings' category picker and both ship display names. The comment above
// `RULE_BUCKET_CATEGORIES` in extension/background.js says so in words — "The
// guard here used to drop them, so the single largest curated delivery category
// could never appear in 'Most blocked categories'."
//
// Both platforms write the SAME `blockedByCategory` key and the same shared UI
// ranks it, so Android was writing a corrupted version of a shared statistic with
// a bug the extension had already fixed. Kotlin never even saw the bucket spelling
// `fastfood` that the JS guard exists for, because the asset carries `fast_food`.
const BACKGROUND_JS = path.join(ROOT, "extension", "background.js");
const VPN_SERVICE_KT = path.join(
  ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield", "FitShieldVpnService.kt"
);
const RULE_ENGINE_KT = path.join(
  ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield", "RuleEngine.kt"
);
const genRules = require("../tools/generate-android-rules.js");
const RULES_ASSET = path.join(ROOT, "android", "app", "src", "main", "assets", "fitshield-rules.json");

const stripKotlinComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, " ");

test("the Android and extension category-exclusion sets are the same two strings", () => {
  // Read from background.js rather than restated here: the point is that the two
  // platforms agree, and a literal in this file would agree with nothing.
  const literal = /RULE_BUCKET_CATEGORIES = new Set\(\[([^\]]*)\]\)/.exec(read(BACKGROUND_JS));
  assert.ok(literal, "extension/background.js no longer declares RULE_BUCKET_CATEGORIES in a form this guard can read");
  const extension = [...literal[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

  assert.deepEqual(
    [...genRules.STATS_EXCLUDED_CATEGORIES].sort(), extension,
    "the Android rules generator and the extension exclude different categories from blockedByCategory — " +
      "and both platforms write that one key"
  );
  assert.deepEqual(extension, ["custom", "fastfood"], "the excluded set is the two rule-bucket spellings, and only those");
});

test("Kotlin holds no category vocabulary of its own", () => {
  const source = stripKotlinComments(read(VPN_SERVICE_KT));

  ["delivery", "fast_food", "fastfood", "custom"].forEach((name) => {
    assert.ok(
      !source.includes(`"${name}"`),
      `FitShieldVpnService still names the category "${name}". The exclusion belongs in ` +
        "tools/generate-android-rules.js, where the value is derived; a second copy on this side is what drifted."
    );
  });
});

// The invariant, rather than a list of names: EVERY category Settings' picker
// offers must be one the stat can record. That is precisely the contradiction the
// old Kotlin guard created — a category the user can filter by, that "Most blocked
// categories" could never show.
//
// Worth recording because it corrects the received account of this bug: the
// curated vocabulary has 21 categories and `fast_food` is NOT one of them
// (`fast_casual`, `burger`, `chicken`, `pizza`… are). So of the old guard's three
// clauses, two were inert — no host has ever carried `fast_food` or `custom` — and
// the whole real effect was the first one: `delivery`, which the picker offers with
// 369 brands and 373 blockable hosts, was silently dropped from a statistic the
// extension writes to the same key.
test("every category the picker offers can actually reach Most blocked categories", () => {
  const asset = JSON.parse(read(RULES_ASSET));
  const recordable = new Set(Object.values(asset.meta).map((m) => m.k).filter(Boolean));

  const offered = asset.categories.map((c) => c.id);
  assert.ok(offered.length > 0, "the asset offers no categories, so this can prove nothing");

  const unrecordable = offered.filter((id) => genRules.STATS_EXCLUDED_CATEGORIES.has(id) || !recordable.has(id));
  assert.deepEqual(
    unrecordable, [],
    "Settings' category picker offers these categories and the Android stat cannot record them — the user can " +
      "filter by a category that will never appear in their own Most blocked list"
  );

  // The one that was actually being thrown away, named explicitly so a rename in
  // the data cannot quietly turn this test into a tautology.
  assert.ok(
    recordable.has("delivery"),
    "no host carries the curated category \"delivery\" any more, so this no longer covers the category the old guard dropped"
  );

  // …and no bucket spelling survives into the asset, which is what lets the
  // native side record any non-empty category without a list of its own.
  [...genRules.STATS_EXCLUDED_CATEGORIES].forEach((bucket) => {
    assert.ok(
      !recordable.has(bucket),
      `the generated asset carries the rule-bucket category "${bucket}", which would be recorded verbatim and ranked ` +
        "beside real categories in Most blocked categories"
    );
  });
});

// ---------------------------------------------------------------------------
// "Open anyway" has to exempt the host the app actually connects to
// ---------------------------------------------------------------------------
//
// BlockActivity stores the temporary unlock keyed by `brandId` — the entry's
// canonical domain — and the connection filter looked it up by the host it had
// just MATCHED. Those are the same string for almost every host and a different
// one for every ALIAS domain, and four shipped brands have both an Android app and
// an alias. For those, the user chose "Open anyway", the app was launched for
// them, and the filter reset its very next connection: re-blocked on the host they
// had just been let through.
//
// The fix is data: `meta[host].b` carries the brand id for alias hosts, and
// RuleEngine.brandIdFor resolves it. These assertions walk the REAL generated
// asset against the REAL package dataset, so they fail if either side stops
// carrying what the other needs.
test("every alias host in the rules asset resolves to the brand its unlock is stored under", () => {
  const meta = JSON.parse(read(RULES_ASSET)).meta;
  const brandIds = new Set(Object.values(JSON.parse(read(ASSET)).packages).map((p) => p.brandId));

  // RuleEngine.brandIdFor, in JS: `meta[host].b` when present, else the host.
  const brandIdFor = (host) => (meta[host] && meta[host].b) || host;

  const aliasHosts = Object.keys(meta).filter((host) => meta[host].b);
  assert.ok(
    aliasHosts.length > 0,
    "no host in the asset carries a brand id, so nothing here can prove the alias-unlock path works"
  );

  aliasHosts.forEach((host) => {
    const brand = brandIdFor(host);
    assert.notEqual(brand, host, `${host} carries a redundant brand id equal to itself`);
    assert.ok(meta[brand], `${host} points at "${brand}", which is not itself a blockable host in the asset`);
  });

  // The ones that reach a user: an alias whose brand has an Android app. A hit on
  // the alias must resolve to the brandId BlockActivity would have stored.
  const withApp = aliasHosts.filter((host) => brandIds.has(brandIdFor(host)));
  assert.ok(
    withApp.length > 0,
    "no alias host belongs to a brand with an Android package, so this can no longer reproduce the defect"
  );

  // And the non-alias case is unchanged: the host IS the brand.
  assert.equal(brandIdFor("doordash.com"), "doordash.com");
  assert.equal(
    brandIdFor("a-domain-nobody-curated.example"), "a-domain-nobody-curated.example",
    "a host the asset does not know — a user's own Custom URL — belongs to no brand and must answer itself"
  );
});

test("the filter looks a temporary unlock up by brand, not by the matched host", () => {
  const source = stripKotlinComments(read(VPN_SERVICE_KT));
  const call = /unlockExpiry\(this,\s*([^)]+)\)/.exec(source);
  assert.ok(call, "FitShieldVpnService no longer calls unlockExpiry in a form this guard can read");
  const argument = call[1].trim();

  // What matters is that the argument is the RESOLVED BRAND, not the matched host —
  // not the particular spelling. `brandIdFor(apex)` inline and a local bound from it
  // are the same fact, and 0.57 moved to the local so the allow-list check could
  // share the one lookup. So this rejects the apex and requires the source to derive
  // whatever it does pass from brandIdFor.
  assert.notEqual(
    argument, "apex",
    "the filter resolves the unlock by the matched host. For an alias domain that is not the key BlockActivity " +
      "stored the unlock under, so Open anyway is honoured for one connection and then the app is reset."
  );
  assert.match(
    source, new RegExp(String.raw`(val\s+${argument}\s*=\s*rules\.brandIdFor\(|unlockExpiry\(this,\s*rules\.brandIdFor\()`),
    `unlockExpiry is passed \`${argument}\`, and nothing in FitShieldVpnService derives that from ` +
      "RuleEngine.brandIdFor — so an alias host is judged by a brand id it does not carry"
  );

  const engine = read(RULE_ENGINE_KT);
  assert.match(engine, /fun brandIdFor\(/, "RuleEngine no longer exposes brandIdFor");
  assert.match(engine, /optString\("b",\s*""\)/, "RuleEngine no longer reads the brand id out of the generated asset");
});
