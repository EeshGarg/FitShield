"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const blocklist = require("../blocklist.js");
const {
  loadBlocklists,
  normalizeHostname,
  domainMatches,
  getEntryDomains,
  entryMatchesHost,
  filterEntries,
  isBlockedHost,
  shouldBlockByCountry,
  shouldBlockByCategory
} = blocklist;

const FIXTURE = [
  { domain: "mcdonalds.com", name: "McDonald's", type: "fast_food", countries: ["US", "CA"], regions: ["NA"], category: "burger", specialties: ["fries"], enabled: true },
  { domain: "kfc.com", name: "KFC", type: "fast_food", countries: ["US", "CN"], regions: ["NA", "AS"], category: "chicken", specialties: ["fried chicken"], enabled: true, aliases: ["kfc.co.uk"] },
  { domain: "doordash.com", name: "DoorDash", type: "delivery", countries: ["US"], regions: ["NA"], category: "delivery", specialties: ["restaurant delivery"], enabled: true },
  { domain: "grubhub.com", name: "Grubhub", type: "delivery", countries: ["US"], regions: ["NA"], category: "delivery", specialties: ["restaurant delivery"], enabled: false }
];

test("normalizeHostname strips protocol, www, path and port", () => {
  assert.equal(normalizeHostname("www.mcdonalds.com"), "mcdonalds.com");
  assert.equal(normalizeHostname("https://www.mcdonalds.com/order"), "mcdonalds.com");
  assert.equal(normalizeHostname("order.mcdonalds.com:443"), "order.mcdonalds.com");
  assert.equal(normalizeHostname(""), "");
});

test("domainMatches matches apex + subdomains, rejects look-alikes", () => {
  assert.equal(domainMatches("mcdonalds.com", "mcdonalds.com"), true);
  assert.equal(domainMatches("order.mcdonalds.com", "mcdonalds.com"), true);
  assert.equal(domainMatches("fake-mcdonalds.com", "mcdonalds.com"), false);
  assert.equal(domainMatches("mcdonalds.com.evil.com", "mcdonalds.com"), false);
});

test("getEntryDomains includes apex + aliases", () => {
  assert.deepEqual(getEntryDomains({ domain: "kfc.com", aliases: ["kfc.co.uk"] }), ["kfc.com", "kfc.co.uk"]);
  assert.deepEqual(getEntryDomains({ domain: "doordash.com" }), ["doordash.com"]);
});

test("entryMatchesHost matches apex, subdomain, and alias hosts", () => {
  const kfc = FIXTURE[1];
  assert.equal(entryMatchesHost(kfc, "kfc.com"), true);
  assert.equal(entryMatchesHost(kfc, "order.kfc.com"), true);
  assert.equal(entryMatchesHost(kfc, "www.kfc.co.uk"), true);
  assert.equal(entryMatchesHost(kfc, "fake-kfc.com"), false);
});

test("filterEntries narrows by metadata", () => {
  assert.equal(filterEntries({ type: "delivery" }, FIXTURE).length, 2);
  assert.equal(filterEntries({ country: "CN" }, FIXTURE).length, 1);
  assert.equal(filterEntries({ category: "chicken" }, FIXTURE).length, 1);
  assert.equal(filterEntries({}, FIXTURE).length, 4);
});

test("isBlockedHost honors enabled state, aliases, and look-alike safety", () => {
  assert.equal(isBlockedHost("order.mcdonalds.com", { entries: FIXTURE }), true);
  assert.equal(isBlockedHost("www.kfc.co.uk", { entries: FIXTURE }), true); // alias
  assert.equal(isBlockedHost("grubhub.com", { entries: FIXTURE }), false); // disabled
  assert.equal(isBlockedHost("grubhub.com", { entries: FIXTURE, onlyEnabled: false }), true);
  assert.equal(isBlockedHost("fake-mcdonalds.com", { entries: FIXTURE }), false);
});

test("shouldBlockByCountry / shouldBlockByCategory", () => {
  assert.equal(shouldBlockByCountry(FIXTURE[0], ["CA"]), true);
  assert.equal(shouldBlockByCountry(FIXTURE[0], ["CN"]), false);
  assert.equal(shouldBlockByCategory(FIXTURE[1], ["chicken"]), true);
  assert.equal(shouldBlockByCategory(FIXTURE[1], ["fried chicken"]), false); // specialties are not a category trigger
});

test("loadBlocklists reads both real JSON files and caches results", async () => {
  const a = await loadBlocklists();
  const b = await loadBlocklists();
  assert.ok(a.length > 0);
  assert.ok(a.some((e) => e.type === "fast_food"));
  assert.ok(a.some((e) => e.type === "delivery"));
  // Apex-only and core fields present.
  a.forEach((entry) => {
    assert.equal(typeof entry.domain, "string");
    assert.ok(!/:\/\//.test(entry.domain));
    assert.ok(!/^www\./.test(entry.domain));
  });
  // Real domains resolve end to end.
  assert.equal(isBlockedHost("order.doordash.com"), true);
  assert.equal(isBlockedHost("example.com"), false);
  assert.equal(b.length, a.length);
});
