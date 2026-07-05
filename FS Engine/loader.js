"use strict";
/**
 * FS Engine — dataset loading (the only module that touches I/O or state).
 *
 * Works in two environments without a build step:
 *   - A browser extension: JSON is read with fetch(chrome.runtime.getURL(...)),
 *     so BLOCKLIST_FILES paths are resolved against the extension root.
 *   - Node.js: JSON is read from disk. Paths are resolved against a data
 *     directory — by default the repo's `data/` folder next to "FS Engine/",
 *     overridable per call with `loadBlocklists({ dataDir })`.
 *
 * The loader reads ONLY the `entries` array of each JSON file and ignores all
 * top-level metadata (`_schema`, `_version`, `_lastUpdated`, and anything else).
 * It also keeps a cache of the most recently loaded entries so the index.js
 * convenience wrappers can be called without threading the list everywhere.
 */

// Relative to the data directory (Node) / the extension root (browser).
const BLOCKLIST_FILES = ["blocklists/fast-food.json", "blocklists/delivery.json"];

// Cache of the most recently loaded entries (see getLoadedEntries / index.js).
let loadedEntries = [];

const isExtension =
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  typeof chrome.runtime.getURL === "function";

async function readBlocklistFile(relativePath, options) {
  if (isExtension) {
    const response = await fetch(chrome.runtime.getURL(relativePath));

    if (!response.ok) {
      throw new Error(`Failed to load ${relativePath}: ${response.status}`);
    }

    return response.json();
  }

  // Node.js fallback (tests / tooling). The engine ships no data of its own:
  // point dataDir anywhere a FitShield-shaped dataset lives.
  const fs = require("fs");
  const path = require("path");
  const dataDir = (options && options.dataDir) || path.join(__dirname, "..", "data");
  return JSON.parse(fs.readFileSync(path.join(dataDir, relativePath), "utf8"));
}

/**
 * Load every blocklist file and flatten their `entries` arrays into one list.
 * Top-level metadata keys are deliberately ignored.
 *
 * @param {object} [options] - { dataDir } (Node only; ignored in extensions)
 */
async function loadBlocklists(options) {
  const datasets = await Promise.all(
    BLOCKLIST_FILES.map((file) => readBlocklistFile(file, options))
  );
  const entries = [];

  datasets.forEach((data) => {
    if (data && Array.isArray(data.entries)) {
      data.entries.forEach((entry) => {
        if (entry && typeof entry === "object") {
          entries.push(entry);
        }
      });
    }
  });

  loadedEntries = entries;
  return entries;
}

/** A copy of the most recently loaded entries (empty before the first load). */
function getLoadedEntries() {
  return loadedEntries.slice();
}

// Internal: raw (uncopied) cache reference for index.js's default wrappers.
function _cachedEntries() {
  return loadedEntries;
}

module.exports = { BLOCKLIST_FILES, loadBlocklists, getLoadedEntries, _cachedEntries };
