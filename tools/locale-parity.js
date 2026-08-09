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

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");

const NAMED_PLACEHOLDER = /\$[A-Za-z0-9_@]+\$/;
const positional = (s) => (s.match(/\$[1-9]/g) || []).sort().join(",");

const EXTENSION_DIR = path.join(__dirname, "..", "extension");

const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/**
 * Inline text under a `data-i18n` element that no longer matches English.
 *
 * The attribute makes the inline text a FALLBACK, not decoration: it is what the
 * page paints before `i18n.js` has run, what a reviewer reads in the source, and
 * what a reader sees if the locale layer ever fails to start. When English moves
 * and the markup does not, the two disagree — and the disagreement is invisible
 * to every other check here, because the KEY still resolves perfectly.
 *
 * Reported as a warning rather than an error for the same reason untranslated
 * keys are: nothing is broken on screen, and the fix belongs to whoever owns the
 * markup. It is measured so it cannot drift quietly.
 *
 * Deliberately conservative — only elements whose entire content is a single run
 * of text are compared, because anything richer is a judgement call about markup
 * rather than about wording.
 */
function htmlFallbackDrift(en) {
  const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity]);
  const out = [];

  fs.readdirSync(EXTENSION_DIR)
    .filter((name) => name.endsWith(".html"))
    .sort()
    .forEach((page) => {
      fs.readFileSync(path.join(EXTENSION_DIR, page), "utf8")
        .split("\n")
        .forEach((line, index) => {
          const pattern = /<([a-z0-9]+)\b[^>]*\bdata-i18n="([A-Za-z0-9_]+)"[^>]*>([^<]*)<\/\1>/g;
          let match;

          while ((match = pattern.exec(line)) !== null) {
            const [, , key, raw] = match;
            const text = decode(raw).trim();

            if (!text || !en[key] || text === en[key].message) {
              continue;
            }

            out.push({ page, line: index + 1, key, text, english: en[key].message });
          }
        });
    });

  return out;
}

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
  alternativeAnnounce: ["$1, $2 minutes. Option $3 of $4."],
  // Named delivery only, under an onboarding question whose answers include fast
  // food, so the body contradicted the choices directly beneath it.
  welcomeDeliveryBody: ["Adds a pause screen on delivery platforms like DoorDash and Uber Eats."],

  // --- The 0.56 terminology pass ------------------------------------------
  //
  // One canonical name per concept, chosen and recorded in docs/LOCALIZATION.md.
  // Everything below is a synonym the product no longer uses. They are pinned by
  // exact string as well as by digest because several of them are single common
  // words: "On", "Off" and "Block" are exactly the entries a future bulk import
  // would hand back as a "translation", and the digest guard cannot see that a
  // locale file was never really translated.

  // The product calls itself FitShield. Not "the blocker", not "the shield", and
  // never "armed" — four names for one subject, in four branches of the SAME
  // popup sentence.
  statusInactive: ["Inactive. All sites are accessible."],
  statusAllDisabled: ["Blocker is on, but every individual site is disabled. Open Settings to turn some sites back on."],
  statusOutsideSchedule: ["Blocker is armed, but outside scheduled hours. It will block from $1."],
  // Two generations of the same line. "5 minutes pass" read as a verb phrase and
  // "pass" was jargon the popup never defined; the replacement borrowed
  // frictionSummary's wording but kept "Shield up" as a fifth name for FitShield.
  statusShieldUp: [
    "Shield up. $1 seconds countdown, $2 $3 pass.",
    "Shield up. $1-second pause, then the site stays open for $2 $3."
  ],

  // "blocklist" is one word everywhere else in the product.
  popupBlockerSubtitle: ["Turn every block list on or off."],

  // "Pause" now means the block-page countdown and nothing else. These two
  // buttons turn ALL blocking off, which is a different thing entirely.
  passAllThirtyMinutes: ["Pause everything for 30 minutes"],
  passAllUntilTomorrow: ["Pause everything until tomorrow"],

  // The panel promised "FitShield stays on for everything else" directly above
  // the two buttons that switch it off for everything.
  passTitle: ["Continue to this site"],
  passSubtitle: ["Choose how long. FitShield stays on for everything else."],

  // One country/category had four labels across two adjacent widgets: the search
  // rows said "Blocking"/"Block" while the pinned chips said "On"/"Off" with
  // "Blocking"/"Paused" tooltips. Now "Blocking"/"Not blocking" in all four.
  mbBlock: ["Block"],
  mbOn: ["On"],
  mbOff: ["Off"],
  mbChipToggleOnTitle: ["Blocking — click to pause"],
  mbChipToggleOffTitle: ["Paused — click to block"],
  mbChipRemoveTitle: ["Remove shortcut from quick access"],

  // The tab title and the heading beneath it were two different headlines.
  warningPageTitle: ["Take a Breath"],

  // One rolling seven-day window, three names. "This week" also implied a
  // calendar week that resets on Monday, which is not what weeklyRecap computes.
  recapHeading: ["This week"],
  recapNoActivity: ["Nothing to summarise for the last seven days."],
  recapHidden: ["The weekly summary is switched off."],

  // "Made" names only the event the user personally confirmed in the popup. The
  // button that merely SELECTS an alternative may not use that verb.
  alternativeChooseButton: ["I'll make this"],

  // A "(s)" hack most languages cannot express, replaced by a real key pair.
  scheduleWindowsSummary: ["$1 time window(s) set."],

  // American spelling throughout.
  alternativeFavoriteLabel: ["Save as a favourite"],
  whyFavorite: ["One of your favourites"],
  importCancelledNotice: ["Import cancelled. Nothing was changed."]
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
    //
    // Measured, not warned about. This is the one condition in this file that is
    // the DESIGNED behaviour rather than a fault: docs/LOCALIZATION.md commits to
    // partial locales, both runtime paths fall back, and a test proves the
    // fallback works. Reporting it once per locale produced 82 warnings that
    // never went down and never could — and 82 standing warnings for an accepted
    // condition is how the one warning that matters gets scrolled past.
    //
    // Nothing stopped being checked. The debt is still computed here, still
    // stated in the notes below with its full range, and `npm run locales:status`
    // still prints it per locale and per surface. What changed is the channel:
    // the defect channel is now reserved for defects, and this pass ADDED one to
    // it — English left standing in a non-Latin-script locale, which is a real
    // fault that the 82 warnings were loud enough to hide.
    const missing = enKeys.filter((k) => !keySet.has(k));
    if (code !== "en" && missing.length > 0) {
      const percent = Math.round(((enKeys.length - missing.length) / enKeys.length) * 100);
      coverage.push({ code, missing: missing.length, percent });
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

    // Keys written ahead of the page script that will render them. Exempt from
    // the unused-key scan, but never invisible: a staged key with no reader is
    // real work someone still owes, and it is stated on every validation run
    // until the marker is removed.
    prune.stagedInvalid().forEach((entry) => {
      reporter.fail(`"${entry.key}" is staged for "${entry.file}", which does not exist in extension/`);
    });

    prune.stagedKeys().forEach((file, key) => {
      reporter.warn(`"${key}" is staged for ${file}, which does not read it yet — the string cannot appear on screen`);
    });

    prune.stagedFulfilled().forEach((entry) => {
      reporter.warn(
        `"${entry.key}" is still marked "[staged: ${entry.file}]" but ${entry.file} already reads it — ` +
          `remove the note from its English description`
      );
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

  const drift = htmlFallbackDrift(en.data);

  drift.forEach((entry) => {
    reporter.warn(
      `${entry.page}:${entry.line} inline fallback for "${entry.key}" is ${JSON.stringify(entry.text)} but ` +
        `English now says ${JSON.stringify(entry.english)}`
    );
  });

  if (drift.length > 0) {
    reporter.note(`${drift.length} inline HTML fallback(s) disagree with English (markup edit, not a locale edit)`);
  }

  // English filed as a translation in a locale that does not use the Latin
  // alphabet. Unlike missing keys, this is NOT the designed fallback: the key is
  // defined, so nothing can substitute the current English, and the string lands
  // in a Cyrillic or Devanagari list as a Latin word. It also inflates the
  // coverage figure and hides the string from every translator worklist, which
  // is why it survived so long — 761 entries across 39 locales when the check was
  // first run. Fix by translating it, or by deleting the entry so the fallback
  // applies honestly.
  try {
    const hybrid = require("./locale-hybrid-audit.js");

    hybrid.englishInNonLatinScript().forEach((keys, code) => {
      reporter.fail(
        `${code}: ${keys.length} English string(s) filed as translations in a non-Latin-script locale ` +
          `(${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}) — translate them or delete the entries ` +
          `(node tools/locale-hybrid-audit.js --stranded ${code})`
      );
    });

    // A stray ASCII pipe, the fingerprint of the machine-translation pass that
    // left 154 Odia labels rendering with a vertical bar and a line break in
    // front of them. No English message contains a pipe, so this cannot be a
    // false positive.
    hybrid.findMangledPunctuation().forEach((keys, code) => {
      reporter.fail(
        `${code}: ${keys.length} message(s) contain a stray "|" left by a machine-translation pass ` +
          `(${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}) — no English message has one`
      );
    });

    // "блокироватьing", "Блокироватьlist" — an English suffix welded onto a
    // translated stem by a word-level find-and-replace. The oldest damage in the
    // corpus and the loudest: it is gibberish in the reader's own script.
    hybrid.findFusedScripts().forEach((keys, code) => {
      reporter.fail(
        `${code}: ${keys.length} message(s) weld Latin letters onto a word in the local script ` +
          `(${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}) — retranslate or delete them`
      );
    });
  } catch (error) {
    reporter.warn(`could not check for stranded English: ${error.message}`);
  }

  const fullyTranslated = dirs.length - coverage.length;
  const averagePercent = coverage.length
    ? Math.round(coverage.reduce((sum, item) => sum + item.percent, 0) / coverage.length)
    : 100;

  reporter.note(`${dirs.length} locales · ${enKeys.length} English keys`);

  // The translation debt, stated as a measurement. Range as well as average,
  // because the average alone hides a locale sitting far below its peers.
  if (coverage.length > 0) {
    const percents = coverage.map((item) => item.percent).sort((a, b) => a - b);
    const lowest = percents[0];
    const highest = percents[percents.length - 1];
    const median = percents[Math.floor(percents.length / 2)];
    const debt = coverage.reduce((sum, item) => sum + item.missing, 0);
    const worst = coverage
      .filter((item) => item.percent === lowest)
      .map((item) => item.code)
      .join(", ");

    reporter.note(
      `${fullyTranslated}/${dirs.length} locales complete · ${coverage.length} partial, ` +
        `${lowest}%–${highest}% (median ${median}%, average ${averagePercent}%)`
    );
    reporter.note(
      `translation debt: ${debt} untranslated string(s), every one of which renders in English by design ` +
        `(docs/LOCALIZATION.md) · lowest coverage: ${worst}`
    );

    // The actionable slice of that debt: strings the product added and never had
    // translated ANYWHERE. A locale being behind is a translator's queue; a key
    // no locale has is a handover that never happened, and it is the shape
    // `currencyAuto` shipped in — English-only while the Intl-localized text
    // beside it was not.
    const neverTranslated = enKeys.filter((key) =>
      dirs.every((code) => code === "en" || !load.loadLocale(code).data[key])
    );

    if (neverTranslated.length > 0) {
      reporter.note(
        `${neverTranslated.length} English key(s) are translated in no locale at all — ` +
          `the strings added since the last translation pass (node tools/locale-status.js --todo <locale>)`
      );
    }
  }
  reporter.note(`stats keys: ${statsKeys.length}, category keys: ${catKeys.length}`);
  reporter.note(`categories localized in ${fullyLocalizedCats + 1}/${dirs.length} locales (rest use clean English fallback)`);
  return reporter;
}

if (require.main === module) {
  runCli(localeParity);
}

module.exports = localeParity;
module.exports.RETIRED_ENGLISH = RETIRED_ENGLISH;
module.exports.htmlFallbackDrift = htmlFallbackDrift;
