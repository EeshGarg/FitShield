/**
 * FitShield blocklist site-record helpers (pure).
 *
 * Turns raw engine entries + the user's disabled-key lists into the
 * { key, label, match, domain, enabled, … } site records the UI renders. This
 * is the SAME key/record logic the background service worker uses in
 * getSettings(); it is factored out here so the settings page can rebuild the
 * block state directly from chrome.storage.local + the loaded engine when the
 * worker is unavailable (asleep, evicted, or an unbuilt/mis-loaded folder),
 * instead of snapping every toggle back to its default.
 *
 * No DOM, no chrome.*, no I/O — the engine is passed in — so both the page and
 * test/blocklist-records.test.js can use it. That test pins these records equal
 * to the worker's getBlockState output so the two copies never drift.
 */
(function (global) {
  "use strict";

  // Legacy keys stripped the TLD (kept only so pre-existing disabled-site prefs
  // still resolve). Mirrors background.js:legacyDomainToKey.
  function legacyDomainToKey(domain) {
    return String(domain || "")
      .toLowerCase()
      .replace(/\.[a-z]+$/, "")
      .replace(/[^a-z0-9]/g, "");
  }

  // Stable, collision-resistant key from the full hostname + bucket.
  // Mirrors background.js:domainToKey — must stay byte-identical so the keys the
  // page writes (disabled*SiteKeys) match the ones the worker reads.
  function domainToKey(domain, type) {
    const bucket = String(type || "site")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const host = String(domain || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    return `${bucket}-${host}`;
  }

  // Map one engine entry to a site record. `engine` is the FitShieldBlocklist
  // API (for getEntryDomains / normalizeHostname). Mirrors
  // background.js:entryToSiteRecord.
  function entryToSiteRecord(entry, engine) {
    const domains = engine.getEntryDomains(entry);
    const domain = domains[0] || engine.normalizeHostname(entry.domain);
    const aliases = domains.slice(1);

    return {
      key: domainToKey(domain, entry.type),
      legacyKey: legacyDomainToKey(domain),
      label: entry.name || domain,
      match: domain,
      home: `https://www.${domain}/`,
      domain,
      apex: domain,
      aliases,
      type: entry.type || "",
      countries: Array.isArray(entry.countries) ? entry.countries : [],
      regions: Array.isArray(entry.regions) ? entry.regions : [],
      category: entry.category || "",
      specialties: Array.isArray(entry.specialties) ? entry.specialties : [],
      enabled: entry.enabled !== false
    };
  }

  // De-duplicate by type + domain, keeping the first record (same as the
  // worker), so a brand listed in both buckets does not appear twice per bucket.
  function buildSiteRecords(entries, engine) {
    const byTypeAndDomain = new Map();

    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const record = entryToSiteRecord(entry, engine);
      const dedupeKey = `${record.type}:${record.domain}`;
      if (!byTypeAndDomain.has(dedupeKey)) {
        byTypeAndDomain.set(dedupeKey, record);
      }
    });

    return [...byTypeAndDomain.values()];
  }

  // Apply the user's disabled-key list. Mirrors
  // background.js:mergeSitesWithEnabledState.
  function mergeEnabledState(sites, disabledKeys) {
    const disabled = new Set(disabledKeys || []);
    return (Array.isArray(sites) ? sites : []).map((site) => ({
      ...site,
      enabled: !disabled.has(site.key) && !disabled.has(site.legacyKey)
    }));
  }

  const api = {
    legacyDomainToKey,
    domainToKey,
    entryToSiteRecord,
    buildSiteRecords,
    mergeEnabledState
  };

  global.FitShieldBlocklistRecords = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
