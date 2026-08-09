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
 *     placeholder set that differs from English for a key the locale DOES have,
 *   - a translation of English text that has since CHANGED. This is the one
 *     failure mode the fallback cannot rescue: the key IS defined, so neither
 *     chrome.i18n nor i18n.js can substitute the current English, and 82 locales
 *     keep rendering a sentence the product retired. `learnMoreLink` shipped a
 *     whole release that way — English moved to "About FitShield" while every
 *     other locale said "Visit fitshield.net",
 *   - a locale entry byte-identical to an English SENTENCE. That is English
 *     filed as a translation: it renders exactly what the fallback would render,
 *     while inflating the coverage figure and hiding the string from every
 *     translator worklist.
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

/**
 * English wordings the product has RETIRED, pinned by key.
 *
 * The digest baseline (tools/locale-source-baseline.json) is the general guard
 * against translations of changed English. This is the specific one: the exact
 * strings that were found shipping in 82 locales after English had moved on. It
 * is deliberately independent of the baseline file, so deleting or hand-editing
 * that file cannot quietly bring them back — and it catches the worst variant,
 * where the "translation" is the old English text verbatim and so is invisible
 * to every other check in this file.
 */
const RETIRED_ENGLISH = {
  learnMoreLink: ["Visit fitshield.net"],
  warningEyebrow: ["FitShield Check"],
  warningTitle: ["Take one minute."],
  warningIntro: ["Check in before you order. Hunger, convenience, stress, and habit can feel similar in the moment."],
  warningLockedButton: ["Locked"],
  warningContinueButton: ["Continue"],
  blockReasonHeading: ["Why you're seeing this"],
  alternativeAnnounce: ["$1, $2 minutes. Option $3 of $4."]
};

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
      if (code !== "en" && (RETIRED_ENGLISH[key] || []).includes(msg)) {
        reporter.fail(
          `${code}.${key}: ships retired English wording "${msg}" — English now says ` +
            `"${en.data[key] ? en.data[key].message : "(key removed)"}". Delete the entry so the fallback applies.`
        );
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

  // A key nothing can display is still shipped in all 83 files and still lands
  // in translator worklists, so it is surfaced here rather than left to be found
  // by accident. Reported as a warning: the fix is a data edit, not a breakage.
  try {
    const prune = require("./locale-prune");

    prune.staleExemptions().forEach((prefix) => {
      reporter.fail(
        `dynamic-key prefix "${prefix}" is exempted from the unused-key check but no code builds it any more`
      );
    });

    prune.unusedKeys().forEach((key) => {
      reporter.warn(`"${key}" exists in every locale but no source references it (node tools/locale-prune.js --apply)`);
    });

    // Translations of English that has since changed. Unlike an untranslated
    // key, this cannot heal itself at runtime, so it is an error.
    const stale = prune.staleTranslations();
    stale.forEach((codes, key) => {
      reporter.fail(
        `"${key}": English text changed after the translations were cut — ${codes.length} locale(s) still ` +
          `render the old wording, and the fallback cannot correct them. Re-translate, or run ` +
          `\`node tools/locale-prune.js --apply\``
      );
    });

    // English sentences filed as translations. Removing one changes nothing on
    // screen and makes the coverage figure true.
    const copies = prune.englishCopies();
    copies.forEach((codes, key) => {
      reporter.fail(
        `"${key}": byte-identical to the English sentence in ${codes.length} locale(s) — that is English ` +
          `filed as a translation (node tools/locale-prune.js --apply)`
      );
    });

    // The baseline is only a guard while it covers the corpus. A key added to
    // English since the last recording is not an error — nothing is translated
    // against it yet — but it does need recording before it can be watched.
    const baseline = prune.readBaseline();
    const unrecorded = enKeys.filter((key) => !Object.prototype.hasOwnProperty.call(baseline, key));

    if (Object.keys(baseline).length === 0) {
      reporter.fail(
        "no English source baseline recorded — translations of changed English cannot be detected " +
          "(node tools/locale-prune.js --baseline)"
      );
    } else if (unrecorded.length > 0) {
      reporter.warn(
        `${unrecorded.length} English key(s) added since the source baseline was recorded; changes to them ` +
          `are unwatched until \`node tools/locale-prune.js --baseline\` runs`
      );
    }

    reporter.note(
      `source baseline: ${Object.keys(baseline).length} English string(s) recorded · ` +
        `${prune.total(stale)} stale translation(s) · ${prune.total(copies)} verbatim-English copy(ies)`
    );
  } catch (error) {
    reporter.warn(`could not check for unreferenced keys: ${error.message}`);
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
module.exports.RETIRED_ENGLISH = RETIRED_ENGLISH;
