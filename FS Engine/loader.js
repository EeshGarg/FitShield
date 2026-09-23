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

// Cache of the most recently loaded entries (see _cachedEntries / index.js).
let loadedEntries = [];

// Resolve the WebExtension runtime from whichever namespace the engine is loaded
// under: `chrome` (Chrome/Brave/Edge, and also exposed by Firefox) or `browser`
// (the WebExtension standard, some Firefox contexts). Either lets the engine
// fetch its datasets by extension-relative URL, so the same bundle runs on every
// supported browser; in Node both are absent and we read from disk.
const webextRuntime =
  (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function")
    ? chrome.runtime
    : (typeof browser !== "undefined" && browser.runtime && typeof browser.runtime.getURL === "function")
      ? browser.runtime
      : null;

const isExtension = webextRuntime !== null;

async function readBlocklistFile(relativePath, options) {
  if (isExtension) {
    const response = await fetch(webextRuntime.getURL(relativePath));

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
// In an extension the datasets are immutable files at fixed extension-relative
// paths, so loading them twice in one page can only ever produce the same list.
// It was producing it twice: the settings page calls loadBlocklists from two
// independent initializers, which meant fetching and JSON.parsing 814 KB twice on
// one page load. Held as the promise, so two concurrent callers share one read.
//
// Node is deliberately NOT cached: `dataDir` is a per-call argument there, and
// the tooling loads different datasets in one process.
let extensionLoadPromise = null;

async function loadBlocklists(options) {
  if (isExtension) {
    if (!extensionLoadPromise) {
      extensionLoadPromise = readAllBlocklists(options).catch((error) => {
        extensionLoadPromise = null; // a failed load must not be remembered
        throw error;
      });
    }

    return extensionLoadPromise;
  }

  return readAllBlocklists(options);
}

async function readAllBlocklists(options) {
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

// Internal: raw (uncopied) cache reference for index.js's default wrappers.
function _cachedEntries() {
  return loadedEntries;
}

module.exports = { BLOCKLIST_FILES, loadBlocklists, _cachedEntries };
