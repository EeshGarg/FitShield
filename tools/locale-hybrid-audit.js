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
  "add", "of", "to", "or", "an",
  // "Block by country" was half-translated in seven Cyrillic and Greek locales —
  // "Блакіраваць by краіна", "Αποκλεισμός by χώρα" — and survived because the
  // preposition carrying the whole defect was missing from this list.
  "by"
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

// ---------------------------------------------------------------------------
// English left standing in a locale that does not use the Latin alphabet
// ---------------------------------------------------------------------------

/**
 * The gap between `findHybrids` and `locale-prune.englishCopies`.
 *
 * `findHybrids` needs a string to MIX scripts, so a wholly-English message in a
 * Cyrillic file is invisible to it. `englishCopies` needs two words and an
 * English function word, so "Bakery", "Grocery" and "Restaurant" are invisible to
 * that. Between them sat 900+ entries: a Bulgarian user reading
 * "Куриерска услуга · Доставка · Бързо хранене · Bakery · Grocery · Restaurant"
 * in one list, and `ug.clearButton` rendering the word "Clear" in a page of
 * Uyghur.
 *
 * The rule this encodes is narrow and script-based, which is what makes it safe:
 * in a locale whose own corpus is overwhelmingly non-Latin, a message that is
 * PURE Latin AND byte-identical to the English one is not a translation that
 * happened to match — that coincidence cannot occur across a script boundary.
 * Even loanwords cross it: Russian writes "Пицца", Japanese "ピザ", Persian
 * "پیتزا". So the test is decisive here in a way it never could be for German.
 *
 * `ALLOWED_UNTRANSLATED` is the deliberate exception list — proper nouns that
 * genuinely stay in Latin script everywhere, because they are names of things
 * rather than words.
 */
const ALLOWED_UNTRANSLATED = new Set([
  "appName", // the product is called FitShield in every language
  "actionTitle",
  "bmcAlt" // "Buy Me a Coffee" is a third-party service's own name
]);

// A locale counts as non-Latin when its own translations are overwhelmingly in
// another script. Measured rather than hardcoded, so a locale added later is
// classified by what it actually contains.
const NON_LATIN_SHARE = 0.6;

function isNonLatinLocale(data) {
  const written = Object.values(data)
    .map((entry) => (entry && entry.message) || "")
    .filter((message) => /\p{Letter}/u.test(message));

  if (written.length < 20) {
    return false;
  }

  return written.filter((message) => NON_LATIN.test(message)).length / written.length >= NON_LATIN_SHARE;
}

const PURE_LATIN = (text) => /\p{Letter}/u.test(text) && !NON_LATIN.test(text);

/**
 * A native letter FUSED to Latin letters inside one word: "блокироватьing",
 * "Блокироватьlist", "αποκλεισμόςing".
 *
 * This is the exact damage the header of this file describes, and until now the
 * file could not detect it.  asks for an English FUNCTION word, and
 * the residue of a word-level find-and-replace is a SUFFIX — "ing", "ed",
 * "list" — which is not a word at all. Its own documented example,
 * , was never caught by it.
 *
 * Adjacency is the signal, and it is only decidable in scripts that separate
 * words with spaces. Japanese and Chinese write "FitShieldの設定" with no space,
 * so Latin fused to native text is correct there and this rule must not look at
 * them. Cyrillic, Greek, Armenian, Georgian, Hebrew, Arabic and the Indic
 * deliberately excluded, because they attach case and plural suffixes straight
 */
const SPACED_SCRIPTS = /[Ͱ-ϿЀ-ӿ԰-֏Ⴀ-ჿ]/;
const FUSED = /[Ͱ-ϿЀ-ӿ԰-֏Ⴀ-ჿ][A-Za-z]|[A-Za-z][Ͱ-ϿЀ-ӿ԰-֏Ⴀ-ჿ]/;

/** @returns {Map<string, string[]>} locale -> keys whose words fuse two scripts */
function findFusedScripts() {
  const out = new Map();

  localeCodes().forEach((code) => {
    if (code === "en") return;

    const data = readLocale(code);
    const bad = Object.keys(data).filter((key) => {
      const message = (data[key] && data[key].message) || "";
      return SPACED_SCRIPTS.test(message) && FUSED.test(message);
    });

    if (bad.length > 0) out.set(code, bad);
  });

  return out;
}

/**
 * A stray ASCII pipe: the fingerprint of a bad machine-translation pass.
 *
 * `or/messages.json` carried 174 of them — 154 messages literally beginning
 * " |
", so every label rendered with a vertical bar and a line break in front
 * of it, and most of the rest ending " |" where the Odia danda "।" belonged.
 *
 * Decidable on its own, which is why it is an error rather than a review list:
 * NO English message in the corpus contains a pipe, so a pipe in a translation is
 * never something the source asked for.
 *
 * The same pass also split English words and localized around the pieces
 * ("ଦ daily ନନ୍ଦିନ", "ପୁନ umes" from "res|umes"). A general "short Latin run
 * between native-script characters" rule was tried for those and rejected: it
 * also flags `blockByCategoryHint`, where the embedded "burger, pizza, coffee"
 * are the search terms the hint deliberately tells the user to type. A check that
 * cannot tell an artifact from an instruction is worse than no check. Those cases
 * are caught instead by `findHybrids`, which reads the English function words the
 * fragments sit beside.
 */
function findMangledPunctuation() {
  const out = new Map();

  localeCodes().forEach((code) => {
    if (code === "en") return;

    const data = readLocale(code);
    const bad = [];

    Object.keys(data).forEach((key) => {
      const message = (data[key] && data[key].message) || "";

      if (message.includes("|")) bad.push(key);
    });

    if (bad.length > 0) out.set(code, bad);
  });

  return out;
}

/** @returns {Map<string, string[]>} locale -> keys still carrying English in Latin script */
function englishInNonLatinScript() {
  const en = readLocale("en");
  const out = new Map();

  localeCodes().forEach((code) => {
    if (code === "en") return;

    const data = readLocale(code);
    if (!isNonLatinLocale(data)) return;

    const stranded = Object.keys(data).filter((key) => {
      if (ALLOWED_UNTRANSLATED.has(key)) return false;
      if (!en[key]) return false;

      const message = (data[key] && data[key].message) || "";
      return message === en[key].message && PURE_LATIN(message);
    });

    if (stranded.length > 0) {
      out.set(code, stranded);
    }
  });

  return out;
}

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
module.exports.englishInNonLatinScript = englishInNonLatinScript;
module.exports.findMangledPunctuation = findMangledPunctuation;
module.exports.findFusedScripts = findFusedScripts;
module.exports.isNonLatinLocale = isNonLatinLocale;
module.exports.ALLOWED_UNTRANSLATED = ALLOWED_UNTRANSLATED;

if (require.main === module) {
  // A worklist rather than a pass/fail: `--stranded` prints every English string
  // still standing in a non-Latin locale, which is what a translator needs.
  if (process.argv.includes("--stranded")) {
    const stranded = englishInNonLatinScript();
    let count = 0;
    stranded.forEach((keys) => { count += keys.length; });

    if (count === 0) {
      console.log("No English strings stranded in a non-Latin-script locale.");
      process.exit(0);
    }

    const only = process.argv[process.argv.indexOf("--stranded") + 1];
    console.log(`${count} English string(s) stranded across ${stranded.size} non-Latin locale(s):`);

    stranded.forEach((keys, code) => {
      if (only && !only.startsWith("--") && !only.split(",").includes(code)) return;
      const data = readLocale(code);
      console.log(`\n${code} (${keys.length}):`);
      keys.forEach((key) => console.log(`  ${key.padEnd(32)} ${JSON.stringify(data[key].message)}`));
    });

    process.exit(0);
  }

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
