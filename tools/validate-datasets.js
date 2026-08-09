#!/usr/bin/env node
"use strict";
/**
 * Structural + metadata validation for the curated blocklists.
 *
 * Checks: JSON validity, top-level schema keys, required entry fields, field
 * types, duplicate domains (within a file AND across files), a domain already
 * covered by another entry's apex, generator-template metadata, brand names
 * built out of the domain, hostname shape, enabled flag, and unknown/orphaned
 * fields. Country, region, alias, and category specifics live in their own
 * focused audits (country-audit, alias-audit, category-audit).
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

// A brand name that ends in its own TLD ("Auchan.fr", "Bbq.co.kr",
// "Alicepizza .it") was built out of the domain by a generator, not written.
// It is the string the block page prints as the brand, so it has to read like
// a brand.
const TLD_IN_NAME =
  /\s*\.\s*(com?|net|org|io|cn|kr|jp|tw|hk|in|br|ru|de|fr|it|es|nl|pl|se|no|dk|fi|cz|hu|ro|gr|tr|ua|au|nz|za|ae|sa|eg|ma|ng|ke|th|vn|ph|id|my|sg|mx|ar|cl|pe|ca|uk|ie|at|ch|be|pt|il|pk|lu|global|asia|life|world|app|shop|store|online|club|xyz|tv|biz|info)(\s*\.\s*[a-z]{2})?\s*$/i;

// …except where the domain IS the brand. These companies write their own name
// that way, so "Takeaway.com" is the label and "Takeaway" would be the wrong
// one. The list is explicit on purpose: a generated label and a real one are
// the same shape, so each has to be a decision rather than a pattern.
const DOMAIN_IS_THE_BRAND = new Set([
  "delivery.com", "owner.com", "thuisbezorgd.nl", "takeaway.com", "pyszne.pl",
  "tsukurioki.jp", "hungry.ca", "menu.ca", "58.com"
]);

// The share of one file a single (countries, specialties, category) tuple may
// hold. `fast-food.json` once had 804 entries — 38% of it — carrying the exact
// tuple ["JP"] / ["rice dishes","set meals","sides"] / fast_casual, which is
// what a classifier stamps on everything it cannot classify. Real curation does
// not produce a plurality that large, and every one of those fields is printed
// to the user on the block page.
const MAX_TEMPLATE_SHARE = 0.12;

function validateDatasets() {
  const reporter = new Reporter("Datasets — structure & metadata");
  let totalEntries = 0;
  const acrossFiles = new Map(); // domain -> "file[index]"
  const allApexes = new Map(); // domain -> file name

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

        // Across files, too. This check did not exist, and 115 domains were
        // listed in BOTH blocklists with different names, different categories
        // and different countries. The keys the settings page builds include
        // the rule bucket, so each of those brands got two rows and two
        // toggles: turning "BBQ Chicken" off in one list left the other rule
        // blocking the site, and the block page then named the brand
        // "Bbq.co.kr" and placed a Korean chain in Japan.
        if (acrossFiles.has(domain)) {
          dupes += 1;
          reporter.fail(`${where}: domain is also listed in ${acrossFiles.get(domain)} — one brand, two toggles`);
        } else {
          acrossFiles.set(domain, `${ds.name}[${i}]`);
        }

        allApexes.set(domain, ds.name);
      }

      // A name built out of the domain is what the block page prints as the
      // brand. 550 entries once carried one, including "Auchan.fr",
      // "Bbq.co.kr" and "Justea T.dk" — the last of which is what a naive
      // title-caser does to "justeat".
      if (typeof entry.name === "string" && TLD_IN_NAME.test(entry.name) && !DOMAIN_IS_THE_BRAND.has(domain)) {
        reporter.fail(`${where}: name "${entry.name}" is the domain, not a brand name`);
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

    // Generator templates: one identical (countries, specialties, category)
    // tuple repeated over a large share of a file is fabricated metadata, not
    // curation.
    const tuples = new Map();
    data.entries.forEach((entry) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const specialties = Array.isArray(entry.specialties) ? entry.specialties : [];
      if (specialties.length === 0) {
        return; // an honest "not known" is not a template
      }
      const key = `${JSON.stringify(entry.countries || [])} / ${JSON.stringify(specialties)} / ${entry.category}`;
      tuples.set(key, (tuples.get(key) || 0) + 1);
    });

    tuples.forEach((count, key) => {
      if (data.entries.length > 0 && count / data.entries.length > MAX_TEMPLATE_SHARE) {
        reporter.fail(
          `${ds.name}: ${count} of ${data.entries.length} entries (${Math.round(
            (count / data.entries.length) * 100
          )}%) share the identical metadata ${key} — that is a classifier default, not curation`
        );
      }
    });

    totalEntries += data.entries.length;
    reporter.note(
      `${ds.name}: ${data.entries.length} entries, v${data._version} (${data._lastUpdated}) — ` +
      `${dupes} dup domains, ${unknownTypes} unknown types, ${unknownFields} unknown fields`
    );
  }

  // An entry whose domain sits under another entry's apex is already blocked by
  // it. The extra row only ever produced a second Settings toggle that could not
  // turn the site off, so the parent and the child have to be a deliberate
  // choice between "block the whole brand" and "block only its food surface".
  [...allApexes.keys()].forEach((domain) => {
    const parent = [...allApexes.keys()].find((other) => other !== domain && domain.endsWith(`.${other}`));

    if (parent) {
      reporter.fail(
        `${domain} (${allApexes.get(domain)}) is already blocked by the listed apex ${parent} ` +
        `(${allApexes.get(parent)}) — list one or the other, not both`
      );
    }
  });

  reporter.note(`total entries: ${totalEntries}`);
  return reporter;
}

if (require.main === module) {
  runCli(validateDatasets);
}

module.exports = validateDatasets;
