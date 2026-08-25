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
  // in Japan. bbq.co.kr has since moved to fast-food.json — it is bb.q Chicken's
  // own ordering site, and the brand's other row was already there — so the
  // probe is a marketplace that has only ever had one delivery row.
  const probe = DELIVERY.entries.find((entry) => entry.domain === "doordash.com") || DELIVERY.entries[0];

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
  // Self-maintaining: a name is domain-derived when it ends in a dot plus THIS
  // record's own final domain label.
  //
  // This used to be a hand-written list of 55 TLDs, which is a list that rots.
  // It omitted .ee .lt .lv .ci .sn .md .hr .rs .bg .sk .dz .nu .eu .coffee
  // .cafe .fit .africa .tokyo among others, so it passed at zero while
  // "Costa.coffee", "Wolt.ee", "Maxima.lt", "Hungrylion.africa" and thirty
  // more shipped as brand names. Deriving the tail from the record removes the
  // list, and with it the possibility of the list being incomplete.
  const looksDomainDerived = (entry) => {
    const labels = String(entry.domain || "").split(".");
    const tld = labels[labels.length - 1];

    if (!tld) {
      return false;
    }

    // Whitespace collapsed first: five records read "Hesburger .bg".
    // Two backslashes: inside a template literal a single one escapes to a bare
    // dot, which in a regex is ANY character — "AnomaliCoffee" then matched
    // ".coffee$" and "AldiUK" matched ".uk$".
    return new RegExp(`\\.${tld}$`, "i").test(String(entry.name || "").replace(/\s+/g, ""));
  };

  // Companies that genuinely write their own name as a domain. A generated
  // label and a real one have the same shape, so each of these is a decision.
  const DOMAIN_IS_THE_BRAND = new Set([
    "delivery.com", "owner.com", "thuisbezorgd.nl", "takeaway.com", "pyszne.pl",
    "tsukurioki.jp", "hungry.ca", "menu.ca", "ele.me", "e.leclerc"
  ]);

  const generated = ALL.filter(
    (entry) => looksDomainDerived(entry) && !DOMAIN_IS_THE_BRAND.has(entry.domain)
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

test("a brand whose NAME names a country claims that country", () => {
  // The block page prints the name and the country list one under the other,
  // so a row that names a market in one and omits it in the other prints a
  // contradiction. lawson108.com was named "Lawson China" with no countries at
  // all — and it is not Chinese: its Android package is com.bzbs.lawson, and
  // bzbs is Buzzebees, the Thai loyalty platform whose only other package in
  // this catalog is com.bzbs.burgerking -> burgerkingthailand.com. Lawson 108
  // is the Saha-Lawson Thailand venture. Four more rows had the same shape,
  // with the market named in the domain as well as the brand.
  const NAMED = {
    Korea: "KR", China: "CN", Japan: "JP", Taiwan: "TW", India: "IN", Thailand: "TH",
    Vietnam: "VN", Malaysia: "MY", Singapore: "SG", Indonesia: "ID", Philippines: "PH",
    Mexico: "MX", Brasil: "BR", Brazil: "BR", Canada: "CA", Australia: "AU",
    France: "FR", Germany: "DE", Spain: "ES", Italy: "IT", Poland: "PL", Turkey: "TR",
    Russia: "RU", Nigeria: "NG", Kenya: "KE", Egypt: "EG", Chile: "CL", Peru: "PE",
    Colombia: "CO", Argentina: "AR", Portugal: "PT"
  };

  // A place name inside a brand name that is not a market claim.
  const NOT_A_MARKET = new Set(["maggianos.com"]); // "Maggiano's Little Italy" is a neighbourhood

  const wrong = [];
  ALL.filter((entry) => !NOT_A_MARKET.has(entry.domain)).forEach((entry) => {
    Object.entries(NAMED).forEach(([word, iso]) => {
      if (new RegExp(`\\b${word}\\b`, "i").test(entry.name || "") && !(entry.countries || []).includes(iso)) {
        wrong.push(`${entry.domain} is called "${entry.name}" but claims ${JSON.stringify(entry.countries)}`);
      }
    });
  });

  assert.deepEqual(wrong, [], `the name and the country row contradict each other:\n  ${wrong.join("\n  ")}`);

  const stale = [...NOT_A_MARKET].filter((domain) => !BY_DOMAIN.has(domain));
  assert.deepEqual(stale, [], `exempted brands that are no longer listed: ${stale.join(", ")}`);

  // And the row that started it, asserted directly: a wrong country is worse
  // than no country, because the user reads it as a fact about the brand.
  const lawson = BY_DOMAIN.get("lawson108.com");
  assert.ok(lawson, "lawson108.com is no longer listed");
  assert.equal(lawson.name, "Lawson 108");
  assert.deepEqual(lawson.countries, ["TH"]);
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

test("a generator's default tuple is not shipped as a description of a brand", () => {
  // The share test above passes at 100/1991 = 5%, and 5% was still a lie:
  // ["sandwiches","burgers","salads"] sat on 100 rows, 99 of them the catch-all
  // `fast_casual`, including Portillo's Hot Dogs, Skyline Chili, Goodberry's
  // Frozen Custard and The Melting Pot. That is what the classifier wrote when
  // it had nothing, and it was then read BACK: willys.com was filed `sandwich`
  // on the strength of it. Cleared to an empty list — an honest "not known" —
  // the way the fabricated ["JP"]/["rice dishes","set meals","sides"] tuples
  // were before it.
  const CLEARED = [["sandwiches", "burgers", "salads"]].map((tuple) => JSON.stringify(tuple));

  const returned = ALL.filter((entry) => CLEARED.includes(JSON.stringify(entry.specialties || [])))
    .map((entry) => `${entry.domain} ("${entry.name}")`);

  assert.deepEqual(returned, [], `a cleared template is back on these rows:\n  ${returned.join("\n  ")}`);

  // The witnesses, so this cannot be satisfied by shortening the list above.
  // Each sells something the template never mentioned, and each must now say
  // nothing rather than something false.
  [
    ["goodberrys.com", "frozen custard"],
    ["portilloshotdogs.com", "hot dogs"],
    ["skylinechili.com", "chili"],
    ["meltingpot.com", "fondue"]
  ].forEach(([domain, sells]) => {
    const entry = BY_DOMAIN.get(domain);
    assert.ok(entry, `${domain} is no longer listed — this witness needs replacing`);
    assert.deepEqual(
      entry.specialties,
      [],
      `${entry.name} sells ${sells}; the block page must not claim otherwise`
    );
  });

  // And the row the template was read back off. `grocery` was wrong (that came
  // from willys.se, the Swedish supermarket) and so was `sandwich`.
  const willys = BY_DOMAIN.get("willys.com");
  assert.ok(willys, "willys.com is no longer listed");
  assert.equal(willys.category, "fast_casual", "a category derived from a template is not a category");
  assert.equal(BY_DOMAIN.get("willys.se").category, "grocery", "the Swedish grocer is a different brand");
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

// ---------------------------------------------------------------------------
// One brand, one bucket
// ---------------------------------------------------------------------------

// The two files ARE the two switches the popup offers. A brand whose country
// domains were split across them meant turning one switch off left the same
// brand blocked by the other: mcdonalds.com.cn and mcdonalds.co.kr sat in
// delivery while fourteen siblings sat in fast food, and wolt.de, just-eat.fr
// and foodpanda.vn sat in fast food while wolt.com and just-eat.co.uk sat in
// delivery. Turning "Fast food sites" off unblocked 27 delivery platforms.
function bucketsByStem() {
  const stems = new Map();

  [
    ["delivery", path.join(ROOT, "data", "blocklists", "delivery.json")],
    ["fast-food", path.join(ROOT, "data", "blocklists", "fast-food.json")]
  ].forEach(([bucket, file]) => {
    JSON.parse(fs.readFileSync(file, "utf8")).entries.forEach((entry) => {
      const stem = String(entry.domain || "").split(".")[0];

      if (!stems.has(stem)) {
        stems.set(stem, new Set());
      }

      stems.get(stem).add(bucket);
    });
  });

  return stems;
}

test("no brand has its domains split across both blocklists", () => {
  const split = [...bucketsByStem()].filter(([, buckets]) => buckets.size > 1).map(([stem]) => stem);

  assert.deepEqual(
    split,
    [],
    `these brands are in both files, so one switch cannot turn them off: ${split.join(", ")}`
  );
});

// The stem guard above keys on the domain, so it only ever caught brands that
// straddled the files under ONE domain shape. Nine more straddled under two:
// HEYTEA as xicha.com and heytea.com, Cotti Coffee as cotti.com and
// cotticoffee.com, Real Kungfu under four domains, and Angel-in-us, bb.q
// Chicken, BHC Chicken, Paris Baguette, TGI Fridays and Yandex Lavka under a
// Korean or Russian domain in one file and an international one in the other.
// Every one of them survived turning either switch off.
test("no two rows of one brand answer to different popup switches", () => {
  const by = new Map();
  ALL.forEach((e) => { const k = e.name.trim().toLowerCase(); if (!by.has(k)) by.set(k, []); by.get(k).push(e); });
  const split = [...by.values()].filter((rows) => new Set(rows.map((r) => r.type)).size > 1)
    .map((rows) => `${rows[0].name}: ${rows.map((r) => r.domain + "=" + r.type).join(", ")}`);
  assert.deepEqual(split, [], `one brand, two switches:\n  ${split.join("\n  ")}`);
});

// The same question asked of the OTHER field the two rows disagreed about.
// rema.no became `grocery` while rema1000.no stayed `fast_casual`, so the
// category filter in Settings blocked half of one Norwegian supermarket.
test("no two rows of one brand disagree about their category", () => {
  const by = new Map();
  ALL.forEach((e) => { const k = e.name.trim().toLowerCase(); if (!by.has(k)) by.set(k, []); by.get(k).push(e); });
  const split = [...by.values()].filter((rows) => new Set(rows.map((r) => r.category)).size > 1)
    .map((rows) => `${rows[0].name}: ${rows.map((r) => r.domain + "=" + r.category).join(", ")}`);
  assert.deepEqual(split, [], `one brand, two categories:\n  ${split.join("\n  ")}`);
});

// Exact-name matching is not enough on its own: a brand writes itself
// "bb.q Chicken" on one row and "BBQ Chicken" on another, "Angel-in-us Coffee"
// and "Angelinuscoffee", "TGI Fridays Korea" and "Tgifridays". Normalising the
// punctuation and the trailing market word is what makes the two guards above
// cover the whole brand rather than the rows that happened to be typed alike.
function brandKey(name) {
  const MARKET = /(korea|china|japan|taiwan|hongkong|singapore|malaysia|thailand|vietnam|india|indonesia|philippines|uk|usa|us|canada|australia|mexico|brasil|brazil|france|germany|espana|spain|italia|italy|nederland|polska|poland|turkiye|turkey|russia|global|international)$/;
  let key = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const market = key.match(MARKET);
  return market && key.length > market[1].length + 2 ? key.slice(0, -market[1].length) : key;
}

// Different companies that normalise to the same key. Each is a decision, and
// each is checked below for still being real, so the list cannot rot into a
// way of silencing the guard.
const NOT_THE_SAME_BRAND = {
  willys: ["willys.com", "willys.se"],       // Willy's, a US restaurant, and Willys, the Swedish grocer
  eatclub: ["eatclub.com.au", "eatclub.in"], // an Australian deals app and an Indian cloud kitchen
  foody: ["foody.com.mx", "foody.vn"]        // unrelated platforms in Mexico and Vietnam
};

test("one brand means one switch and one category, however the brand writes its name", () => {
  const by = new Map();
  ALL.forEach((e) => { const k = brandKey(e.name); if (!by.has(k)) by.set(k, []); by.get(k).push(e); });

  const split = [...by]
    .filter(([key]) => !NOT_THE_SAME_BRAND[key])
    .filter(([, rows]) => new Set(rows.map((r) => r.type)).size > 1 || new Set(rows.map((r) => r.category)).size > 1)
    .map(([, rows]) => `${rows[0].name}: ${rows.map((r) => `${r.domain}=${r.type}/${r.category}`).join(", ")}`);

  assert.deepEqual(split, [], `rows of one brand that disagree:\n  ${split.join("\n  ")}`);

  // Every declared exception must still be two rows that really do disagree —
  // otherwise it is silencing nothing and should go.
  const pointless = Object.entries(NOT_THE_SAME_BRAND).filter(([, domains]) => {
    const rows = domains.map((d) => BY_DOMAIN.get(d));
    if (rows.some((row) => !row)) {
      return true;
    }
    return new Set(rows.map((r) => r.type)).size === 1 && new Set(rows.map((r) => r.category)).size === 1;
  });

  assert.deepEqual(
    pointless.map(([key]) => key),
    [],
    "these exceptions no longer describe two rows that disagree, or name a row that is gone"
  );
});

test("turning off one blocklist does not leave the other one's brands blocked", async () => {
  const blocked = (rules, domain) =>
    rules.some((rule) => (((rule.condition || {}).urlFilter) || "") === `||${domain}`);

  // A marketplace and a chain from each of the brands that used to straddle.
  const marketplaces = ["wolt.de", "just-eat.fr", "foodpanda.vn", "pedidosya.pe"];
  const chains = ["mcdonalds.co.kr", "subway.co.kr", "pizzahut.com.cn"];

  const noFastFood = loadBackground({ fastFoodSitesEnabled: false });
  await noFastFood.context.queueRefreshBlockingState();
  const withoutFastFood = noFastFood.rules();

  marketplaces.forEach((domain) =>
    assert.ok(blocked(withoutFastFood, domain), `${domain} is a delivery marketplace and must survive turning fast food off`)
  );
  chains.forEach((domain) =>
    assert.ok(!blocked(withoutFastFood, domain), `${domain} is a fast-food chain and must stop blocking when fast food is off`)
  );

  const noDelivery = loadBackground({ deliverySitesEnabled: false });
  await noDelivery.context.queueRefreshBlockingState();
  const withoutDelivery = noDelivery.rules();

  marketplaces.forEach((domain) =>
    assert.ok(!blocked(withoutDelivery, domain), `${domain} must stop blocking when delivery is off`)
  );
  chains.forEach((domain) =>
    assert.ok(blocked(withoutDelivery, domain), `${domain} is a chain and must survive turning delivery off`)
  );
});

// ---------------------------------------------------------------------------
// Only surfaces you can order food from
// ---------------------------------------------------------------------------

// Blocking something a person cannot order food from is the most expensive
// mistake this catalog can make: the user cannot reach a service they need,
// FitShield is the visible cause, and they uninstall. The rewrite removed
// parcel carriers and general marketplaces on exactly this basis and left a
// set behind, so the same rule was being applied to some brands and not others.
test("no messenger, fitness app, holding company or courier is blocked", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  const rules = bg.rules();
  const blocked = (domain) =>
    rules.some((rule) => (((rule.condition || {}).urlFilter) || "") === `||${domain}`);

  const notOrderingSurfaces = [
    ["line.me", "the LINE messenger — blocking it takes out LINE Login and the web client"],
    ["cult.fit", "an Indian fitness app"],
    ["tokmanni.fi", "discount variety retail"],
    ["centralgroup.com", "a retail conglomerate's corporate site"],
    ["minor.com", "a hospitality holding company"],
    // minorfood.com is the SAME conglomerate's food-division corporate site,
    // and it carried the exact signature the thirteen other corporate sites
    // were removed on: fast_food/fast_casual, no specialties, no countries.
    // It was left listed while minor.com went, which made the criterion a
    // matter of which domain the sweep happened to look at. Minor's brands are
    // listed one by one below.
    ["minorfood.com", "the food division's corporate site, not an ordering surface"],
    ["amrest.eu", "a restaurant franchisor's corporate site"],
    ["bhcgroup.co.kr", "a corporate group site"],
    ["jumia.ma", "general African e-commerce"],
    ["sendme.ng", "a courier and errand platform"],
    ["pickndrop.co.ke", "a courier and errand platform"],
    ["dada.cn", "a same-city courier platform"]
  ];

  notOrderingSurfaces.forEach(([domain, why]) =>
    assert.ok(!blocked(domain), `${domain} is blocked and should not be — ${why}`)
  );

  // Removing them must not cost coverage: every one of these brands keeps the
  // surface a person actually orders from.
  [
    ["lineman.co.th", "LINE MAN, the food delivery app"],
    ["eatfit.in", "cult.fit's food arm"],
    ["jumiafood.com", "Jumia's food arm"],
    ["bhc.co.kr", "BHC's consumer site"],
    ["thepizzacompany.com", "Minor's pizza chain"],
    ["swensens.com", "Minor's ice-cream chain"],
    ["sizzler.com", "Minor's steakhouse chain"],
    ["burgerkingthailand.com", "Minor's Burger King franchise"]
  ].forEach(([domain, what]) => assert.ok(blocked(domain), `${what} (${domain}) stopped being blocked`));

  // jumia.co.ke was an apex, so removing it stopped covering the surface the
  // apex was covering: food.jumia.co.ke, Jumia Food's Kenyan storefront.
  // Neither food.jumia.com nor jumiafood.com reaches it. The same is true of
  // the other three jumia.<cc> apexes the rewrite removed, so all four markets
  // are restored as aliases of the brand's existing row — one brand, one
  // Settings toggle, and the general-commerce apexes stay open.
  ["food.jumia.ci", "food.jumia.co.ke", "food.jumia.ma", "food.jumia.sn"].forEach((surface) => {
    const apex = surface.replace(/^food\./, "");
    assert.ok(blocked(surface), `${surface} is Jumia Food's ordering surface and is not blocked`);
    assert.ok(!blocked(apex), `${apex} is general African e-commerce and must stay open`);
  });
});

// ---------------------------------------------------------------------------
// A removal must not quietly take a real ordering surface with it
// ---------------------------------------------------------------------------

test("removing a brand did not orphan another brand's Android app", () => {
  // Android coverage is keyed on package IDs, and a package can outlive — or
  // die with — the blocklist row it hung off. Both happened.
  //
  //   arclandservice.co.jp was removed as a holding company, correctly. Its
  //   package li.yapp.appE3F5CA73 is not a corporate app: it is the Yappli-built
  //   CONSUMER app for Katsuya, the chain Arcland operates. It went with the
  //   row, and no katsuya.jp row existed to catch it, so a real ordering app
  //   silently stopped being interrupted on the phone.
  //
  //   cult.fit was removed, also correctly — it is a fitness app. eatfit.in
  //   was `packageStatus: "shared_app"` with no packages of its own, and the
  //   app it shared was cult.fit's fit.cure.android. The status was left
  //   pointing at nothing, so the record claimed Android coverage that no
  //   longer existed anywhere in the catalog.
  const apps = ["fast-food-apps.json", "delivery-apps.json"].flatMap(
    (file) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", "android", file), "utf8")).apps
  );
  const byBrand = new Map(apps.map((app) => [app.brandId, app]));
  const packageOwner = new Map();
  apps.forEach((app) => (app.packageIds || []).forEach((id) => packageOwner.set(id, app.brandId)));

  const ORPHANED_BY_A_REMOVAL = [
    {
      removed: "arclandservice.co.jp",
      package: "li.yapp.appE3F5CA73",
      rehomedTo: "katsuya.jp",
      what: "the Yappli-built Katsuya app"
    },
    {
      removed: "cult.fit",
      package: "fit.cure.android",
      dependedOnIt: "eatfit.in",
      what: "the Cult.fit app EatFit was recorded as sharing"
    }
  ];

  const problems = [];

  ORPHANED_BY_A_REMOVAL.forEach((row) => {
    assert.ok(!BY_DOMAIN.has(row.removed), `${row.removed} is listed again — this case no longer applies`);

    if (row.rehomedTo) {
      // The consumer app must belong to a brand the catalog still lists.
      const owner = packageOwner.get(row.package);
      if (owner !== row.rehomedTo) {
        problems.push(`${row.package} (${row.what}) belongs to ${owner || "nothing"}, not ${row.rehomedTo}`);
      }
      if (!BY_DOMAIN.has(row.rehomedTo)) {
        problems.push(`${row.rehomedTo} carries ${row.package} but is not in the blocklists`);
      }
    }

    if (row.dependedOnIt) {
      // The removed brand's package must be gone...
      if (packageOwner.has(row.package)) {
        problems.push(`${row.package} belongs to ${row.removed}, which was removed, yet is still mapped`);
      }
      // ...and nothing may still claim to be covered by it.
      const dependent = byBrand.get(row.dependedOnIt);
      if (dependent && dependent.packageStatus === "shared_app" && (dependent.packageIds || []).length === 0) {
        problems.push(
          `${row.dependedOnIt} still says "shared_app", but ${row.what} left with ${row.removed} — ` +
            "the status names an app that is not in the catalog"
        );
      }
    }
  });

  assert.deepEqual(problems, [], `an Android mapping outlived or died with its brand:\n  ${problems.join("\n  ")}`);

  // Katsuya's brand row itself, since the app is only reachable through it.
  const katsuya = BY_DOMAIN.get("katsuya.jp");
  assert.ok(katsuya, "katsuya.jp is not listed, so li.yapp.appE3F5CA73 has nothing to hang off");
  assert.equal(katsuya.type, "fast_food");
  assert.deepEqual(katsuya.countries, ["JP"]);
});

test("the courier category is empty, because a courier is not a place to order from", () => {
  const couriers = [];

  ["delivery", "fast-food"].forEach((bucket) => {
    JSON.parse(fs.readFileSync(path.join(ROOT, "data", "blocklists", `${bucket}.json`), "utf8")).entries.forEach(
      (entry) => {
        if (entry.category === "courier") {
          couriers.push(entry.domain);
        }
      }
    );
  });

  assert.deepEqual(couriers, [], `courier platforms are still listed: ${couriers.join(", ")}`);
});

test("the recipe taxonomy carries no branch for a category no brand can have", async () => {
  // The catalog stopped having couriers, and `taxonomy.categoryCravings` kept a
  // `courier` branch mapping to convenience/comfort/late-night. Nothing can
  // reach it — deriveCravings looks the category up from the blocked entry, and
  // no entry carries that word — so it is a rule about the product that the
  // product no longer contains.
  //
  // This is NOT the same question as the display name: tools/category-audit.js
  // deliberately keeps catLabelCourier on a RETIRED list, because anyone who
  // was blocked on a courier before the removal still carries the id in their
  // lifetime stats and would otherwise see prettified English. A name for
  // history is not a live branch in the matcher.
  const catalog = await recipes.loadCatalog();
  const used = new Set(ALL.map((entry) => entry.category));

  // The three keys that are legitimately not a curated category: two rule
  // buckets deriveCravings falls back to, and the id a user's own site carries.
  const NOT_A_BRAND_CATEGORY = new Set(["fast_food", "custom", "general"]);

  const dead = Object.keys(catalog.taxonomy.categoryCravings)
    .filter((category) => !used.has(category) && !NOT_A_BRAND_CATEGORY.has(category))
    .sort();

  assert.deepEqual(dead, [], `craving branches no blocked brand can reach: ${dead.join(", ")}`);

  // The fallbacks have to keep working, or removing a dead branch would be a
  // way of breaking a live one.
  NOT_A_BRAND_CATEGORY.forEach((key) =>
    assert.ok(
      (catalog.taxonomy.categoryCravings[key] || []).length > 0,
      `${key} is what the matcher falls back to and it maps to nothing`
    )
  );
});

// ---------------------------------------------------------------------------
// A category is a claim the user reads
// ---------------------------------------------------------------------------

// The curated category reaches the screen twice — the block page's Category row
// and Settings' most-blocked list — so a wrong one is visible, not internal.
// The shipped guard used to check six hard-coded domains in one direction only,
// which is why 33 supermarkets sat in `fast_casual` and two restaurants sat in
// `grocery` through a name collision with supermarkets in other countries.
test("a grocer is filed as grocery, in both directions", () => {
  const grocers = [
    "iga.com.au", "conad.it", "ica.se", "kiwi.no", "rema.no", "zabka.pl", "vkusvill.ru",
    "lider.cl", "santaisabel.cl", "metro.pe", "marjane.ma", "giant.sg", "family.com.tw",
    "oda.com", "iki.lt", "barbora.lt", "barbora.lv",
    // Missed by the 41-grocer pass. rema1000.no is the same brand and the same
    // country as rema.no, which had just been corrected — so the pass created a
    // split where there had only been a shared mistake, and Settings' category
    // filter then blocked half of one supermarket.
    "rema1000.no",
    // Finnish online grocers left as `fast_casual` while prisma.fi, next to
    // them in the same market, was moved.
    "k-ruoka.fi", "s-kaupat.fi", "prisma.fi",
    // An Algerian hypermarket, and the Russian quick-commerce grocery service
    // whose two rows disagreed about both their bucket and their category.
    "uno.dz", "lavka.yandex.ru", "yandexlavka.ru"
  ];

  const wrong = grocers
    .map((domain) => ALL.find((entry) => entry.domain === domain))
    .filter(Boolean)
    .filter((entry) => entry.category !== "grocery")
    .map((entry) => `${entry.domain} is ${entry.category}`);

  assert.deepEqual(wrong, [], `supermarkets filed as something else: ${wrong.join(", ")}`);

  // The other direction, which nothing checked: a record whose OWN specialties
  // are restaurant food has no business being called a grocer. checkers.com is
  // Checkers Drive-In (burgers, seasoned fries, wings) and was filed `grocery`.
  const RESTAURANT_FOOD = /burger|sandwich|fries|wings|pizza|taco|sushi|noodle/i;
  const misfiled = ALL.filter((entry) => entry.category === "grocery")
    .filter((entry) => (entry.specialties || []).some((s) => RESTAURANT_FOOD.test(s)))
    .map((entry) => `${entry.domain} sells ${(entry.specialties || []).join("/")}`);

  assert.deepEqual(misfiled, [], `filed as grocery but selling restaurant food: ${misfiled.join("; ")}`);
});

test("no category is a value the display layer cannot name", () => {
  const en = JSON.parse(
    fs.readFileSync(path.join(ROOT, "extension", "_locales", "en", "messages.json"), "utf8")
  );

  const key = (id) =>
    "catLabel" +
    String(id)
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join("");

  const unnamed = [...new Set(ALL.map((entry) => entry.category))]
    .filter((category) => category && !en[key(category)])
    .sort();

  assert.deepEqual(
    unnamed,
    [],
    `these categories would print as a prettified id rather than a real name: ${unnamed.join(", ")}`
  );
});
