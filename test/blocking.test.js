"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

// Load background.js into an isolated sandbox with a stubbed chrome + fetch so
// the real blocking pipeline (JSON load -> rule catalog -> dynamic rules) can be
// exercised without a browser.
function loadBackground() {
  const store = {};
  let fetchCount = 0;

  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      lastError: null
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in store) out[k] = store[k];
          });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); }
      },
      onChanged: { addListener: () => {} }
    },
    alarms: { clear: async () => {}, create: async () => {}, onAlarm: { addListener: () => {} } },
    declarativeNetRequest: {
      _rules: [],
      getDynamicRules: (cb) => cb(chrome.declarativeNetRequest._rules),
      updateDynamicRules: (opts, cb) => {
        chrome.declarativeNetRequest._rules = opts.addRules || [];
        cb();
      }
    }
  };

  const fetchImpl = async (url) => {
    fetchCount += 1;
    const rel = url.replace("chrome-extension://test/", "");
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    return { ok: true, status: 200, json: async () => json };
  };

  const sandbox = { chrome, console, fetch: fetchImpl, setTimeout, URL, Math };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  sandbox.importScripts = (file) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });

  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context, { filename: "background.js" });

  return {
    context,
    store,
    rules: () => chrome.declarativeNetRequest._rules,
    fetchCount: () => fetchCount
  };
}

const hasDomain = (rules, domain) => rules.some((r) => r.condition.urlFilter === `||${domain}`);

test("default settings block delivery + fast food with anchored main_frame rules", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  const rules = bg.rules();

  assert.ok(rules.length > 0);
  assert.ok(hasDomain(rules, "doordash.com"), "delivery domain should block");
  assert.ok(hasDomain(rules, "kfc.com"), "fast-food domain should block");
  assert.ok(rules.every((r) => r.condition.urlFilter.startsWith("||")), "apex/subdomain anchored");
  assert.ok(rules.every((r) => r.condition.resourceTypes.includes("main_frame")));
  assert.ok(rules.every((r) => r.action.redirect.url.includes("warning.html")));

  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "rule ids are unique");
});

test("every generated rule has a valid ASCII urlFilter (IDN domains are punycoded)", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  const rules = bg.rules();

  // A single non-ASCII urlFilter makes Chrome reject the whole updateDynamicRules
  // batch, silently disabling all blocking. Every filter must be ASCII.
  rules.forEach((r) => {
    assert.match(r.condition.urlFilter, /^\|\|[a-z0-9.-]+$/, `bad urlFilter: ${r.condition.urlFilter}`);
  });

  // The one known IDN brand (saemaeul식당.com) blocks via its punycode host.
  assert.ok(rules.some((r) => r.condition.urlFilter.includes("xn--")), "expected a punycoded IDN rule");
});

test("disabling the delivery bucket drops delivery rules but keeps fast food", async () => {
  const bg = loadBackground();
  Object.assign(bg.store, { deliverySitesEnabled: false });
  await bg.context.queueRefreshBlockingState();
  // grubhub is delivery-only; mcdonalds is fast-food-only.
  assert.equal(hasDomain(bg.rules(), "grubhub.com"), false);
  assert.ok(hasDomain(bg.rules(), "mcdonalds.com"));
});

test("a disabled (whitelisted) site is not blocked", async () => {
  const bg = loadBackground();
  Object.assign(bg.store, { disabledDeliverySiteKeys: ["delivery-grubhub-com"] });
  await bg.context.queueRefreshBlockingState();
  assert.equal(hasDomain(bg.rules(), "grubhub.com"), false);
  assert.ok(hasDomain(bg.rules(), "doordash.com"), "other delivery sites still block");
});

test("country blocking works even with bucket toggles off", async () => {
  const bg = loadBackground();
  Object.assign(bg.store, { deliverySitesEnabled: false, fastFoodSitesEnabled: false, enabledCountries: ["CN"] });
  await bg.context.queueRefreshBlockingState();
  const rules = bg.rules();
  assert.ok(rules.length > 0);
  assert.ok(hasDomain(rules, "meituan.com"), "Meituan operates in CN");
  assert.equal(hasDomain(rules, "grubhub.com"), false, "Grubhub is US-only");
});

test("category blocking works even with bucket toggles off", async () => {
  const bg = loadBackground();
  Object.assign(bg.store, { deliverySitesEnabled: false, fastFoodSitesEnabled: false, enabledCategories: ["pizza"] });
  await bg.context.queueRefreshBlockingState();
  const rules = bg.rules();
  assert.ok(hasDomain(rules, "dominos.com"), "pizza brand blocked");
  assert.equal(hasDomain(rules, "mcdonalds.com"), false, "burger brand not blocked by pizza category");
});

test("custom sites are blocked", async () => {
  const bg = loadBackground();
  Object.assign(bg.store, {
    deliverySitesEnabled: false,
    fastFoodSitesEnabled: false,
    customSites: [{ domain: "example.com", enabled: true }]
  });
  await bg.context.queueRefreshBlockingState();
  assert.ok(hasDomain(bg.rules(), "example.com"));
});

test("an active temporary bypass removes the site from rules (across both buckets)", async () => {
  const bg = loadBackground();
  // doordash.com is listed in BOTH buckets; a pass on the delivery key must
  // still clear the fast-food rule for the same domain.
  Object.assign(bg.store, { siteBypasses: { "delivery-doordash-com": Date.now() + 5 * 60 * 1000 } });
  await bg.context.queueRefreshBlockingState();
  assert.equal(hasDomain(bg.rules(), "doordash.com"), false);
  assert.ok(hasDomain(bg.rules(), "grubhub.com"), "non-bypassed sites still block");
});

test("disabling the extension clears all rules", async () => {
  const bg = loadBackground();
  Object.assign(bg.store, { enabled: false });
  await bg.context.queueRefreshBlockingState();
  assert.equal(bg.rules().length, 0);
});

test("a schedule outside the active window clears rules", async () => {
  const bg = loadBackground();
  const now = new Date();
  const fmt = (offsetMin) => {
    const d = new Date(now.getTime() + offsetMin * 60000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  Object.assign(bg.store, { scheduleEnabled: true, scheduleStart: fmt(5), scheduleEnd: fmt(6) });
  await bg.context.queueRefreshBlockingState();
  assert.equal(bg.rules().length, 0);
});

test("isScheduleActive handles same-day and overnight windows", () => {
  const bg = loadBackground();
  const isActive = bg.context.isScheduleActive;
  assert.equal(isActive("18:00", "23:00", new Date(2020, 0, 1, 20, 0)), true);
  assert.equal(isActive("18:00", "23:00", new Date(2020, 0, 1, 10, 0)), false);
  assert.equal(isActive("22:00", "06:00", new Date(2020, 0, 1, 23, 30)), true);
  assert.equal(isActive("22:00", "06:00", new Date(2020, 0, 1, 12, 0)), false);
});

test("getBlockedSiteInfo resolves the trigger brand from a site key", async () => {
  const bg = loadBackground();
  const info = await bg.context.getBlockedSiteInfo("delivery-doordash-com");
  assert.equal(info.found, true);
  assert.equal(info.label, "DoorDash");
  assert.equal(info.domain, "doordash.com");
  assert.equal(typeof info.category, "string");

  const missing = await bg.context.getBlockedSiteInfo("does-not-exist");
  assert.equal(missing.found, false);
});

test("recordBlockedVisit increments the local counter (and starts from zero)", async () => {
  const bg = loadBackground();
  assert.equal(await bg.context.recordBlockedVisit(), 1);
  assert.equal(await bg.context.recordBlockedVisit(), 2);
  assert.equal(bg.store.blockedVisits, 2);
});

test("recordBlockedVisit only stores an integer count, never any URL or history", async () => {
  const bg = loadBackground();
  await bg.context.recordBlockedVisit();
  // The only key the counter touches is the integer total.
  assert.deepEqual(Object.keys(bg.store), ["blockedVisits"]);
  assert.equal(typeof bg.store.blockedVisits, "number");
});

test("recordRecipeChoice adds (meal - recipe) calories using the configured meal size", async () => {
  const bg = loadBackground();
  Object.assign(bg.store, { avgMealCalories: 1000 });
  const result = await bg.context.recordRecipeChoice(400);
  assert.equal(result.added, 600);
  assert.equal(result.caloriesAvoided, 600);
  assert.equal(result.recipesChosen, 1);
});

test("recordRecipeChoice falls back to a default when recipe calories are unknown", async () => {
  const bg = loadBackground();
  // No avgMealCalories set -> default 1000; unknown recipe calories -> default 500.
  const result = await bg.context.recordRecipeChoice(null);
  assert.equal(result.added, 500);
});

test("recordRecipeChoice never goes negative and accumulates", async () => {
  const bg = loadBackground();
  Object.assign(bg.store, { avgMealCalories: 800 });
  const first = await bg.context.recordRecipeChoice(2000); // recipe bigger than meal
  assert.equal(first.added, 0);
  const second = await bg.context.recordRecipeChoice(300);
  assert.equal(second.added, 500);
  assert.equal(second.caloriesAvoided, 500);
  assert.equal(second.recipesChosen, 2);
});

test("recordRecipeChoice only stores aggregate numbers, never recipe or site detail", async () => {
  const bg = loadBackground();
  await bg.context.recordRecipeChoice(400);
  assert.deepEqual(Object.keys(bg.store).sort(), ["caloriesAvoided", "recipesChosen"]);
});

test("JSON blocklists are fetched once and cached per worker", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  await bg.context.queueRefreshBlockingState();
  await bg.context.getBlockedSiteInfo("delivery-doordash-com");
  // The two blocklist files are each fetched exactly once despite repeated work.
  assert.equal(bg.fetchCount(), 2);
});
