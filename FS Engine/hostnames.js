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
 * Normalize a domain from either a string entry or an entry object to an apex
 * hostname. Backward-compatible with older string-only blocklist entries.
 */
function normalizeDomain(value) {
  if (value && typeof value === "object") {
    return normalizeHostname(value.domain);
  }

  return normalizeHostname(value);
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

module.exports = { normalizeHostname, normalizeDomain, domainMatches };
