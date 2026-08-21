"use strict";
/**
 * Concurrent pass grants must not lose each other.
 *
 * `grantPass` read the whole pass list, appended one pass and wrote it back,
 * with nothing serializing the read-modify-write — unlike `recordEvent` and
 * `refreshBlockingState`, both of which were already serialized in the same
 * file for exactly this reason. Two block pages granting at the same moment
 * both read the old list, and the second write erased the first.
 *
 * The customer sat through the pause on both tabs, chose a duration on both,
 * and was told yes on both. The tab whose pass was erased is interrupted again
 * the moment it loads, while "Temporary passes used" counts a pass that does
 * not exist. `repeatHistory` rides on the same write and was lost with it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackground } = require("./helpers/background-harness.js");

// The worker runs in its own VM realm, so arrays it returns do not share this
// realm's Array.prototype and deepStrictEqual fails on identical contents.
// Compare values, not prototypes.
const plain = (list) => Array.from(list || []);

// Match the rule's own filter rather than a substring of the whole rule: a bare
// includes("kfc.com") also matches kfc.com.au and reports a pass as ignored
// when it was honoured.
const hasDomain = (rules, domain) =>
  rules.some((rule) => {
    const filter = ((rule.condition || {}).urlFilter) || "";
    return filter.includes("||" + domain + "^") || filter === domain;
  });

// Fire the grants without awaiting between them, which is what two block pages
// in two tabs actually do. Awaiting each in turn hides the defect completely.
function grantBoth(bg, sites, presetId = "site10") {
  return Promise.all(
    sites.map((site) => bg.message({ type: "grantPass", site, presetId }))
  );
}

test("two passes granted at the same moment are both stored", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const results = await grantBoth(bg, ["delivery-doordash-com", "fast-food-kfc-com"]);

  results.forEach((r, i) => assert.equal(r.granted, true, `grant ${i} was refused: ${JSON.stringify(r)}`));

  const stored = plain(bg.store.passes);
  assert.equal(stored.length, 2, `both grants were accepted but ${stored.length} pass(es) were stored`);

  const targets = plain(stored).map((p) => p.target).sort();
  assert.deepEqual(targets, ["doordash.com", "kfc.com"], `stored targets: ${JSON.stringify(targets)}`);
});

test("three simultaneous grants all survive", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const results = await grantBoth(bg, [
    "delivery-doordash-com",
    "fast-food-kfc-com",
    "fast-food-mcdonalds-com"
  ]);

  results.forEach((r, i) => assert.equal(r.granted, true, `grant ${i} was refused`));
  assert.equal(plain(bg.store.passes).length, 3, "a burst of three grants must store three passes");
});

test("the pass count and the counter that reports it cannot disagree", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await grantBoth(bg, ["delivery-doordash-com", "fast-food-kfc-com"]);

  const stored = plain(bg.store.passes).length;
  const used = ((bg.store.stats || {}).totals || {}).passesUsed;

  // "Temporary passes used" is presented to the user as a fact about their own
  // behaviour. Counting a pass that was silently discarded makes it a lie.
  assert.equal(used, stored, `passesUsed says ${used} but ${stored} pass(es) exist`);
});

test("a site granted a pass in a burst is not interrupted straight away", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await grantBoth(bg, ["delivery-doordash-com", "fast-food-kfc-com"]);
  await bg.context.queueRefreshBlockingState();

  // This is the symptom the user actually feels: they were told yes, and the
  // site blocks them again on the very next load.
  assert.ok(!hasDomain(bg.rules(), "doordash.com"), "doordash was granted a pass and is still blocked");
  assert.ok(!hasDomain(bg.rules(), "kfc.com"), "kfc was granted a pass and is still blocked");
});

test("concurrent grants do not lose the repeat-friction history", async () => {
  const bg = loadBackground({ repeatFrictionEnabled: true });
  await bg.context.queueRefreshBlockingState();

  await grantBoth(bg, ["delivery-doordash-com", "fast-food-kfc-com"]);

  const history = Object.assign({}, bg.store.repeatHistory);
  // Repeat friction exists to make the SECOND visit cost more. Losing one of
  // two continues means the escalation silently forgets the user gave in.
  assert.deepEqual(
    Object.keys(history).sort(),
    ["doordash.com", "kfc.com"],
    `repeatHistory kept ${JSON.stringify(Object.keys(history))}`
  );
});

test("a revoke cannot be undone by a grant already in flight", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  // Both are issued before either resolves, so the revoke must land after the
  // grant rather than being overwritten by it. "End all passes" has to mean it.
  const inFlight = bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "site10" });
  const revoked = bg.message({ type: "revokeAllPasses" });

  await Promise.all([inFlight, revoked]);

  assert.deepEqual(plain(bg.store.passes), [], "a pass survived an end-all-passes issued alongside it");
});
