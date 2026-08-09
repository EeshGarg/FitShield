#!/usr/bin/env node
"use strict";
/**
 * Find translations that are neither translated nor English, but a mangled mix.
 *
 * FitShield's localization contract (docs/LOCALIZATION.md) is: translate a string
 * properly, or leave it out and let it fall back to English. Both are fine. What
 * is not fine is a third state that arrived from a word-level find-and-replace
 * over English source strings:
 *
 *     ru  warningTitle   "Take one минута."
 *     ru  popupScheduleSubtitle  "Использоватьful for meal budgets..."
 *     be  fastFoodToggleTitle    "Уключыць fast food сайт блакіравацьing"
 *     or  customNoMatch          " |\nକ search ଣସି କଷ୍ଟମ୍ URL ..."
 *
 * A Russian speaker reads "блокироватьing" as gibberish, and a product that ships
 * gibberish reads as fake. English fallback is strictly better, so these are
 * removed rather than kept.
 *
 * DETECTION. A string is reported when it contains BOTH:
 *   1. characters from a non-Latin script, AND
 *   2. an English FUNCTION word (the, and, your, this, will, match, ...) that is
 *      not part of a brand, an acronym, or an example domain.
 *
 * Function words are the discriminator on purpose. A real translation routinely
 * keeps a Latin technical noun ("URL", "Timer", "Blocker", "DoorDash") and that
 * must NOT be flagged; no real translation keeps English grammar words.
 *
 *   node tools/locale-hybrid-audit.js            # report
 *   node tools/locale-hybrid-audit.js --apply    # delete them (English fallback)
 */

const fs = require("fs");
const path = require("path");
const { Reporter } = require("./lib/report.js");

const ROOT = path.join(__dirname, "..");
const LOCALES_DIR = path.join(ROOT, "extension", "_locales");

// Scripts that cannot legitimately share a word with English.
const NON_LATIN =
  /[Ͱ-ϿЀ-ӿ԰-֏֐-׿؀-ۿ܀-ݏऀ-ॿঀ-৿਀-෿฀-๿က-႟Ⴀ-ჿ぀-ヿ㐀-鿿가-힯]/;

// Latin that legitimately survives translation: the brand, partner brand names
// used as examples, acronyms, example domains, protocol names, language names.
const ALLOWED_LATIN =
  /FitShield|DoorDash|Uber\s*Eats|example\.com|https?|URL|Tagalog|Blocklist|Blocker|Timer|Shield|Wi-?Fi|ID|OK/gi;

// English grammar. Nothing but English source text contains these.
const FUNCTION_WORDS = [
  "the", "and", "your", "you", "this", "that", "is", "are", "was", "will", "for", "with",
  "from", "before", "after", "when", "every", "all", "some", "match", "stay", "open",
  "appears", "keep", "turn", "choose", "adjust", "how", "long", "own", "only", "during",
  "like", "its", "has", "been", "but", "not", "more", "less", "whole", "groups",
  "individually", "back", "active", "enabled", "disabled", "search", "helped", "avoid",
  "resumes", "follow", "other", "each", "into", "onto", "about", "which", "while",
  "then", "than", "them", "they", "their", "there", "here", "any", "can", "must",
  "should", "would", "could", "take", "one", "make", "use", "show", "hide", "view",
  "add", "of", "to", "or", "an"
];

const FUNCTION_RE = new RegExp(`(?:^|[^A-Za-z])(?:${FUNCTION_WORDS.join("|")})(?:[^A-Za-z]|$)`, "i");

/**
 * True when a string is English PROSE rather than a name.
 *
 * Two or more words, at least one of which is English grammar. That excludes the
 * things that legitimately survive translation byte-for-byte — "FitShield",
 * "Pizza", "Buy Me a Coffee", "Fast Casual", "Filipino / Tagalog" — and includes
 * everything a translator would actually have to rewrite. Used by
 * tools/locale-prune.js to tell a real translation that happens to match English
 * from English text that was simply copied into a locale file.
 */
function isEnglishPhrase(text) {
  const value = String(text || "").trim();
  return value.split(/\s+/).length >= 2 && FUNCTION_RE.test(value);
}

const localeCodes = require("./lib/load.js").localeDirs;

function readLocale(code) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, code, "messages.json"), "utf8"));
}

/** @returns {Map<string, string[]>} locale -> keys whose message is a mangled mix */
function findHybrids() {
  const en = readLocale("en");
  const out = new Map();

  localeCodes().forEach((code) => {
    if (code === "en") return;

    const data = readLocale(code);
    const bad = [];

    Object.keys(data).forEach((key) => {
      const message = (data[key] && data[key].message) || "";

      if (!NON_LATIN.test(message)) return;
      // Identical to English means "not translated yet", which is a supported
      // state, not a mangled one.
      if (en[key] && en[key].message === message) return;

      if (FUNCTION_RE.test(message.replace(ALLOWED_LATIN, " "))) bad.push(key);
    });

    if (bad.length > 0) out.set(code, bad);
  });

  return out;
}

function removeHybrids(found) {
  let removed = 0;

  found.forEach((keys, code) => {
    const file = path.join(LOCALES_DIR, code, "messages.json");
    const data = readLocale(code);
    keys.forEach((key) => { delete data[key]; removed += 1; });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  });

  return removed;
}

function audit() {
  const reporter = new Reporter("Localization — mangled hybrid strings");
  const found = findHybrids();

  let total = 0;
  found.forEach((keys) => { total += keys.length; });

  if (total === 0) {
    reporter.note(`${localeCodes().length - 1} translated locale(s) checked — no mangled strings`);
    return reporter;
  }

  found.forEach((keys, code) => {
    keys.forEach((key) => {
      const message = readLocale(code)[key].message;
      reporter.fail(`${code}.${key}: English grammar inside a translated string — "${message.slice(0, 70)}"`);
    });
  });

  reporter.note(`run \`node tools/locale-hybrid-audit.js --apply\` to drop them (they fall back to English)`);
  return reporter;
}

module.exports = audit;
module.exports.findHybrids = findHybrids;
module.exports.FUNCTION_WORDS = FUNCTION_WORDS;
module.exports.isEnglishPhrase = isEnglishPhrase;

if (require.main === module) {
  const found = findHybrids();
  let total = 0;
  found.forEach((keys) => { total += keys.length; });

  if (total === 0) {
    console.log("No mangled hybrid strings.");
    process.exit(0);
  }

  console.log(`${total} mangled string(s) across ${found.size} locale(s):`);
  found.forEach((keys, code) => console.log(`  ${code.padEnd(6)} ${keys.length}`));

  if (!process.argv.includes("--apply")) {
    console.log("\nSample:");
    const [firstCode, firstKeys] = [...found.entries()][0];
    firstKeys.slice(0, 8).forEach((key) => {
      console.log(`  ${firstCode}.${key}: ${JSON.stringify(readLocale(firstCode)[key].message.slice(0, 80))}`);
    });
    console.log("\nRe-run with --apply to remove them (they fall back to English).");
    process.exit(0);
  }

  const removed = removeHybrids(found);
  console.log(`\nRemoved ${removed} entries. Run \`npm run sync\`.`);
}
