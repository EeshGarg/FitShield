/**
 * FitShield metadata-driven blocklist loader.
 *
 * Works in two environments without a build step:
 *   - The extension service worker, loaded with `importScripts("blocklist.js")`.
 *     JSON files are read with fetch(chrome.runtime.getURL(...)).
 *   - Node.js (tests), loaded with `require("./blocklist.js")`.
 *     JSON files are read from disk with fs.
 *
 * The loader reads ONLY the `entries` array of each JSON file and ignores all
 * top-level metadata (`_schema`, `_version`, `_lastUpdated`, and anything else).
 */
(function (global) {
  "use strict";

  // Relative to this file / the extension root.
  const BLOCKLIST_FILES = ["blocklists/fast-food.json", "blocklists/delivery.json"];

  // Cache of the most recently loaded entries so the filter helpers can be
  // called with just their filter arguments (see filterEntries / isBlockedHost).
  let loadedEntries = [];

  const isExtension =
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    typeof chrome.runtime.getURL === "function";

  async function readBlocklistFile(relativePath) {
    if (isExtension) {
      const response = await fetch(chrome.runtime.getURL(relativePath));

      if (!response.ok) {
        throw new Error(`Failed to load ${relativePath}: ${response.status}`);
      }

      return response.json();
    }

    // Node.js fallback (tests / tooling).
    const fs = require("fs");
    const path = require("path");
    const absolutePath = path.join(__dirname, relativePath);
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  }

  /**
   * Load every blocklist file and flatten their `entries` arrays into one list.
   * Top-level metadata keys are deliberately ignored.
   */
  async function loadBlocklists() {
    const datasets = await Promise.all(BLOCKLIST_FILES.map(readBlocklistFile));
    const entries = [];

    datasets.forEach((data) => {
      if (data && Array.isArray(data.entries)) {
        data.entries.forEach((entry) => {
          if (entry && typeof entry === "object") {
            entries.push(entry);
          }
        });
      }
    });

    loadedEntries = entries;
    return entries;
  }

  /**
   * Normalize a hostname for comparison: lowercase, strip protocol/path/port and
   * a leading `www.`. Accepts bare hostnames or full URLs.
   */
  function normalizeHostname(hostname) {
    let host = String(hostname || "").trim().toLowerCase();

    if (!host) {
      return "";
    }

    if (host.includes("://")) {
      try {
        host = new URL(host).hostname;
      } catch (error) {
        // Fall through and clean it up manually below.
      }
    }

    // Drop any path, query, fragment or port that slipped through.
    host = host.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
    host = host.replace(/\.+$/, ""); // trailing dot(s)
    host = host.replace(/^www\./, "");

    return host;
  }

  /**
   * True when `hostname` is the apex `domain` or a subdomain of it.
   * "fake-mcdonalds.com" does NOT match "mcdonalds.com" because matching is
   * anchored at a domain-label boundary.
   */
  function domainMatches(hostname, domain) {
    const host = normalizeHostname(hostname);
    const apex = normalizeHostname(domain);

    if (!host || !apex) {
      return false;
    }

    return host === apex || host.endsWith(`.${apex}`);
  }

  /**
   * Every blockable hostname for an entry: its primary apex `domain` plus any
   * `aliases` (alternate domains a brand owns). Aliases are optional metadata;
   * entries without them are unaffected. Returns a de-duplicated, normalized
   * list so callers can match a request against all of a brand's domains.
   */
  function getEntryDomains(entry) {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const domains = [normalizeHostname(entry.domain)];

    if (Array.isArray(entry.aliases)) {
      entry.aliases.forEach((alias) => domains.push(normalizeHostname(alias)));
    }

    return [...new Set(domains.filter(Boolean))];
  }

  /**
   * True when `hostname` is the entry's apex domain, one of its alias domains,
   * or a subdomain of any of those.
   */
  function entryMatchesHost(entry, hostname) {
    return getEntryDomains(entry).some((domain) => domainMatches(hostname, domain));
  }

  function getEnabledEntries(entries) {
    const source = Array.isArray(entries) ? entries : loadedEntries;
    return source.filter((entry) => entry && entry.enabled !== false);
  }

  /**
   * Filter entries by any combination of metadata. Omitted/empty filters match
   * everything, so filterEntries({}) returns the full list.
   *
   * @param {object} filters - { type, country, region, category, specialty }
   * @param {Array}  [entries] - defaults to the last loaded entries.
   */
  function filterEntries(filters, entries) {
    const { type, country, region, category, specialty } = filters || {};
    const source = Array.isArray(entries) ? entries : loadedEntries;

    return source.filter((entry) => {
      if (!entry) {
        return false;
      }

      if (type && entry.type !== type) {
        return false;
      }

      if (country && !(entry.countries || []).includes(country)) {
        return false;
      }

      if (region && !(entry.regions || []).includes(region)) {
        return false;
      }

      if (category && entry.category !== category) {
        return false;
      }

      if (specialty && !(entry.specialties || []).includes(specialty)) {
        return false;
      }

      return true;
    });
  }

  /**
   * True when `hostname` should be blocked given the supplied options.
   *
   * @param {string} hostname
   * @param {object} [options] - { type, country, region, category, specialty,
   *                               onlyEnabled = true, entries }
   */
  function isBlockedHost(hostname, options) {
    const opts = options || {};
    const { onlyEnabled = true, entries, ...filters } = opts;
    const source = Array.isArray(entries) ? entries : loadedEntries;
    const pool = onlyEnabled ? getEnabledEntries(source) : source;
    const candidates = filterEntries(filters, pool);

    return candidates.some((entry) => entryMatchesHost(entry, hostname));
  }

  // ---------------------------------------------------------------------------
  // Metadata-aware blocking helpers (country + category).
  // All of these are defensive: entries may be plain strings or may be missing
  // `countries`, `category`, or `specialties` without crashing.
  // ---------------------------------------------------------------------------

  // Minimal ISO code -> display name map for the codes used in the blocklists.
  // Unknown codes fall back to the code itself, so adding new codes never breaks.
  const COUNTRY_NAMES = {
    US: "United States",
    CA: "Canada",
    GB: "United Kingdom",
    DE: "Germany",
    FR: "France",
    BR: "Brazil",
    MX: "Mexico",
    IN: "India",
    CN: "China",
    JP: "Japan",
    KR: "South Korea",
    AU: "Australia",
    NZ: "New Zealand",
    IT: "Italy",
    ES: "Spain"
  };

  function getCountryName(code) {
    const normalized = String(code || "").trim().toUpperCase();
    return COUNTRY_NAMES[normalized] || normalized;
  }

  // Normalize a domain from either a string entry or an entry object to an apex
  // hostname. Backward-compatible with older string-only blocklist entries.
  function normalizeDomain(value) {
    if (value && typeof value === "object") {
      return normalizeHostname(value.domain);
    }

    return normalizeHostname(value);
  }

  function toCodeSet(values, transform) {
    const set = new Set();

    (Array.isArray(values) ? values : []).forEach((value) => {
      const normalized = transform(String(value || "").trim());

      if (normalized) {
        set.add(normalized);
      }
    });

    return set;
  }

  const toUpper = (value) => value.toUpperCase();
  const toLower = (value) => value.toLowerCase();

  // Discover the distinct country codes present in the blocklist metadata.
  // Returns [{ code, name, count }] sorted by display name.
  function getAvailableCountries(entries) {
    const source = Array.isArray(entries) ? entries : loadedEntries;
    const counts = new Map();

    source.forEach((entry) => {
      const countries = entry && Array.isArray(entry.countries) ? entry.countries : [];

      countries.forEach((rawCode) => {
        const code = String(rawCode || "").trim().toUpperCase();

        if (code) {
          counts.set(code, (counts.get(code) || 0) + 1);
        }
      });
    });

    return [...counts.entries()]
      .map(([code, count]) => ({ code, count, name: getCountryName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Discover the distinct categories present in the blocklist metadata, plus the
  // specialties seen under each one (used to make search results richer).
  // Returns [{ category, count, specialties }] sorted by category.
  function getAvailableCategories(entries) {
    const source = Array.isArray(entries) ? entries : loadedEntries;
    const info = new Map();

    source.forEach((entry) => {
      const category = entry && typeof entry.category === "string" ? entry.category.trim() : "";

      if (!category) {
        return;
      }

      if (!info.has(category)) {
        info.set(category, { category, count: 0, specialties: new Set() });
      }

      const record = info.get(category);
      record.count += 1;

      const specialties = entry && Array.isArray(entry.specialties) ? entry.specialties : [];
      specialties.forEach((rawSpecialty) => {
        const specialty = String(rawSpecialty || "").trim();

        if (specialty) {
          record.specialties.add(specialty);
        }
      });
    });

    return [...info.values()]
      .map((record) => ({
        category: record.category,
        count: record.count,
        specialties: [...record.specialties]
      }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }

  // True when the entry is active in any of the enabled country codes. A domain
  // belonging to multiple countries matches if ANY of them is enabled.
  function shouldBlockByCountry(entry, enabledCountries) {
    if (!entry || !Array.isArray(entry.countries) || entry.countries.length === 0) {
      return false;
    }

    const enabled = toCodeSet(enabledCountries, toUpper);

    if (enabled.size === 0) {
      return false;
    }

    return entry.countries.some((code) => enabled.has(String(code || "").trim().toUpperCase()));
  }

  // True when the entry's primary category is one of the enabled categories.
  // Matching is on `category` only (specialties stay search-only, per spec).
  function shouldBlockByCategory(entry, enabledCategories) {
    if (!entry || typeof entry.category !== "string" || !entry.category.trim()) {
      return false;
    }

    const enabled = toCodeSet(enabledCategories, toLower);

    if (enabled.size === 0) {
      return false;
    }

    return enabled.has(entry.category.trim().toLowerCase());
  }

  const api = {
    BLOCKLIST_FILES,
    loadBlocklists,
    normalizeHostname,
    normalizeDomain,
    domainMatches,
    getEntryDomains,
    entryMatchesHost,
    getEnabledEntries,
    filterEntries,
    isBlockedHost,
    getCountryName,
    getAvailableCountries,
    getAvailableCategories,
    shouldBlockByCountry,
    shouldBlockByCategory,
    getLoadedEntries: () => loadedEntries.slice()
  };

  global.FitShieldBlocklist = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
