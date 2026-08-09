"use strict";
/**
 * End-to-end customer scenarios.
 *
 * Each of these is a situation a real person is in, driven through the real
 * worker and the real matching engine. They exist because unit tests can all
 * pass while the product still fails the person using it — "does a vegetarian
 * ever see meat?" is not a property of any single function.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const core = require("../extension/fitshield-core.js");
const recipes = require("../extension/recipes.js");

// --- worker harness (same shape as blocking.test.js) ------------------------

let engineBundlePath = null;
function bundledEngine() {
  if (!engineBundlePath) {
    const { bundleEngine } = require("../build.js");
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "fs-scenario-"));
    engineBundlePath = path.join(dir, "blocklist.js");
    fs.writeFileSync(engineBundlePath, bundleEngine());
  }
  return engineBundlePath;
}

function srcPath(rel) {
  if (rel === "blocklist.js") return bundledEngine();
  const candidates = [path.join(ROOT, "extension", rel), path.join(ROOT, "data", rel), path.join(ROOT, rel)];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[2];
}

function loadWorker(initialStore) {
  const store = { ...(initialStore || {}) };
  const listeners = {};
  let openTabs = [{ id: 1 }];

  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.55", name: "FitShield" }),
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      lastError: null
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys === null || keys === undefined) return { ...store };
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); }
      },
      onChanged: { addListener: () => {} }
    },
    tabs: {
      query: async () => openTabs.slice(),
      create: () => {},
      onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } }
    },
    alarms: {
      _set: {},
      clear: async (n) => { delete chrome.alarms._set[n]; },
      create: async (n, o) => { chrome.alarms._set[n] = o; },
      onAlarm: { addListener: () => {} }
    },
    declarativeNetRequest: {
      _rules: [],
      getDynamicRules: (cb) => cb(chrome.declarativeNetRequest._rules),
      updateDynamicRules: (opts, cb) => { chrome.declarativeNetRequest._rules = opts.addRules || []; cb(); }
    }
  };

  const sandbox = {
    chrome,
    console,
    fetch: async (url) => {
      const rel = url.replace("chrome-extension://test/", "");
      return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(srcPath(rel), "utf8")) };
    },
    setTimeout, URL, Math, Date, JSON, Promise
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  sandbox.importScripts = (f) => vm.runInContext(fs.readFileSync(srcPath(f), "utf8"), context, { filename: f });
  vm.runInContext(fs.readFileSync(srcPath("background.js"), "utf8"), context, { filename: "background.js" });

  return {
    context,
    store,
    listeners,
    setOpenTabs: (tabs) => { openTabs = tabs; },
    rules: () => chrome.declarativeNetRequest._rules,
    message: (payload) =>
      new Promise((resolve) => {
        const handled = listeners.message(payload, {}, resolve);
        if (!handled) resolve(null);
      })
  };
}

const blocks = (worker, domain) => worker.rules().some((r) => r.condition.urlFilter === `||${domain}`);

let catalogReady = false;
async function withCatalog() {
  if (!catalogReady) {
    await recipes.loadCatalog();
    catalogReady = true;
  }
}

// ===========================================================================
// Scenario 1 — Late-night pizza craving
// ===========================================================================

test("Scenario 1: it is 11pm, they open a pizza site and want food NOW", async () => {
  await withCatalog();
  const worker = loadWorker();
  await worker.context.queueRefreshBlockingState();

  assert.ok(blocks(worker, "dominos.com"), "the pizza site is interrupted");

  const context = await worker.message({ type: "getBlockContext", site: "fast-food-dominos-com" });
  assert.equal(context.found, true);
  assert.equal(context.site.label, "Domino's");

  // The default answer is pizza-shaped.
  const best = recipes.selectAlternative(context.site, context.preferences).entry;
  assert.ok(best.cravings.includes("pizza"), `expected a pizza answer, got ${best.id}`);

  // "I'm hungry" gets something genuinely fast.
  const fast = recipes.selectAlternative(context.site, context.preferences, { filter: "fastest", intent: "hungry" });
  assert.ok(fast.entry.totalMinutes <= 15, `${fast.entry.id} takes ${fast.entry.totalMinutes} min`);
  assert.deepEqual(fast.relaxed, [], "a fast pizza answer exists without relaxing anything");

  // And it is executable, not a gesture.
  assert.ok(fast.entry.ingredients.every((i) => i.quantity > 0 && i.unit), "every ingredient has a quantity");
  assert.ok(fast.entry.steps.length >= 2);

  // Late-night specifically has answers too.
  const lateNight = recipes.rankAlternatives(context.site, context.preferences).matches
    .filter((m) => m.entry.cravings.includes("late-night"));
  assert.ok(lateNight.length >= 3, "there are several late-night options");
});

// ===========================================================================
// Scenario 2 — A legitimate family order
// ===========================================================================

test("Scenario 2: they genuinely need to order for someone else", async () => {
  const worker = loadWorker();
  await worker.context.queueRefreshBlockingState();

  // The intent prompt routes straight to the pass options; granting one works.
  const granted = await worker.message({
    type: "grantPass",
    site: "delivery-doordash-com",
    presetId: "site30",
    intent: "someone-else"
  });

  assert.equal(granted.ok, true);
  assert.match(granted.destination, /doordash\.com/, "they reach the site they asked for");

  await worker.context.queueRefreshBlockingState();
  assert.ok(!blocks(worker, "doordash.com"), "and are not re-blocked");
  assert.ok(blocks(worker, "kfc.com"), "while everything else stays protected");

  // It is recorded as what it was — a deliberate continuation — and NOT as any
  // kind of personal calorie or savings event.
  const totals = worker.store.stats.totals;
  assert.equal(totals.continued, 1);
  assert.equal(totals.passesUsed, 1);
  assert.equal(totals.alternativesSelected, 0, "nothing implies they chose to cook");
  assert.equal(worker.store.caloriesAvoided, undefined, "no calorie claim was made");

  const serialized = JSON.stringify(worker.store);
  assert.ok(!/caloriesAvoided/.test(serialized), "the profile gained no calorie figure");
});

// ===========================================================================
// Scenario 3 — A vegetarian
// ===========================================================================

test("Scenario 3: a vegetarian never sees meat, on any blocked site", async () => {
  await withCatalog();
  const worker = loadWorker({ dietPreference: "vegetarian" });
  await worker.context.queueRefreshBlockingState();

  const sites = ["fast-food-kfc-com", "fast-food-mcdonalds-com", "delivery-doordash-com", "fast-food-dominos-com"];

  for (const key of sites) {
    const context = await worker.message({ type: "getBlockContext", site: key });
    assert.equal(context.preferences.dietPreference, "vegetarian");

    const ranked = recipes.rankAlternatives(context.site, context.preferences);
    assert.ok(ranked.matches.length > 0, `${key} still offers something`);

    ranked.matches.forEach((match) => {
      assert.ok(
        ["vegan", "vegetarian"].includes(match.entry.diet),
        `${match.entry.id} (${match.entry.diet}) was offered on ${key}`
      );

      // And the label is accurate, not just declared.
      match.entry.ingredients
        .filter((i) => !i.optional)
        .forEach((ingredient) => {
          assert.doesNotMatch(
            ingredient.item,
            /\b(beef|pork|bacon|ham|chicken|turkey|lamb|sausage|salami|pepperoni|prosciutto|chorizo|tuna|salmon|prawns?|shrimp)\b/i,
            `${match.entry.id} is labelled ${match.entry.diet} but requires "${ingredient.item}"`
          );
        });
    });
  }

  // Even the fried-chicken answer is a stated substitute, not a chicken dish.
  const chickenContext = await worker.message({ type: "getBlockContext", site: "fast-food-kfc-com" });
  const best = recipes.selectAlternative(chickenContext.site, chickenContext.preferences).entry;
  assert.ok(["vegan", "vegetarian"].includes(best.diet));
});

// ===========================================================================
// Scenario 4 — A minimal kitchen
// ===========================================================================

test("Scenario 4: a microwave and a cupboard is enough to be useful", async () => {
  await withCatalog();
  const worker = loadWorker({
    equipment: ["microwave"],
    pantry: ["rice", "canned beans", "bread", "eggs", "cheese"]
  });
  await worker.context.queueRefreshBlockingState();

  const context = await worker.message({ type: "getBlockContext", site: "delivery-doordash-com" });
  const ranked = recipes.rankAlternatives(context.site, context.preferences);

  assert.ok(ranked.matches.length >= 8, `only ${ranked.matches.length} options for a microwave kitchen`);
  assert.deepEqual(ranked.relaxed, [], "nothing had to be relaxed");

  ranked.matches.forEach((match) => {
    assert.ok(
      recipes.equipmentAvailable(match.entry, ["microwave"]),
      `${match.entry.id} needs ${match.entry.equipment.join(", ")}`
    );
  });

  // The top pick should use something they said they keep.
  const top = ranked.matches[0].entry;
  const ingredients = top.ingredients.map((i) => i.item.toLowerCase()).join(" ");
  assert.match(ingredients, /rice|bean|bread|egg|cheese/, `${top.id} ignores the declared pantry`);
});

// ===========================================================================
// Scenario 5 — Repeat access
// ===========================================================================

test("Scenario 5: coming back soon after continuing is noticed, explained, and capped", async () => {
  const worker = loadWorker();
  await worker.context.queueRefreshBlockingState();

  const first = await worker.message({ type: "getBlockContext", site: "delivery-doordash-com" });
  assert.equal(first.repeat.repeat, false, "the first visit is unremarkable");

  await worker.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "siteDefault" });

  const second = await worker.message({ type: "getBlockContext", site: "delivery-doordash-com" });
  assert.equal(second.repeat.repeat, true);
  assert.ok(second.timerSeconds > first.timerSeconds, "the pause is a little longer");
  assert.ok(second.repeat.windowMinutes > 0, "and the page can say when it lapses");

  // Repeated bypasses do NOT compound.
  for (let i = 0; i < 5; i += 1) {
    await worker.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "siteDefault" });
  }
  const sixth = await worker.message({ type: "getBlockContext", site: "delivery-doordash-com" });
  assert.equal(sixth.timerSeconds, second.timerSeconds, "friction is capped, not exponential");

  // The override is still there. It is never taken away.
  const escape = await worker.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "site30" });
  assert.equal(escape.ok, true);
});

test("Scenario 5b: strict mode is stricter but still reversible and still has an override", async () => {
  const strict = core.frictionProfileValues("strict");
  const worker = loadWorker(strict);
  await worker.context.queueRefreshBlockingState();

  const context = await worker.message({ type: "getBlockContext", site: "delivery-doordash-com" });
  assert.equal(context.timerSeconds, strict.timerSeconds);

  // The block page's own way out still works under strict.
  const granted = await worker.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "siteDefault" });
  assert.equal(granted.ok, true);

  // And switching back down is a plain settings write with nothing to unwind.
  const light = core.frictionProfileValues("light");
  assert.equal(core.detectFrictionProfile(light), "light");
});

// ===========================================================================
// Scenario 6 — An existing user upgrades
// ===========================================================================

test("Scenario 6: a populated 0.54 profile upgrades without losing anything", async () => {
  const before = {
    enabled: true,
    timerSeconds: 90,
    passDurationMinutes: 12,
    scheduleEnabled: true,
    // Hours that always cover "now", so the blocking assertions below are not
    // time-of-day dependent. The schedule VALUES are asserted verbatim.
    scheduleStart: "00:00",
    scheduleEnd: "23:59",
    deliverySitesEnabled: true,
    fastFoodSitesEnabled: true,
    disabledDeliverySiteKeys: ["delivery-grubhub-com"],
    disabledFastFoodSiteKeys: ["mcdonalds"],
    customSites: ["localpizza.example", { domain: "wings.example", enabled: false }],
    // Country blocking is deliberately ADDITIVE — it can re-block a brand the
    // user whitelisted. That is existing, intended behaviour and is covered in
    // blocking.test.js; keeping it out here isolates the migration properties.
    enabledCategories: ["pizza"],
    quickAccessCategories: ["pizza"],
    blockedVisits: 214,
    recipesChosen: 31,
    caloriesAvoided: 12400,
    blockedByDomain: { "doordash.com": 60, "kfc.com": 25 },
    blockedByCategory: { pizza: 30 },
    blockedByCountry: { US: 60 },
    avgMealCost: 22,
    avgMealCalories: 1100,
    currency: "GBP",
    theme: { accent: "#7ef0a8" },
    themeMode: "dark",
    cardOrder: ["protection-status", "blocking-options"],
    uiLanguage: "fr"
  };

  const worker = loadWorker({ ...before });
  await worker.context.queueRefreshBlockingState();
  const after = worker.store;

  // Nothing the user set is different.
  assert.equal(after.timerSeconds, 90);
  assert.equal(after.passDurationMinutes, 12);
  assert.equal(after.uiLanguage, "fr");
  assert.equal(after.currency, "GBP");
  assert.equal(after.avgMealCost, 22);
  assert.deepEqual(JSON.parse(JSON.stringify(after.theme)), before.theme);
  assert.deepEqual(JSON.parse(JSON.stringify(after.cardOrder)), before.cardOrder);
  assert.deepEqual(JSON.parse(JSON.stringify(after.enabledCategories)), ["pizza"]);

  // Statistics were translated, and the originals are still present.
  assert.equal(after.stats.totals.interruptions, 214);
  assert.equal(after.stats.totals.alternativesSelected, 31);
  assert.equal(after.blockedVisits, 214);
  assert.equal(after.caloriesAvoided, 12400);
  assert.deepEqual(JSON.parse(JSON.stringify(after.blockedByDomain)), before.blockedByDomain);

  // Whitelists still apply, in BOTH key formats.
  assert.ok(!blocks(worker, "grubhub.com"), "the current-format exception holds");
  assert.ok(!blocks(worker, "mcdonalds.com"), "the pre-0.55 exception holds");

  // Custom sites survive, including the disabled one.
  assert.ok(blocks(worker, "localpizza.example"));
  assert.ok(!blocks(worker, "wings.example"), "a disabled custom site stays disabled");

  // The schedule kept its hours.
  assert.equal(after.schedule.windows[0].start, "00:00");
  assert.equal(after.schedule.windows[0].end, "23:59");
  assert.equal(after.scheduleStart, "00:00", "the legacy keys are still readable");
});

// ===========================================================================
// Scenario 7 — Browser restart
// ===========================================================================

test("Scenario 7: passes and schedule state behave correctly across a restart", async () => {
  const now = Date.now();

  // A profile mid-session: one pass with time left, one already expired, and a
  // schedule override that has passed.
  const worker = loadWorker({
    passes: [
      { id: "live", scope: "site", target: "doordash.com", createdAt: now - 60000, expiresAt: now + 600000, maxDurationMs: 900000, used: false },
      { id: "dead", scope: "site", target: "kfc.com", createdAt: now - 7200000, expiresAt: now - 60000, maxDurationMs: 600000, used: false }
    ],
    schedule: { mode: "always", windows: [], until: now - 1000 }
  });

  // The restart.
  worker.listeners.startup();
  await worker.context.queueRefreshBlockingState();

  assert.ok(!blocks(worker, "doordash.com"), "a pass with time left survives the restart");
  assert.ok(blocks(worker, "kfc.com"), "an expired pass does not");
  assert.equal(worker.store.passes.length, 1, "and the expired one is cleaned out");

  // The lapsed schedule override no longer forces blocking on.
  assert.equal(core.evaluateSchedule({ mode: "always", windows: [], until: now - 1000 }).reason, "always");

  // A second restart much later expires the remaining pass too.
  const later = loadWorker({ passes: JSON.parse(JSON.stringify(worker.store.passes)) });
  const stored = later.store.passes[0];
  assert.equal(core.activePasses([stored], now + 20 * 60 * 1000).length, 0, "gone 20 minutes later");
});

// ===========================================================================
// Scenario 8 — A bad imported backup
// ===========================================================================

test("Scenario 8: malformed, oversized, and hostile backups are refused safely", () => {
  const backup = require("../extension/backup.js");

  const good = JSON.stringify({
    _type: "fitshield-settings-backup",
    schema: 2,
    settings: { enabled: true, timerSeconds: 75, pantry: ["eggs"] }
  });
  const restored = backup.normalizeImported(backup.parseBackup(good));
  assert.equal(restored.timerSeconds, 75, "a good file still works");

  const bad = [
    ["not json at all", /valid JSON/],
    ["", /empty/],
    ["[]", /FitShield backup/],
    ["null", /FitShield backup/],
    ['{"_type":"other-extension","settings":{"enabled":true}}', /not a FitShield backup/],
    ['{"_type":"fitshield-settings-backup","schema":99,"settings":{}}', /newer version/],
    ['{"totallyUnrelated":true}', /no FitShield settings/],
    [JSON.stringify({ settings: { theme: "x".repeat(backup.MAX_BYTES) } }), /too large/]
  ];

  bad.forEach(([text, pattern]) => {
    assert.throws(() => backup.parseBackup(text), pattern, `should have refused: ${text.slice(0, 40)}`);
  });

  // Hostile content that DOES parse is neutralised rather than stored.
  const hostile = backup.normalizeImported(
    backup.parseBackup(
      JSON.stringify({
        settings: {
          enabled: true,
          timerSeconds: 999999999,
          evilKey: "payload",
          customAlternatives: [{ name: "<script>x</script>", steps: ["y"], equipment: ["nuclear reactor"] }],
          __proto__: { polluted: true }
        }
      })
    )
  );

  assert.equal({}.polluted, undefined, "Object.prototype is intact");
  assert.equal(hostile.evilKey, undefined, "an unknown key never reaches storage");
  assert.equal(hostile.timerSeconds, core.MAX_TIMER_SECONDS, "an absurd value is clamped");
  assert.deepEqual(hostile.customAlternatives[0].equipment.filter((e) => e === "nuclear reactor"), []);
});

// ===========================================================================
// Scenario 9 — Keyboard and screen reader
// ===========================================================================

test("Scenario 9: the block page can be completed without a mouse", () => {
  const html = fs.readFileSync(path.join(ROOT, "extension", "warning.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "extension", "warning.js"), "utf8");

  // Every action is a real <button>, so it is focusable and activates on Enter
  // and Space with no extra keyboard handling.
  ["back", "continue", "chooseAlt", "anotherAlt", "favAlt", "intentSkip", "passCancel"].forEach((id) => {
    assert.ok(
      new RegExp(`<button[^>]*id="${id}"`).test(html),
      `#${id} must be a <button> to be keyboard-operable`
    );
  });

  // Nothing is a div-with-onclick.
  assert.ok(!/<div[^>]*onclick/i.test(html));

  // The scrolling steps container is reachable by keyboard.
  assert.ok(/id="altStepsScroll"[^>]*tabindex="0"/.test(html), "a scroll container must be focusable");

  // Focus is visible.
  assert.ok(/:focus-visible\s*\{[^}]*outline/.test(html), "focus must be visible");

  // Toggle state is programmatic, not visual.
  assert.ok(/aria-pressed/.test(js));

  // Ingredients and steps are real lists in the right order.
  assert.ok(/<ul class="alt-ingredients"/.test(html));
  assert.ok(/<ol class="alt-steps"/.test(html));

  // Headings form an outline rather than being styled text.
  assert.ok(/<h1 id="pauseTitle"/.test(html));
  assert.ok(/<h2 id="altTitle"/.test(html));
});

test("Scenario 9b: the countdown does not flood a screen reader", () => {
  const html = fs.readFileSync(path.join(ROOT, "extension", "warning.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "extension", "warning.js"), "utf8");

  // The number itself is hidden from assistive technology…
  assert.ok(/id="timer"[^>]*aria-hidden="true"/.test(html), "the per-second number must not be announced");

  // …and a separate polite region announces milestones only.
  assert.ok(/id="timerAnnounce"[^>]*aria-live="polite"/.test(html));
  assert.ok(/ANNOUNCE_AT\s*=\s*new Set/.test(js), "announcements are limited to specific moments");

  const milestones = /ANNOUNCE_AT = new Set\(\[([^\]]*)\]/.exec(js);
  assert.ok(milestones, "the milestone list should be explicit");
  assert.ok(milestones[1].split(",").length <= 6, "only a handful of announcements");

  // Reduced motion is honoured, and no animation gates an action.
  assert.ok(/prefers-reduced-motion/.test(html));
  assert.ok(/prefersReducedMotion/.test(js));
});

// ===========================================================================
// Scenario 10 — Offline
// ===========================================================================

test("Scenario 10: everything works with no network at all", async () => {
  await withCatalog();

  // The worker harness only ever resolves packaged files; if any code path
  // needed the network it would already have failed. Assert it explicitly: the
  // only fetch targets are runtime.getURL paths.
  const runtimeFiles = require("../build.js").FILES
    .map(([src, dest]) => [String(dest), src])
    .filter(([dest]) => dest.endsWith(".js"));

  runtimeFiles.forEach(([name, src]) => {
    const source = fs.readFileSync(src, "utf8");
    for (const match of source.matchAll(/fetch\s*\(([^)]*)\)/g)) {
      assert.match(match[1], /getURL/, `${name} fetches something that is not packaged`);
    }
  });

  // The whole decision path runs with no I/O beyond the packaged catalog.
  const worker = loadWorker();
  await worker.context.queueRefreshBlockingState();
  assert.ok(worker.rules().length > 0, "blocking works offline");

  const context = await worker.message({ type: "getBlockContext", site: "fast-food-kfc-com" });
  assert.equal(context.found, true);

  const pick = recipes.selectAlternative(context.site, context.preferences);
  assert.ok(pick.entry, "an alternative is chosen offline");
  assert.ok(pick.entry.steps.length > 0, "with full instructions available offline");

  const granted = await worker.message({ type: "grantPass", site: "fast-food-kfc-com", presetId: "siteDefault" });
  assert.equal(granted.ok, true, "a pass can be granted offline");
});

// ===========================================================================
// Cross-cutting: the product did not become a fitness app
// ===========================================================================

test("scope: no tracking feature crept in", () => {
  const enMessages = JSON.parse(
    fs.readFileSync(path.join(ROOT, "extension", "_locales", "en", "messages.json"), "utf8")
  );
  const allCopy = Object.values(enMessages).map((entry) => entry.message).join(" ");

  // Things FitShield is explicitly not.
  const OUT_OF_SCOPE = [
    /\bstep count|\bsteps today|pedometer/i,
    /\bweigh(-| )?in|log your weight|body fat|BMI\b/i,
    /waist|measurements|progress photo/i,
    /macro(s)? (target|goal|budget)/i,
    /daily calorie (budget|goal|target)/i,
    /barcode|scan (the )?barcode/i,
    /expiry date|expiration date|use by/i,
    /shopping list|grocery list/i,
    /meal plan(ner)?|weekly plan/i,
    /leaderboard|streak|compete|rank(ing)? against/i,
    /sign (in|up)|create an account|log in to/i,
    /subscribe|subscription|upgrade to pro/i
  ];

  const found = OUT_OF_SCOPE.filter((pattern) => pattern.test(allCopy)).map(String);
  assert.deepEqual(found, [], `out-of-scope feature copy found: ${found.join(", ")}`);
});

test("scope: the statistics vocabulary still only names observed events", () => {
  assert.deepEqual(core.STAT_EVENTS, [
    "interruptions",
    "left",
    "continued",
    "passesUsed",
    "alternativesViewed",
    "alternativesSelected",
    "alternativesMade"
  ]);
});

test("scope: no visible control is dead", () => {
  // Every id the block page and settings markup expose as a button is wired up
  // in the matching script.
  const pairs = [
    ["warning.html", "warning.js"],
    ["settings.html", "preferences.js"],
    ["welcome.html", "welcome.js"]
  ];

  pairs.forEach(([page, script]) => {
    const html = fs.readFileSync(path.join(ROOT, "extension", page), "utf8");
    const js = fs.readFileSync(path.join(ROOT, "extension", script), "utf8");
    const settingsJs = page === "settings.html"
      ? fs.readFileSync(path.join(ROOT, "extension", "settings.js"), "utf8")
      : "";

    const ids = [...html.matchAll(/<button[^>]*id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);

    ids.forEach((id) => {
      const referenced = js.includes(`"${id}"`) || settingsJs.includes(`"${id}"`);
      assert.ok(referenced, `${page}: #${id} is rendered but never wired up in ${script}`);
    });
  });
});
