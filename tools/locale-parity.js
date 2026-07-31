#!/usr/bin/env node
"use strict";
/**
 * Locale parity audit. A superset of test/locales.test.js with extra checks and
 * human-readable output.
 *
 * ERRORS (these break something):
 *   - the English base locale is missing or invalid,
 *   - a locale defines a key English does not have — a dead string that can
 *     never be shown, and usually a rename that was only half-applied,
 *   - a duplicate key in the raw JSON (JSON.parse silently keeps the last one),
 *   - an empty message, an unsafe $name$ placeholder, or a positional
 *     placeholder set that differs from English for a key the locale DOES have.
 *
 * WARNINGS (translation debt, not breakage):
 *   - a locale is missing an English key. This is reported as a per-locale
 *     coverage figure rather than an error because BOTH runtime paths already
 *     fall back to English for a missing key: chrome.i18n falls back to
 *     default_locale, and i18n.js falls back to its cached English map. An
 *     untranslated string therefore renders in English, which is the intended
 *     behaviour — it does not render blank and it does not throw.
 *
 * This is deliberately different from an exact-parity gate. Exact parity forces
 * every new English string to be machine-translated into 80+ languages before it
 * can ship, which produces confident-sounding nonsense; measuring the debt
 * instead keeps the gap visible and honest.
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
  const coverage = [];

  for (const code of dirs) {
    const loc = load.loadLocale(code);
    if (loc.error) {
      reporter.fail(`${code}: invalid JSON — ${loc.error}`);
      continue;
    }

    const keys = Object.keys(loc.data).sort();
    const keySet = new Set(keys);

    // A key English does not have can never be displayed: it is dead weight and
    // almost always a half-finished rename. That is an error.
    keys.filter((k) => !enSet.has(k)).forEach((k) => reporter.fail(`${code}: extra key "${k}" (not in English)`));

    // A key English HAS but this locale does not simply falls back to English.
    const missing = enKeys.filter((k) => !keySet.has(k));
    if (code !== "en" && missing.length > 0) {
      const percent = Math.round(((enKeys.length - missing.length) / enKeys.length) * 100);
      coverage.push({ code, missing: missing.length, percent });
      reporter.warn(
        `${code}: ${missing.length} untranslated key(s) — ${percent}% translated (these render in English)`
      );
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

  const fullyTranslated = dirs.length - coverage.length;
  const averagePercent = coverage.length
    ? Math.round(coverage.reduce((sum, item) => sum + item.percent, 0) / coverage.length)
    : 100;

  reporter.note(`${dirs.length} locales · ${enKeys.length} English keys`);
  reporter.note(
    `${fullyTranslated}/${dirs.length} locales fully translated · ` +
      `${coverage.length} partial (average ${averagePercent}% — the rest render in English)`
  );
  reporter.note(`stats keys: ${statsKeys.length}, category keys: ${catKeys.length}`);
  reporter.note(`categories localized in ${fullyLocalizedCats + 1}/${dirs.length} locales (rest use clean English fallback)`);
  return reporter;
}

if (require.main === module) {
  runCli(localeParity);
}

module.exports = localeParity;
