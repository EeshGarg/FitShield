#!/usr/bin/env node
"use strict";
/**
 * Structural + metadata validation for the curated blocklists.
 *
 * Checks: JSON validity, top-level schema keys, required entry fields, field
 * types, duplicate domains (within a file), hostname shape, enabled flag, and
 * unknown/orphaned fields. Country, region, alias, and category specifics live
 * in their own focused audits (country-audit, alias-audit, category-audit).
 */

const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");

const REQUIRED_TOP = ["_version", "_lastUpdated", "entries"];
const REQUIRED_FIELDS = ["domain", "name", "type", "category"];
const KNOWN_FIELDS = new Set([
  "domain", "name", "aliases", "type", "countries", "regions",
  "category", "specialties", "enabled", "notes", "confidence", "parent"
]);
const KNOWN_TYPES = new Set(["fast_food", "delivery"]);

function validateDatasets() {
  const reporter = new Reporter("Datasets — structure & metadata");
  let totalEntries = 0;

  for (const ds of load.loadDatasets()) {
    if (ds.error) {
      reporter.fail(`${ds.name}: invalid JSON — ${ds.error}`);
      continue;
    }

    const data = ds.data;
    REQUIRED_TOP.forEach((k) => {
      if (!(k in data)) {
        reporter.fail(`${ds.name}: missing top-level "${k}"`);
      }
    });

    if (!Array.isArray(data.entries)) {
      reporter.fail(`${ds.name}: "entries" is not an array`);
      continue;
    }

    const seen = new Map();
    let dupes = 0;
    let unknownTypes = 0;
    let unknownFields = 0;

    data.entries.forEach((entry, i) => {
      const where = `${ds.name}[${i}] ${entry && entry.domain ? entry.domain : "?"}`;

      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        reporter.fail(`${where}: entry is not an object`);
        return;
      }

      REQUIRED_FIELDS.forEach((f) => {
        if (!entry[f] || (typeof entry[f] === "string" && !entry[f].trim())) {
          reporter.fail(`${where}: missing/empty required field "${f}"`);
        }
      });

      const domain = String(entry.domain || "").toLowerCase();
      if (domain && !load.isApexDomain(domain)) {
        reporter.fail(`${where}: domain is not a clean apex hostname`);
      }
      if (domain) {
        if (seen.has(domain)) {
          dupes += 1;
          reporter.fail(`${where}: duplicate domain (also at index ${seen.get(domain)})`);
        } else {
          seen.set(domain, i);
        }
      }

      if (entry.type && !KNOWN_TYPES.has(entry.type)) {
        unknownTypes += 1;
        reporter.warn(`${where}: unknown type "${entry.type}"`);
      }

      ["countries", "regions", "specialties", "aliases"].forEach((f) => {
        if (entry[f] !== undefined && !Array.isArray(entry[f])) {
          reporter.fail(`${where}: "${f}" must be an array`);
        }
      });

      if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
        reporter.fail(`${where}: "enabled" must be a boolean`);
      }

      Object.keys(entry).forEach((k) => {
        if (!KNOWN_FIELDS.has(k)) {
          unknownFields += 1;
          reporter.warn(`${where}: unknown field "${k}"`);
        }
      });
    });

    totalEntries += data.entries.length;
    reporter.note(
      `${ds.name}: ${data.entries.length} entries, v${data._version} (${data._lastUpdated}) — ` +
      `${dupes} dup domains, ${unknownTypes} unknown types, ${unknownFields} unknown fields`
    );
  }

  reporter.note(`total entries: ${totalEntries}`);
  return reporter;
}

if (require.main === module) {
  runCli(validateDatasets);
}

module.exports = validateDatasets;
