#!/usr/bin/env node
"use strict";
/**
 * Country audit. Validates the `countries` metadata that powers country-based
 * blocking and the "most blocked countries" stat.
 *
 * Errors: malformed code (not 2 uppercase letters), unknown ISO 3166-1 alpha-2
 * code, duplicate code within an entry, and a country list that contradicts the
 * one fact the domain itself states — its ccTLD. Warnings: a `regions` array
 * that is inconsistent with the entry's countries (missing or extra continent
 * tag).
 */

const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");
const engine = require("../FS Engine");

// ccTLDs that genuinely name a country. Deliberately excludes the ones sold as
// generic TLDs (.co, .io, .me, .tv, .ai, .ly, .cc, .fm, .to, .gg, .sh, .st) —
// those say nothing about where a brand trades.
const CCTLD_COUNTRY = {
  ae: "AE", ao: "AO", ar: "AR", at: "AT", au: "AU", az: "AZ", ba: "BA", bd: "BD", be: "BE",
  bg: "BG", bh: "BH", bo: "BO", br: "BR", bw: "BW", by: "BY", ca: "CA", ch: "CH", ci: "CI",
  cl: "CL", cm: "CM", cn: "CN", cr: "CR", cz: "CZ", de: "DE", dk: "DK", do: "DO", dz: "DZ",
  ec: "EC", ee: "EE", eg: "EG", es: "ES", et: "ET", fi: "FI", fr: "FR", ge: "GE", gh: "GH",
  gr: "GR", gt: "GT", hk: "HK", hn: "HN", hr: "HR", hu: "HU", id: "ID", ie: "IE", il: "IL",
  in: "IN", iq: "IQ", ir: "IR", is: "IS", it: "IT", jo: "JO", jp: "JP", ke: "KE", kh: "KH",
  kr: "KR", kw: "KW", kz: "KZ", la: "LA", lb: "LB", lk: "LK", lt: "LT", lu: "LU", lv: "LV",
  ma: "MA", md: "MD", mk: "MK", mm: "MM", mn: "MN", mo: "MO", mt: "MT", mu: "MU", mx: "MX",
  my: "MY", mz: "MZ", ng: "NG", ni: "NI", nl: "NL", no: "NO", np: "NP", nz: "NZ", om: "OM",
  pa: "PA", pe: "PE", ph: "PH", pk: "PK", pl: "PL", pt: "PT", py: "PY", qa: "QA", ro: "RO",
  rs: "RS", ru: "RU", rw: "RW", sa: "SA", se: "SE", sg: "SG", si: "SI", sk: "SK", sn: "SN",
  sv: "SV", th: "TH", tn: "TN", tr: "TR", tw: "TW", tz: "TZ", ua: "UA", ug: "UG", uk: "GB",
  uy: "UY", uz: "UZ", ve: "VE", vn: "VN", za: "ZA", zm: "ZM", zw: "ZW"
};

function cctldCountry(domain) {
  const parts = String(domain || "").toLowerCase().split(".");
  return CCTLD_COUNTRY[parts[parts.length - 1]] || null;
}

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

      // The ccTLD is the one thing about an entry's market that can be checked
      // without leaving the repository, and it caught a classifier that had
      // stamped "JP" on 1,230 brands: Aldi Germany, Auchan France, Carrefour
      // and 7-Eleven Vietnam were all filed under Japan, and the block page
      // prints that list to the user. Blocking is unaffected — but the country
      // picker and the "most blocked countries" stat both read this field.
      const cc = cctldCountry(entry.domain);
      if (cc && countries.length > 0 && !countries.includes(cc)) {
        reporter.fail(
          `${where}: domain is registered under .${String(entry.domain).split(".").pop()} (${cc}) ` +
            `but countries are ${JSON.stringify(countries)}`
        );
      }

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

  // Every valid ISO code the data uses must resolve to a display name in the FS
  // Engine (getCountryName), so the country picker in every FitShield build shows
  // a real name, not a raw code. This ties the engine's country coverage to the
  // data across all versions (browser bundle + Android reuse the same engine).
  let unnamed = 0;
  [...allCodes].forEach((code) => {
    if (load.ISO_COUNTRIES.has(code) && engine.getCountryName(code) === code) {
      unnamed += 1;
      reporter.fail(
        `FS Engine cannot name ISO country "${code}" (getCountryName echoes the code) — ` +
          "extend the curated names in FS Engine/metadata.js"
      );
    }
  });

  reporter.note(
    `${allCodes.size} distinct country codes; ${malformed} malformed, ${unknown} unknown, ` +
      `${regionWarnings} region inconsistencies, ${unnamed} unnamed by engine`
  );
  return reporter;
}

if (require.main === module) {
  runCli(countryAudit);
}

module.exports = countryAudit;
