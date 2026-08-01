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

const { loadBackground: bootWorker } = require("./helpers/background-harness.js");

// These tests only need the sandbox globals, not the whole harness surface.
const loadBackground = (seed) => bootWorker(seed).context;

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
