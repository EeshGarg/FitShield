#!/usr/bin/env node
"use strict";
/**
 * Remove locale entries that should not exist. Four families, one command.
 *
 * 1. UNREFERENCED ENGLISH KEYS. A key nothing references is not harmless: it is
 *    shipped in 83 files, it shows up in translator worklists, and someone will
 *    spend real effort translating a string that cannot appear on screen.
 *
 * 2. ORPHANED TRANSLATIONS. A key English has dropped but a locale still carries.
 *    Nothing requests it and there is no English entry to fall back to.
 *
 * 3. STALE TRANSLATIONS. A key whose English text has CHANGED since the
 *    translations were cut. The translation is faithful — to a sentence the
 *    product no longer says. See `staleTranslations()` for why this is worse
 *    than no translation at all.
 *
 * 4. VERBATIM ENGLISH COPIES. A locale entry byte-identical to an English
 *    sentence. That is English text filed as if it were a translation: it makes
 *    the coverage number lie and hides the string from every translator
 *    worklist. See `englishCopies()`.
 *
 * Families 1 and 2 are unreachable; 3 and 4 are reachable but dishonest. All
 * four are fixed the same way — delete the entry, let English fall back — and
 * deleting is safe by construction: chrome.i18n falls back to `default_locale`
 * and i18n.js falls back to its cached English map, so a removed entry renders
 * exactly what it rendered before, minus the lie.
 *
 * Some keys ARE referenced, just not by a literal name — the code builds them
 * from data (`catLabel${PascalCase}`, `diet_${diet}`, `allergen_${name}`,
 * `dietOption_${diet}`). Those prefixes are declared below and are never
 * reported, because a text search cannot see them.
 *
 *   node tools/locale-prune.js            # report only
 *   node tools/locale-prune.js --apply    # remove all four families
 *   node tools/locale-prune.js --baseline # re-record English as reviewed
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const LOCALES_DIR = path.join(EXT, "_locales");

// The English text every surviving translation was cut against, one short digest
// per key. `staleTranslations()` compares it to today's English.
const BASELINE_FILE = path.join(__dirname, "locale-source-baseline.json");

// Key families the code composes at runtime. Each entry is a prefix whose keys
// are looked up dynamically, with the site that does it, so the exemption can be
// re-verified rather than trusted.
const DYNAMIC_PREFIXES = [
  { prefix: "catLabel", site: "settings.js — `catLabel${pascal}`" },
  { prefix: "diet_", site: "warning.js — t(`diet_${entry.diet}`)" },
  { prefix: "dietOption_", site: "preferences.js — t(`dietOption_${value}`)" },
  { prefix: "allergen_", site: "preferences.js — t(`allergen_${value}`)" }
];

// Keys the manifest references via __MSG_name__ rather than in JS.
const MANIFEST_KEYS = ["appName", "appDescription", "actionTitle"];

/**
 * A key written in English AHEAD of the code that will render it.
 *
 * Locale files and page scripts are owned by different people, and a string
 * cannot land in both at once: whoever edits `diagnostics.js` cannot add the
 * message it needs, and whoever writes the message cannot wire it up. Without a
 * way to say so, the two halves deadlock — which is how sixteen customer-visible
 * diagnostics sentences ended up hardcoded in English inside `diagnostics.js`,
 * where no locale could ever reach them.
 *
 * So the English entry declares its consumer in its own `description`:
 *
 *   "description": "… [staged: diagnostics.js]"
 *
 * The marker means exactly one thing — "this key has no reader YET, and the file
 * named is the one that must grow one". It suppresses nothing else: the key is
 * still parity-checked, still placeholder-checked, still offered to translators.
 * `stagedFulfilled()` reports every marker whose consumer has since caught up so
 * the note gets deleted rather than becoming folklore, and `stagedInvalid()`
 * fails outright if a marker names a file that does not exist.
 */
const STAGED_MARKER = /\[staged:\s*([A-Za-z0-9._-]+)\s*\]/;

// key -> the source file that must come to reference it.
function stagedKeys(en) {
  const data = en || english();
  const out = new Map();

  Object.keys(data).forEach((key) => {
    const match = STAGED_MARKER.exec((data[key] && data[key].description) || "");
    if (match) {
      out.set(key, match[1]);
    }
  });

  return out;
}

// A marker naming a file that is not there is a typo, and a typo would silently
// exempt the key forever.
function stagedInvalid() {
  const out = [];

  stagedKeys().forEach((file, key) => {
    if (!fs.existsSync(path.join(EXT, file))) {
      out.push({ key, file });
    }
  });

  return out;
}

// Markers whose consumer already reads the key. The staging did its job; the
// note is now false and should be removed from the English description.
function stagedFulfilled() {
  const blob = sourceBlob();
  const out = [];

  stagedKeys().forEach((file, key) => {
    if (referenced(blob, key)) {
      out.push({ key, file });
    }
  });

  return out;
}

const { isEnglishPhrase } = require("./locale-hybrid-audit.js");

// The locale set every locale tool walks. Shared so two tools can never
// disagree about which locales exist.
const localeCodes = require("./lib/load.js").localeDirs;

function readLocale(code) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, code, "messages.json"), "utf8"));
}

function english() {
  return readLocale("en");
}

/**
 * Remove JavaScript comments, so that PROSE ABOUT a key cannot pass as a use of
 * it.
 *
 * `referenced()` below is a whole-word text match, and a text match cannot tell
 * "the code reads this key" from "a comment explains why the code stopped
 * reading this key". The second is the more common of the two, because deleting
 * a call site is exactly the moment someone writes a paragraph naming what they
 * deleted — and that paragraph then keeps the dead key alive in this audit
 * forever.
 *
 * `mbOn` and `mbOff` are the worked example. Their only surviving mention in
 * `extension/` was the comment at settings.js:1006 recording that the chips had
 * MOVED OFF them onto `mbBlocking`/`mbBlock`. The keys rendered nowhere, yet
 * this tool reported the corpus clean, because the sentence announcing their
 * death was itself the evidence they were alive.
 *
 * Stripping has to be string-aware in both directions:
 *
 *   - a naive `replace(/\/\/.*$/gm, "")` eats `"https://fitshield.net"` and
 *     everything after it on that line, which would silently drop the real
 *     `t("someKey")` calls sharing the line and prune keys that ARE live;
 *   - `extension/fitshield-core.js:1129` contains `/^[a-z][a-z0-9+.-]*:\/\//`,
 *     a regex literal holding two escaped slashes, so regex literals have to be
 *     recognised too or that line loses its tail.
 *
 * Template literals are treated as opaque: a comment inside `${...}` survives.
 * That errs toward keeping a key, which is the safe direction — a false "still
 * referenced" leaves a dead string in the corpus, while a false "unreferenced"
 * deletes a string the product still renders.
 */
function stripJsComments(source) {
  // Characters after which a `/` opens a regex literal rather than dividing.
  const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">", ""]);
  const REGEX_KEYWORDS = /(?:^|[^A-Za-z0-9_$])(return|typeof|instanceof|in|of|new|delete|void|throw|do|else|case|yield|await)$/;

  let out = "";
  let i = 0;
  let prev = "";

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      // Keep the newlines so reported line numbers elsewhere stay meaningful.
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] || "");
          i += 2;
          continue;
        }
        out += source[i];
        const done = source[i] === c;
        i += 1;
        if (done) break;
      }
      prev = c;
      continue;
    }

    if (c === "/" && (REGEX_PRECEDERS.has(prev) || REGEX_KEYWORDS.test(out.replace(/\s+$/, "")))) {
      out += c;
      i += 1;
      let inClass = false;
      while (i < source.length && source[i] !== "\n") {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] || "");
          i += 2;
          continue;
        }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        out += source[i];
        const done = source[i] === "/" && !inClass;
        i += 1;
        if (done) break;
      }
      prev = "/";
      continue;
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }

  return out;
}

// `<!-- … -->` hides prose in markup the same way `//` does in script, and the
// page comments name message keys too (settings.html:1428 discusses
// `avgMealCostLabel`). Script blocks inside a page get the JS treatment.
function stripHtmlComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (all, open, body, close) => open + stripJsComments(body) + close);
}

// The Android WebView UI reads the SAME `_locales` corpus through the same
// `FitShieldI18n.t()`, so a key it alone renders is live. Scanning only
// `extension/` would report every such key as dead and invite a prune that
// blanks the Android screens — the corpus serves both platforms, so both
// platforms have to be searched.
const ANDROID_WEB = path.join(ROOT, "android", "app", "src", "main", "assets", "web");

function readSourceDir(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((name) => /\.(js|html)$/.test(name) && name !== "blocklist.js")
    .map((name) => {
      const source = fs.readFileSync(path.join(dir, name), "utf8");
      return name.endsWith(".html") ? stripHtmlComments(source) : stripJsComments(source);
    });
}

function sourceBlob() {
  const parts = [...readSourceDir(EXT), ...readSourceDir(ANDROID_WEB)];

  // JSON has no comments, so the manifest goes in as written.
  parts.push(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  return parts.join("\n");
}

/**
 * Is `key` referenced by name anywhere in the extension source?
 *
 * Whole-key, not substring. A plain `blob.includes(key)` reports a dead key as
 * live whenever a LONGER key that starts with it is still in use — which is
 * exactly what a rename produces. `warningTriggeredBy` survived that way for a
 * release: the code had moved to `warningTriggeredByPrefix`, the substring
 * matched, and 82 translations of a sentence nothing could render stayed in the
 * corpus. Locale keys are [A-Za-z0-9_], so a \b on each end is sufficient.
 */
function referenced(blob, key) {
  return new RegExp(`\\b${key}\\b`).test(blob);
}

function unusedKeys() {
  const en = english();
  const blob = sourceBlob();
  const staged = stagedKeys(en);

  return Object.keys(en).filter((key) => {
    if (MANIFEST_KEYS.includes(key)) return false;
    if (DYNAMIC_PREFIXES.some((entry) => key.startsWith(entry.prefix))) return false;
    if (staged.has(key)) return false;
    return !referenced(blob, key);
  });
}

/**
 * Keys a translation still carries that English has dropped.
 *
 * These are the *other* half of the same problem. When a string's meaning
 * changes, the honest move is a new key — a locale keeping the old translation
 * would otherwise render text that describes behaviour the product no longer
 * has, in 82 languages, while English reads correctly. So the old key leaves
 * English, and every translation of it becomes unreachable: nothing requests
 * it, and there is no English entry to fall back to.
 *
 * Unreachable is not harmless. `tools/locale-parity.js` fails the build on
 * them, and until they are gone the failure hides real parity problems.
 *
 * @returns {Map<string, string[]>} locale code -> the keys English no longer has
 */
function orphanedKeys() {
  const en = english();
  const out = new Map();

  localeCodes().forEach((code) => {
    if (code === "en") {
      return;
    }

    const data = readLocale(code);
    const extra = Object.keys(data).filter((key) => !Object.prototype.hasOwnProperty.call(en, key));

    if (extra.length > 0) {
      out.set(code, extra);
    }
  });

  return out;
}

// --- The English source baseline ------------------------------------------

/**
 * The digest that decides whether a translation has outlived its source.
 *
 * Deliberately case-INSENSITIVE, and only case-insensitive.
 *
 * The question this guard exists to answer is "does the English still SAY what
 * it said when this was translated?". Letter case is not part of what a sentence
 * says — it is an English house-style choice, and every other language applies
 * its own capitalisation rules regardless of ours. German capitalises every
 * noun; French sentence-cases headings whatever English does. So "Your Stats" ->
 * "Your stats" invalidates no translation anywhere, and treating it as a rewrite
 * would have deleted roughly 1,400 genuine translations across eighteen keys the
 * one time this repository restyled its headings — real human work destroyed to
 * record a change of capital letter.
 *
 * Everything else still counts. A single changed word, a dropped clause, a moved
 * placeholder, added punctuation: all of those change the digest and raise the
 * stale-translation error, which is the failure `learnMoreLink` shipped without.
 */
function digest(text) {
  return crypto.createHash("sha1").update(String(text).toLowerCase(), "utf8").digest("hex").slice(0, 12);
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) {
    return {};
  }
  const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  return parsed.keys || {};
}

// Record the English text `only` (or all of it) as what the translations in the
// corpus were cut against. Passing a key list is how a freshly merged worklist
// says "these were translated from today's English" without vouching for keys it
// did not touch.
function writeBaseline(only) {
  const en = english();
  const keys = only ? readBaseline() : {};

  (only || Object.keys(en)).forEach((key) => {
    if (en[key]) {
      keys[key] = digest(en[key].message);
    }
  });

  const sorted = {};
  Object.keys(keys)
    .sort()
    .forEach((key) => {
      sorted[key] = keys[key];
    });

  return saveBaseline(sorted);
}

function saveBaseline(keys) {
  fs.writeFileSync(
    BASELINE_FILE,
    JSON.stringify(
      {
        _note:
          "The English text every surviving translation was cut against, as a short digest per key. " +
          "When an English string changes, its digest changes and tools/locale-parity.js fails for every " +
          "locale still shipping a translation of the old wording — the failure that `learnMoreLink` " +
          "(\"Visit fitshield.net\") went a whole release without. Fix by re-translating the key or by " +
          "running `node tools/locale-prune.js --apply`, which drops the stale translations and re-records " +
          "this file. Never edit it by hand to silence a failure.",
        _regenerate: "node tools/locale-prune.js --baseline",
        keys
      },
      null,
      2
    ) + "\n"
  );

  return Object.keys(keys).length;
}

/**
 * Translations of English text that has since changed.
 *
 * A translation is only correct relative to the sentence it was made from. When
 * the English changes and the translations do not, every locale keeps saying the
 * old thing — and unlike an untranslated key, this cannot heal, because the key
 * IS defined and so neither fallback path can substitute the current English.
 * The result is a permanent divergence the parity gate cannot see: 82 locales
 * rendering copy the product retired.
 *
 * `learnMoreLink` is the worked example. English moved from "Visit
 * fitshield.net" to "About FitShield"; all 82 locales kept the old English
 * verbatim, so every non-English block page ended with an instruction the
 * English build no longer gave.
 *
 * @returns {Map<string, string[]>} key -> locales still translating the old text
 */
function staleTranslations() {
  const en = english();
  const baseline = readBaseline();
  const out = new Map();

  const drifted = Object.keys(en).filter((key) => baseline[key] && baseline[key] !== digest(en[key].message));

  if (drifted.length === 0) {
    return out;
  }

  const others = localeCodes().filter((code) => code !== "en");
  const loaded = others.map((code) => [code, readLocale(code)]);

  drifted.forEach((key) => {
    const holders = loaded.filter(([, data]) => Object.prototype.hasOwnProperty.call(data, key)).map(([code]) => code);

    if (holders.length > 0) {
      out.set(key, holders);
    }
  });

  return out;
}

/**
 * Locale entries that are byte-identical to an English SENTENCE.
 *
 * A locale file saying `"appDescription": "FitShield browser extension that
 * helps you stay mindful of…"` in Dutch is not a Dutch translation; it is
 * English filed under a Dutch key. It renders exactly as the fallback would, so
 * it buys nothing, and it costs two real things: the coverage figure counts it
 * as translated, and `locale-status.js --todo` never offers it to a translator
 * because the key is already "done".
 *
 * Only PROSE is reported (see `isEnglishPhrase`). Names and loanwords are
 * legitimately identical — Italian really does call it "Pizza", every locale
 * really does call the product "FitShield" — and flagging those would demand
 * that translators invent differences.
 *
 * @returns {Map<string, string[]>} key -> locales that copied the English
 */
function englishCopies() {
  const en = english();
  const phrases = Object.keys(en).filter((key) => isEnglishPhrase(en[key].message));
  const out = new Map();

  localeCodes().forEach((code) => {
    if (code === "en") return;
    const data = readLocale(code);

    phrases.forEach((key) => {
      if (data[key] && data[key].message === en[key].message) {
        out.set(key, [...(out.get(key) || []), code]);
      }
    });
  });

  return out;
}

// Re-verify each declared dynamic prefix still has a construction site, so the
// exemption list cannot quietly outlive the code that justified it.
function staleExemptions() {
  const blob = sourceBlob();
  return DYNAMIC_PREFIXES.filter((entry) => !blob.includes("`" + entry.prefix)).map((entry) => entry.prefix);
}

// Remove `keys` from every locale, English included. For keys that are dead
// everywhere (families 1 and 2).
function prune(keys) {
  let touched = 0;
  let removed = 0;

  localeCodes().forEach((code) => {
    const file = path.join(LOCALES_DIR, code, "messages.json");
    const data = readLocale(code);
    let changed = 0;

    keys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        delete data[key];
        changed += 1;
      }
    });

    if (changed > 0) {
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
      touched += 1;
      removed += changed;
    }
  });

  return { touched, removed };
}

// Remove specific keys from specific locales, never from English. For families 3
// and 4, where the English entry is correct and only the translations are not.
function pruneTranslations(byKey) {
  const byLocale = new Map();

  byKey.forEach((codes, key) => {
    codes.forEach((code) => {
      if (code === "en") return;
      byLocale.set(code, [...(byLocale.get(code) || []), key]);
    });
  });

  let removed = 0;

  byLocale.forEach((keys, code) => {
    const file = path.join(LOCALES_DIR, code, "messages.json");
    const data = readLocale(code);

    keys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        delete data[key];
        removed += 1;
      }
    });

    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  });

  return { touched: byLocale.size, removed };
}

function total(map) {
  let n = 0;
  map.forEach((list) => {
    n += list.length;
  });
  return n;
}

if (require.main === module) {
  if (process.argv.includes("--baseline")) {
    const n = writeBaseline();
    console.log(`Recorded ${n} English string(s) as the translation baseline.`);
    process.exit(0);
  }

  const stale = staleExemptions();

  if (stale.length > 0) {
    console.error(
      `These dynamic-key prefixes are exempted but no construction site remains: ${stale.join(", ")}.\n` +
        "Remove the exemption from DYNAMIC_PREFIXES so their keys can be pruned."
    );
    process.exit(1);
  }

  const badMarkers = stagedInvalid();

  if (badMarkers.length > 0) {
    console.error(
      "These [staged: …] markers name a file that does not exist in extension/:\n" +
        badMarkers.map((entry) => `  ${entry.key} -> ${entry.file}`).join("\n")
    );
    process.exit(1);
  }

  const pending = stagedKeys();
  const fulfilled = stagedFulfilled();

  if (pending.size > 0) {
    console.log(`${pending.size} English key(s) staged for a page script that does not read them yet:`);
    pending.forEach((file, key) => console.log(`  ${key.padEnd(28)} -> ${file}`));
    console.log("");
  }

  if (fulfilled.length > 0) {
    console.log(`${fulfilled.length} staged key(s) whose consumer has caught up — delete the [staged: …] note:`);
    fulfilled.forEach((entry) => console.log(`  ${entry.key.padEnd(28)} ${entry.file} now references it`));
    console.log("");
  }

  const keys = unusedKeys();
  const orphans = orphanedKeys();
  const changed = staleTranslations();
  const copies = englishCopies();
  // Unreachable in both directions; reported separately, pruned together.
  const orphanNames = [...new Set([...orphans.values()].flat())].sort();

  if (keys.length === 0 && orphanNames.length === 0 && changed.size === 0 && copies.size === 0) {
    console.log("Nothing to prune: no unreferenced, orphaned, stale, or copied locale entries.");
    process.exit(0);
  }

  if (keys.length > 0) {
    console.log(`${keys.length} key(s) in English that no source file references:`);
    keys.forEach((key) => console.log(`  ${key}`));
  }

  if (orphanNames.length > 0) {
    console.log(
      `${orphanNames.length} key(s) English has dropped, still translated in ${orphans.size} locale(s):`
    );
    orphanNames.forEach((key) => console.log(`  ${key}`));
  }

  if (changed.size > 0) {
    console.log(`\n${changed.size} key(s) whose English text changed after the translations were cut:`);
    changed.forEach((codes, key) => console.log(`  ${key.padEnd(28)} ${codes.length} stale translation(s)`));
  }

  if (copies.size > 0) {
    console.log(`\n${copies.size} key(s) filed as translated but byte-identical to the English sentence:`);
    copies.forEach((codes, key) => console.log(`  ${key.padEnd(28)} ${codes.length} locale(s)`));
  }

  if (!process.argv.includes("--apply")) {
    console.log("\nRe-run with --apply to remove them (every one falls back to English).");
    process.exit(0);
  }

  const dead = prune([...keys, ...orphanNames]);
  const staleDrop = pruneTranslations(changed);
  const copyDrop = pruneTranslations(copies);
  const recorded = writeBaseline();

  console.log(
    `\nRemoved ${dead.removed} dead entr(ies) across ${dead.touched} file(s), ` +
      `${staleDrop.removed} stale translation(s), ${copyDrop.removed} English copy(ies). ` +
      `Baseline re-recorded (${recorded} keys). Run \`npm run sync\`.`
  );
}

module.exports = {
  unusedKeys,
  orphanedKeys,
  staleTranslations,
  englishCopies,
  staleExemptions,
  stagedKeys,
  stagedInvalid,
  stagedFulfilled,
  STAGED_MARKER,
  prune,
  pruneTranslations,
  readBaseline,
  writeBaseline,
  referenced,
  sourceBlob,
  stripJsComments,
  stripHtmlComments,
  digest,
  total,
  BASELINE_FILE,
  DYNAMIC_PREFIXES
};
