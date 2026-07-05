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
