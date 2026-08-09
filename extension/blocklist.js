/* GENERATED single-file browser bundle of "FS Engine/" — built by build.js.
 * Do not edit: change the engine sources and rebuild (node build.js).
 * API reference: "FS Engine/README.md". */
(function () {
"use strict";
var __modules = Object.create(null), __cache = Object.create(null);
function __require(id) {
  if (__cache[id]) return __cache[id].exports;
  if (!__modules[id]) throw new Error("FS Engine bundle: module not bundled: " + id);
  var m = { exports: {} };
  __cache[id] = m;
  __modules[id].call(m.exports, m, m.exports, __require);
  return m.exports;
}
__modules["./hostnames.js"] = function (module, exports, require) {
"use strict";
/**
 * FS Engine — hostname normalization & domain matching.
 *
 * Pure string logic: no I/O, no state, no environment assumptions. Every other
 * engine module builds on the semantics defined here. See README.md §Matching.
 */

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

module.exports = { normalizeHostname, domainMatches };
};
__modules["./entries.js"] = function (module, exports, require) {
"use strict";
/**
 * FS Engine — entry matching & filtering.
 *
 * Pure functions over blocklist entry objects (see README.md §Data contract).
 * Every function here takes the entry list EXPLICITLY — the convenience
 * wrappers that default to the last-loaded datasets live in index.js, so this
 * module stays stateless and independently testable.
 */

const { normalizeHostname, domainMatches } = require("./hostnames.js");

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

/** Entries not explicitly disabled (`enabled: false`). */
function getEnabledEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.enabled !== false);
}

/**
 * Filter entries by any combination of metadata. Omitted/empty filters match
 * everything, so filterEntries({}, entries) returns the full list.
 *
 * @param {object} filters - { type, country, region, category, specialty }
 * @param {Array}  entries
 */
function filterEntries(filters, entries) {
  const { type, country, region, category, specialty } = filters || {};
  const source = Array.isArray(entries) ? entries : [];

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
 * @param {object} options - { entries, type, country, region, category,
 *                             specialty, onlyEnabled = true }
 */
function isBlockedHost(hostname, options) {
  const opts = options || {};
  const { onlyEnabled = true, entries, ...filters } = opts;
  const source = Array.isArray(entries) ? entries : [];
  const pool = onlyEnabled ? getEnabledEntries(source) : source;
  const candidates = filterEntries(filters, pool);

  return candidates.some((entry) => entryMatchesHost(entry, hostname));
}

module.exports = { getEntryDomains, entryMatchesHost, getEnabledEntries, filterEntries, isBlockedHost };
};
__modules["./metadata.js"] = function (module, exports, require) {
"use strict";
/**
 * FS Engine — metadata-aware helpers (countries, categories, block policies).
 *
 * All of these are defensive: entries may be plain strings or may be missing
 * `countries`, `category`, or `specialties` without crashing. Like entries.js,
 * everything is stateless — the entry list is always explicit.
 */

// Curated display names. These pin common markets to stable, short English
// forms (and cover any runtime lacking a full-ICU Intl.DisplayNames). Anything
// NOT here is resolved by Intl.DisplayNames — complete for every ISO 3166-1
// alpha-2 code in modern browsers (Chrome/Firefox/Safari) and Node 18+ — before
// finally echoing the raw code. So the engine names every country the datasets
// use (111+ and counting) while staying dependency-free. HK is overridden
// because Intl's "Hong Kong SAR China" is too verbose for the picker.
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
  ES: "Spain",
  HK: "Hong Kong"
};

// Memoized Intl.DisplayNames (region type) per locale. Guarded so a runtime
// without Intl.DisplayNames just falls back to the curated map / raw code.
const regionNamerCache = new Map();

function regionNamer(locale) {
  const key = locale || "en";

  if (regionNamerCache.has(key)) {
    return regionNamerCache.get(key);
  }

  let namer = null;
  try {
    if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
      namer = new Intl.DisplayNames([key], { type: "region" });
    }
  } catch (error) {
    namer = null;
  }

  regionNamerCache.set(key, namer);
  return namer;
}

// Display name for an ISO 3166-1 alpha-2 code. English by default (curated short
// forms win); pass a BCP-47 `locale` to localize via Intl. Unknown codes echo.
function getCountryName(code, locale) {
  const normalized = String(code || "").trim().toUpperCase();

  if (!normalized) {
    return "";
  }

  const wantLocale = locale || "en";

  // English: curated short forms win (stable, test-pinned); other locales prefer
  // Intl so the name is actually localized.
  if (wantLocale === "en" && COUNTRY_NAMES[normalized]) {
    return COUNTRY_NAMES[normalized];
  }

  const namer = regionNamer(wantLocale);
  if (namer) {
    try {
      const name = namer.of(normalized);
      if (name && name !== normalized) {
        return name;
      }
    } catch (error) {
      // Invalid code for Intl — fall through to the curated map / raw code.
    }
  }

  return COUNTRY_NAMES[normalized] || normalized;
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
// Returns [{ code, name, count }] sorted by display name. Pass a BCP-47 `locale`
// to localize the names (defaults to English).
function getAvailableCountries(entries, locale) {
  const source = Array.isArray(entries) ? entries : [];
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
    .map(([code, count]) => ({ code, count, name: getCountryName(code, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Discover the distinct categories present in the blocklist metadata, plus the
// specialties seen under each one (used to make search results richer).
// Returns [{ category, count, specialties }] sorted by category.
function getAvailableCategories(entries) {
  const source = Array.isArray(entries) ? entries : [];
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

module.exports = {
  getCountryName,
  getAvailableCountries,
  getAvailableCategories,
  shouldBlockByCountry,
  shouldBlockByCategory
};
};
__modules["./loader.js"] = function (module, exports, require) {
"use strict";
/**
 * FS Engine — dataset loading (the only module that touches I/O or state).
 *
 * Works in two environments without a build step:
 *   - A browser extension: JSON is read with fetch(chrome.runtime.getURL(...)),
 *     so BLOCKLIST_FILES paths are resolved against the extension root.
 *   - Node.js: JSON is read from disk. Paths are resolved against a data
 *     directory — by default the repo's `data/` folder next to "FS Engine/",
 *     overridable per call with `loadBlocklists({ dataDir })`.
 *
 * The loader reads ONLY the `entries` array of each JSON file and ignores all
 * top-level metadata (`_schema`, `_version`, `_lastUpdated`, and anything else).
 * It also keeps a cache of the most recently loaded entries so the index.js
 * convenience wrappers can be called without threading the list everywhere.
 */

// Relative to the data directory (Node) / the extension root (browser).
const BLOCKLIST_FILES = ["blocklists/fast-food.json", "blocklists/delivery.json"];

// Cache of the most recently loaded entries (see _cachedEntries / index.js).
let loadedEntries = [];

// Resolve the WebExtension runtime from whichever namespace the engine is loaded
// under: `chrome` (Chrome/Brave/Edge, and also exposed by Safari and Firefox) or
// `browser` (the WebExtension standard, some Firefox contexts). Either lets the
// engine fetch its datasets by extension-relative URL, so the same bundle runs
// on every supported browser; in Node both are absent and we read from disk.
const webextRuntime =
  (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function")
    ? chrome.runtime
    : (typeof browser !== "undefined" && browser.runtime && typeof browser.runtime.getURL === "function")
      ? browser.runtime
      : null;

const isExtension = webextRuntime !== null;

async function readBlocklistFile(relativePath, options) {
  if (isExtension) {
    const response = await fetch(webextRuntime.getURL(relativePath));

    if (!response.ok) {
      throw new Error(`Failed to load ${relativePath}: ${response.status}`);
    }

    return response.json();
  }

  // Node.js fallback (tests / tooling). The engine ships no data of its own:
  // point dataDir anywhere a FitShield-shaped dataset lives.
  const fs = require("fs");
  const path = require("path");
  const dataDir = (options && options.dataDir) || path.join(__dirname, "..", "data");
  return JSON.parse(fs.readFileSync(path.join(dataDir, relativePath), "utf8"));
}

/**
 * Load every blocklist file and flatten their `entries` arrays into one list.
 * Top-level metadata keys are deliberately ignored.
 *
 * @param {object} [options] - { dataDir } (Node only; ignored in extensions)
 */
async function loadBlocklists(options) {
  const datasets = await Promise.all(
    BLOCKLIST_FILES.map((file) => readBlocklistFile(file, options))
  );
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

// Internal: raw (uncopied) cache reference for index.js's default wrappers.
function _cachedEntries() {
  return loadedEntries;
}

module.exports = { BLOCKLIST_FILES, loadBlocklists, _cachedEntries };
};
__modules["./index.js"] = function (module, exports, require) {
"use strict";
/**
 * FS Engine — public API.
 *
 * This file is the single source of truth for the engine's API surface; the
 * full reference lives in README.md. The stateless building blocks live in
 * hostnames.js / entries.js / metadata.js, the I/O + entry cache in loader.js.
 * Functions that take an entry list default to the last-loaded datasets, so
 * `await loadBlocklists()` once, then call everything else bare.
 *
 * Consumed three ways, with the exact same surface:
 *   - Node:     const engine = require("./FS Engine");
 *   - Browser:  the single-file bundle build.js emits as `blocklist.js`,
 *               which defines the global `FitShieldBlocklist`.
 *   - Global:   requiring this file also sets `FitShieldBlocklist` on the
 *               global scope (service workers rely on that side effect).
 */

const hostnames = require("./hostnames.js");
const entries = require("./entries.js");
const metadata = require("./metadata.js");
const loader = require("./loader.js");

// Default an omitted entry list to the loader's cache (raw reference — every
// consumer below only reads it; it is never handed out).
const withDefault = (list) => (Array.isArray(list) ? list : loader._cachedEntries());

const api = {
  // Loading (loader.js)
  BLOCKLIST_FILES: loader.BLOCKLIST_FILES,
  loadBlocklists: loader.loadBlocklists,


  // Hostname semantics (hostnames.js)
  normalizeHostname: hostnames.normalizeHostname,

  domainMatches: hostnames.domainMatches,

  // Entry matching & filtering (entries.js) — entry list defaults to the cache
  getEntryDomains: entries.getEntryDomains,
  entryMatchesHost: entries.entryMatchesHost,
  getEnabledEntries: (list) => entries.getEnabledEntries(withDefault(list)),
  filterEntries: (filters, list) => entries.filterEntries(filters, withDefault(list)),
  isBlockedHost: (hostname, options) => {
    const opts = options || {};
    return entries.isBlockedHost(hostname, { ...opts, entries: withDefault(opts.entries) });
  },

  // Metadata & block policies (metadata.js)
  getCountryName: metadata.getCountryName,
  getAvailableCountries: (list, locale) => metadata.getAvailableCountries(withDefault(list), locale),
  getAvailableCategories: (list) => metadata.getAvailableCategories(withDefault(list)),
  shouldBlockByCountry: metadata.shouldBlockByCountry,
  shouldBlockByCategory: metadata.shouldBlockByCategory
};

// The service worker / event page consumes the engine through this global
// (see extension/background.js). Set in Node too, for side-effect parity.
const globalScope = typeof self !== "undefined" ? self : globalThis;
globalScope.FitShieldBlocklist = api;

module.exports = api;
};
__require("./index.js");
})();
