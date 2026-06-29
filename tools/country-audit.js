#!/usr/bin/env node
"use strict";
/**
 * Country audit. Validates the `countries` metadata that powers country-based
 * blocking and the "most blocked countries" stat.
 *
 * Errors: malformed code (not 2 uppercase letters), unknown ISO 3166-1 alpha-2
 * code, duplicate code within an entry. Warnings: a `regions` array that is
 * inconsistent with the entry's countries (missing or extra continent tag).
 */

const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");

function expectedRegions(countries) {
  const set = new Set();
  countries.forEach((c) => {
    const r = load.COUNTRY_REGION[c];
    if (r) {
      set.add(r);
    }
  });
  return set;
}

function countryAudit() {
  const reporter = new Reporter("Datasets — countries & regions");
  const datasets = load.loadDatasets().filter((d) => !d.error && Array.isArray(d.data.entries));
  const allCodes = new Set();
  let malformed = 0;
  let unknown = 0;
  let regionWarnings = 0;

  datasets.forEach((ds) => {
    ds.data.entries.forEach((entry, i) => {
      const where = `${ds.name}[${i}] ${entry.domain}`;
      const countries = Array.isArray(entry.countries) ? entry.countries : [];
      const seen = new Set();

      countries.forEach((raw) => {
        const code = String(raw || "");
        allCodes.add(code.toUpperCase());

        if (!/^[A-Z]{2}$/.test(code)) {
          malformed += 1;
          reporter.fail(`${where}: malformed country code "${code}"`);
          return;
        }
        if (!load.ISO_COUNTRIES.has(code)) {
          unknown += 1;
          reporter.fail(`${where}: unknown ISO country code "${code}"`);
        }
        if (seen.has(code)) {
          reporter.fail(`${where}: duplicate country "${code}"`);
        }
        seen.add(code);
      });

      // Region consistency (warning only — regions are informational metadata).
      const regions = Array.isArray(entry.regions) ? entry.regions : [];
      regions.forEach((r) => {
        if (!load.KNOWN_REGIONS.has(r)) {
          reporter.fail(`${where}: unknown region "${r}"`);
        }
      });

      if (countries.length > 0) {
        const expected = expectedRegions(countries);
        const have = new Set(regions);
        const missing = [...expected].filter((r) => !have.has(r));
        const extra = [...have].filter((r) => !expected.has(r));
        if (missing.length) {
          regionWarnings += 1;
          reporter.warn(`${where}: regions missing ${missing.join(",")} implied by its countries`);
        }
        if (extra.length) {
          regionWarnings += 1;
          reporter.warn(`${where}: regions has ${extra.join(",")} not implied by any country`);
        }
      }
    });
  });

  reporter.note(`${allCodes.size} distinct country codes; ${malformed} malformed, ${unknown} unknown, ${regionWarnings} region inconsistencies`);
  return reporter;
}

if (require.main === module) {
  runCli(countryAudit);
}

module.exports = countryAudit;
