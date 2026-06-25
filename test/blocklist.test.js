"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const blocklist = require("../blocklist.js");
const {
  loadBlocklists,
  normalizeHostname,
  normalizeDomain,
  domainMatches,
  getEnabledEntries,
  filterEntries,
  isBlockedHost,
  getCountryName,
  getAvailableCountries,
  getAvailableCategories,
  shouldBlockByCountry,
  shouldBlockByCategory
} = blocklist;

// Fixture entries so the filter/matching tests do not depend on the live
// blocklist contents.
const FIXTURE = [
  {
    domain: "mcdonalds.com",
    name: "McDonald's",
    type: "fast_food",
    countries: ["US", "CA"],
    regions: ["NA"],
    category: "burger",
    specialties: ["fries", "coffee"],
    enabled: true
  },
  {
    domain: "kfc.com",
    name: "KFC",
    type: "fast_food",
    countries: ["US", "CN"],
    regions: ["NA", "AS"],
    category: "chicken",
    specialties: ["fried chicken"],
    enabled: true
  },
  {
    domain: "doordash.com",
    name: "DoorDash",
    type: "delivery",
    countries: ["US"],
    regions: ["NA"],
    category: "delivery",
    specialties: ["restaurant delivery"],
    enabled: true
  },
  {
    domain: "grubhub.com",
    name: "Grubhub",
    type: "delivery",
    countries: ["US"],
    regions: ["NA"],
    category: "delivery",
    specialties: ["restaurant delivery"],
    enabled: false
  }
];

test("normalizeHostname strips protocol, www, path and port", () => {
  assert.equal(normalizeHostname("mcdonalds.com"), "mcdonalds.com");
  assert.equal(normalizeHostname("www.mcdonalds.com"), "mcdonalds.com");
  assert.equal(normalizeHostname("WWW.McDonalds.com"), "mcdonalds.com");
  assert.equal(normalizeHostname("https://www.mcdonalds.com/order"), "mcdonalds.com");
  assert.equal(normalizeHostname("order.mcdonalds.com:443"), "order.mcdonalds.com");
  assert.equal(normalizeHostname("mcdonalds.com."), "mcdonalds.com");
  assert.equal(normalizeHostname(""), "");
  assert.equal(normalizeHostname(null), "");
});

test("domainMatches matches apex and subdomains only", () => {
  assert.equal(domainMatches("mcdonalds.com", "mcdonalds.com"), true);
  assert.equal(domainMatches("www.mcdonalds.com", "mcdonalds.com"), true);
  assert.equal(domainMatches("order.mcdonalds.com", "mcdonalds.com"), true);
  assert.equal(domainMatches("https://order.mcdonalds.com/cart", "mcdonalds.com"), true);
});

test("domainMatches rejects look-alike domains", () => {
  assert.equal(domainMatches("fake-mcdonalds.com", "mcdonalds.com"), false);
  assert.equal(domainMatches("mcdonalds.com.evil.com", "mcdonalds.com"), false);
  assert.equal(domainMatches("notmcdonalds.com", "mcdonalds.com"), false);
  assert.equal(domainMatches("", "mcdonalds.com"), false);
});

test("getEnabledEntries drops disabled entries", () => {
  const enabled = getEnabledEntries(FIXTURE);
  assert.equal(enabled.length, 3);
  assert.ok(!enabled.some((entry) => entry.domain === "grubhub.com"));
});

test("filterEntries narrows by metadata", () => {
  assert.equal(filterEntries({ type: "delivery" }, FIXTURE).length, 2);
  assert.equal(filterEntries({ type: "fast_food" }, FIXTURE).length, 2);
  assert.equal(filterEntries({ country: "CN" }, FIXTURE).length, 1);
  assert.equal(filterEntries({ region: "AS" }, FIXTURE).length, 1);
  assert.equal(filterEntries({ category: "chicken" }, FIXTURE).length, 1);
  assert.equal(filterEntries({ specialty: "fries" }, FIXTURE).length, 1);
  assert.equal(filterEntries({ country: "US" }, FIXTURE).length, 4);
  // Empty filter matches everything.
  assert.equal(filterEntries({}, FIXTURE).length, 4);
  // Combined filters are AND-ed together.
  assert.equal(filterEntries({ type: "fast_food", country: "CN" }, FIXTURE).length, 1);
});

test("isBlockedHost honors enabled state and filters", () => {
  // Enabled entry matches.
  assert.equal(isBlockedHost("www.mcdonalds.com", { entries: FIXTURE }), true);
  // Disabled entry (grubhub) does not match by default.
  assert.equal(isBlockedHost("grubhub.com", { entries: FIXTURE }), false);
  // ...but matches when disabled entries are included.
  assert.equal(isBlockedHost("grubhub.com", { entries: FIXTURE, onlyEnabled: false }), true);
  // Look-alike never matches.
  assert.equal(isBlockedHost("fake-mcdonalds.com", { entries: FIXTURE }), false);
  // Country filter restricts the pool.
  assert.equal(isBlockedHost("kfc.com", { entries: FIXTURE, country: "CN" }), true);
  assert.equal(isBlockedHost("doordash.com", { entries: FIXTURE, country: "CN" }), false);
});

test("loadBlocklists reads only entries and ignores metadata", async () => {
  const entries = await loadBlocklists();

  assert.ok(Array.isArray(entries));
  assert.ok(entries.length > 0);
  // No top-level metadata keys leak into the entry list.
  assert.ok(!entries.some((entry) => "_schema" in entry || "_version" in entry || "_lastUpdated" in entry));
  // Both buckets are represented.
  assert.ok(entries.some((entry) => entry.type === "fast_food"));
  assert.ok(entries.some((entry) => entry.type === "delivery"));
  // Every entry has the required core fields.
  entries.forEach((entry) => {
    assert.equal(typeof entry.domain, "string");
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.type, "string");
  });
});

test("loaded entries power isBlockedHost end to end", async () => {
  await loadBlocklists();
  assert.equal(isBlockedHost("order.mcdonalds.com"), true);
  assert.equal(isBlockedHost("www.doordash.com"), true);
  assert.equal(isBlockedHost("fake-doordash.com"), false);
  assert.equal(isBlockedHost("example.com"), false);
});

test("blocklist JSON files are valid and apex-only", () => {
  const dir = path.join(__dirname, "..", "blocklists");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));

  assert.ok(files.length >= 2);

  files.forEach((file) => {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    assert.ok(Array.isArray(data.entries), `${file} has an entries array`);

    data.entries.forEach((entry) => {
      // Apex domain only: no protocol, no path, no leading www.
      assert.ok(!/:\/\//.test(entry.domain), `${entry.domain} has no protocol`);
      assert.ok(!entry.domain.includes("/"), `${entry.domain} has no path`);
      assert.ok(!/^www\./.test(entry.domain), `${entry.domain} has no www. prefix`);
    });
  });
});

// ---------------------------------------------------------------------------
// Country & category blocking helpers.
// ---------------------------------------------------------------------------

test("normalizeDomain handles strings and entry objects", () => {
  assert.equal(normalizeDomain("https://www.mcdonalds.com/order"), "mcdonalds.com");
  assert.equal(normalizeDomain({ domain: "WWW.KFC.com" }), "kfc.com");
  assert.equal(normalizeDomain(null), "");
});

test("getCountryName maps known codes and falls back to the code", () => {
  assert.equal(getCountryName("US"), "United States");
  assert.equal(getCountryName("cn"), "China");
  assert.equal(getCountryName("ZZ"), "ZZ");
});

test("getAvailableCountries discovers unique codes with counts", () => {
  const countries = getAvailableCountries(FIXTURE);
  const codes = countries.map((c) => c.code);
  assert.ok(codes.includes("US"));
  assert.ok(codes.includes("CN"));
  // US appears in mcdonalds, kfc, doordash, grubhub fixtures = 4.
  assert.equal(countries.find((c) => c.code === "US").count, 4);
  assert.equal(countries.find((c) => c.code === "US").name, "United States");
});

test("getAvailableCategories discovers categories with specialties", () => {
  const categories = getAvailableCategories(FIXTURE);
  const names = categories.map((c) => c.category);
  assert.ok(names.includes("burger"));
  assert.ok(names.includes("chicken"));
  assert.ok(names.includes("delivery"));
  const burger = categories.find((c) => c.category === "burger");
  assert.ok(burger.specialties.includes("fries"));
});

test("shouldBlockByCountry matches any enabled country (multi-country safe)", () => {
  const mcd = FIXTURE[0]; // countries: US, CA
  assert.equal(shouldBlockByCountry(mcd, ["CA"]), true);
  assert.equal(shouldBlockByCountry(mcd, ["cn"]), false);
  assert.equal(shouldBlockByCountry(mcd, ["GB", "CA"]), true);
  assert.equal(shouldBlockByCountry(mcd, []), false);
});

test("shouldBlockByCategory matches on category only", () => {
  const kfc = FIXTURE[1]; // category: chicken, specialties: fried chicken
  assert.equal(shouldBlockByCategory(kfc, ["chicken"]), true);
  assert.equal(shouldBlockByCategory(kfc, ["CHICKEN"]), true);
  assert.equal(shouldBlockByCategory(kfc, ["burger"]), false);
  // specialties are NOT a blocking trigger
  assert.equal(shouldBlockByCategory(kfc, ["fried chicken"]), false);
});

test("metadata helpers are defensive against missing fields", () => {
  const bare = { domain: "example.com" };
  const stringEntry = "legacy.com";
  assert.doesNotThrow(() => getAvailableCountries([bare, stringEntry]));
  assert.doesNotThrow(() => getAvailableCategories([bare, stringEntry]));
  assert.equal(shouldBlockByCountry(bare, ["US"]), false);
  assert.equal(shouldBlockByCategory(bare, ["burger"]), false);
  assert.equal(shouldBlockByCountry(stringEntry, ["US"]), false);
});

test("country/category union blocking against loaded entries", async () => {
  const entries = await loadBlocklists();

  // shouldBlockByCountry over the real data: CN should hit KFC and Pizza Hut.
  // (Assertions check inclusion so they stay valid as the blocklist grows.)
  const cnBlocked = entries.filter((entry) => shouldBlockByCountry(entry, ["CN"])).map((e) => e.domain);
  assert.ok(cnBlocked.includes("kfc.com"));
  assert.ok(cnBlocked.includes("pizzahut.com"));
  assert.ok(!cnBlocked.includes("doordash.com")); // delivery brand, not in CN

  // shouldBlockByCategory: pizza should include Domino's and Pizza Hut.
  const pizzaBlocked = entries.filter((entry) => shouldBlockByCategory(entry, ["pizza"])).map((e) => e.domain);
  assert.ok(pizzaBlocked.includes("dominos.com"));
  assert.ok(pizzaBlocked.includes("pizzahut.com"));
  // Pizza entries are blocked while a burger like McDonald's is not.
  assert.ok(!pizzaBlocked.includes("mcdonalds.com"));

  // getAvailableCategories / getAvailableCountries reflect the full dataset.
  assert.ok(getAvailableCategories(entries).some((c) => c.category === "pizza"));
  assert.ok(getAvailableCountries(entries).some((c) => c.code === "CN"));
});
