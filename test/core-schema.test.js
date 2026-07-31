"use strict";
/**
 * Storage schema + migration tests.
 *
 * The contract these protect: an existing FitShield profile must survive an
 * upgrade with nothing important lost, and the migration must be safe to run
 * twice, safe on garbage, and safe when several versions behind.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../extension/fitshield-core.js");

// A realistic pre-0.55 profile: every key a long-time user would have.
function legacyProfile() {
  return {
    enabled: true,
    timerSeconds: 45,
    passDurationMinutes: 7,
    scheduleEnabled: true,
    scheduleStart: "19:30",
    scheduleEnd: "02:00",
    deliverySitesEnabled: true,
    fastFoodSitesEnabled: false,
    customSitesEnabled: true,
    disabledDeliverySiteKeys: ["delivery-ubereats-com", "ubereats"],
    disabledFastFoodSiteKeys: ["fast_food-mcdonalds-com"],
    customSites: ["pizzaplace.example", { domain: "Wings.example", enabled: false }],
    siteBypasses: { "delivery-doordash-com": Date.now() + 10 * 60 * 1000 },
    enabledCountries: ["US", "CA"],
    enabledCategories: ["pizza"],
    quickAccessCountries: ["US"],
    quickAccessCategories: ["pizza"],
    blockedVisits: 137,
    caloriesAvoided: 8200,
    recipesChosen: 19,
    blockedByDomain: { "doordash.com": 40 },
    blockedByCategory: { pizza: 12 },
    blockedByCountry: { US: 40 },
    avgMealCost: 18,
    avgMealCalories: 1100,
    currency: "USD",
    theme: { accent: "#7ef0a8" },
    themeMode: "dark",
    uiLanguage: "de",
    lastSeenVersion: "0.54"
  };
}

test("a profile with no schemaVersion is treated as v1 and migrated", () => {
  const result = core.migrateState(legacyProfile());

  assert.equal(result.from, 1);
  assert.equal(result.to, core.SCHEMA_VERSION);
  assert.equal(result.changed, true);
  assert.equal(result.error, null);
  assert.equal(result.state[core.SCHEMA_KEY], core.SCHEMA_VERSION);
});

test("migration is idempotent — running it again changes nothing", () => {
  const once = core.migrateState(legacyProfile()).state;
  const twice = core.migrateState(once);

  assert.equal(twice.changed, false);
  assert.deepEqual(twice.state, once);
});

test("migration preserves every setting a user could notice", () => {
  const before = legacyProfile();
  const after = core.migrateState(before).state;

  // Blocking preferences survive verbatim.
  assert.equal(after.enabled, true);
  assert.equal(after.timerSeconds, 45);
  assert.equal(after.passDurationMinutes, 7);
  assert.equal(after.fastFoodSitesEnabled, false);
  assert.deepEqual(after.disabledDeliverySiteKeys, before.disabledDeliverySiteKeys);
  assert.deepEqual(after.disabledFastFoodSiteKeys, before.disabledFastFoodSiteKeys);
  assert.deepEqual(after.enabledCountries, ["US", "CA"]);
  assert.deepEqual(after.enabledCategories, ["pizza"]);
  assert.deepEqual(after.quickAccessCountries, ["US"]);

  // Appearance / language / stats maps are untouched.
  assert.deepEqual(after.theme, before.theme);
  assert.equal(after.uiLanguage, "de");
  assert.deepEqual(after.blockedByDomain, before.blockedByDomain);
  assert.deepEqual(after.blockedByCategory, before.blockedByCategory);
  assert.deepEqual(after.blockedByCountry, before.blockedByCountry);
  assert.equal(after.avgMealCost, 18);
});

test("legacy string customSites become records without losing the disabled one", () => {
  const after = core.migrateState(legacyProfile()).state;

  assert.deepEqual(after.customSites, [
    { domain: "pizzaplace.example", enabled: true },
    { domain: "wings.example", enabled: false }
  ]);
});

test("the flat schedule becomes a structured window and the flat keys stay readable", () => {
  const after = core.migrateState(legacyProfile()).state;

  assert.equal(after.schedule.mode, "windows");
  assert.equal(after.schedule.windows.length, 1);
  assert.equal(after.schedule.windows[0].start, "19:30");
  assert.equal(after.schedule.windows[0].end, "02:00");
  assert.deepEqual(after.schedule.windows[0].days, core.ALL_DAYS);

  // An older build reading this profile still finds what it understands.
  assert.equal(after.scheduleStart, "19:30");
  assert.equal(after.scheduleEnd, "02:00");
  assert.equal(after.scheduleEnabled, true);
});

test("scheduleEnabled:false keeps the window so switching it back on restores the hours", () => {
  const profile = { ...legacyProfile(), scheduleEnabled: false };
  const after = core.migrateState(profile).state;

  assert.equal(after.schedule.mode, "always");
  assert.equal(after.schedule.windows[0].start, "19:30");
});

test("statistics are translated, not reset, and the old counters stay put", () => {
  const after = core.migrateState(legacyProfile()).state;

  assert.equal(after.stats.totals.interruptions, 137, "blockedVisits becomes interruptions");
  assert.equal(after.stats.totals.alternativesSelected, 19, "recipesChosen becomes alternativesSelected");

  // Nothing the user watched grow is deleted.
  assert.equal(after.blockedVisits, 137);
  assert.equal(after.recipesChosen, 19);
  assert.equal(after.caloriesAvoided, 8200);

  // The calorie estimate is preserved in a recoverable legacy field and the
  // estimate panel stays switched on for someone who already had one.
  assert.equal(after.legacy.caloriesAvoided, 8200);
  assert.equal(after.showEstimates, true);
});

test("a fresh profile does not switch estimates on", () => {
  const after = core.migrateState({ blockedVisits: 3 }).state;
  assert.equal(after.showEstimates, undefined);
  assert.equal(core.readSettings(after).showEstimates, false);
});

test("an active site bypass survives as a site-scoped pass", () => {
  const profile = legacyProfile();
  const after = core.migrateState(profile).state;

  assert.equal(after.passes.length, 1);
  assert.equal(after.passes[0].scope, "site");
  assert.equal(after.passes[0].target, "doordash.com");
  assert.equal(after.passes[0].expiresAt, profile.siteBypasses["delivery-doordash-com"]);

  // The unmapped original is kept so nothing is silently discarded.
  assert.deepEqual(after.legacy.siteBypasses, profile.siteBypasses);
});

test("an already-expired bypass is not resurrected", () => {
  const after = core.migrateState({ siteBypasses: { "delivery-x-com": Date.now() - 1000 } }).state;
  assert.deepEqual(after.passes, []);
});

test("the friction profile is inferred from the timer without changing it", () => {
  assert.equal(core.migrateState({ timerSeconds: 20 }).state.frictionProfile, "light");
  assert.equal(core.migrateState({ timerSeconds: 60 }).state.frictionProfile, "standard");
  assert.equal(core.migrateState({ timerSeconds: 180 }).state.frictionProfile, "strict");
  assert.equal(core.migrateState({ timerSeconds: 180 }).state.timerSeconds, 180);
});

test("migration is safe on missing, empty, and malformed input", () => {
  for (const input of [undefined, null, {}, [], 42, "nope", { schemaVersion: "banana" }]) {
    const result = core.migrateState(input);
    assert.equal(result.error, null, `threw on ${JSON.stringify(input)}`);
    assert.equal(typeof result.state, "object");
  }

  const hostile = core.migrateState({
    customSites: [null, 7, { nope: true }, "ok.example"],
    siteBypasses: { bad: "soon", worse: null },
    stats: "not an object",
    schedule: { windows: "no" }
  });

  assert.equal(hostile.error, null);
  assert.deepEqual(hostile.state.customSites, [{ domain: "ok.example", enabled: true }]);
  assert.deepEqual(hostile.state.passes, []);
});

test("migration never lets a __proto__ key escape into the prototype", () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"blockedVisits":2}');
  const after = core.migrateState(payload).state;

  assert.equal({}.polluted, undefined);
  assert.equal(after.polluted, undefined);
  assert.equal(after.stats.totals.interruptions, 2);
});

test("a future schemaVersion is left alone rather than downgraded", () => {
  const future = { [core.SCHEMA_KEY]: 99, mystery: true };
  const result = core.migrateState(future);

  assert.equal(result.changed, false);
  assert.equal(result.state.mystery, true);
});

// ---------------------------------------------------------------------------
// readSettings
// ---------------------------------------------------------------------------

test("readSettings fills every default for an empty profile", () => {
  const settings = core.readSettings({});

  assert.equal(settings.enabled, true);
  assert.equal(settings.timerSeconds, core.DEFAULT_TIMER_SECONDS);
  assert.equal(settings.schedule.mode, "always");
  assert.deepEqual(settings.passes, []);
  assert.deepEqual(settings.pantry, []);
  assert.deepEqual(settings.equipment, core.DEFAULT_EQUIPMENT);
  assert.equal(settings.dietPreference, "omnivore");
  assert.equal(settings.showEstimates, false);
  core.STAT_EVENTS.forEach((event) => assert.equal(settings.stats.totals[event], 0));
});

test("readSettings clamps hostile numbers instead of trusting them", () => {
  const settings = core.readSettings({
    timerSeconds: 999999,
    passDurationMinutes: -5,
    repeatExtraSeconds: 10000,
    repeatWindowMinutes: 0
  });

  assert.equal(settings.timerSeconds, core.MAX_TIMER_SECONDS);
  assert.equal(settings.passDurationMinutes, core.MIN_PASS_DURATION_MINUTES);
  assert.equal(settings.repeatExtraSeconds, 120);
  assert.equal(settings.repeatWindowMinutes, 5);
});

test("readSettings understands a legacy flat schedule with no schedule object", () => {
  const settings = core.readSettings({ scheduleEnabled: true, scheduleStart: "22:00", scheduleEnd: "04:00" });

  assert.equal(settings.schedule.mode, "windows");
  assert.equal(settings.schedule.windows[0].start, "22:00");
  assert.equal(settings.schedule.windows[0].end, "04:00");
});

test("readSettings drops pantry and equipment values that are not in the vocabulary", () => {
  const settings = core.readSettings({
    pantry: ["eggs", "unicorn", "rice", "<script>"],
    equipment: ["microwave", "plasma cutter"]
  });

  assert.deepEqual(settings.pantry, ["eggs", "rice"]);
  assert.deepEqual(settings.equipment, ["microwave"]);
});

test("friction presets describe themselves consistently", () => {
  core.FRICTION_PROFILE_IDS.forEach((id) => {
    const values = core.frictionProfileValues(id);
    assert.equal(values.frictionProfile, id);
    assert.equal(core.detectFrictionProfile(values), id);
    assert.ok(values.timerSeconds >= core.MIN_TIMER_SECONDS);
  });

  assert.equal(core.frictionProfileValues("nope"), null);
  assert.equal(core.detectFrictionProfile({ timerSeconds: 37, passDurationMinutes: 9 }), "custom");
});

test("strict mode is reversible and never removes the override", () => {
  const strict = core.frictionProfileValues("strict");
  const light = core.frictionProfileValues("light");

  assert.ok(strict.settingsDelaySeconds > 0, "strict uses a cooling-off delay");
  assert.equal(light.settingsDelaySeconds, 0);
  // Switching back is a plain settings write with no extra state to unwind.
  assert.equal(core.detectFrictionProfile(light), "light");
});
