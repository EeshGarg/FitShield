"use strict";
/**
 * Backup / restore tests.
 *
 * Restore writes straight into the store the service worker trusts, so a backup
 * file is treated as hostile input. These tests cover both directions: that a
 * real profile survives a round trip with nothing important lost, and that a
 * malformed, oversized, or hostile file is refused without damaging what is
 * already there.
 *
 * NOTE ON SCOPE: one earlier test asserted that a wrapper whose `settings` was
 * NOT an object should be reinterpreted as bare settings — i.e. that
 * `{ enabled: true, settings: 5 }` restores a key literally called "settings"
 * with the value 5. That was permissive parsing of a file that is already
 * malformed, and it wrote a junk key into storage. It is replaced by a test
 * asserting the key is dropped.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backup = require("../extension/backup.js");
const core = require("../extension/fitshield-core.js");
const { parseBackup, extractSettings, normalizeImported } = backup;

// A realistic populated profile.
function profile() {
  return {
    schemaVersion: core.SCHEMA_VERSION,
    enabled: true,
    timerSeconds: 90,
    passDurationMinutes: 10,
    frictionProfile: "custom",
    schedule: { mode: "windows", windows: [{ days: [1, 2, 3], start: "18:00", end: "23:00" }], until: null },
    deliverySitesEnabled: true,
    fastFoodSitesEnabled: false,
    disabledDeliverySiteKeys: ["delivery-grubhub-com"],
    customSites: [{ domain: "pizza.example", enabled: true }],
    enabledCountries: ["US"],
    enabledCategories: ["pizza"],
    dietPreference: "vegetarian",
    pantry: ["eggs", "rice"],
    equipment: ["microwave", "stove"],
    avoidAllergens: ["peanut"],
    alternativeFavorites: ["naan-pizza"],
    customAlternatives: [
      {
        id: "custom-eggs",
        kind: "custom",
        title: "Emergency eggs",
        description: "",
        ingredients: ["2 eggs"],
        steps: ["Fry them."],
        totalMinutes: 5,
        activeMinutes: 5,
        equipment: ["stove"],
        diet: "vegetarian",
        categories: [],
        cravings: ["breakfast"],
        favorite: false,
        createdAt: 1
      }
    ],
    stats: { totals: { ...core.emptyStatTotals(), interruptions: 40, left: 22 }, history: [] },
    blockedByDomain: { "doordash.com": 12 },
    theme: { accent: "#7ef0a8" },
    uiLanguage: "de",
    blockedVisits: 40,
    caloriesAvoided: 3000
  };
}

const wrap = (settings) => ({
  _type: "fitshield-settings-backup",
  schema: backup.SCHEMA_VERSION,
  version: "0.55",
  exportedAt: "2026-07-31T00:00:00.000Z",
  keyCount: Object.keys(settings).length,
  settings
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test("a populated profile survives a full round trip", () => {
  const original = profile();
  const restored = normalizeImported(parseBackup(JSON.stringify(wrap(original))));

  assert.equal(restored.enabled, true);
  assert.equal(restored.timerSeconds, 90);
  assert.equal(restored.passDurationMinutes, 10);
  assert.equal(restored.fastFoodSitesEnabled, false);
  assert.deepEqual(restored.disabledDeliverySiteKeys, ["delivery-grubhub-com"]);
  assert.deepEqual(restored.enabledCategories, ["pizza"]);
  assert.equal(restored.dietPreference, "vegetarian");
  assert.deepEqual(restored.pantry, ["eggs", "rice"]);
  assert.deepEqual(restored.alternativeFavorites, ["naan-pizza"]);
  assert.equal(restored.customAlternatives.length, 1);
  assert.equal(restored.customAlternatives[0].title, "Emergency eggs");
  assert.equal(restored.stats.totals.interruptions, 40);
  assert.deepEqual(restored.blockedByDomain, { "doordash.com": 12 });
  assert.equal(restored.uiLanguage, "de");
});

test("the structured schedule round-trips intact", () => {
  const restored = normalizeImported(parseBackup(JSON.stringify(wrap(profile()))));

  assert.equal(restored.schedule.mode, "windows");
  assert.deepEqual(restored.schedule.windows[0].days, [1, 2, 3]);
  assert.equal(restored.schedule.windows[0].start, "18:00");
});

test("legacy counters are carried across so nothing a user watched grow is lost", () => {
  const restored = normalizeImported(parseBackup(JSON.stringify(wrap(profile()))));

  assert.equal(restored.blockedVisits, 40);
  assert.equal(restored.caloriesAvoided, 3000);
});

test("every durable key is exportable and no excluded key is", () => {
  backup.EXCLUDED_KEYS.forEach((key) => {
    assert.ok(!backup.DURABLE_KEYS.includes(key), `${key} must not be both durable and excluded`);
  });

  // The block-relevant preferences a user would be upset to re-enter.
  ["timerSeconds", "schedule", "customSites", "pantry", "customAlternatives", "stats"].forEach((key) => {
    assert.ok(backup.DURABLE_KEYS.includes(key), `${key} must be in a backup`);
  });
});

test("an active pass is never carried in a backup", () => {
  // Restoring one on another machine, or days later, would silently unblock a
  // site the user is not currently looking at.
  assert.ok(backup.EXCLUDED_KEYS.includes("passes"));
  assert.ok(backup.EXCLUDED_KEYS.includes("siteBypasses"));

  const withPass = parseBackup(JSON.stringify(wrap({ ...profile(), passes: [{ id: "x" }] })));
  assert.equal(withPass.passes, undefined, "a pass in the file is dropped on import");
});

// ---------------------------------------------------------------------------
// Legacy formats
// ---------------------------------------------------------------------------

test("a pre-wrapper bare settings object is still accepted", () => {
  const settings = extractSettings({ enabled: false, deliverySitesEnabled: true });
  assert.deepEqual(settings, { enabled: false, deliverySitesEnabled: true });
});

test("a schema-1 backup written before the decision flow restores cleanly", () => {
  const old = {
    _type: "fitshield-settings-backup",
    schema: 1,
    version: "0.54",
    settings: {
      enabled: true,
      timerSeconds: 45,
      scheduleEnabled: true,
      scheduleStart: "19:00",
      scheduleEnd: "23:00",
      customSites: ["legacy.example"],
      blockedVisits: 7,
      recipesChosen: 2
    }
  };

  const restored = normalizeImported(parseBackup(JSON.stringify(old)));

  assert.equal(restored.timerSeconds, 45);
  assert.equal(restored.blockedVisits, 7);
  // The flat schedule is understood even though the file has no schedule object.
  assert.equal(restored.scheduleStart, "19:00");
});

test("a backup from a NEWER format version is refused with an actionable message", () => {
  const future = { _type: "fitshield-settings-backup", schema: 99, settings: { enabled: true } };

  assert.throws(() => parseBackup(JSON.stringify(future)), /newer version of FitShield/);
});

// ---------------------------------------------------------------------------
// Malformed, oversized, and hostile input
// ---------------------------------------------------------------------------

test("invalid JSON is refused", () => {
  assert.throws(() => parseBackup("{not json"), /valid JSON/);
});

test("an empty file is refused", () => {
  assert.throws(() => parseBackup(""), /empty/);
});

test("an oversized file is refused before it is parsed", () => {
  const huge = JSON.stringify({ settings: { theme: "x".repeat(backup.MAX_BYTES) } });

  assert.ok(huge.length > backup.MAX_BYTES);
  assert.throws(() => parseBackup(huge), /too large/);
});

test("non-objects and arrays are refused", () => {
  assert.throws(() => extractSettings(null), /FitShield backup/);
  assert.throws(() => extractSettings([1, 2, 3]), /FitShield backup/);
  assert.throws(() => extractSettings("nope"), /FitShield backup/);
  assert.throws(() => parseBackup("[]"), /FitShield backup/);
  assert.throws(() => parseBackup("42"), /FitShield backup/);
});

test("a file with a foreign _type is refused", () => {
  const foreign = { _type: "some-other-extension", settings: { enabled: true } };
  assert.throws(() => parseBackup(JSON.stringify(foreign)), /not a FitShield backup/);
});

test("a file with nothing FitShield recognises is refused rather than silently applied", () => {
  assert.throws(() => parseBackup(JSON.stringify({ someOtherApp: true })), /no FitShield settings/);
});

test("keys FitShield does not own are dropped, not written into storage", () => {
  const settings = parseBackup(
    JSON.stringify(wrap({ enabled: true, evilKey: "payload", settings: 5, __proto__: { polluted: true } }))
  );

  assert.equal(settings.evilKey, undefined, "an unknown key is dropped");
  assert.equal(settings.settings, undefined, "a junk 'settings' key is dropped");
  assert.deepEqual(Object.keys(settings), ["enabled"]);
});

test("a prototype-pollution payload cannot escape into Object.prototype", () => {
  const hostile = '{"settings":{"enabled":true,"theme":{"__proto__":{"polluted":true}}}}';
  const settings = parseBackup(hostile);

  assert.equal({}.polluted, undefined, "Object.prototype was not touched");
  assert.equal(settings.theme.polluted, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(settings.theme, "__proto__"));
});

test("a hostile custom alternative is sanitized rather than trusted", () => {
  const hostile = wrap({
    enabled: true,
    customAlternatives: [
      {
        id: "x",
        name: '<img src=x onerror="alert(1)">',
        steps: ['<script>alert(1)</script>'],
        ingredients: ["1 cup <b>bold</b>"],
        totalMinutes: 999999,
        equipment: ["plasma cutter"],
        diet: "carnivore"
      },
      { name: "", steps: [] }
    ]
  });

  const restored = normalizeImported(parseBackup(JSON.stringify(hostile)));

  assert.equal(restored.customAlternatives.length, 1, "the entry with no name or steps is dropped");

  const entry = restored.customAlternatives[0];
  // The text is kept verbatim as TEXT — the renderer uses textContent, so markup
  // in a name is inert. What matters is that the shape is normalized.
  assert.equal(typeof entry.title, "string");
  assert.ok(entry.totalMinutes <= 24 * 60, "an absurd duration is clamped");
  assert.deepEqual(entry.equipment.filter((item) => item === "plasma cutter"), [], "unknown equipment is dropped");
  assert.ok(core.DIETS.includes(entry.diet), "an unknown diet falls back to a known one");
});

test("hostile numbers in a backup are clamped by the same rules the runtime uses", () => {
  const restored = normalizeImported(
    parseBackup(JSON.stringify(wrap({ enabled: true, timerSeconds: 9999999, passDurationMinutes: -50 })))
  );

  assert.equal(restored.timerSeconds, core.MAX_TIMER_SECONDS);
  assert.equal(restored.passDurationMinutes, core.MIN_PASS_DURATION_MINUTES);
});

test("a partial backup restores only what it carried", () => {
  const restored = normalizeImported(parseBackup(JSON.stringify(wrap({ timerSeconds: 30 }))));

  assert.deepEqual(Object.keys(restored).sort(), ["schemaVersion", "timerSeconds"]);
  assert.equal(restored.enabled, undefined, "a key the file did not carry is not reset to a default");
});

test("an import is stamped with the current schema version", () => {
  const restored = normalizeImported(parseBackup(JSON.stringify(wrap({ enabled: true }))));
  assert.equal(restored[core.SCHEMA_KEY], core.SCHEMA_VERSION);
});

// ---------------------------------------------------------------------------
// Load order
// ---------------------------------------------------------------------------
//
// backup.js used to bind FitShieldCore at load time. It is loaded before
// fitshield-core.js on both pages that use it, so in the browser the binding
// resolved to null and `normalizeImported` silently returned the file
// unvalidated — while Node tests kept passing, because `require` was available
// there. The tests below pin both halves of the fix: the module must work
// whatever order it is loaded in, and the pages must load core first anyway.

test("backup.js validates even when it is evaluated BEFORE fitshield-core.js", () => {
  const vm = require("node:vm");

  const sandbox = { console, JSON, Object, Array, Number, String, Date, Math, Error };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  // Deliberately the wrong order: backup first, core second, no `require`.
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "backup.js"), "utf8"), context, {
    filename: "backup.js"
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "fitshield-core.js"), "utf8"), context, {
    filename: "fitshield-core.js"
  });

  const restored = sandbox.FitShieldBackup.normalizeImported(
    sandbox.FitShieldBackup.parseBackup(JSON.stringify(wrap({ enabled: true, timerSeconds: 9999999 })))
  );

  assert.equal(restored.timerSeconds, core.MAX_TIMER_SECONDS, "the hostile value must still be clamped");
  assert.equal(restored[core.SCHEMA_KEY], core.SCHEMA_VERSION, "the import must still be stamped");
});

test("an import refuses rather than degrades when the validator is genuinely absent", () => {
  const vm = require("node:vm");

  const sandbox = { console, JSON, Object, Array, Number, String, Date, Math, Error };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  // core never loads at all.
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "backup.js"), "utf8"), context, {
    filename: "backup.js"
  });

  assert.throws(
    () => sandbox.FitShieldBackup.normalizeImported({ enabled: true }),
    /could not validate/i,
    "silently importing un-normalized settings is the failure this must prevent"
  );
});

test("every page loads fitshield-core.js before anything that uses it", () => {
  const USERS = ["backup.js", "settings.js", "preferences.js", "welcome.js", "warning.js", "recipes.js"];

  ["settings.html", "welcome.html", "warning.html", "popup.html"].forEach((page) => {
    const html = fs.readFileSync(path.join(__dirname, "..", "extension", page), "utf8");
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);

    const coreIndex = scripts.indexOf("fitshield-core.js");
    const userIndex = scripts.findIndex((script) => USERS.includes(script));

    if (userIndex === -1) {
      return;
    }

    assert.notEqual(coreIndex, -1, `${page} loads ${scripts[userIndex]} but never loads fitshield-core.js`);
    assert.ok(
      coreIndex < userIndex,
      `${page} loads ${scripts[userIndex]} (position ${userIndex}) before fitshield-core.js (position ${coreIndex})`
    );

    assert.equal(
      scripts.filter((script) => script === "fitshield-core.js").length,
      1,
      `${page} loads fitshield-core.js more than once`
    );
  });
});

// ---------------------------------------------------------------------------
// Release metadata
// ---------------------------------------------------------------------------

test("changelog.json is valid and lists the current version", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
  const changelog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "changelog.json"), "utf8"));

  assert.ok(Array.isArray(changelog.entries) && changelog.entries.length > 0);
  changelog.entries.forEach((entry) => {
    assert.equal(typeof entry.version, "string");
    assert.equal(typeof entry.title, "string");
    assert.ok(Array.isArray(entry.changes) && entry.changes.length > 0);
  });

  assert.ok(
    changelog.entries.some((entry) => entry.version === manifest.version),
    "changelog should include the current manifest version"
  );
});

// ---------------------------------------------------------------------------
// Round-trip durability
//
// `readSettings` silently owned `customSites` through the defaults spread but
// never populated it, so `normalizeImported` preferred that empty default over
// the file's real value: an export followed by an import deleted every custom
// blocked domain and reported success. And every import stamped
// SCHEMA_VERSION before migrating, so a 0.54 backup's counters were never
// translated and all seven statistics read zero.
// ---------------------------------------------------------------------------

test("custom blocked sites survive an export/import round trip", () => {
  const sites = [
    { domain: "pizzahut.co.uk", enabled: true },
    { domain: "localkebab.example", enabled: false }
  ];

  const restored = backup.normalizeImported(
    backup.parseBackup(
      JSON.stringify({
        _type: "fitshield-settings-backup",
        schema: 2,
        settings: { customSites: sites, enabled: true }
      })
    )
  );

  assert.deepEqual(restored.customSites, sites, "the domains must come back exactly as exported");
});

test("a legacy string[] of custom sites is upgraded, not dropped", () => {
  const restored = backup.normalizeImported(
    backup.parseBackup(
      JSON.stringify({
        _type: "fitshield-settings-backup",
        schema: 1,
        settings: { customSites: ["https://www.foo.example/menu", "bar.example"] }
      })
    )
  );

  assert.deepEqual(restored.customSites, [
    { domain: "foo.example", enabled: true },
    { domain: "bar.example", enabled: true }
  ]);
});

test("a 0.54 backup's counters reach the statistics the panel reads", () => {
  const restored = backup.normalizeImported(
    backup.parseBackup(
      JSON.stringify({
        _type: "fitshield-settings-backup",
        schema: 1,
        version: "0.54",
        settings: { blockedVisits: 137, recipesChosen: 19, caloriesAvoided: 8200 }
      })
    )
  );

  assert.equal(restored.stats.totals.interruptions, 137, "blockedVisits must become interruptions");
  assert.equal(restored.stats.totals.alternativesSelected, 19, "recipesChosen must become alternativesSelected");
  assert.equal(restored.blockedVisits, 137, "and the original counter is still preserved");
  assert.equal(restored.schemaVersion, 2);
});

test("a 0.54 schedule reaches the structured form on restore", () => {
  const restored = backup.normalizeImported(
    backup.parseBackup(
      JSON.stringify({
        _type: "fitshield-settings-backup",
        schema: 1,
        settings: { scheduleEnabled: true, scheduleStart: "19:30", scheduleEnd: "02:00" }
      })
    )
  );

  assert.equal(restored.schedule.mode, "windows");
  assert.deepEqual(restored.schedule.windows, [{ days: [0, 1, 2, 3, 4, 5, 6], start: "19:30", end: "02:00" }]);
});

test("a partial backup still does not overwrite anything it did not carry", () => {
  // The migration fills in every default; adopting those would let a two-key
  // file wipe the current profile's schedule, passes and statistics.
  const restored = backup.normalizeImported(
    backup.parseBackup(
      JSON.stringify({ _type: "fitshield-settings-backup", schema: 2, settings: { timerSeconds: 30 } })
    )
  );

  assert.deepEqual(Object.keys(restored).sort(), ["schemaVersion", "timerSeconds"]);
});

test("every durable key survives a full round trip with its value intact", () => {
  // The class of bug above, generalised: any key readSettings does not handle
  // is silently replaced by its default on import.
  const profile = {
    customSites: [{ domain: "wings.example", enabled: false }],
    pantry: ["eggs", "rice"],
    equipment: ["microwave", "stove"],
    avoidAllergens: ["peanut"],
    dietPreference: "vegetarian",
    alternativeFavorites: ["naan-pizza"],
    enabledCountries: ["GB", "US"],
    enabledCategories: ["pizza"],
    disabledDeliverySiteKeys: ["delivery-ubereats-com"],
    timerSeconds: 45,
    passDurationMinutes: 12,
    frictionProfile: "custom",
    uiLanguage: "fr",
    showEstimates: true,
    avgMealCost: 22
  };

  const restored = backup.normalizeImported(
    backup.parseBackup(JSON.stringify({ _type: "fitshield-settings-backup", schema: 2, settings: profile }))
  );

  Object.keys(profile).forEach((key) => {
    assert.deepEqual(restored[key], profile[key], `${key} must survive the round trip unchanged`);
  });
});
