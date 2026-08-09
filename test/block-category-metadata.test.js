"use strict";
/**
 * The brand a block page describes, versus the rule that fired.
 *
 * `getRuleCatalog` relabels every entry it returns with its RULE BUCKET
 * ("delivery" / "fastfood" / "custom"), which is exactly what the
 * declarativeNetRequest bookkeeping needs. `findSite` used to search that
 * catalog first, and both user-facing readers go through `findSite` — so the
 * bucket reached the block page in the field reserved for the brand's curated
 * category, and from there reached storage, because the block page reports that
 * same field to `recordBlockedBrand`.
 *
 * Jollibee is `fast_casual` in the shipped dataset and arrived as "fastfood".
 * Every delivery brand arrived as "delivery". Settings' "Most blocked
 * categories" therefore accumulated rule buckets while the category PICKER
 * beside it listed the curated vocabulary — one page describing two different
 * things with the same word.
 *
 * These drive the REAL worker against the REAL datasets, and check both halves
 * at once: the readers now report curated metadata, and the rule catalog still
 * carries its bucket, because the rules depend on it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackground } = require("./helpers/background-harness.js");

const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));

// A booted worker with the blocklists loaded and the rules built, exactly as a
// browser reaches it before any block page can open.
async function bootedWorker(initialStore) {
  const bg = loadBackground(initialStore);
  await bg.context.queueRefreshBlockingState();
  return bg;
}

// What the rule catalog says about a key — read out of the worker's own module
// scope, so this is the catalog the rules were actually built from rather than a
// re-implementation of it.
function catalogEntry(bg, siteKey) {
  return bg.evalIn(
    `getSettings().then((settings) => ` +
      `getRuleCatalog(settings).find((entry) => entry.key === ${JSON.stringify(siteKey)}) || null)`
  );
}

// ---------------------------------------------------------------------------
// The readers report the curated category; the catalog keeps its bucket
// ---------------------------------------------------------------------------

test("the block page is told Jollibee's curated category, not the rule bucket", async () => {
  const bg = await bootedWorker();

  const context = await bg.message({ type: "getBlockContext", site: "fast-food-jollibee-com" });

  assert.equal(context.found, true, "the brand must still resolve");
  assert.equal(context.site.domain, "jollibee.com");
  assert.equal(
    context.site.category,
    "fast_casual",
    "the block page was handed the rule bucket where the curated category belongs"
  );
  // The type is what the Rule row names, and it must stay the bucket's identity.
  assert.equal(context.site.type, "fast_food");
});

test("the rule catalog still labels Jollibee with its bucket", async () => {
  const bg = await bootedWorker();

  const entry = await catalogEntry(bg, "fast-food-jollibee-com");

  assert.ok(entry, "the brand must still be in the rule catalog");
  assert.equal(entry.category, "fastfood", "the rule bookkeeping lost its bucket");
  // And the rule built from it still redirects that domain.
  assert.ok(
    bg.rules().some((rule) => rule.condition.urlFilter === "||jollibee.com"),
    "the redirect rule for the brand disappeared"
  );
});

// There used to be two readers of one brand, and this asserted they agreed.
// The second (`getBlockedSiteInfo`) was sent by nothing that ships and has been
// removed, so what remains is the property that always mattered: the reader the
// block page actually uses reports the CURATED category, never the rule bucket
// the site was blocked by.
test("the block context reports the curated category, not the rule bucket", async () => {
  const bg = await bootedWorker();

  const context = await bg.message({ type: "getBlockContext", site: "fast-food-jollibee-com" });

  assert.equal(context.found, true);
  assert.equal(context.site.category, "fast_casual", "the dataset's word, not the bucket");
  assert.notEqual(context.site.category, "fastfood");
  assert.equal(context.site.type, "fast_food", "and the rule bucket is still available separately");
});

test("a delivery brand reports what the dataset curated, not the bucket it was blocked by", async () => {
  const bg = await bootedWorker();

  // Both are type "delivery" and both were reported as category "delivery"; the
  // dataset calls one a meal kit and the other a tea brand, which is what
  // Settings' picker offers and what the recipe picker reads.
  const mealKit = await bg.message({ type: "getBlockContext", site: "delivery-hellofresh-com-au" });
  const tea = await bg.message({ type: "getBlockContext", site: "delivery-heytea-com" });

  assert.equal(mealKit.site.category, "meal_kit");
  assert.equal(mealKit.site.type, "delivery");
  assert.equal(tea.site.category, "tea");

  assert.equal(
    (await catalogEntry(bg, "delivery-hellofresh-com-au")).category,
    "delivery",
    "the rule catalog must still bucket it as delivery"
  );
});

test("a custom site keeps its own identity on the block page", async () => {
  // The catalog's entry for a custom site is a stub with no `type` at all, so
  // the block page's Rule row rendered blank for the sites the user added
  // themselves. The full record says "custom" for both.
  const bg = await bootedWorker({ customSites: [{ domain: "example.com", enabled: true }], customSitesEnabled: true });

  const context = await bg.message({ type: "getBlockContext", site: "custom-example-com" });

  assert.equal(context.found, true);
  assert.equal(context.site.type, "custom", "the Rule row has nothing to name");
  assert.equal(context.site.category, "custom", "a custom site has no curated category");
});

test("an unknown site key still resolves to nothing", async () => {
  const bg = await bootedWorker();

  const context = await bg.message({ type: "getBlockContext", site: "fast-food-not-a-brand-example" });

  assert.equal(context.found, false);
  assert.equal(context.site, null);
  assert.ok(context.timerSeconds > 0, "the pause still works without a resolved brand");
});

// ---------------------------------------------------------------------------
// End to end: what the block page reports is what Settings ranks
// ---------------------------------------------------------------------------

test("an interruption is counted under a category Settings' picker actually offers", async () => {
  const bg = await bootedWorker();

  // Precisely what warning.js sends: the fields it read off the block context.
  const context = await bg.message({ type: "getBlockContext", site: "fast-food-jollibee-com" });
  await bg.message({
    type: "recordBlockedBrand",
    meta: {
      domain: context.site.domain,
      category: context.site.category,
      countries: context.site.countries
    }
  });

  assert.deepEqual(plain(bg.store.blockedByCategory), { fast_casual: 1 });
  assert.deepEqual(plain(bg.store.blockedByDomain), { "jollibee.com": 1 });
  assert.deepEqual(plain(bg.store.blockedByCountry), { PH: 1 }, "only the primary market is counted");
});

// ---------------------------------------------------------------------------
// The rule-bucket keys already on disk
// ---------------------------------------------------------------------------

test("the rule-bucket keys left in the category breakdown are dropped, and only those", async () => {
  const bg = await bootedWorker({
    blockedByCategory: { fastfood: 41, custom: 3, fast_casual: 7, delivery: 5, convenience: 2 },
    blockedByDomain: { "jollibee.com": 41 },
    blockedByCountry: { PH: 41 },
    stats: { totals: { interruptions: 44 } }
  });

  assert.deepEqual(
    plain(bg.store.blockedByCategory),
    // "delivery" and "fast_casual" are curated categories; "convenience" is one
    // the Android build counts. None of them is a rule bucket, so none moves.
    { fast_casual: 7, delivery: 5, convenience: 2 },
    "the repair must remove the two bucket keys and nothing else"
  );

  // The interruptions behind the dropped label are still counted, per brand and
  // per market, where they were never mislabeled.
  assert.deepEqual(plain(bg.store.blockedByDomain), { "jollibee.com": 41 });
  assert.deepEqual(plain(bg.store.blockedByCountry), { PH: 41 });
  assert.equal(bg.store.stats.totals.interruptions, 44, "no interruption may be forgotten");
});

test("the repair is idempotent and leaves a clean profile untouched", async () => {
  const bg = await bootedWorker({ blockedByCategory: { fastfood: 2, pizza: 9 } });

  assert.deepEqual(plain(bg.store.blockedByCategory), { pizza: 9 });

  // A second and third refresh must not keep rewriting the map, and a profile
  // that never had a bucket key must not be written at all.
  await bg.context.queueRefreshBlockingState();
  await bg.context.queueRefreshBlockingState();
  assert.deepEqual(plain(bg.store.blockedByCategory), { pizza: 9 });

  const clean = await bootedWorker({ blockedByCategory: { pizza: 4 } });
  assert.deepEqual(plain(clean.store.blockedByCategory), { pizza: 4 });

  const untouched = await bootedWorker();
  assert.equal(untouched.store.blockedByCategory, undefined, "an empty profile must not gain the key");
});

test("a malformed category breakdown neither throws nor stops blocking", async () => {
  for (const value of ["not an object", 42, ["fastfood"], null]) {
    const bg = await bootedWorker({ blockedByCategory: value });

    assert.ok(bg.rules().length > 0, `blocking stopped for blockedByCategory = ${JSON.stringify(value)}`);
    assert.deepEqual(
      plain(bg.store.blockedByCategory),
      plain(value),
      "malformed input must be left exactly as found, not guessed at"
    );
  }
});

// ---------------------------------------------------------------------------
// The privacy shape of the fix
// ---------------------------------------------------------------------------

test("reporting a curated category adds no stored field and no request", async () => {
  const bg = await bootedWorker();
  const before = bg.fetchCount();
  const keysBefore = Object.keys(bg.store).sort();

  const context = await bg.message({ type: "getBlockContext", site: "fast-food-jollibee-com" });

  assert.equal(bg.fetchCount(), before, "reading a brand must not fetch anything");
  assert.deepEqual(Object.keys(bg.store).sort(), keysBefore, "a read must not write");

  await bg.message({
    type: "recordBlockedBrand",
    meta: { domain: context.site.domain, category: context.site.category, countries: context.site.countries }
  });

  assert.deepEqual(
    Object.keys(bg.store).filter((key) => !keysBefore.includes(key)).sort(),
    ["blockedByCategory", "blockedByCountry", "blockedByDomain"],
    "recording a brand may only touch the three existing aggregate maps"
  );

  // Integer aggregates only: no URL, no path, no timestamp, no history.
  const serialized = JSON.stringify({
    blockedByCategory: bg.store.blockedByCategory,
    blockedByCountry: bg.store.blockedByCountry,
    blockedByDomain: bg.store.blockedByDomain
  });
  assert.ok(!/https?:\/\//.test(serialized), "no URL is ever stored");
  Object.values(bg.store.blockedByCategory).forEach((count) => {
    assert.ok(Number.isInteger(count), "the category breakdown must stay integer counts");
  });
});
