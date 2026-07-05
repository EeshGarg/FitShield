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
// consumer below only reads it, and callers get copies via getLoadedEntries).
const withDefault = (list) => (Array.isArray(list) ? list : loader._cachedEntries());

const api = {
  // Loading (loader.js)
  BLOCKLIST_FILES: loader.BLOCKLIST_FILES,
  loadBlocklists: loader.loadBlocklists,
  getLoadedEntries: loader.getLoadedEntries,

  // Hostname semantics (hostnames.js)
  normalizeHostname: hostnames.normalizeHostname,
  normalizeDomain: hostnames.normalizeDomain,
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
  getAvailableCountries: (list) => metadata.getAvailableCountries(withDefault(list)),
  getAvailableCategories: (list) => metadata.getAvailableCategories(withDefault(list)),
  shouldBlockByCountry: metadata.shouldBlockByCountry,
  shouldBlockByCategory: metadata.shouldBlockByCategory
};

// The service worker / event page consumes the engine through this global
// (see extension/background.js). Set in Node too, for side-effect parity.
const globalScope = typeof self !== "undefined" ? self : globalThis;
globalScope.FitShieldBlocklist = api;

module.exports = api;
