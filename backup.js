/**
 * FitShield settings backup / restore.
 *
 * One JSON file holds every setting from chrome.storage.local. Export writes a
 * download; import reads a file back into storage. Entirely local — no network.
 *
 * The parsing/validation helpers are pure so they can be unit-tested in Node;
 * the download/storage helpers are browser-only.
 */
(function (global) {
  "use strict";

  const FILE_NAME = "fitshield-settings.json";
  const BACKUP_TYPE = "fitshield-settings-backup";

  function getVersion() {
    try {
      return (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest().version
        : "";
    } catch (error) {
      return "";
    }
  }

  // Pull every stored setting into a wrapped, self-describing backup object.
  async function collectBackup() {
    const settings = await chrome.storage.local.get(null);
    return {
      _type: BACKUP_TYPE,
      version: getVersion(),
      exportedAt: new Date().toISOString(),
      settings
    };
  }

  // Pure: validate a parsed object and return the settings map. Accepts both the
  // wrapped { settings: {...} } form and a bare settings object.
  function extractSettings(parsed) {
    const isPlainObject = (value) =>
      value && typeof value === "object" && !Array.isArray(value);

    if (!isPlainObject(parsed)) {
      throw new Error("Not a FitShield backup.");
    }

    const settings = isPlainObject(parsed.settings) ? parsed.settings : parsed;

    if (!isPlainObject(settings)) {
      throw new Error("Not a FitShield backup.");
    }

    return settings;
  }

  // Pure: parse JSON text into a validated settings map.
  function parseBackup(text) {
    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error("That file isn't valid JSON.");
    }

    return extractSettings(parsed);
  }

  // Browser: trigger a download of the current settings.
  async function downloadBackup() {
    const data = await collectBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = FILE_NAME;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // Browser: parse a file's text and write it into storage. Returns the count of
  // settings restored.
  async function importFromText(text) {
    const settings = parseBackup(text);
    await chrome.storage.local.set(settings);
    return Object.keys(settings).length;
  }

  const api = {
    FILE_NAME,
    BACKUP_TYPE,
    collectBackup,
    extractSettings,
    parseBackup,
    downloadBackup,
    importFromText
  };

  global.FitShieldBackup = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
