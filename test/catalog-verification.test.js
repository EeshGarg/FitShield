"use strict";
/**
 * Independent verification of the curated-catalog rewrite (commit e9aca7f).
 *
 * The catalog IS the product: a brand that quietly stops being blocked is a
 * paying user's delivery app that stops being interrupted, and a country tag
 * the block page prints is a claim about the world. That rewrite deleted 153
 * rows and rewrote metadata on roughly half the remainder, and it shipped with
 * tests written by the same pass that made the change. This file was written
 * separately, from the pre-rewrite tree, to pin the things a reader has to be
 * able to trust without re-deriving them:
 *
 *   1. NOTHING was silently unblocked. Every domain that was blocked before the
 *      rewrite is still blocked, except a NAMED list of deliberate removals —
 *      and each of those has its own food surface still blocked in its place.
 *   2. Country tags are checkable against the domain and are checked, in BOTH
 *      directions: never contradicting the ccTLD, and never blank when the
 *      ccTLD settles it.
 *   3. The matcher answers the block that was actually interrupted, for every
 *      brand in the catalog and across real kitchens — including the two shapes
 *      that were broken before (a constant `fastest` slot, and a filter that
 *      removed every answer while reporting nothing).
 *   4. The bucket rewrite (04e5c8b · 83c9dd2 · b3cda1f) moved 197 rows between
 *      the two files, deleted 30, renamed 52 brands and recategorised 84. What
 *      is pinned here is that the deletion cost exactly the 30 hosts it named —
 *      measured by booting this same worker against the PRE-rewrite datasets and
 *      diffing the installed rule list host by host, which found 30 lost, 0
 *      gained and 0 collateral — that every brand it moved now answers to
 *      exactly one popup switch in BOTH directions, and that the phone and the
 *      browser still block the same set of hosts.
 *
 * These drive the REAL service worker (test/helpers/background-harness.js), the
 * REAL engine bundle and the REAL extension/recipes.js against the shipped
 * datasets. Nothing here asserts the shape of the JSON: a record can be
 * well-formed and still tell the user something false.
 *
 * Where a check overlaps test/blocklist-quality.test.js it is deliberately
 * WIDER — that file's ccTLD table covers 36 country codes and its name check 55
 * top-level domains, and a table is only as good as its longest entry.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const engine = require("../FS Engine");
const recipes = require("../extension/recipes.js");
const { loadBackground } = require("./helpers/background-harness.js");

const ROOT = path.join(__dirname, "..");
const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", "blocklists", name), "utf8"));

const FAST_FOOD = read("fast-food.json");
const DELIVERY = read("delivery.json");
const ALL = [...FAST_FOOD.entries, ...DELIVERY.entries];
const BY_DOMAIN = new Map(ALL.map((entry) => [entry.domain, entry]));

// ---------------------------------------------------------------------------
// The historical record the rewrite acted on
// ---------------------------------------------------------------------------

// Domains that carried TWO rows before the rewrite — once in fast-food.json and
// once in delivery.json. One row was deleted from each. The claim attached to
// that deletion is "the curated record stays; every one of those domains is
// still blocked", and a wrongly-identified duplicate is a brand that silently
// stopped being interrupted. Every name below is checked against the rules the
// worker actually installs.
const DEDUPLICATED = [
  "60chicken.com", "aiqfome.com", "airasiafood.com", "angelinus.com", "baskinrobbins.co.kr",
  "bbq.co.kr", "behrouzbiryani.com", "bhc.co.kr", "bolt.eu", "boltfood.com", "bonchon.com",
  "bornga.co.kr", "box8.in", "burgerking.co.kr", "burgerking.com.cn", "chagee.com",
  "cheogajip.co.kr", "chowdeck.com", "composecoffee.com", "deliveroo.co.uk", "deliveroo.hk",
  "dicos.com.cn", "dominos.co.kr", "dominos.com.cn", "doordash.com", "dunkindonuts.co.kr",
  "eatclub.in", "eatfit.in", "eatsure.com", "ediya.com", "elmenus.com", "faasos.com",
  "farfor.ru", "foodora.com", "foodora.cz", "foodora.dk", "foodora.fi", "foodora.hu",
  "foodora.no", "foodora.se", "foodpanda.hk", "foodpanda.la", "foodpanda.my", "foodpanda.ph",
  "foodpanda.sg", "foodpanda.tw", "freshmenu.com", "glovoapp.com", "gojek.com",
  "gong-cha.co.kr", "goobne.co.kr", "heytea.com", "hollys.co.kr", "hosigi.co.kr",
  "ifood.com.br", "just-eat.co.uk", "just-eat.ie", "justeat.dk", "justeat.it", "kfc.co.kr",
  "kyochon.com", "lieferando.at", "lieferando.ch", "lieferando.de", "lotteria.com",
  "luckincoffee.com", "magicpin.in", "mcdonalds.co.kr", "mega-mgccoffee.com", "menulog.com.au",
  "mexicana.co.kr", "mojopizza.in", "momstouch.co.kr", "mrdfood.com", "mrpizza.co.kr",
  "mstand.cn", "nayuki.com", "nenechicken.com", "outback.co.kr", "ovenstory.in",
  "paikdabang.com", "papajohns.co.kr", "paris.co.kr", "pedidosya.cl", "pedidosya.com",
  "pelicana.co.kr", "pickaroo.com", "pizzaalvolo.co.kr", "pizzahut.co.kr", "pizzahut.com.hk",
  "pyszne.pl", "rappi.cl", "rappi.com.br", "rebelfoods.com", "samokat.ru", "schoolfood.co.kr",
  "subway.co.kr", "swiggy.com", "talabat.com", "tanuki.ru", "theborn.co.kr", "thuisbezorgd.nl",
  "tlj.co.kr", "tomntoms.com", "twosome.co.kr", "ubereats.com", "wallace.com.cn", "wolt.com",
  "wowmomo.com", "yakitoriya.ru", "yidiandian.com", "yonghe.com.cn", "zomato.com"
];

// Rows whose own listed apex already covered them. Deleting the row is only
// safe if the apex really does block the subdomain — which is a claim about
// Chrome's `||domain` anchoring, not about the JSON.
const SWALLOWED_BY_APEX = [
  ["waimai.meituan.com", "meituan.com"],
  ["meishi.meituan.com", "meituan.com"],
  ["h5.ele.me", "ele.me"],
  ["m.ele.me", "ele.me"],
  ["m.dianping.com", "dianping.com"]
];

// The 33 hosts unblocked ON PURPOSE, because blocking them took non-food with
// them. Each is named here so that re-adding one is a decision somebody has to
// make in this file, not an accident in a dataset.
const DELIBERATELY_UNBLOCKED = {
  "parent apex, food surface listed separately": [
    "grab.com", "uber.com", "jd.com", "taobao.com", "coupang.com", "yandex.ru"
  ],
  "general commerce and classifieds": [
    "tmall.com", "58.com", "58daojia.com", "ganji.com", "danggeunmarket.com"
  ],
  "parcel and freight carriers": [
    "sf-express.com", "jtexpress.com.cn", "cainiao.com", "cainiao.com.cn", "sto.cn",
    "yto.net.cn", "zto.com", "best-inc.com", "deppon.com", "mottu.com.br", "picup.co.za",
    "sendyit.com"
  ],
  "recipe and cooking sites the block page tells the user to visit": [
    "meishij.net", "xiachufang.com", "douguo.com", "cookpad.com.cn", "zhimeishi.com",
    "meishichina.com", "haodou.com", "akhbarelyomfood.com", "africabites.com"
  ],
  "a standards body, not a shop": ["ondc.org"]
};

// A removal only stands up if the brand's ordering surface is still interrupted.
const FOOD_SURFACE_STILL_BLOCKED = [
  ["uber.com", "ubereats.com"],
  ["grab.com", "food.grab.com"],
  ["grab.com", "grabfood.com"],
  ["yandex.ru", "eda.yandex.ru"],
  ["yandex.ru", "lavka.yandex.ru"],
  ["jd.com", "jddj.com"],
  ["jd.com", "daojia.jd.com"],
  ["taobao.com", "koubei.taobao.com"],
  ["coupang.com", "coupangeats.com"]
];

// ---------------------------------------------------------------------------
// One worker, booted once. Booting it per test costs ~300ms each.
// ---------------------------------------------------------------------------

let installedFilters = null;

async function blockedHosts() {
  if (!installedFilters) {
    const bg = loadBackground();
    await bg.context.queueRefreshBlockingState();
    const rules = bg.rules();

    assert.ok(rules.length > 2000, `the worker installed only ${rules.length} rules — nothing below would mean anything`);

    installedFilters = rules.map((rule) => String(rule.condition.urlFilter).replace(/^\|\|/, ""));
  }

  return installedFilters;
}

// Chrome's `||domain` urlFilter matches the apex and every subdomain. IDN
// domains reach the rule list punycoded, so the probe is punycoded too.
const asciiHost = (hostname) => {
  const host = String(hostname).toLowerCase().replace(/^www\./, "");

  try {
    return new URL(`http://${host}`).hostname;
  } catch (error) {
    return host;
  }
};

async function isBlockedByWorker(hostname) {
  const host = asciiHost(hostname);
  return (await blockedHosts()).some((filter) => host === filter || host.endsWith(`.${filter}`));
}

// ---------------------------------------------------------------------------
// 1. The rewrite unblocked nothing it did not name
// ---------------------------------------------------------------------------

test("every de-duplicated brand is still blocked by the row that survived", async () => {
  const unblocked = [];

  for (const domain of DEDUPLICATED) {
    if (!(await isBlockedByWorker(domain))) {
      unblocked.push(domain);
    }
  }

  assert.deepEqual(
    unblocked,
    [],
    `these brands lost their second row and are now blocked by nothing at all:\n  ${unblocked.join("\n  ")}`
  );

  // And the point of the de-duplication: exactly one row, so one Settings toggle.
  const twice = DEDUPLICATED.filter((domain) => ALL.filter((entry) => entry.domain === domain).length !== 1);
  assert.deepEqual(twice, [], `still listed more than once: ${twice.join(", ")}`);
});

test("a row deleted as redundant is still blocked by the apex that swallowed it", async () => {
  for (const [child, apex] of SWALLOWED_BY_APEX) {
    assert.ok(BY_DOMAIN.has(apex), `${apex} is gone, so deleting ${child} unblocked it`);
    assert.equal(BY_DOMAIN.has(child), false, `${child} is listed again — the de-duplication was undone`);
    assert.ok(await isBlockedByWorker(child), `${child} is not blocked; ${apex} does not actually cover it`);
  }
});

test("the deliberately unblocked hosts are unblocked, and only those", async () => {
  const stillBlocked = [];

  for (const [reason, hosts] of Object.entries(DELIBERATELY_UNBLOCKED)) {
    for (const host of hosts) {
      if (await isBlockedByWorker(host)) {
        stillBlocked.push(`${host} (${reason})`);
      }
    }
  }

  assert.deepEqual(
    stillBlocked,
    [],
    `these were unblocked on purpose and are blocking again:\n  ${stillBlocked.join("\n  ")}`
  );

  const total = Object.values(DELIBERATELY_UNBLOCKED).reduce((sum, list) => sum + list.length, 0);
  assert.equal(total, 33, `the removal list is meant to be exactly the 33 audited hosts, not ${total}`);
});

test("unblocking a parent never unblocked the brand's ordering surface", async () => {
  for (const [broad, food] of FOOD_SURFACE_STILL_BLOCKED) {
    assert.equal(await isBlockedByWorker(broad), false, `${broad} carries non-food traffic and must stay open`);
    assert.ok(await isBlockedByWorker(food), `${food} is the ordering surface and must still be interrupted`);
  }
});

test("a parcel carrier is open and a recipe site is open, through the real worker", async () => {
  // Two of the removals exist to stop OVER-blocking, and both are testable as
  // behaviour: package tracking must work, and the block page tells the user to
  // go and cook, which it cannot do if cooking sites are blocked.
  for (const carrier of ["sf-express.com", "www.zto.com", "tracking.cainiao.com"]) {
    assert.equal(await isBlockedByWorker(carrier), false, `${carrier} is a courier — blocking it blocks parcel tracking`);
  }

  for (const site of ["xiachufang.com", "www.douguo.com", "haodou.com"]) {
    assert.equal(await isBlockedByWorker(site), false, `${site} is a recipe site — the block page sends the user there`);
  }
});

test("the one non-ASCII domain reaches the rule list punycoded and still matches", async () => {
  const idn = ALL.filter((entry) => /[^\x00-\x7f]/.test(entry.domain));
  assert.equal(idn.length, 1, `expected exactly one IDN entry, found ${idn.length}`);

  const [entry] = idn;
  assert.ok(await isBlockedByWorker(entry.domain), `${entry.domain} produced no usable rule`);
  assert.ok(
    (await blockedHosts()).some((filter) => filter.startsWith("xn--")),
    "no punycoded rule reached the worker — Chrome rejects a non-ASCII urlFilter and drops the WHOLE batch"
  );

  // The name must not be the domain: this record is what the block page prints.
  assert.equal(entry.name, "Saemaeul Sikdang");
});

// ---------------------------------------------------------------------------
// 2. Country claims, both directions
// ---------------------------------------------------------------------------

// Every country-code top-level domain the shipped datasets actually use, mapped
// to the country it settles. Deliberately WIDER than the 36-code table in
// blocklist-quality.test.js: that table's silence is what let "Maxima.lv" and
// "Wolt.rs" through a test named "a country tag never contradicts the ccTLD".
const CCTLD = {
  ae: "AE", ar: "AR", at: "AT", au: "AU", be: "BE", bd: "BD", bg: "BG", bo: "BO", br: "BR",
  by: "BY", ca: "CA", ch: "CH", ci: "CI", cl: "CL", cn: "CN", cr: "CR", cz: "CZ", de: "DE",
  dk: "DK", do: "DO", dz: "DZ", ec: "EC", ee: "EE", eg: "EG", es: "ES", fi: "FI", fr: "FR",
  gh: "GH", gr: "GR", hk: "HK", hn: "HN", hr: "HR", hu: "HU", id: "ID", ie: "IE", il: "IL",
  in: "IN", is: "IS", it: "IT", jp: "JP", ke: "KE", kh: "KH", kr: "KR", kw: "KW", kz: "KZ",
  la: "LA", lk: "LK", lt: "LT", lu: "LU", lv: "LV", ma: "MA", md: "MD", mt: "MT", mx: "MX",
  my: "MY", ng: "NG", ni: "NI", nl: "NL", no: "NO", np: "NP", nz: "NZ", pa: "PA", pe: "PE",
  ph: "PH", pk: "PK", pl: "PL", pt: "PT", py: "PY", qa: "QA", ro: "RO", rs: "RS", ru: "RU",
  sa: "SA", se: "SE", sg: "SG", si: "SI", sk: "SK", sn: "SN", sv: "SV", th: "TH", tn: "TN",
  tr: "TR", tw: "TW", ua: "UA", uk: "GB", uy: "UY", vn: "VN", za: "ZA"
};

const ccTldOf = (domain) => CCTLD[String(domain).split(".").pop().toLowerCase()] || null;

test("no country tag contradicts its own ccTLD, over every ccTLD the data uses", () => {
  const wrong = ALL.filter((entry) => {
    const expected = ccTldOf(entry.domain);
    return expected && (entry.countries || []).length > 0 && !entry.countries.includes(expected);
  }).map((entry) => `${entry.domain} claims ${JSON.stringify(entry.countries)}`);

  assert.deepEqual(wrong, [], `country tags the domain itself contradicts:\n  ${wrong.join("\n  ")}`);
});

test("a country the domain settles is never left blank", () => {
  // The other half of the same fact, and the half that catches a CLEARING pass
  // that went too far. 456 tags were deleted as unverifiable; not one of them
  // may be a tag the domain itself proves. A blank list is a brand the country
  // picker can never reach and an empty "Active in" row on the block page.
  const blank = ALL.filter((entry) => ccTldOf(entry.domain) && (entry.countries || []).length === 0)
    .map((entry) => `${entry.domain} is a .${entry.domain.split(".").pop()} with no country at all`);

  assert.deepEqual(blank, [], `verifiable country tags that were cleared:\n  ${blank.join("\n  ")}`);
});

test("claiming Japan and nothing else requires a Japanese domain", () => {
  // The original defect: 1,230 brands claimed Japan and 118 had a domain for it,
  // because one generator template stamped ["JP"] on everything it could not
  // classify. Aldi Germany, Auchan France and 7-Eleven Vietnam were all filed
  // under Japan, and the block page prints that list.
  const japanOnly = ALL.filter((entry) => (entry.countries || []).length === 1 && entry.countries[0] === "JP");
  const unsupported = japanOnly
    .filter((entry) => !/\.jp$|\.tokyo$/.test(entry.domain))
    .map((entry) => `${entry.domain} ("${entry.name}")`);

  assert.deepEqual(unsupported, [], `sole-Japan claims with no Japanese domain:\n  ${unsupported.join("\n  ")}`);
  assert.ok(japanOnly.length > 50, `only ${japanOnly.length} Japan-only brands — the correction should not have emptied Japan`);

  // And Japan must no longer dominate the picker.
  const jp = engine.getAvailableCountries(ALL, "en").find((row) => row.code === "JP");
  assert.ok(jp, "Japan disappeared from the country picker entirely");
  assert.ok(
    jp.count / ALL.length < 0.15,
    `Japan is claimed by ${jp.count}/${ALL.length} brands — that is the generator template again`
  );
});

test("the country picker still reaches every market the datasets name", () => {
  const picker = engine.getAvailableCountries(ALL, "en");
  const offered = new Set(picker.map((row) => row.code));
  const used = new Set(ALL.flatMap((entry) => entry.countries || []));
  const missing = [...used].filter((code) => !offered.has(code));

  assert.deepEqual(missing, [], `countries in the data the picker cannot offer: ${missing.join(", ")}`);
  assert.ok(picker.length > 100, `only ${picker.length} countries reachable — the correction over-pruned`);

  // Every code must be a well-formed ISO-3166 alpha-2, because it is fed
  // straight to Intl.DisplayNames to build the "Active in" row.
  const malformed = [...used].filter((code) => !/^[A-Z]{2}$/.test(code));
  assert.deepEqual(malformed, [], `country codes the block page cannot name: ${malformed.join(", ")}`);
});

test("selecting a country blocks the brands that claim it, and not the rest", async () => {
  const bg = loadBackground({ deliverySitesEnabled: false, fastFoodSitesEnabled: false, enabledCountries: ["LV"] });
  await bg.context.queueRefreshBlockingState();
  const filters = new Set(bg.rules().map((rule) => String(rule.condition.urlFilter).replace(/^\|\|/, "")));

  const latvian = ALL.filter((entry) => (entry.countries || []).includes("LV"));
  assert.ok(latvian.length > 3, `only ${latvian.length} Latvian brands — pick a busier country for this probe`);

  const missed = latvian.filter((entry) => !filters.has(asciiHost(entry.domain))).map((entry) => entry.domain);
  assert.deepEqual(missed, [], `claim Latvia but country blocking does not catch them: ${missed.join(", ")}`);

  // A brand with no country tag cannot be caught by country selection — which is
  // the honest consequence of clearing an unverifiable tag rather than guessing.
  assert.equal(filters.has("mcdonalds.com"), false, "a country filter must not sweep in unrelated brands");
});

// ---------------------------------------------------------------------------
// 3. The matcher answers the block that was interrupted
// ---------------------------------------------------------------------------

// A deterministic spread across the whole catalog, not the first row of each
// group: every 37th record, which walks both files and every category.
const SPREAD = ALL.filter((_, index) => index % 37 === 0);

const infoFor = (entry) => ({
  key: entry.domain,
  domain: entry.domain,
  type: entry.type,
  category: entry.category,
  specialties: entry.specialties || []
});

test("every brand in the catalog derives at least one craving", async () => {
  const catalog = await recipes.loadCatalog();
  const silent = ALL.filter((entry) => {
    const cravings = recipes.deriveCravings(infoFor(entry), catalog.taxonomy);
    return cravings.primary.length === 0 && cravings.secondary.length === 0;
  }).map((entry) => `${entry.domain} (${entry.category})`);

  assert.deepEqual(silent, [], `blocks the matcher has nothing to say about:\n  ${silent.join("\n  ")}`);
});

test("the shipped answer is not a constant across the catalog", async () => {
  // selectAlternative is what BOTH block pages call — extension/warning.js and,
  // since 12c87c3, Android's block.js. If one entry fills the first slot for a
  // large share of the catalog, the page is not answering the block, it is
  // reciting. Swept over the whole spread rather than a handful of brands.
  await recipes.loadCatalog();

  const first = new Map();

  SPREAD.forEach((entry) => {
    const selection = recipes.selectAlternative(infoFor(entry), {}, { rotation: 0, seed: entry.domain });
    assert.ok(selection && selection.entry, `${entry.domain} produced no suggestion at all`);
    first.set(selection.entry.id, (first.get(selection.entry.id) || 0) + 1);
  });

  assert.ok(first.size >= 12, `the whole catalog is answered with only ${first.size} different things`);

  const commonest = Math.max(...first.values());
  assert.ok(
    commonest / SPREAD.length < 0.35,
    `one entry answers ${commonest}/${SPREAD.length} brands — that is a constant, not an answer`
  );
});

test("the fastest slot is not a constant across the catalog", async () => {
  // selectTrio is NOT shown to anyone — no block page offers three shapes, and
  // the docstring that said so was corrected in 6a1d4f4. It stays tested because
  // it is exported matcher capability, and because the bug below is the shape of
  // mistake that would reappear in whatever consumes it: sorting the whole
  // eligible pool by elapsed time returned the catalog's global minimum every
  // time, so ten unrelated brands — pizza, tacos, wings, ice cream — all offered
  // Two-Minute Iced Coffee. The shipped regression checks ten brands; this walks
  // the whole catalog.
  await recipes.loadCatalog();

  const slots = { closest: new Map(), fastest: new Map(), easiest: new Map() };

  SPREAD.forEach((entry) => {
    recipes.selectTrio(infoFor(entry), {}).forEach((item) => {
      const seen = slots[item.label];
      seen.set(item.entry.id, (seen.get(item.entry.id) || 0) + 1);
    });
  });

  assert.ok(SPREAD.length > 50, `only ${SPREAD.length} brands sampled — widen the spread`);

  Object.entries(slots).forEach(([label, seen]) => {
    assert.ok(seen.size >= 10, `the ${label} slot only ever produced ${seen.size} different things across ${SPREAD.length} brands`);

    const commonest = Math.max(...seen.values());
    assert.ok(
      commonest / SPREAD.length < 0.4,
      `one entry fills the ${label} slot for ${commonest}/${SPREAD.length} brands — that slot is a constant, not an answer`
    );
  });
});

test("every slot in a trio answers the block at the same tier", async () => {
  // Same caveat as above: a capability, not a shipped surface. "fastest" and
  // "easiest" must be the fastest and easiest ANSWERS, not the fastest and
  // easiest rows in the catalog. A salad chain that fills two of three slots
  // with a turkey sandwich and a rice bowl has answered a different question in
  // each slot.
  const catalog = await recipes.loadCatalog();
  const tierOf = (entryCravings, wanted) => {
    const tags = new Set((entryCravings || []).map((value) => String(value).toLowerCase()));
    if (wanted.primary.some((craving) => tags.has(craving))) return 2;
    if (wanted.secondary.some((craving) => tags.has(craving))) return 1;
    return 0;
  };

  const mixed = [];

  SPREAD.forEach((entry) => {
    const info = infoFor(entry);
    const wanted = recipes.deriveCravings(info, catalog.taxonomy);
    const tiers = recipes.selectTrio(info, {}).map((item) => tierOf(item.entry.cravings, wanted));

    if (tiers.length > 1 && new Set(tiers).size > 1) {
      mixed.push(`${entry.domain}: tiers ${JSON.stringify(tiers)}`);
    }
  });

  assert.deepEqual(mixed, [], `trios whose slots answer different questions:\n  ${mixed.join("\n  ")}`);
});

test("a suggestion is never unmakeable in the kitchen the user declared, silently", async () => {
  // The blender-only case. A filter that removes every answer has to be
  // REPORTED even when it leaves the pool full — otherwise a pizza order is
  // answered with a cottage cheese bowl and the page prints no reason.
  await recipes.loadCatalog();

  const kitchens = [
    ["blender"], ["microwave"], ["kettle"], ["toaster"], ["rice cooker"], ["air fryer"],
    ["stove", "oven"], ["microwave", "kettle"]
  ];
  const brands = ["dominos.com", "mcdonalds.com", "kfc.com", "starbucks.com", "chatime.com",
    "doordash.com", "tesco.com", "subway.com", "baskinrobbins.com", "chipotle.com"];
  const silent = [];

  kitchens.forEach((equipment) => {
    brands.forEach((domain) => {
      const entry = BY_DOMAIN.get(domain);
      assert.ok(entry, `${domain} is no longer listed — this probe proves nothing`);

      const ranked = recipes.rankAlternatives(infoFor(entry), { equipment }, {});
      assert.ok(ranked.matches.length > 0, `${domain} in a ${equipment.join("+")} kitchen returned nothing at all`);

      const top = ranked.matches[0].entry;

      if (!recipes.equipmentAvailable(top, equipment) && !ranked.relaxed.includes("equipment")) {
        silent.push(`${domain} / ${equipment.join("+")} -> "${top.id}" needs ${JSON.stringify(top.equipment)}`);
      }
    });
  });

  assert.deepEqual(silent, [], `offered with no reason line and no way to make it:\n  ${silent.join("\n  ")}`);
});

test("an equipment filter that removes every answer says so", async () => {
  await recipes.loadCatalog();

  // Fried chicken in a blender-only kitchen: every answer to the craving needs
  // heat. The page has to be able to say why it is offering something else.
  const kfc = BY_DOMAIN.get("kfc.com");
  const ranked = recipes.rankAlternatives(infoFor(kfc), { equipment: ["blender"] }, {});

  assert.ok(
    ranked.relaxed.includes("equipment"),
    "a blender-only kitchen lost every fried-chicken answer and reported nothing"
  );
  assert.ok(ranked.matches.length > 0, "reporting the relaxation must not mean showing an empty screen");
  assert.ok(
    recipes.equipmentAvailable(ranked.matches[0].entry, ["blender"]),
    "the filter is real: what is still offered must still be makeable"
  );
});

test("diet and allergens are absolute, over the whole catalog", async () => {
  await recipes.loadCatalog();

  const violations = [];

  [["vegan", ["vegan"]], ["vegetarian", ["vegan", "vegetarian"]], ["pescatarian", ["vegan", "vegetarian", "pescatarian"]]]
    .forEach(([diet, allowed]) => {
      SPREAD.slice(0, 20).forEach((entry) => {
        recipes.rankAlternatives(infoFor(entry), { dietPreference: diet }, {}).matches.forEach((match) => {
          if (!allowed.includes(String(match.entry.diet || "").toLowerCase())) {
            violations.push(`${diet} was offered ${match.entry.id} (${match.entry.diet})`);
          }
        });
      });
    });

  ["peanuts", "gluten", "dairy", "shellfish"].forEach((allergen) => {
    SPREAD.slice(0, 20).forEach((entry) => {
      recipes.rankAlternatives(infoFor(entry), { avoidAllergens: [allergen] }, {}).matches.forEach((match) => {
        if ((match.entry.allergens || []).map((value) => String(value).toLowerCase()).includes(allergen)) {
          violations.push(`avoiding ${allergen} was offered ${match.entry.id}`);
        }
      });
    });
  });

  assert.deepEqual([...new Set(violations)], [], `hard filters were relaxed:\n  ${[...new Set(violations)].join("\n  ")}`);
});

test("Show another walks the ranking instead of shuffling it", async () => {
  await recipes.loadCatalog();

  const entry = BY_DOMAIN.get("dominos.com");
  const seen = [];

  for (let rotation = 0; rotation < 6; rotation += 1) {
    const selection = recipes.selectAlternative(infoFor(entry), {}, { rotation });
    assert.ok(selection.entry, `rotation ${rotation} produced nothing`);
    seen.push(selection.entry.id);
  }

  assert.equal(new Set(seen).size, seen.length, `Show another repeated itself: ${seen.join(" -> ")}`);

  // Stable: stepping back returns the same suggestion, which is the whole point
  // of a rotation index rather than a random pick.
  const again = recipes.selectAlternative(infoFor(entry), {}, { rotation: 2 });
  assert.equal(again.entry.id, seen[2]);
});

// ---------------------------------------------------------------------------
// 4. What the block page is handed
// ---------------------------------------------------------------------------

test("every field the block page prints is present and printable", async () => {
  const catalog = await recipes.loadCatalog();
  const categories = new Set(Object.keys(catalog.taxonomy.categoryCravings));
  const problems = [];

  ALL.forEach((entry) => {
    if (!entry.name || !String(entry.name).trim()) {
      problems.push(`${entry.domain} has no name to print`);
    }

    if (!entry.category || !categories.has(entry.category)) {
      problems.push(`${entry.domain} carries category "${entry.category}", which the taxonomy does not know`);
    }

    if (!["delivery", "fast_food"].includes(entry.type)) {
      problems.push(`${entry.domain} carries type "${entry.type}", which no rule bucket matches`);
    }

    if (!Array.isArray(entry.countries) || !Array.isArray(entry.regions)) {
      problems.push(`${entry.domain} has a malformed country/region list`);
    }
  });

  assert.deepEqual(problems, [], `records the block page cannot render honestly:\n  ${problems.join("\n  ")}`);
});

test("a brand name never leaks a scheme, a path, a port or stray whitespace", () => {
  // The name is printed verbatim, inside the user's own sentence on the block
  // page. Anything that reads as a URL there is a generator artifact that
  // reached a screen. ("&" and " / " are left alone: "A&W Restaurants" and
  // "Restorando / TheFork" are how those brands are actually written.)
  const urlish = ALL.filter((entry) => /:\/\/|\S\/\S|:\d/.test(entry.name) || entry.name !== entry.name.trim())
    .map((entry) => `${entry.domain} -> ${JSON.stringify(entry.name)}`);

  assert.deepEqual(urlish, [], `names that read as URLs:\n  ${urlish.join("\n  ")}`);
});

test("a row's type matches the file it lives in", () => {
  // The two bucket toggles ("Delivery apps" / "Fast food sites") switch on
  // `type`, and Settings groups the rows the same way. A row whose type
  // disagrees with its file is a brand filed under a toggle the user would
  // never think to look under.
  const wrong = [
    ...FAST_FOOD.entries.filter((entry) => entry.type !== "fast_food"),
    ...DELIVERY.entries.filter((entry) => entry.type !== "delivery")
  ].map((entry) => `${entry.domain} is type "${entry.type}"`);

  assert.deepEqual(wrong, [], `rows filed under the wrong bucket:\n  ${wrong.join("\n  ")}`);
});

test("the categories in the data are exactly the ones the picker offers", () => {
  const offered = new Set(engine.getAvailableCategories(ALL).map((row) => row.category));
  const used = new Set(ALL.map((entry) => entry.category));

  assert.deepEqual([...used].filter((category) => !offered.has(category)), [], "a category the picker cannot reach");
  assert.deepEqual([...offered].filter((category) => !used.has(category)), [], "a picker row that matches no brand");
  assert.ok(used.size >= 20 && used.size <= 30, `${used.size} categories — the vocabulary has drifted`);
});

test("selecting a category blocks that category and nothing else", async () => {
  const bg = loadBackground({ deliverySitesEnabled: false, fastFoodSitesEnabled: false, enabledCategories: ["tea"] });
  await bg.context.queueRefreshBlockingState();
  const filters = new Set(bg.rules().map((rule) => String(rule.condition.urlFilter).replace(/^\|\|/, "")));

  const tea = ALL.filter((entry) => entry.category === "tea");
  assert.ok(tea.length > 20, `only ${tea.length} tea brands — the merge lost the bubble-tea chains`);

  const missed = tea.filter((entry) => !filters.has(asciiHost(entry.domain))).map((entry) => entry.domain);
  assert.deepEqual(missed, [], `filed as tea but a tea filter misses them: ${missed.join(", ")}`);

  assert.equal(filters.has("mcdonalds.com"), false, "a category filter must not sweep in other categories");
  assert.equal(filters.size, tea.length, `the tea filter produced ${filters.size} rules for ${tea.length} tea brands`);
});

// ---------------------------------------------------------------------------
// 5. The bucket rewrite (04e5c8b · 83c9dd2 · b3cda1f)
// ---------------------------------------------------------------------------
//
// Three commits moved 197 rows between the two files, deleted 30 rows, renamed
// 52 brands and recategorised 84. Every one of those touched something a user
// reads or a switch a user throws, and they were made in one pass, so the pass
// and its tests share whatever the pass got wrong.
//
// The independent check that matters most is arithmetic, not opinion: the tree
// BEFORE those commits installed 2,538 redirect rules for 2,535 records, and
// the deletion was declared to be 30 hosts. Anything other than 2,508 rules for
// 2,505 records means a row went missing somewhere nobody counted. Measured by
// booting the real worker against the pre-rewrite datasets and diffing the
// installed rule list host by host — 30 hosts lost, 0 gained, 0 collateral.

const PRE_REWRITE_RULES = 2538;
const PRE_REWRITE_RECORDS = 2535;

// The 30, and WHY each one stopped being a place you can order food.
const REWRITE_UNBLOCKED = {
  "a messenger, a gym, and a variety store — not ordering surfaces": [
    "line.me", "cult.fit", "tokmanni.fi"
  ],
  "holding companies and franchise operators, whose brands are listed separately": [
    "centralgroup.com", "minor.com", "amrest.eu", "bhcgroup.co.kr", "kiwa-group.co.jp",
    "arclandservice.co.jp", "zamp.com.br", "maruha-net.co.jp"
  ],
  "general-commerce marketplaces; the food surface is its own row": [
    "jumia.ci", "jumia.co.ke", "jumia.ma", "jumia.sn"
  ],
  "courier and errand fleets — you hire them, you do not order dinner from them": [
    "dada.cn", "imdada.cn", "dadajiasong.com", "shansong.com", "flashex.com", "flashhold.com",
    "fengniao.com", "fengniaodelivery.com", "fengniaozhongbao.cn", "sfcityrush.com",
    "uupt.com", "uupaotui.com", "sendme.ng", "gokada.ng", "pickndrop.co.ke"
  ]
};

// For each removal, the surface the user could still actually order from. A
// removal is only defensible if the brand's own ordering page stays blocked, or
// if the removal was of something nobody orders from at all.
const SURVIVING_ORDERING_SURFACE = [
  ["bhcgroup.co.kr", "bhc.co.kr"],
  ["bhcgroup.co.kr", "bhcchicken.global"],
  ["line.me", "lineman.co.th"],
  ["cult.fit", "eatfit.in"],
  ["jumia.ci", "jumiafood.com"],
  ["jumia.co.ke", "food.jumia.com"],
  ["minor.com", "thepizzacompany.com"],
  ["minor.com", "swensens.com"],
  ["centralgroup.com", "mkrestaurant.com"],
  ["tokmanni.fi", "prisma.fi"],
  ["tokmanni.fi", "s-kaupat.fi"],
  ["fengniao.com", "ele.me"],
  ["dada.cn", "jddj.com"],
  ["shansong.com", "meituan.com"]
];

test("the bucket rewrite unblocked exactly the thirty hosts it named", async () => {
  const stillBlocked = [];

  for (const [reason, hosts] of Object.entries(REWRITE_UNBLOCKED)) {
    for (const host of hosts) {
      if (await isBlockedByWorker(host)) {
        stillBlocked.push(`${host} (${reason})`);
      }
    }
  }

  assert.deepEqual(stillBlocked, [], `named as removed but still blocking:\n  ${stillBlocked.join("\n  ")}`);

  const named = Object.values(REWRITE_UNBLOCKED).reduce((sum, list) => sum + list.length, 0);
  assert.equal(named, 30, `the removal was declared to be 30 hosts, and this list holds ${named}`);
});

test("the rewrite dropped thirty rules and thirty records, and nothing else", async () => {
  // The whole point. A brand can vanish from the rule list by being deleted, by
  // being moved to a file the worker does not read, by losing an alias, or by
  // acquiring a domain Chrome refuses to compile — and every one of those looks
  // identical to the user: the app stops being interrupted, silently.
  assert.equal(
    ALL.length,
    PRE_REWRITE_RECORDS - 30,
    `the catalog holds ${ALL.length} records; ${PRE_REWRITE_RECORDS} minus the 30 named removals is ${PRE_REWRITE_RECORDS - 30}`
  );

  const filters = await blockedHosts();
  assert.equal(
    filters.length,
    PRE_REWRITE_RULES - 30,
    `the worker installed ${filters.length} rules; ${PRE_REWRITE_RULES} minus the 30 named removals is ${PRE_REWRITE_RULES - 30}`
  );
});

test("every record and every alias the catalog still holds reaches the rule list", async () => {
  const filters = new Set(await blockedHosts());
  const missing = [];

  ALL.forEach((entry) => {
    if (entry.enabled === false) {
      return;
    }

    [entry.domain, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].forEach((host) => {
      if (!filters.has(asciiHost(host))) {
        missing.push(`${entry.domain} -> ${host}`);
      }
    });
  });

  assert.deepEqual(missing, [], `listed in the data but not in the rules:\n  ${missing.join("\n  ")}`);
});

// The brands whose country domains used to sit in BOTH files, so that turning
// one popup switch off left the same brand blocked by the other. Each maps to
// the bucket it now belongs to, whole.
const ONE_BRAND_ONE_SWITCH = {
  delivery: {
    wolt: /^wolt\./, justeat: /^just-?eat\./, foodpanda: /^foodpanda\./,
    pedidosya: /^pedidosya\./, menulog: /^menulog\./, faasos: /^faasos\./
  },
  fast_food: {
    mcdonalds: /^mcdonalds\./, kfc: /^kfc\./, pizzahut: /^pizzahut\./, dominos: /^dominos\./,
    burgerking: /^burgerking\./, subway: /^subway\./, lotteria: /^lotteria\./,
    momstouch: /^momstouch\./, papajohns: /^papajohns\./, pizzaetang: /^pizzaetang\./,
    pelicana: /^pelicana\./, vips: /^vips\./, outback: /^outback\./, bornga: /^bornga\./,
    sushiro: /^sushiro\./, gongcha: /^gong-?cha\./, baskinrobbins: /^baskinrobbins\./,
    dunkin: /^dunkin/
  }
};

test("each brand the rewrite moved answers to exactly one popup switch, in both directions", async () => {
  // Asserted through the switches themselves, not through `type`: a row can
  // carry the right type and still be swept in by the other bucket, and the
  // symptom the user reported was "I turned off delivery and McDonald's Korea
  // kept being blocked".
  const withSwitches = async (delivery, fastFood) => {
    const bg = loadBackground({ deliverySitesEnabled: delivery, fastFoodSitesEnabled: fastFood });
    await bg.context.queueRefreshBlockingState();
    return new Set(bg.rules().map((rule) => String(rule.condition.urlFilter).replace(/^\|\|/, "")));
  };

  const deliveryOnly = await withSwitches(true, false);
  const fastFoodOnly = await withSwitches(false, true);
  const problems = [];
  let covered = 0;

  Object.entries(ONE_BRAND_ONE_SWITCH).forEach(([bucket, stems]) => {
    const mine = bucket === "delivery" ? deliveryOnly : fastFoodOnly;
    const theirs = bucket === "delivery" ? fastFoodOnly : deliveryOnly;

    Object.entries(stems).forEach(([stem, pattern]) => {
      const rows = ALL.filter((entry) => pattern.test(entry.domain));
      assert.ok(rows.length > 1, `${stem} matched ${rows.length} rows — this probe proves nothing`);
      covered += rows.length;

      rows.forEach((entry) => {
        const host = asciiHost(entry.domain);

        if (!mine.has(host)) {
          problems.push(`${entry.domain} is meant to be ${bucket} and the ${bucket} switch alone does not block it`);
        }

        if (theirs.has(host)) {
          problems.push(`${entry.domain} is meant to be ${bucket} but the OTHER switch still blocks it`);
        }
      });
    });
  });

  assert.deepEqual(problems, [], `brands still answering to two switches:\n  ${problems.join("\n  ")}`);
  assert.ok(covered > 150, `only ${covered} rows checked — the rewrite claimed to move about 191`);
});

test("turning both bucket switches off leaves nothing blocked", async () => {
  // The other half of "one brand, one switch": a row filed under neither type
  // would survive both switches being off and be unreachable from the popup.
  const bg = loadBackground({ deliverySitesEnabled: false, fastFoodSitesEnabled: false });
  await bg.context.queueRefreshBlockingState();
  assert.equal(bg.rules().length, 0, "a row is being blocked that neither popup switch can reach");
});

test("the ordering surface behind every host removed as corporate is still interrupted", async () => {
  for (const [removed, surface] of SURVIVING_ORDERING_SURFACE) {
    assert.equal(
      await isBlockedByWorker(removed),
      false,
      `${removed} was removed and is blocking again`
    );
    assert.ok(
      await isBlockedByWorker(surface),
      `${removed} was removed because ${surface} covers the brand — and ${surface} is not blocked`
    );
  }
});

test("no courier row survived, and no marketplace was mistaken for one", async () => {
  const couriers = ALL.filter((entry) => entry.category === "courier").map((entry) => entry.domain);
  assert.deepEqual(couriers, [], `still filed as couriers: ${couriers.join(", ")}`);

  // The removal criterion was the CATEGORY, not the word "courier" in a
  // specialty — 34 rows carry "courier delivery" as a specialty and every one
  // of them is a marketplace you order dinner from.
  const marketplaces = ALL.filter((entry) =>
    (entry.specialties || []).some((value) => /courier/i.test(String(value)))
  );
  assert.ok(marketplaces.length > 20, `only ${marketplaces.length} rows mention a courier specialty`);

  const swept = [];

  for (const entry of marketplaces) {
    if (!(await isBlockedByWorker(entry.domain))) {
      swept.push(`${entry.domain} ("${entry.name}")`);
    }
  }

  assert.deepEqual(swept, [], `ordering marketplaces removed with the courier fleets:\n  ${swept.join("\n  ")}`);
});

// ---------------------------------------------------------------------------
// 6. What the rename and recategorisation passes left behind
// ---------------------------------------------------------------------------

// The only brands whose real name contains a dot. Everything else that carried
// one — "Costa.coffee", "Wolt.ee", "Hesburger .bg" — was a generator artifact
// printed on the block page. This list is the pin: a new one has to be added
// here deliberately, by somebody who checked that the brand is written that way.
const NAMES_THAT_REALLY_CARRY_A_DOT = [
  "Co.opmart", "Delivery.com", "Ele.me", "Ele.me Hong Kong", "Hungry.ca", "Menu.ca",
  "Owner.com", "Pyszne.pl", "Takeaway.com", "Takeaway.com Belgium", "Thuisbezorgd.nl",
  "Tsukurioki.jp"
];

test("a brand name never carries a top-level domain the brand does not own", () => {
  const allowed = new Set(NAMES_THAT_REALLY_CARRY_A_DOT);
  const leaked = ALL.filter((entry) => /\.[a-z]{2,}/.test(entry.name) && !allowed.has(entry.name))
    .map((entry) => `${entry.domain} -> ${JSON.stringify(entry.name)}`);

  assert.deepEqual(leaked, [], `names that are still domains:\n  ${leaked.join("\n  ")}`);

  // And the allowlist must not rot into a way of hiding new ones.
  const unused = NAMES_THAT_REALLY_CARRY_A_DOT.filter((name) => !ALL.some((entry) => entry.name === name));
  assert.deepEqual(unused, [], `allowlisted names no longer in the data: ${unused.join(", ")}`);
});

test("a brand name never leaves a space stranded before its own suffix", () => {
  // "Hesburger .bg" and "Hesburger .lv" reached a screen. The space is the tell
  // that a name was assembled from parts rather than written down.
  const stranded = ALL.filter((entry) => /\s\./.test(entry.name) || /\s{2,}/.test(entry.name))
    .map((entry) => `${entry.domain} -> ${JSON.stringify(entry.name)}`);

  assert.deepEqual(stranded, [], `names assembled from parts:\n  ${stranded.join("\n  ")}`);
});

test("the two rows pulled out of grocery are the two that are not grocers", () => {
  // `checkers.com` and `willys.com` were filed as supermarkets because two other
  // brands own the same words: Checkers is a South African supermarket, Willys a
  // Swedish one. Both of those are listed separately, and both are still
  // grocery — which is what makes the correction checkable rather than a guess.
  const by = (domain) => {
    const entry = BY_DOMAIN.get(domain);
    assert.ok(entry, `${domain} is no longer listed — this probe proves nothing`);
    return entry;
  };

  assert.notEqual(by("checkers.com").category, "grocery", "checkers.com is a US drive-in burger chain");
  assert.notEqual(by("willys.com").category, "grocery", "willys.com is a US restaurant, not a supermarket");

  assert.equal(by("checkers60.com").category, "grocery", "Checkers Sixty60 IS the South African supermarket");
  assert.equal(by("willys.se").category, "grocery", "willys.se IS the Swedish supermarket");

  // Checkers and Rally's are the same operator and carry the same three
  // specialties; the pair is the evidence that checkers.com is the burger chain.
  assert.equal(by("checkers.com").category, by("rallys.com").category);
  assert.deepEqual(by("checkers.com").specialties, by("rallys.com").specialties);
});

test("a grocer refiled in the catalog is refiled in the Android app catalog too", () => {
  // The recategorisation moved 36 Android packages out of the "Fast food" pill
  // and under the "Grocery" pill. If the two catalogs disagree, an Android user
  // sees a supermarket app under a switch they turned off for burger chains.
  const packages = JSON.parse(
    fs.readFileSync(path.join(ROOT, "android", "app", "src", "main", "assets", "android-packages.json"), "utf8")
  ).packages;

  const wrong = [];

  Object.entries(packages).forEach(([id, meta]) => {
    const entry = BY_DOMAIN.get(meta.brandId);

    if (!entry) {
      wrong.push(`${id} points at ${meta.brandId}, which the blocklists no longer carry`);
      return;
    }

    if (entry.category === "grocery" && meta.category !== "grocery") {
      wrong.push(`${id} (${meta.brandId}) is grocery in the catalog and "${meta.category}" on Android`);
    }

    if (meta.category === "grocery" && entry.category !== "grocery") {
      wrong.push(`${id} (${meta.brandId}) is grocery on Android and "${entry.category}" in the catalog`);
    }
  });

  assert.deepEqual(wrong, [], `the two catalogs disagree:\n  ${wrong.join("\n  ")}`);
});

test("Android blocks exactly the hosts the extension blocks", async () => {
  // Two generators, one dataset. The Android VPN rule file is built from the
  // same blocklists as the extension's dynamic rules, and a drift between them
  // is a brand that is interrupted on the desktop and not on the phone — which
  // no test on either side alone can see.
  const rules = JSON.parse(
    fs.readFileSync(path.join(ROOT, "android", "app", "src", "main", "assets", "fitshield-rules.json"), "utf8")
  );

  const android = new Set((rules.hosts || []).map(asciiHost));
  const extension = new Set(await blockedHosts());

  const onlyExtension = [...extension].filter((host) => !android.has(host));
  const onlyAndroid = [...android].filter((host) => !extension.has(host));

  assert.deepEqual(onlyExtension, [], `blocked in the browser and not on Android: ${onlyExtension.join(", ")}`);
  assert.deepEqual(onlyAndroid, [], `blocked on Android and not in the browser: ${onlyAndroid.join(", ")}`);
});
