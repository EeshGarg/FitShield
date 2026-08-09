"use strict";
/**
 * Curated-blocklist quality: the promises the DATA makes to the user.
 *
 * Everything the block page prints about a brand — its name, its category, the
 * countries it operates in — comes from these two files, and until recently the
 * category was overwritten by the rule bucket before it ever reached a screen.
 * Now that it does reach a screen, each of these fields is a claim, and each
 * test below exists because the datasets once failed it:
 *
 *   - 115 domains were listed in BOTH blocklists, so one brand produced two
 *     Settings rows with two different names and two different categories, and
 *     turning one off left the other one blocking;
 *   - seven listed apexes already blocked another listed entry, so the second
 *     row was a toggle that could not turn anything off;
 *   - general-purpose hosts (Uber's ride-hailing site, Yandex's search portal,
 *     Taobao, JD, parcel carriers, recipe sites) were blocked wholesale;
 *   - 1,230 brands claimed Japan, including Aldi Germany and Auchan France;
 *   - 550 brand names were the domain string with the TLD left on.
 *
 * These assert BEHAVIOUR through the shipped engine and the real service
 * worker, not the shape of the JSON — a record can be well-formed and still
 * tell the user something false.
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
// One brand, one toggle
// ---------------------------------------------------------------------------

test("no domain is listed in both blocklists", () => {
  const fastFood = new Set(FAST_FOOD.entries.map((entry) => entry.domain));
  const both = DELIVERY.entries.filter((entry) => fastFood.has(entry.domain)).map((entry) => entry.domain);

  assert.deepEqual(
    both,
    [],
    `these domains are in both files, so each gets two Settings rows and two toggles:\n  ${both.join("\n  ")}`
  );
});

test("no listed apex already blocks another listed entry", () => {
  const domains = ALL.map((entry) => entry.domain);
  const swallowed = [];

  domains.forEach((domain) => {
    const parent = domains.find((other) => other !== domain && domain.endsWith(`.${other}`));
    if (parent) {
      swallowed.push(`${domain} is already blocked by ${parent}`);
    }
  });

  assert.deepEqual(swallowed, [], `redundant rows that cannot be turned off:\n  ${swallowed.join("\n  ")}`);
});

test("turning a brand off in Settings really stops it being blocked", async () => {
  // The reproduction that started this: bbq.co.kr was listed twice, so
  // disabling "BBQ Chicken" left a second rule redirecting the same host, and
  // the block page then named the brand "Bbq.co.kr" and placed a Korean chain
  // in Japan.
  const probe = DELIVERY.entries.find((entry) => entry.domain === "bbq.co.kr") || DELIVERY.entries[0];

  const before = loadBackground();
  const state = await before.message({ type: "getBlockState" });
  const record = state.deliverySites.find((site) => site.match === probe.domain);
  assert.ok(record, `${probe.domain} is missing from the delivery site list`);

  const after = loadBackground({ disabledDeliverySiteKeys: [record.key] });
  await after.message({ type: "getBlockState" });
  await after.context.queueRefreshBlockingState();

  // Spread out of the worker's sandbox before asserting: arrays created in the
  // vm realm are not deepStrictEqual to arrays created here, whatever is in them.
  const still = [...after.rules()].filter((rule) => String(rule.condition.urlFilter) === `||${probe.domain}`);

  assert.equal(
    still.length,
    0,
    `${probe.domain} is still blocked by ${still.length} rule(s) after its only toggle was turned off`
  );

  // And the counterpart: it really was blocked before the toggle.
  const baseline = [...before.rules()];
  assert.ok(
    baseline.length === 0 || baseline.some((rule) => String(rule.condition.urlFilter) === `||${probe.domain}`),
    `${probe.domain} was never blocked, so turning it off proves nothing`
  );
});

// ---------------------------------------------------------------------------
// Over-blocking
// ---------------------------------------------------------------------------

test("general-purpose hosts are not blocked, while the brand's food surface still is", () => {
  // Each pair is: a host that serves substantial non-food content, and the
  // food-ordering surface of the SAME brand that must still be interrupted.
  const pairs = [
    ["uber.com", "ubereats.com"],
    ["yandex.ru", "eda.yandex.ru"],
    ["yandex.ru", "lavka.yandex.ru"],
    ["taobao.com", "koubei.taobao.com"],
    ["jd.com", "jddj.com"],
    ["jd.com", "daojia.jd.com"],
    ["coupang.com", "coupangeats.com"],
    ["grab.com", "food.grab.com"]
  ];

  pairs.forEach(([broad, food]) => {
    assert.equal(
      engine.isBlockedHost(broad, { entries: ALL }),
      false,
      `${broad} serves ride-hailing, search or general shopping — blocking its apex takes all of that with it`
    );
    assert.equal(
      engine.isBlockedHost(food, { entries: ALL }),
      true,
      `${food} is the ordering surface and must still be blocked`
    );
  });
});

test("parcel carriers and recipe sites are not in the blocklists", () => {
  // Blocking a parcel carrier blocks package tracking. Blocking a recipe site
  // blocks the exact thing FitShield's own block page tells the user to go do.
  const shouldNotBeListed = [
    "sf-express.com", "zto.com", "sto.cn", "yto.net.cn", "cainiao.com", "deppon.com",
    "xiachufang.com", "douguo.com", "haodou.com", "cookpad.com.cn", "meishichina.com",
    "58.com", "ganji.com"
  ];

  const listed = shouldNotBeListed.filter((host) => engine.isBlockedHost(host, { entries: ALL }));
  assert.deepEqual(listed, [], `these are not food-ordering surfaces:\n  ${listed.join("\n  ")}`);
});

// ---------------------------------------------------------------------------
// What the block page prints
// ---------------------------------------------------------------------------

test("no brand name is just its own domain", () => {
  const TLD_TAIL =
    /\s*\.\s*(com?|net|org|io|cn|kr|jp|tw|hk|in|br|ru|de|fr|it|es|nl|pl|se|no|dk|fi|cz|hu|ro|gr|tr|ua|au|nz|za|ae|sa|eg|ma|ng|ke|th|vn|ph|id|my|sg|mx|ar|cl|pe|ca|uk|ie|at|ch|be|pt|il|pk|lu)(\s*\.\s*[a-z]{2})?\s*$/i;

  // Companies that genuinely write their own name as a domain. A generated
  // label and a real one have the same shape, so each of these is a decision.
  const DOMAIN_IS_THE_BRAND = new Set([
    "delivery.com", "owner.com", "thuisbezorgd.nl", "takeaway.com", "pyszne.pl",
    "tsukurioki.jp", "hungry.ca", "menu.ca"
  ]);

  const generated = ALL.filter(
    (entry) => TLD_TAIL.test(entry.name) && !DOMAIN_IS_THE_BRAND.has(entry.domain)
  ).map((entry) => `${entry.domain} -> "${entry.name}"`);

  assert.deepEqual(generated, [], `the block page would print these as the brand:\n  ${generated.join("\n  ")}`);

  // The allowlist has to stay honest too: every brand on it must still exist.
  const stale = [...DOMAIN_IS_THE_BRAND].filter((domain) => !BY_DOMAIN.has(domain));
  assert.deepEqual(stale, [], `allowlisted brands that are no longer listed: ${stale.join(", ")}`);
});

test("a country tag never contradicts the domain's own ccTLD", () => {
  // The one fact about a brand's market that can be checked without leaving the
  // repository. It caught a classifier that had filed Aldi Germany, Auchan
  // France and 7-Eleven Vietnam under Japan — a list the block page prints.
  const CC = {
    de: "DE", fr: "FR", kr: "KR", jp: "JP", cn: "CN", tw: "TW", in: "IN", br: "BR", au: "AU",
    nz: "NZ", es: "ES", it: "IT", nl: "NL", pl: "PL", se: "SE", dk: "DK", no: "NO", fi: "FI",
    ru: "RU", tr: "TR", za: "ZA", ph: "PH", vn: "VN", th: "TH", my: "MY", sg: "SG", id: "ID",
    mx: "MX", ca: "CA", uk: "GB", ie: "IE", pt: "PT", be: "BE", ch: "CH", at: "AT", ae: "AE"
  };

  const wrong = ALL.filter((entry) => {
    const tld = entry.domain.split(".").pop();
    const expected = CC[tld];
    return expected && (entry.countries || []).length > 0 && !entry.countries.includes(expected);
  }).map((entry) => `${entry.domain} claims ${JSON.stringify(entry.countries)}`);

  assert.deepEqual(wrong, [], `country tags that the domain itself contradicts:\n  ${wrong.join("\n  ")}`);
});

test("no single metadata template covers a large share of a file", () => {
  // 804 entries — 38% of fast-food.json — once carried the identical tuple
  // ["JP"] / ["rice dishes","set meals","sides"] / fast_casual. That is what a
  // classifier stamps on everything it cannot classify, and every field in it
  // is shown to the user.
  [["fast-food.json", FAST_FOOD], ["delivery.json", DELIVERY]].forEach(([name, file]) => {
    const tuples = new Map();

    file.entries.forEach((entry) => {
      const specialties = entry.specialties || [];
      if (specialties.length === 0) {
        return; // an empty list is an honest "not known", not a template
      }
      const key = `${JSON.stringify(entry.countries || [])} / ${JSON.stringify(specialties)} / ${entry.category}`;
      tuples.set(key, (tuples.get(key) || 0) + 1);
    });

    tuples.forEach((count, key) => {
      assert.ok(
        count / file.entries.length <= 0.12,
        `${name}: ${count}/${file.entries.length} entries share ${key}`
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Every curated category reaches an answer
// ---------------------------------------------------------------------------

test("every category a brand can carry has a craving mapping", async () => {
  const catalog = await recipes.loadCatalog();
  const mapped = catalog.taxonomy.categoryCravings;
  const used = [...new Set(ALL.map((entry) => entry.category))].sort();
  const unmapped = used.filter((category) => !mapped[category]);

  assert.deepEqual(unmapped, [], `these categories reach the middle craving tier with nothing in it: ${unmapped}`);
  assert.ok(used.length >= 20, `only ${used.length} categories — the vocabulary should not collapse`);
});

test("a brand from every category gets a suggestion that answers its craving", async () => {
  await recipes.loadCatalog();

  const byCategory = new Map();
  ALL.forEach((entry) => {
    if (!byCategory.has(entry.category)) {
      byCategory.set(entry.category, []);
    }
    byCategory.get(entry.category).push(entry);
  });

  const failures = [];

  byCategory.forEach((entries, category) => {
    // A spread across the group, not just the first row.
    const sample = [entries[0], entries[Math.floor(entries.length / 2)], entries[entries.length - 1]];

    [...new Set(sample)].forEach((entry) => {
      const info = {
        key: entry.domain,
        domain: entry.domain,
        type: entry.type,
        category: entry.category,
        specialties: entry.specialties || []
      };
      const best = recipes.rankAlternatives(info, {}).matches[0];

      if (!best) {
        failures.push(`${category}/${entry.domain}: nothing at all`);
        return;
      }

      if (!best.reasons.some((reason) => reason.key === "craving")) {
        failures.push(`${category}/${entry.domain}: "${best.entry.title}" answers no craving`);
      }
    });
  });

  assert.deepEqual(failures, [], `blocks with no real answer:\n  ${failures.join("\n  ")}`);
});

test("the categories the blocklists use are the ones Settings can filter by", () => {
  // getAvailableCategories powers the category picker. A category in the data
  // that the engine cannot surface is a brand the user cannot filter for.
  const available = new Set(engine.getAvailableCategories(ALL).map((row) => row.category));
  const missing = [...new Set(ALL.map((entry) => entry.category))].filter((category) => !available.has(category));

  assert.deepEqual(missing, [], `categories the picker cannot offer: ${missing}`);
});

test("a supermarket is not filed as a restaurant", () => {
  // Carrefour, Aldi, Coles and 76 others were `fast_casual` with the specialties
  // "rice dishes, set meals, sides" — the block page called a hypermarket a
  // fast-casual restaurant and said it sold set meals.
  const supermarkets = ["carrefour.fr", "auchan.fr", "ah.nl", "coles.com.au", "asda.com", "edeka.de"];
  const wrong = supermarkets
    .map((domain) => BY_DOMAIN.get(domain))
    .filter(Boolean)
    .filter((entry) => entry.category !== "grocery")
    .map((entry) => `${entry.domain} is "${entry.category}"`);

  assert.deepEqual(wrong, [], `supermarkets filed as restaurants:\n  ${wrong.join("\n  ")}`);
});

test("a bubble-tea chain is filed as tea, and a juice bar as smoothie", () => {
  const teaBrands = ALL.filter((entry) =>
    (entry.specialties || []).some((specialty) => /\b(bubble tea|milk tea|fruit tea)\b/i.test(specialty))
  );

  assert.ok(teaBrands.length > 20, `expected the tea chains to still be listed, found ${teaBrands.length}`);

  const misfiled = teaBrands
    .filter((entry) => entry.category === "smoothie")
    .filter((entry) => !(entry.specialties || []).some((specialty) => /smoothie|juice/i.test(specialty)))
    .map((entry) => entry.domain);

  assert.deepEqual(misfiled, [], `tea shops filed under smoothie: ${misfiled.join(", ")}`);

  const smoothies = ALL.filter((entry) => entry.category === "smoothie");
  const notDrinks = smoothies
    .filter((entry) => !(entry.specialties || []).some((specialty) => /smoothie|juice|fruit drink/i.test(specialty)))
    .map((entry) => entry.domain);

  assert.deepEqual(notDrinks, [], `filed as smoothie but sells no smoothies: ${notDrinks.join(", ")}`);
});
