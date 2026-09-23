#!/usr/bin/env node
"use strict";
/**
 * Generate the Android rules asset from CANONICAL FitShield data via the
 * SEPARATED engine (FS Engine).
 *
 * This is the single bridge between the shared engine and the native Android
 * adapter. The native APK cannot execute the JavaScript engine directly, so the
 * canonical pipeline emits a normalized, engine-derived host list that the
 * Android VpnService DNS filter consumes. There is NO hand-maintained Android
 * blocklist and NO second matcher: the host set here is exactly what
 * FS Engine considers blockable (apex + alias domains of every
 * enabled entry), and the Android matcher applies the same apex/subdomain rule
 * as the engine's domainMatches().
 *
 * Output is DETERMINISTIC (sorted, no timestamps) so the committed asset only
 * changes when the canonical data changes — and tools/android-audit.js fails the
 * build if the asset ever drifts from the engine.
 *
 *   node tools/generate-android-rules.js        # writes the asset
 *   require(...).derive()                        # returns the canonical object
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const engine = require("../FS Engine");
const load = require("./lib/load");

const ASSET_PATH = path.join(
  load.ROOT, "android", "app", "src", "main", "assets", "fitshield-rules.json"
);
// Semantics fixture consumed by the Android instrumentation test to prove the
// Kotlin matcher agrees with the JS engine on representative hosts.
const FIXTURE_PATH = path.join(
  load.ROOT, "android", "app", "src", "androidTest", "assets", "semantics-fixture.json"
);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Category spellings that must NEVER be recorded as a "most blocked category".
//
// These are RULE BUCKETS, not curated categories, and they are the same two
// strings — for the same two reasons — as `RULE_BUCKET_CATEGORIES` in
// extension/background.js: "fastfood" is what getRuleCatalog labels a fast-food
// brand with (the datasets spell the curated category "fast_food", so that
// spelling can only have come from the bucket), and "custom" is the user's own
// list, so a ranked list of food categories containing it would be describing
// their settings rather than their cravings.
//
// `delivery` is deliberately ABSENT, and that absence is the whole point. It is a
// genuine curated category, Settings' picker offers it (369 brands, 373 blockable
// hosts — the second largest after fast_casual), and it ships a display name.
// FitShieldVpnService.kt carried its own copy of this guard reading
// `category != "delivery" && category != "fast_food" && category != "custom"` —
// the extension's PRE-FIX condition, and never mentioning "fastfood" at all. So
// Android's "Most blocked categories" could never show delivery while the picker
// one panel away offered it, and both platforms write the SAME
// `blockedByCategory` key, read by the same shared UI: Android was corrupting a
// shared statistic with a bug the extension had already fixed.
//
// Two of that guard's three clauses were inert, which is worth stating because it
// makes the remaining one easy to miss: the curated vocabulary has 21 categories
// and neither `fast_food` nor `custom` is among them (`fast_casual`, `burger`,
// `pizza`, `chicken`… are). Dropping `delivery` was the entire real effect.
//
// The filter lives HERE, where the value is produced, rather than on the native
// side: this generator is the one bridge between the canonical data and the
// phone, so Kotlin now carries no category vocabulary at all and has nothing left
// to drift. test/android-controls.test.js reads the extension's set out of
// extension/background.js and fails if the two ever stop being the same strings.
const STATS_EXCLUDED_CATEGORIES = new Set(["fastfood", "custom"]);

function datasetVersions() {
  const out = {};
  for (const ds of load.loadDatasets()) {
    if (!ds.error && ds.data) {
      out[ds.name.replace(/\.json$/, "")] = ds.data._version || "?";
    }
  }
  return out;
}

// Derive the canonical Android ruleset purely from the engine + canonical data.
// Returns the exact object that should be on disk (minus formatting).
async function derive() {
  const entries = await engine.loadBlocklists();
  const enabled = engine.getEnabledEntries(entries);

  const hostSet = new Set();
  enabled.forEach((entry) => {
    engine.getEntryDomains(entry).forEach((host) => {
      if (host) {
        hostSet.add(host);
      }
    });
  });

  const hosts = [...hostSet].sort();

  // Engine-derived filter metadata so the Android UI can show the SAME country
  // and category pickers as the extension without bundling the full datasets.
  const countries = engine.getAvailableCountries(entries).map((c) => ({ code: c.code, count: c.count }));
  const categories = engine.getAvailableCategories(entries).map((c) => ({ id: c.category, count: c.count }));

  // Per-host block metadata so the native DNS filter can record the SAME
  // "most blocked category / country" breakdown as the extension: category is
  // the entry's food category, country is the brand's PRIMARY (first-listed)
  // operating market. Deterministic (sorted by host). Uses only curated brand
  // metadata — never the user's location or browsing data.
  const hostMeta = new Map();
  enabled.forEach((entry) => {
    const primaryCountry = (Array.isArray(entry.countries) && entry.countries[0])
      ? String(entry.countries[0]).trim().toUpperCase() : "";
    const rawCategory = (entry && typeof entry.category === "string") ? entry.category.trim().toLowerCase() : "";
    // See STATS_EXCLUDED_CATEGORIES: a bucket spelling is emitted as no category
    // at all, so the native side records nothing for it and needs no list of its
    // own to decide that.
    const category = STATS_EXCLUDED_CATEGORIES.has(rawCategory) ? "" : rawCategory;
    // The entry's canonical domain, which is also what
    // tools/generate-android-packages.js uses as `brandId` and therefore the key
    // a temporary unlock is stored under.
    const brandId = String(entry.domain || "").trim().toLowerCase();
    engine.getEntryDomains(entry).forEach((host) => {
      if (!host) return;
      const value = { c: primaryCountry, k: category };
      // `b` — the brand id — is emitted ONLY for an ALIAS host, i.e. one that is
      // not itself the brand id. It exists because the native side was assuming
      // apex == brandId and the two differ for every alias domain we ship:
      // BlockActivity stores "Open anyway" under the brandId, while the
      // connection filter looked the unlock up by the MATCHED host. So on the
      // four shipped brands with an app and an alias (burgerking.com/bk.com,
      // nandos.co.uk/nandos.com, wingstop.com/wingstop.co.uk and food.jumia.com's
      // four country domains), a user who chose "Open anyway" had the app opened
      // for them and every connection it made to the alias domain reset anyway.
      //
      // Carried as DATA rather than fixed in Kotlin because the mapping is a
      // property of the curated datasets, which change without the APK changing.
      // Emitted only where it differs from the host so the asset does not gain
      // 2500 redundant copies of its own key; RuleEngine.brandIdFor falls back to
      // the host, which is correct for every non-alias host and for the user's own
      // custom domains, which have no brand at all.
      if (brandId && host !== brandId) value.b = brandId;
      hostMeta.set(host, value);
    });
  });
  const meta = {};
  [...hostMeta.keys()].sort().forEach((host) => { meta[host] = hostMeta.get(host); });

  return {
    _generated: true,
    _doNotEdit:
      "GENERATED from canonical FitShield data (data/blocklists/*.json) via the separated engine (FS Engine). " +
      "Run `npm run generate:android` to regenerate. Do NOT hand-edit — tools/android-audit.js fails the build on drift.",
    schema: 2,
    engine: "FS Engine",
    source: engine.BLOCKLIST_FILES.slice(),
    datasetVersions: datasetVersions(),
    appVersion: load.manifest().version,
    // Matching contract the Android adapter MUST implement (identical to
    // FS Engine domainMatches): a query host is blocked when it equals an
    // apex or is a subdomain of it (host === apex || host endsWith "." + apex).
    matching: "apex-or-subdomain",
    count: hosts.length,
    sha256: sha256(JSON.stringify(hosts)),
    countries,
    categories,
    meta,
    hosts
  };
}

// A small, engine-produced parity fixture: host -> expected blocked. Generated
// from FS Engine so the Android instrumentation test can assert the
// Kotlin matcher returns identical results (proving shared semantics on-device).
async function deriveFixture() {
  await engine.loadBlocklists();
  const cases = [
    "doordash.com",            // apex of a known entry
    "www.doordash.com",        // subdomain -> blocked
    "order.ubereats.com",      // subdomain -> blocked
    "mcdonalds.com",           // apex -> blocked
    "fake-doordash.com",       // look-alike -> NOT blocked
    "doordash.com.evil.com",   // suffix trick -> NOT blocked
    "example.com",             // unrelated -> NOT blocked
    "github.com"               // unrelated -> NOT blocked
  ];
  return {
    _generated: true,
    _doNotEdit: "GENERATED by tools/generate-android-rules.js. Shared semantics fixture for the Android matcher.",
    engine: "FS Engine isBlockedHost",
    cases: cases.map((host) => ({ host, blocked: engine.isBlockedHost(host) }))
  };
}

async function generate() {
  const asset = await derive();
  fs.mkdirSync(path.dirname(ASSET_PATH), { recursive: true });
  fs.writeFileSync(ASSET_PATH, JSON.stringify(asset, null, 2) + "\n");

  const fixture = await deriveFixture();
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");

  return { asset, fixture };
}

if (require.main === module) {
  generate()
    .then(({ asset }) => {
      console.log(`Generated Android rules: ${path.relative(load.ROOT, ASSET_PATH).split(path.sep).join("/")}`);
      console.log(`  ${asset.count} blockable hosts, sha256 ${asset.sha256.slice(0, 12)}…`);
      console.log(`  from ${asset.source.join(", ")} (v${Object.values(asset.datasetVersions).join("/")}) via ${asset.engine}`);
    })
    .catch((error) => {
      console.error("Android rule generation failed:", error);
      process.exit(1);
    });
}

module.exports = {
  derive, deriveFixture, generate, ASSET_PATH, FIXTURE_PATH,
  // Exported so a test can hold it against the extension's RULE_BUCKET_CATEGORIES
  // instead of restating the two strings a third time.
  STATS_EXCLUDED_CATEGORIES
};
