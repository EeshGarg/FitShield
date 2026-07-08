"use strict";
/**
 * Pins the settings page's offline fallback records (extension/blocklist-records.js)
 * equal to what the background service worker returns from getBlockState. Both
 * derive site records from the same engine entries; if their key/label/enabled
 * logic ever drifts, the settings page's individual-site toggles would write
 * disabled keys the worker doesn't recognize. This test fails on any drift.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const build = require("../build.js");
const engine = require("../FS Engine");
const records = require("../extension/blocklist-records.js");

function srcPath(rel) {
  if (rel === "blocklist.js") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-bundle-"));
    const p = path.join(dir, "blocklist.js");
    fs.writeFileSync(p, build.bundleEngine());
    return p;
  }
  const candidates = [path.join(ROOT, "extension", rel), path.join(ROOT, "data", rel), path.join(ROOT, rel)];
  return candidates.find((c) => fs.existsSync(c)) || candidates[2];
}

// Load background.js in a sandbox with a seedable storage, exactly like
// blocking.test.js, so we can read its real getBlockState output.
function loadBackground(seed) {
  const store = { ...seed };
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
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); }
      },
      onChanged: { addListener: () => {} }
    },
    alarms: { clear: async () => {}, create: async () => {}, onAlarm: { addListener: () => {} } },
    declarativeNetRequest: {
      _rules: [],
      getDynamicRules: (cb) => cb([]),
      updateDynamicRules: (opts, cb) => cb()
    }
  };
  const fetchImpl = async (url) => ({
    ok: true, status: 200,
    json: async () => JSON.parse(fs.readFileSync(srcPath(url.replace("chrome-extension://test/", "")), "utf8"))
  });
  const sandbox = { chrome, console, fetch: fetchImpl, setTimeout, URL, Math, Date };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (f) => vm.runInContext(fs.readFileSync(srcPath(f), "utf8"), context, { filename: f });
  vm.runInContext(fs.readFileSync(srcPath("background.js"), "utf8"), context, { filename: "background.js" });
  return context;
}

const sig = (site) => `${site.key}|${site.label}|${site.domain}|${site.enabled}`;

// Normalize to a plain, sorted, main-realm string array. getBlockState returns
// arrays created inside the background's vm sandbox (a different realm), whose
// prototype makes deepStrictEqual reject an otherwise-identical main-realm
// array; Array.from rebuilds them here so only the CONTENT is compared.
const sigs = (list) => Array.from(list, sig).sort();

async function localSites(disabled) {
  const entries = await engine.loadBlocklists();
  const all = records.buildSiteRecords(entries, engine);
  return {
    delivery: records.mergeEnabledState(all.filter((r) => r.type === "delivery"), disabled.delivery),
    fastFood: records.mergeEnabledState(all.filter((r) => r.type === "fast_food"), disabled.fastFood)
  };
}

test("fallback records match the worker's getBlockState (default: all enabled)", async () => {
  const bg = loadBackground({});
  const worker = await bg.getBlockState();
  const local = await localSites({ delivery: [], fastFood: [] });

  assert.deepEqual(
    sigs(local.delivery),
    sigs(worker.deliverySites),
    "delivery site records must match the worker"
  );
  assert.deepEqual(
    sigs(local.fastFood),
    sigs(worker.fastFoodSites),
    "fast-food site records must match the worker"
  );
  assert.ok(local.delivery.length > 0 && local.fastFood.length > 0, "sanity: records were built");
});

test("fallback records honor disabled-site keys identically to the worker", async () => {
  // A whitelisted (disabled) site must resolve to enabled:false the same way in
  // both paths — same key format is what makes this line up.
  const disabled = { delivery: ["delivery-grubhub-com"], fastFood: ["fast_food-mcdonalds-com"] };
  const bg = loadBackground({
    disabledDeliverySiteKeys: disabled.delivery,
    disabledFastFoodSiteKeys: disabled.fastFood
  });
  const worker = await bg.getBlockState();
  const local = await localSites(disabled);

  assert.deepEqual(sigs(local.delivery), sigs(worker.deliverySites));
  assert.deepEqual(sigs(local.fastFood), sigs(worker.fastFoodSites));

  // And the disabled ones are actually reflected as disabled in the local build.
  const grubhub = local.delivery.find((s) => s.key === "delivery-grubhub-com");
  assert.ok(grubhub && grubhub.enabled === false, "grubhub should be disabled in the fallback build");
});
