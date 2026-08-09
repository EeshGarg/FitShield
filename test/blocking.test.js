"use strict";
/**
 * Background-worker tests: the real blocking pipeline, driven headlessly.
 *
 * background.js is loaded into a sandbox with a stubbed chrome + fetch, so the
 * whole chain — JSON blocklists -> rule catalog -> declarativeNetRequest rules,
 * plus schedules, scoped passes, and statistics — runs exactly as it does in the
 * browser, against the real engine bundle and the real datasets.
 *
 * NOTE ON SCOPE: this file replaces an earlier version that tested
 * `recordBlockedVisit`, `recordRecipeChoice`, and a single `siteBypasses` map.
 * Those functions no longer exist. They were not deleted to make a build pass —
 * they encoded claims the product should not make (a page view counted as a
 * prevented order; "calories avoided" incremented the moment a recipe card was
 * displayed, before anything was cooked). Their replacements are covered below
 * and in test/stats-semantics.test.js, which asserts the new semantics directly.
 * Everything the old file proved about RULE BUILDING is kept verbatim.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const core = require("../extension/fitshield-core.js");

// The sandboxed worker requests PACKAGED (zip-root-relative) paths — e.g.
// "blocklist.js", "blocklists/delivery.json" — exactly as the shipped extension
// does. In the repo those sources live in extension/ and data/; build.js
// flattens them back together and BUNDLES "FS Engine/" into blocklist.js, so
// this suite exercises the exact artifact the extension ships.
const { loadBackground } = require("./helpers/background-harness.js");

const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));

const hasDomain = (rules, domain) => rules.some((r) => r.condition.urlFilter === `||${domain}`);

// ---------------------------------------------------------------------------
// Rule building
// ---------------------------------------------------------------------------

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

  assert.ok(rules.some((r) => r.condition.urlFilter.includes("xn--")), "expected a punycoded IDN rule");
});

test("disabling the delivery bucket drops delivery rules but keeps fast food", async () => {
  const bg = loadBackground({ deliverySitesEnabled: false });
  await bg.context.queueRefreshBlockingState();

  // grubhub is delivery-only; mcdonalds is fast-food-only.
  assert.equal(hasDomain(bg.rules(), "grubhub.com"), false);
  assert.ok(hasDomain(bg.rules(), "mcdonalds.com"));
});

test("a disabled (whitelisted) site is not blocked", async () => {
  const bg = loadBackground({ disabledDeliverySiteKeys: ["delivery-grubhub-com"] });
  await bg.context.queueRefreshBlockingState();

  assert.equal(hasDomain(bg.rules(), "grubhub.com"), false);
  assert.ok(hasDomain(bg.rules(), "doordash.com"), "other brands are unaffected");
});

test("legacy TLD-stripped whitelist keys still apply after the upgrade", async () => {
  const bg = loadBackground({ disabledDeliverySiteKeys: ["grubhub"] });
  await bg.context.queueRefreshBlockingState();

  assert.equal(hasDomain(bg.rules(), "grubhub.com"), false, "a pre-0.55 whitelist entry must keep working");
});

test("country blocking works even with bucket toggles off", async () => {
  const bg = loadBackground({
    deliverySitesEnabled: false,
    fastFoodSitesEnabled: false,
    enabledCountries: ["JP"]
  });
  await bg.context.queueRefreshBlockingState();

  assert.ok(bg.rules().length > 0, "country selection alone must produce rules");
});

test("category blocking works even with bucket toggles off", async () => {
  const bg = loadBackground({
    deliverySitesEnabled: false,
    fastFoodSitesEnabled: false,
    enabledCategories: ["pizza"]
  });
  await bg.context.queueRefreshBlockingState();

  assert.ok(bg.rules().length > 0);
  assert.ok(hasDomain(bg.rules(), "dominos.com"), "a pizza brand should be caught by the category");
});

test("custom sites are blocked", async () => {
  const bg = loadBackground({ customSites: [{ domain: "example-food.test", enabled: true }] });
  await bg.context.queueRefreshBlockingState();

  assert.ok(hasDomain(bg.rules(), "example-food.test"));
});

test("disabling the extension clears all rules", async () => {
  const bg = loadBackground({ enabled: false });
  await bg.context.queueRefreshBlockingState();

  assert.equal(bg.rules().length, 0);
});

test("JSON blocklists are fetched once and cached per worker", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  const first = bg.fetchCount();
  await bg.context.queueRefreshBlockingState();

  assert.equal(bg.fetchCount(), first, "a second refresh must not re-fetch the datasets");
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

test("a schedule outside the active window clears rules", async () => {
  // Pick a same-day window that provably cannot contain "now", whatever time the
  // suite runs at: an afternoon window in the morning, or an early-morning
  // window in the afternoon. Both have start < end, so neither wraps midnight.
  const morning = new Date().getHours() < 12;
  const start = morning ? "13:00" : "01:00";
  const end = morning ? "14:00" : "02:00";

  const bg = loadBackground({
    schedule: { mode: "windows", windows: [{ days: core.ALL_DAYS, start, end }], until: null }
  });
  await bg.context.queueRefreshBlockingState();

  assert.equal(bg.rules().length, 0, "outside the window nothing is blocked");
});

test("an always-on schedule blocks and arms no schedule alarm", async () => {
  const bg = loadBackground({ schedule: { mode: "always", windows: [], until: null } });
  await bg.context.queueRefreshBlockingState();

  assert.ok(bg.rules().length > 0);
  assert.equal(bg.alarms().scheduleBoundaryReached, undefined, "always-on has no boundary to wake for");
});

test("a windowed schedule arms exactly one boundary alarm", async () => {
  const bg = loadBackground({
    schedule: { mode: "windows", windows: [{ days: core.ALL_DAYS, start: "00:00", end: "23:59" }], until: null }
  });
  await bg.context.queueRefreshBlockingState();

  const alarm = bg.alarms().scheduleBoundaryReached;
  assert.ok(alarm, "a windowed schedule must arm a boundary alarm");
  assert.ok(alarm.when > Date.now(), "the boundary is in the future");
});

test("a pre-0.55 flat schedule is honoured with no schedule object present", async () => {
  const bg = loadBackground({ scheduleEnabled: true, scheduleStart: "00:00", scheduleEnd: "23:59" });
  await bg.context.queueRefreshBlockingState();

  assert.ok(bg.rules().length > 0, "the legacy window covers now, so blocking is on");
});

// ---------------------------------------------------------------------------
// Scoped temporary passes
// ---------------------------------------------------------------------------

test("a site pass removes that domain from the rules, across both buckets", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  assert.ok(hasDomain(bg.rules(), "doordash.com"));

  const granted = await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "site10" });
  assert.equal(granted.ok, true);
  assert.equal(granted.granted, true);
  assert.match(granted.destination, /doordash\.com/);

  await bg.context.queueRefreshBlockingState();
  assert.ok(!hasDomain(bg.rules(), "doordash.com"), "the passed domain is not re-blocked by the other bucket");
  assert.ok(hasDomain(bg.rules(), "kfc.com"), "everything else stays blocked");
});

test("a pass for an unknown site key is refused rather than applied to some other brand", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const response = await bg.message({ type: "grantPass", site: "delivery-not-a-real-site", presetId: "site10" });

  assert.equal(response.ok, false, "an unresolved key must not grant a pass");
  await bg.context.queueRefreshBlockingState();
  assert.ok(hasDomain(bg.rules(), "doordash.com"), "no unrelated brand was unblocked");
});

test("an expired pass does not survive the next refresh", async () => {
  const bg = loadBackground({
    passes: [
      {
        id: "old",
        scope: "site",
        target: "doordash.com",
        createdAt: Date.now() - 60 * 60 * 1000,
        expiresAt: Date.now() - 1000,
        maxDurationMs: 10 * 60 * 1000,
        used: false
      }
    ]
  });

  await bg.context.queueRefreshBlockingState();

  assert.ok(hasDomain(bg.rules(), "doordash.com"), "an expired pass must not still be unblocking");
  assert.deepEqual(plain(bg.store.passes), [], "and it is cleaned out of storage");
});

test("a browser restart expires stale passes", async () => {
  const bg = loadBackground({
    passes: [
      {
        id: "stale",
        scope: "all",
        target: "",
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
        expiresAt: Date.now() - 60 * 1000,
        maxDurationMs: 30 * 60 * 1000,
        used: false
      }
    ]
  });

  bg.listeners.startup();
  await bg.context.queueRefreshBlockingState();

  assert.ok(bg.rules().length > 0, "blocking is active again after the restart");
  assert.deepEqual(plain(bg.store.passes), []);
});

test("a pause-everything pass clears all rules while it lasts", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "all30" });
  await bg.context.queueRefreshBlockingState();

  assert.equal(bg.rules().length, 0, "everything is paused");

  await bg.message({ type: "revokeAllPasses" });
  await bg.context.queueRefreshBlockingState();
  assert.ok(bg.rules().length > 0, "revoking restores blocking immediately");
});

test("a tab-scoped pass dies when its tab closes", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "tab", tabId: 1 });
  await bg.context.queueRefreshBlockingState();
  assert.ok(!hasDomain(bg.rules(), "doordash.com"));

  bg.setOpenTabs([{ id: 2 }]);
  await bg.listeners.tabRemoved(1);
  await bg.context.queueRefreshBlockingState();

  assert.ok(hasDomain(bg.rules(), "doordash.com"), "closing the tab ends the pass");
});

// ---------------------------------------------------------------------------
// A pass is a pass. It is not a switch that turns the product back on.
// ---------------------------------------------------------------------------

test("granting a pass does not silently re-arm a FitShield the user turned off", async () => {
  const bg = loadBackground({ enabled: false });
  await bg.context.queueRefreshBlockingState();
  assert.equal(bg.rules().length, 0, "precondition: the master switch is off");

  // A block-page tab left open from before the user switched off is still
  // clickable; grantPass used to write `enabled: true` alongside the pass, so
  // "For 5 minutes" quietly re-armed the whole extension for after it expired.
  const granted = await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "site10" });

  assert.equal(granted.ok, true);
  assert.equal(bg.store.enabled, false, "the button said five minutes, not turn FitShield back on");

  await bg.context.queueRefreshBlockingState();
  assert.equal(bg.rules().length, 0, "and blocking stays off, as the user chose");
});

// ---------------------------------------------------------------------------
// "Block until tomorrow" is the one commitment button in the product
//
// It set a timestamp and nothing enforced it: the very next block page offered
// "Pause everything until tomorrow" as a normal option, one click turned
// blocking completely off, and Settings went on rendering "Blocking everything
// until tomorrow."
// ---------------------------------------------------------------------------

test("a pause-everything pass is refused while block-until-tomorrow is on", async () => {
  const until = Date.now() + 6 * 60 * 60 * 1000;
  const bg = loadBackground({ schedule: { mode: "always", windows: [], until } });
  await bg.context.queueRefreshBlockingState();

  for (const presetId of ["all30", "allTomorrow"]) {
    const response = await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId });

    assert.equal(response.ok, false, `${presetId} must not be able to cancel the commitment`);
    assert.equal(response.reason, "scheduleOverride", "and the page is told exactly why");
  }

  await bg.context.queueRefreshBlockingState();
  assert.ok(hasDomain(bg.rules(), "doordash.com"), "blocking is untouched");
  assert.ok(hasDomain(bg.rules(), "kfc.com"));
  assert.deepEqual(plain(bg.store.passes || []), [], "no pass was written");
});

test("the override never becomes a trap: site passes and the master switch still work", async () => {
  const until = Date.now() + 6 * 60 * 60 * 1000;
  const bg = loadBackground({ schedule: { mode: "always", windows: [], until } });
  await bg.context.queueRefreshBlockingState();

  const granted = await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "site10" });
  assert.equal(granted.ok, true, "the block page still lets the user through to the site in front of them");

  await bg.context.queueRefreshBlockingState();
  assert.ok(!hasDomain(bg.rules(), "doordash.com"));
  assert.ok(hasDomain(bg.rules(), "kfc.com"), "everything else is still blocked");
});

test("once the override has expired, pausing everything works again", async () => {
  const bg = loadBackground({ schedule: { mode: "always", windows: [], until: Date.now() - 1000 } });
  await bg.context.queueRefreshBlockingState();

  const response = await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "all30" });

  assert.equal(response.ok, true, "an expired commitment is not a permanent one");
});

test("granting a pass arms an expiry alarm", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "site30" });
  await bg.context.queueRefreshBlockingState();

  const alarm = bg.alarms().temporaryPassExpired;
  assert.ok(alarm, "an expiry alarm must be armed");
  assert.ok(alarm.when > Date.now());
});

// ---------------------------------------------------------------------------
// Block-page context
// ---------------------------------------------------------------------------

test("getBlockContext returns everything the block page needs in one call", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const context = await bg.message({ type: "getBlockContext", site: "delivery-doordash-com" });

  assert.equal(context.ok, true);
  assert.equal(context.found, true);
  assert.equal(context.site.domain, "doordash.com");
  assert.equal(context.site.label, "DoorDash");
  assert.ok(context.timerSeconds >= core.MIN_TIMER_SECONDS);
  assert.ok(context.preferences, "the page needs the user's matching preferences");
  assert.ok(Array.isArray(context.preferences.pantry));
  assert.equal(context.repeat.repeat, false, "a first visit earns no extra friction");
});

test("an unresolved site key degrades gracefully instead of throwing", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const context = await bg.message({ type: "getBlockContext", site: "nonsense-key" });

  assert.equal(context.ok, true);
  assert.equal(context.found, false);
  assert.equal(context.site, null);
  assert.ok(context.timerSeconds > 0, "the pause still works without a resolved brand");
});

test("getBlockedSiteInfo still resolves the trigger brand from a site key", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const info = await bg.message({ type: "getBlockedSiteInfo", site: "fast-food-kfc-com" });

  assert.equal(info.found, true);
  assert.equal(info.domain, "kfc.com");
  assert.ok(Array.isArray(info.specialties));
});

// ---------------------------------------------------------------------------
// Repeat-access friction
// ---------------------------------------------------------------------------

test("continuing once makes the next interruption slightly longer, and says why", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const before = await bg.message({ type: "getBlockContext", site: "delivery-doordash-com" });
  await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "siteDefault" });
  const after = await bg.message({ type: "getBlockContext", site: "delivery-doordash-com" });

  assert.ok(after.timerSeconds > before.timerSeconds, "the pause grew");
  assert.equal(after.repeat.repeat, true);
  assert.ok(after.repeat.extraSeconds > 0);
  assert.ok(after.repeat.windowMinutes > 0, "the page can explain when it lapses");
});

test("repeat friction can be switched off", async () => {
  const bg = loadBackground({ repeatFrictionEnabled: false });
  await bg.context.queueRefreshBlockingState();

  const before = await bg.message({ type: "getBlockContext", site: "delivery-doordash-com" });
  await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "siteDefault" });
  const after = await bg.message({ type: "getBlockContext", site: "delivery-doordash-com" });

  assert.equal(after.timerSeconds, before.timerSeconds);
  assert.equal(after.repeat.repeat, false);
});

test("repeat friction is per-domain", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "siteDefault" });
  const other = await bg.message({ type: "getBlockContext", site: "fast-food-kfc-com" });

  assert.equal(other.repeat.repeat, false, "a different brand is unaffected");
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

test("an interruption is recorded as an interruption and nothing else", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "recordInterruption" });

  assert.equal(bg.store.stats.totals.interruptions, 1);
  assert.equal(bg.store.stats.totals.continued, 0);
  assert.equal(bg.store.stats.totals.alternativesSelected, 0);
});

test("leaving and continuing are recorded as separate events", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "recordLeft" });
  assert.equal(bg.store.stats.totals.left, 1);
  assert.equal(bg.store.stats.totals.continued, 0);

  await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "siteDefault" });
  assert.equal(bg.store.stats.totals.continued, 1, "continuing is its own event");
  assert.equal(bg.store.stats.totals.passesUsed, 1);
});

// ---------------------------------------------------------------------------
// A burst of interruptions must not collapse into one
//
// recordEvent was an unserialized read-modify-write of a single `stats` object,
// and the block page fires its messages without awaiting them — so opening
// several delivery links at once (middle-click, session restore, a link farm)
// ran N overlapping get/set cycles in one worker and stored ONE interruption.
// The counter the whole panel is built on undercounted exactly in the burst a
// user is most likely to notice.
// ---------------------------------------------------------------------------

test("simultaneous interruptions are all counted, not collapsed into one", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  // Fired together, exactly as N freshly-redirected block pages do.
  await Promise.all(Array.from({ length: 8 }, () => bg.message({ type: "recordInterruption" })));

  assert.equal(bg.store.stats.totals.interruptions, 8, "every interruption is its own count");
  assert.equal(bg.store.stats.history[0].interruptions, 8, "and the per-day history agrees");
});

test("interleaved events of different kinds do not overwrite each other", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await Promise.all([
    bg.message({ type: "recordInterruption" }),
    bg.message({ type: "recordLeft" }),
    bg.message({ type: "recordInterruption" }),
    bg.message({ type: "recordAlternativeShown", id: "naan-pizza" }),
    bg.message({ type: "recordLeft" }),
    bg.message({ type: "recordInterruption" })
  ]);

  assert.equal(bg.store.stats.totals.interruptions, 3);
  assert.equal(bg.store.stats.totals.left, 2);
  assert.equal(bg.store.stats.totals.alternativesViewed, 1);
});

test("a burst of blocks records every brand, not just the last one", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await Promise.all([
    bg.message({ type: "recordBlockedBrand", meta: { domain: "doordash.com", category: "pizza", countries: ["US"] } }),
    bg.message({ type: "recordBlockedBrand", meta: { domain: "kfc.com", category: "chicken", countries: ["US"] } }),
    bg.message({ type: "recordBlockedBrand", meta: { domain: "doordash.com", category: "pizza", countries: ["US"] } })
  ]);

  assert.deepEqual(plain(bg.store.blockedByDomain), { "doordash.com": 2, "kfc.com": 1 });
  assert.deepEqual(plain(bg.store.blockedByCountry), { US: 3 });
});

test("choosing an alternative records intent, never a completed meal", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "recordAlternativeSelected", id: "naan-pizza" });

  assert.equal(bg.store.stats.totals.alternativesSelected, 1);
  assert.equal(bg.store.stats.totals.alternativesMade, 0, "nothing claims a meal happened");
  assert.equal(bg.store.pendingAlternatives.length, 1, "it is remembered so it can be confirmed later");

  await bg.message({ type: "markAlternativeMade", id: "naan-pizza" });
  assert.equal(bg.store.stats.totals.alternativesMade, 1);
  assert.equal(bg.store.pendingAlternatives.length, 0);
});

test("no statistic stores a URL, a path, or any browsing detail", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "recordInterruption" });
  await bg.message({
    type: "recordBlockedBrand",
    meta: { domain: "doordash.com", category: "pizza", countries: ["US", "CA"] }
  });

  const serialized = JSON.stringify({
    stats: bg.store.stats,
    blockedByDomain: bg.store.blockedByDomain,
    blockedByCategory: bg.store.blockedByCategory,
    blockedByCountry: bg.store.blockedByCountry,
    recentAlternatives: bg.store.recentAlternatives
  });

  assert.ok(!/https?:\/\//.test(serialized), "no URL is ever stored");
  assert.ok(!serialized.includes("/menu"), "no page path is stored");

  assert.deepEqual(plain(bg.store.blockedByDomain), { "doordash.com": 1 });
  assert.deepEqual(plain(bg.store.blockedByCategory), { pizza: 1 });
  assert.deepEqual(plain(bg.store.blockedByCountry), { US: 1 }, "only the primary market is counted");
});

test("bucket names are not counted as food categories", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "recordBlockedBrand", meta: { domain: "x.com", category: "delivery", countries: [] } });

  assert.deepEqual(plain(bg.store.blockedByCategory || {}), {});
});

test("recordBlockedBrand records nothing when the brand could not be resolved", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const result = await bg.message({ type: "recordBlockedBrand", meta: { domain: "", category: "", countries: [] } });

  assert.equal(result.recorded, false);
});

test("showing an alternative records it for rotation, dismissing it for deprioritisation", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "recordAlternativeShown", id: "naan-pizza" });
  assert.deepEqual(plain(bg.store.recentAlternatives), ["naan-pizza"]);
  assert.equal(bg.store.stats.totals.alternativesViewed, 1);

  await bg.message({ type: "recordAlternativeDismissed", id: "naan-pizza" });
  assert.deepEqual(plain(bg.store.dismissedAlternatives), ["naan-pizza"]);
});

// ---------------------------------------------------------------------------
// Preview mode
// ---------------------------------------------------------------------------

test("preview mode records nothing at all", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  const before = JSON.stringify(bg.store.stats || null);

  await bg.message({ type: "recordInterruption", preview: true });
  await bg.message({ type: "recordAlternativeShown", id: "naan-pizza", preview: true });
  await bg.message({ type: "recordAlternativeSelected", id: "naan-pizza", preview: true });
  await bg.message({ type: "recordLeft", preview: true });
  await bg.message({ type: "recordBlockedBrand", meta: { domain: "doordash.com" }, preview: true });

  assert.equal(JSON.stringify(bg.store.stats || null), before, "no statistics were written");
  assert.equal(bg.store.recentAlternatives, undefined);
  assert.equal(bg.store.blockedByDomain, undefined);
});

test("preview mode never grants a real pass", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const response = await bg.message({
    type: "grantPass",
    site: "delivery-doordash-com",
    presetId: "site30",
    preview: true
  });

  assert.equal(response.granted, false);
  await bg.context.queueRefreshBlockingState();
  assert.ok(hasDomain(bg.rules(), "doordash.com"), "the site is still blocked");
});

// ---------------------------------------------------------------------------
// Migration through the real worker
// ---------------------------------------------------------------------------

test("a pre-0.55 profile is migrated on first use and keeps working", async () => {
  const bg = loadBackground({
    timerSeconds: 45,
    blockedVisits: 12,
    recipesChosen: 3,
    caloriesAvoided: 4000,
    customSites: ["legacy.example"],
    scheduleEnabled: true,
    scheduleStart: "00:00",
    scheduleEnd: "23:59",
    siteBypasses: {}
  });

  await bg.context.queueRefreshBlockingState();

  assert.equal(bg.store.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(bg.store.stats.totals.interruptions, 12, "history is carried over, not reset");
  assert.equal(bg.store.stats.totals.alternativesSelected, 3);
  assert.equal(bg.store.caloriesAvoided, 4000, "the old value is still there");
  assert.equal(bg.store.timerSeconds, 45, "the user's timer is untouched");
  assert.ok(hasDomain(bg.rules(), "legacy.example"), "a legacy string custom site still blocks");
});

test("a migrated pass for a hyphenated brand points at the brand that exists", async () => {
  // Through the REAL worker and the REAL catalog: "delivery-just-eat-com" is
  // just-eat.com, not the "just.eat.com" the key's hyphens naively suggest.
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const bg = loadBackground({ siteBypasses: { "delivery-just-eat-com": expiresAt } });

  await bg.context.queueRefreshBlockingState();

  const [pass] = bg.store.passes;
  assert.ok(pass, "the pass survived the update");
  assert.equal(pass.target, "just-eat.com");
  assert.ok(!hasDomain(bg.rules(), "just-eat.com"), "and it actually unblocks the brand it names");
  assert.ok(hasDomain(bg.rules(), "doordash.com"), "while nothing else is opened");
});

// ---------------------------------------------------------------------------
// repeatHistory must age out ON DISK, not only on read
// ---------------------------------------------------------------------------

test("expired repeat history is cleared from storage by an ordinary refresh", async () => {
  const now = Date.now();
  const stale = now - core.repeatHistoryRetentionMs(60) - 60 * 1000;

  const bg = loadBackground({
    repeatWindowMinutes: 60,
    repeatHistory: { "ubereats.com": [stale], "dominos.com": [stale, now - 60 * 1000] }
  });

  await bg.context.queueRefreshBlockingState();

  assert.deepEqual(
    plain(bg.store.repeatHistory),
    { "dominos.com": [now - 60 * 1000] },
    "a profile left alone cannot keep a per-brand timestamp log forever"
  );
});

test("continuing writes a repeat history that carries nothing expired", async () => {
  const stale = Date.now() - core.repeatHistoryRetentionMs(60) - 60 * 1000;
  const bg = loadBackground({ repeatHistory: { "ubereats.com": [stale] } });
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "site10" });

  assert.deepEqual(Object.keys(plain(bg.store.repeatHistory)), ["doordash.com"]);
});

// ---------------------------------------------------------------------------
// The "did you make it?" question has to be about a meal the user remembers
//
// A pending entry carried a timestamp nothing ever read, so nothing expired one:
// older entries resurfaced one popup-open at a time, indefinitely, and that
// answer is the sole input to `alternativesMade` — which the estimate panel
// multiplies by a meal price.
// ---------------------------------------------------------------------------

test("a choice nobody answered for two days stops being asked about", async () => {
  const now = Date.now();
  const bg = loadBackground({
    pendingAlternatives: [
      { id: "ancient", at: now - 30 * 24 * 60 * 60 * 1000 },
      { id: "stale", at: now - 49 * 60 * 60 * 1000 },
      { id: "recent", at: now - 60 * 60 * 1000 },
      { id: "undated" }
    ]
  });
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "getBlockState" });

  assert.deepEqual(
    plain(bg.store.pendingAlternatives).map((item) => item.id),
    ["recent"],
    "only a choice recent enough to remember is still askable"
  );
});

test("selecting a new alternative does not carry forgotten ones forward", async () => {
  const bg = loadBackground({
    pendingAlternatives: [{ id: "stale", at: Date.now() - 72 * 60 * 60 * 1000 }]
  });
  await bg.context.queueRefreshBlockingState();

  await bg.message({ type: "recordAlternativeSelected", id: "naan-pizza" });

  assert.deepEqual(plain(bg.store.pendingAlternatives).map((item) => item.id), ["naan-pizza"]);
});

test("getBlockState exposes the state the popup renders", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const state = await bg.message({ type: "getBlockState" });

  assert.equal(state.ok, true);
  assert.equal(state.enabled, true);
  assert.equal(state.scheduleActive, true);
  assert.ok(Array.isArray(state.deliverySites) && state.deliverySites.length > 0);
  assert.ok(state.recap, "the popup can show a weekly recap");
  assert.ok(Array.isArray(state.passes));
});

test("diagnostics report both runtime globals and the schema version", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const diagnostics = await bg.message({ type: "getDiagnostics", domain: "kfc.com" });

  assert.equal(diagnostics.engineLoaded, true);
  assert.equal(diagnostics.coreLoaded, true);
  assert.equal(diagnostics.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(diagnostics.test.blocked, true);
  assert.ok(diagnostics.blocklistCount > 1000);
});

test("an unknown message type is ignored rather than answered", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  assert.equal(await bg.message({ type: "notARealMessage" }), null);
});
