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

    return candidates.some((entry) => domainMatches(hostname, entry.domain));
  }

  const api = {
    BLOCKLIST_FILES,
    loadBlocklists,
    normalizeHostname,
    domainMatches,
    getEnabledEntries,
    filterEntries,
    isBlockedHost,
    getLoadedEntries: () => loadedEntries.slice()
  };

  global.FitShieldBlocklist = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
