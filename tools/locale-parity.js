#!/usr/bin/env node
"use strict";
/**
 * Locale parity audit. A superset of test/locales.test.js with extra checks and
 * human-readable output.
 *
 * Errors: missing base locale, key set differing from English, empty message,
 * unsafe $name$ placeholder, positional-placeholder mismatch vs English,
 * duplicate key in the raw JSON. Notes: stats + category localization coverage.
 */

const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");

const NAMED_PLACEHOLDER = /\$[A-Za-z0-9_@]+\$/;
const positional = (s) => (s.match(/\$[1-9]/g) || []).sort().join(",");

// Detect duplicate top-level keys, which JSON.parse silently collapses.
function duplicateKeys(raw) {
  const counts = new Map();
  const re = /"([A-Za-z0-9_]+)"\s*:\s*\{/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

function localeParity() {
  const reporter = new Reporter("Localization — parity & placeholders");
  const dirs = load.localeDirs();

  if (!dirs.includes("en")) {
    reporter.fail("missing English base locale");
    return reporter;
  }

  const en = load.loadLocale("en");
  if (en.error) {
    reporter.fail(`en/messages.json invalid: ${en.error}`);
    return reporter;
  }

  const enKeys = Object.keys(en.data).sort();
  const enSet = new Set(enKeys);
  const statsKeys = enKeys.filter((k) => k.startsWith("statsMostBlocked"));
  const catKeys = enKeys.filter((k) => k.startsWith("catLabel"));
  let fullyLocalizedCats = 0;

  for (const code of dirs) {
    const loc = load.loadLocale(code);
    if (loc.error) {
      reporter.fail(`${code}: invalid JSON — ${loc.error}`);
      continue;
    }

    const keys = Object.keys(loc.data).sort();
    const keySet = new Set(keys);

    if (keys.length !== enKeys.length || keys.some((k, i) => k !== enKeys[i])) {
      enKeys.filter((k) => !keySet.has(k)).forEach((k) => reporter.fail(`${code}: missing key "${k}"`));
      keys.filter((k) => !enSet.has(k)).forEach((k) => reporter.fail(`${code}: extra key "${k}"`));
    }

    duplicateKeys(loc.raw).forEach((k) => reporter.fail(`${code}: duplicate key "${k}"`));

    for (const [key, entry] of Object.entries(loc.data)) {
      const msg = entry && typeof entry.message === "string" ? entry.message : null;
      if (msg === null) {
        reporter.fail(`${code}.${key}: message is not a string`);
        continue;
      }
      if (!msg.length) {
        reporter.fail(`${code}.${key}: empty message`);
      }
      if (NAMED_PLACEHOLDER.test(msg)) {
        reporter.fail(`${code}.${key}: unsafe $name$ placeholder`);
      }
      if (code !== "en" && enSet.has(key) && positional(msg) !== positional(en.data[key].message)) {
        reporter.fail(`${code}.${key}: placeholder set differs from English`);
      }
    }

    // Category localization coverage: a locale "localizes" categories when at
    // least one catLabel differs from English. (Loanwords like "Pizza" stay
    // identical in many languages, so requiring *all* to differ would undercount.)
    if (code !== "en" && catKeys.length) {
      const localizesSome = catKeys.some((k) => loc.data[k] && loc.data[k].message !== en.data[k].message);
      if (localizesSome) {
        fullyLocalizedCats += 1;
      }
    }
  }

  reporter.note(`${dirs.length} locales, ${enKeys.length} keys each`);
  reporter.note(`stats keys: ${statsKeys.length}, category keys: ${catKeys.length}`);
  reporter.note(`categories localized in ${fullyLocalizedCats + 1}/${dirs.length} locales (rest use clean English fallback)`);
  return reporter;
}

if (require.main === module) {
  runCli(localeParity);
}

module.exports = localeParity;
