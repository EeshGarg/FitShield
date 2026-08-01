#!/usr/bin/env node
"use strict";
/**
 * Find (and optionally remove) locale keys no source file can ever display.
 *
 * A key that nothing references is not harmless: it is shipped in 83 files, it
 * shows up in translator worklists, and someone will spend real effort
 * translating a string that cannot appear on screen.
 *
 * Some keys ARE referenced, just not by a literal name — the code builds them
 * from data (`catLabel${PascalCase}`, `diet_${diet}`, `allergen_${name}`,
 * `dietOption_${diet}`). Those prefixes are declared below and are never
 * reported, because a text search cannot see them.
 *
 *   node tools/locale-prune.js            # report only
 *   node tools/locale-prune.js --apply    # remove them from every locale
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const LOCALES_DIR = path.join(EXT, "_locales");

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

function sourceBlob() {
  const parts = fs
    .readdirSync(EXT)
    .filter((name) => /\.(js|html)$/.test(name) && name !== "blocklist.js")
    .map((name) => fs.readFileSync(path.join(EXT, name), "utf8"));

  parts.push(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  return parts.join("\n");
}

function unusedKeys() {
  const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "en", "messages.json"), "utf8"));
  const blob = sourceBlob();

  return Object.keys(en).filter((key) => {
    if (MANIFEST_KEYS.includes(key)) return false;
    if (DYNAMIC_PREFIXES.some((entry) => key.startsWith(entry.prefix))) return false;
    return !blob.includes(key);
  });
}

// Re-verify each declared dynamic prefix still has a construction site, so the
// exemption list cannot quietly outlive the code that justified it.
function staleExemptions() {
  const blob = sourceBlob();
  return DYNAMIC_PREFIXES.filter((entry) => !blob.includes("`" + entry.prefix)).map((entry) => entry.prefix);
}

function localeCodes() {
  return fs
    .readdirSync(LOCALES_DIR)
    .filter((code) => fs.existsSync(path.join(LOCALES_DIR, code, "messages.json")))
    .sort();
}

function prune(keys) {
  let touched = 0;
  let removed = 0;

  localeCodes().forEach((code) => {
    const file = path.join(LOCALES_DIR, code, "messages.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
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

if (require.main === module) {
  const stale = staleExemptions();

  if (stale.length > 0) {
    console.error(
      `These dynamic-key prefixes are exempted but no construction site remains: ${stale.join(", ")}.\n` +
        "Remove the exemption from DYNAMIC_PREFIXES so their keys can be pruned."
    );
    process.exit(1);
  }

  const keys = unusedKeys();

  if (keys.length === 0) {
    console.log("No unreferenced locale keys.");
    process.exit(0);
  }

  console.log(`${keys.length} unreferenced key(s):`);
  keys.forEach((key) => console.log(`  ${key}`));

  if (!process.argv.includes("--apply")) {
    console.log("\nRe-run with --apply to remove them from every locale.");
    process.exit(0);
  }

  const { touched, removed } = prune(keys);
  console.log(`\nRemoved ${removed} entries across ${touched} locale file(s). Run \`npm run sync\`.`);
}

module.exports = { unusedKeys, staleExemptions, prune, DYNAMIC_PREFIXES };
