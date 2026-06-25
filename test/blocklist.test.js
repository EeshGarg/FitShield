"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const blocklist = require("../blocklist.js");
const {
  loadBlocklists,
  normalizeHostname,
  domainMatches,
  getEnabledEntries,
  filterEntries,
  isBlockedHost
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
