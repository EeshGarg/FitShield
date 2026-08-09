#!/usr/bin/env node
"use strict";
/**
 * Translation status and translator worklists.
 *
 * English is the source of truth and must be complete. Every other locale may be
 * partial: a key it does not define falls back to English at runtime, in both
 * paths (`chrome.i18n` falls back to `default_locale`, and `i18n.js` falls back
 * to its cached English map). So an untranslated string renders in English
 * rather than blank — correct, but still debt, and debt is only manageable if it
 * is measured.
 *
 * This tool measures it and turns it into something a translator can actually
 * work from, instead of asking them to diff two JSON files by hand.
 *
 *   node tools/locale-status.js                 # coverage table, worst first
 *   node tools/locale-status.js --locale de     # what German is missing
 *   node tools/locale-status.js --todo de       # write one worklist file
 *   node tools/locale-status.js --todo-all      # write a worklist for every locale
 *   node tools/locale-status.js --merge de <file>   # merge a completed worklist back
 *
 * Worklists are written to translations/<locale>.todo.json (git-ignored) as:
 *
 *   { "locale": "de", "missing": 201,
 *     "strings": { "keyName": { "english": "…", "translation": "", "note": "…" } } }
 *
 * A translator fills in `translation` and hands the file back; --merge writes the
 * non-empty ones into extension/_locales/<locale>/messages.json, leaving
 * everything else untouched. It refuses three things: a lost or invented
 * placeholder, Chrome's $name$ syntax, and the English sentence handed back
 * verbatim — the last one because it renders exactly like the fallback while
 * marking the string translated, so nobody is ever asked to translate it again.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOCALES_DIR = path.join(ROOT, "extension", "_locales");
const TODO_DIR = path.join(ROOT, "translations");

// Where a string appears, so a translator knows the context and the space it has
// to fit into. Derived from the key prefix, which this codebase keys by surface.
const SURFACES = [
  [/^warning|^block|^timer|^intent|^alternative|^filter|^pass|^kind|^why|^relaxed|^diet_|^time|^active|^servings|^contains|^optional|^substitutions|^preview/, "block page"],
  [/^popup|^status|^onboarding|^welcome/, "popup / onboarding"],
  [/^friction|^schedule|^day|^kitchen|^pantry|^equipment|^allergen|^customAlt|^recap|^report/, "settings"],
  [/^stats|^catLabel|^protection/, "statistics"],
  [/^language/, "language picker"],
  [/^whatsNew|^changelog/, "what's new"]
];

function surfaceFor(key) {
  const hit = SURFACES.find(([pattern]) => pattern.test(key));
  return hit ? hit[1] : "shared";
}

function readLocale(code) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, code, "messages.json"), "utf8"));
}

// The locale set every locale tool walks. Shared so two tools can never
// disagree about which locales exist.
const localeCodes = require("./lib/load.js").localeDirs;
const prune = require("./locale-prune.js");
const { isEnglishPhrase } = require("./locale-hybrid-audit.js");

function status() {
  const en = readLocale("en");
  const enKeys = Object.keys(en);

  const rows = localeCodes()
    .filter((code) => code !== "en")
    .map((code) => {
      const data = readLocale(code);
      const missing = enKeys.filter((key) => !Object.prototype.hasOwnProperty.call(data, key));
      return {
        code,
        translated: enKeys.length - missing.length,
        missing: missing.length,
        percent: Math.round(((enKeys.length - missing.length) / enKeys.length) * 100),
        missingKeys: missing
      };
    });

  return { enKeys, rows };
}

function printStatus(filter) {
  const { enKeys, rows } = status();
  const shown = filter ? rows.filter((row) => row.code === filter) : rows;

  if (filter && shown.length === 0) {
    console.error(`No such locale: ${filter}`);
    process.exit(1);
  }

  console.log(`English source: ${enKeys.length} keys across ${localeCodes().length} locales\n`);

  if (filter) {
    const row = shown[0];
    console.log(`${row.code}: ${row.percent}% (${row.translated}/${enKeys.length}), ${row.missing} missing\n`);

    const bySurface = new Map();
    row.missingKeys.forEach((key) => {
      const surface = surfaceFor(key);
      bySurface.set(surface, [...(bySurface.get(surface) || []), key]);
    });

    [...bySurface.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .forEach(([surface, keys]) => {
        console.log(`  ${surface} (${keys.length})`);
        keys.forEach((key) => console.log(`    ${key}`));
      });
    return;
  }

  const complete = rows.filter((row) => row.missing === 0);
  const partial = rows.filter((row) => row.missing > 0).sort((a, b) => a.percent - b.percent);

  console.log(`${complete.length} locale(s) complete · ${partial.length} partial\n`);

  if (partial.length > 0) {
    console.log("  locale    translated   missing   coverage");
    partial.forEach((row) => {
      const bar = "#".repeat(Math.round(row.percent / 5)).padEnd(20, ".");
      console.log(
        `  ${row.code.padEnd(8)}  ${String(row.translated).padStart(9)}   ${String(row.missing).padStart(7)}   ${bar} ${row.percent}%`
      );
    });
  }

  // Which surfaces carry the most untranslated text, aggregated across locales —
  // the practical answer to "what should be translated first?".
  const surfaceTotals = new Map();
  partial.forEach((row) => {
    row.missingKeys.forEach((key) => {
      const surface = surfaceFor(key);
      surfaceTotals.set(surface, (surfaceTotals.get(surface) || 0) + 1);
    });
  });

  if (surfaceTotals.size > 0) {
    console.log("\n  Untranslated strings by surface (all locales):");
    [...surfaceTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([surface, count]) => console.log(`    ${surface.padEnd(20)} ${count}`));
  }

  console.log("\n  Untranslated strings render in English — nothing is blank or broken.");
  console.log("  Write a worklist with:  node tools/locale-status.js --todo <locale>");
}

function writeTodo(code) {
  const en = readLocale("en");
  const { rows } = status();
  const row = rows.find((item) => item.code === code);

  if (!row) {
    console.error(`No such locale: ${code}`);
    process.exit(1);
  }

  if (row.missing === 0) {
    console.log(`${code} is already complete — nothing to do.`);
    return null;
  }

  const strings = {};
  row.missingKeys.forEach((key) => {
    strings[key] = {
      english: en[key].message,
      translation: "",
      surface: surfaceFor(key),
      // Positional placeholders MUST survive translation or the string renders
      // with holes. Spelling them out here is cheaper than explaining it later.
      placeholders: (en[key].message.match(/\$[1-9]/g) || []).join(" ") || "none"
    };
  });

  fs.mkdirSync(TODO_DIR, { recursive: true });
  const file = path.join(TODO_DIR, `${code}.todo.json`);

  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        _instructions:
          "Fill in each `translation`. Leave one empty to skip it — it will keep falling back to English, " +
          "which is a supported state; copying the English sentence into the box is NOT, and will be refused. " +
          "Any $1..$9 placeholders listed must appear in your translation too, in whatever order the language needs. " +
          "Do not translate the key names. Hand this file back and run: node tools/locale-status.js --merge " + code + " <file>",
        locale: code,
        missing: row.missing,
        strings
      },
      null,
      2
    ) + "\n"
  );

  console.log(`Wrote ${path.relative(ROOT, file)} — ${row.missing} string(s) for ${code}.`);
  return file;
}

function merge(code, file) {
  const en = readLocale("en");
  const target = path.join(LOCALES_DIR, code, "messages.json");

  if (!fs.existsSync(target)) {
    console.error(`No such locale: ${code}`);
    process.exit(1);
  }

  const worklist = JSON.parse(fs.readFileSync(file, "utf8"));
  const existing = readLocale(code);
  const positional = (text) => (String(text).match(/\$[1-9]/g) || []).sort().join(",");

  let merged = 0;
  const rejected = [];
  const mergedKeys = [];

  Object.entries(worklist.strings || {}).forEach(([key, entry]) => {
    const translation = String((entry && entry.translation) || "").trim();

    if (!translation) {
      return;
    }

    if (!en[key]) {
      rejected.push(`${key}: not an English key`);
      return;
    }

    // A translation that loses or invents a placeholder renders broken, so it is
    // refused rather than merged.
    if (positional(translation) !== positional(en[key].message)) {
      rejected.push(`${key}: placeholders differ from English (${positional(en[key].message) || "none"})`);
      return;
    }

    if (/\$[A-Za-z0-9_@]+\$/.test(translation)) {
      rejected.push(`${key}: uses Chrome's named-placeholder syntax, which will not load`);
      return;
    }

    // The English sentence handed back unchanged is not a translation. Merging
    // it would render identically to the fallback while marking the key done, so
    // the string would never be offered to a translator again.
    if (translation === en[key].message && isEnglishPhrase(en[key].message)) {
      rejected.push(`${key}: identical to the English sentence — leave it empty and it falls back to English`);
      return;
    }

    existing[key] = { message: translation };
    mergedKeys.push(key);
    merged += 1;
  });

  // Preserve English key order so the diff is reviewable.
  const ordered = {};
  Object.keys(en).forEach((key) => {
    if (existing[key]) {
      ordered[key] = existing[key];
    }
  });

  if (rejected.length > 0) {
    console.error(`Refused ${rejected.length} string(s):`);
    rejected.forEach((reason) => console.error(`  ${reason}`));
  }

  if (merged === 0) {
    console.log("Nothing merged.");
    return;
  }

  fs.writeFileSync(target, JSON.stringify(ordered, null, 2) + "\n");
  // These strings were translated from the English that is in the tree right
  // now, so record it. Without this, the next English edit to one of them would
  // be indistinguishable from an edit made before the translation existed.
  prune.writeBaseline(mergedKeys);
  console.log(`Merged ${merged} string(s) into ${code}. Run \`npm run validate:locales\` and \`npm run sync\`.`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1] || true;
  };

  if (argv.includes("--todo-all")) {
    const { rows } = status();
    const written = rows.filter((row) => row.missing > 0).map((row) => writeTodo(row.code)).filter(Boolean);
    console.log(`\n${written.length} worklist(s) in translations/.`);
  } else if (flag("--merge")) {
    const code = flag("--merge");
    const file = argv[argv.indexOf("--merge") + 2];

    if (!file) {
      console.error("Usage: node tools/locale-status.js --merge <locale> <file>");
      process.exit(1);
    }

    merge(code, file);
  } else if (flag("--todo")) {
    writeTodo(flag("--todo"));
  } else {
    printStatus(flag("--locale") || null);
  }
}

module.exports = { status, surfaceFor, writeTodo, merge };
