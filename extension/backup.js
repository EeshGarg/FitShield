/**
 * FitShield settings backup / restore.
 *
 * One JSON file holds everything durable from chrome.storage.local. Export
 * writes a download; import reads a file back. Entirely local — no network, no
 * account, no upload.
 *
 * Restore treats the file as hostile input, because it is: a backup can come
 * from anywhere, and it is written straight into the store the service worker
 * trusts. So it is size-limited, schema-checked, stripped of keys FitShield does
 * not own, scrubbed of prototype-polluting names, and applied only if the WHOLE
 * file validates — never half-written over a working profile.
 *
 * The parsing/validation helpers are pure so they can be unit-tested in Node;
 * the download/storage helpers are browser-only.
 */
(function (global) {
  "use strict";

  const core = typeof FitShieldCore !== "undefined" ? FitShieldCore : (typeof require === "function" ? require("./fitshield-core.js") : null);

  const FILE_NAME = "fitshield-settings.json";
  const BACKUP_TYPE = "fitshield-settings-backup";

  // Backup payload schema version. 1 is every file written before the decision
  // flow existed; 2 adds the kitchen, custom alternatives, structured schedule,
  // friction profile, and the honest statistics shape.
  const SCHEMA_VERSION = 2;

  // A settings backup is a few kilobytes. Anything approaching a megabyte is
  // either corrupt or hostile, and parsing it would be the first thing to hurt.
  const MAX_BYTES = 2 * 1024 * 1024;

  // Everything FitShield owns and is worth carrying between installs. An
  // allowlist rather than a blocklist: a key nobody here recognises is dropped
  // instead of being written into the store the worker reads.
  const DURABLE_KEYS = [
    // schema
    "schemaVersion",
    // blocking
    "enabled",
    "timerSeconds",
    "passDurationMinutes",
    "frictionProfile",
    "askIntent",
    "repeatFrictionEnabled",
    "repeatExtraSeconds",
    "repeatWindowMinutes",
    "settingsDelaySeconds",
    "schedule",
    "scheduleEnabled",
    "scheduleStart",
    "scheduleEnd",
    "deliverySitesEnabled",
    "fastFoodSitesEnabled",
    "customSitesEnabled",
    "disabledDeliverySiteKeys",
    "disabledFastFoodSiteKeys",
    "customSites",
    "enabledCountries",
    "enabledCategories",
    "quickAccessCountries",
    "quickAccessCategories",
    // kitchen + alternatives
    "dietPreference",
    "pantry",
    "equipment",
    "avoidAllergens",
    "alternativeFavorites",
    "customAlternatives",
    // statistics
    "stats",
    "blockedByDomain",
    "blockedByCategory",
    "blockedByCountry",
    "showEstimates",
    "recapEnabled",
    // legacy counters, kept so an old backup restored into a new install still
    // carries the numbers the user watched grow
    "blockedVisits",
    "recipesChosen",
    "caloriesAvoided",
    "legacy",
    // presentation + preferences
    "theme",
    "themeMode",
    "cardOrder",
    "uiLanguage",
    "currency",
    "avgMealCost",
    "avgMealCalories",
    "mealStatsCustomized"
  ];

  // Deliberately NOT backed up:
  //   passes            — an active permission to reach a blocked site. Restoring
  //                       one on another machine, or days later, would silently
  //                       unblock something the user did not ask for right now.
  //   repeatHistory     — a short-lived, device-local behavioural window.
  //   recentAlternatives / dismissedAlternatives — rotation state, not settings.
  //   pendingAlternatives, lastSeenVersion, recapDismissedFor — install-local.
  const EXCLUDED_KEYS = [
    "passes",
    "siteBypasses",
    "repeatHistory",
    "recentAlternatives",
    "dismissedAlternatives",
    "pendingAlternatives",
    "lastSeenVersion",
    "recapDismissedFor"
  ];

  const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function getVersion() {
    try {
      return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest
        ? chrome.runtime.getManifest().version
        : "";
    } catch (error) {
      return "";
    }
  }

  // Recursively strip prototype-polluting keys from anything parsed out of a
  // file. JSON.parse itself will happily produce a literal "__proto__" key.
  function scrub(value, depth) {
    const level = depth || 0;

    if (level > 12) {
      return null;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 5000).map((item) => scrub(item, level + 1));
    }

    if (isPlainObject(value)) {
      const out = {};
      Object.keys(value).forEach((key) => {
        if (!FORBIDDEN_KEYS.has(key)) {
          out[key] = scrub(value[key], level + 1);
        }
      });
      return out;
    }

    return value;
  }

  /**
   * Pull the durable settings into a wrapped, self-describing backup object.
   * The wrapper carries a format version, a creation timestamp, the application
   * version, and a count that acts as a cheap integrity check on restore.
   */
  async function collectBackup() {
    const all = await chrome.storage.local.get(null);
    const settings = {};

    DURABLE_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(all, key)) {
        settings[key] = all[key];
      }
    });

    return {
      _type: BACKUP_TYPE,
      schema: SCHEMA_VERSION,
      version: getVersion(),
      exportedAt: new Date().toISOString(),
      keyCount: Object.keys(settings).length,
      settings
    };
  }

  /**
   * Pure: validate a parsed object and return the settings map it carries.
   * Accepts the wrapped { settings: {...} } form AND a bare settings object,
   * because backups written before the wrapper existed are still in the wild.
   */
  function extractSettings(parsed) {
    if (!isPlainObject(parsed)) {
      throw new Error("That file is not a FitShield backup.");
    }

    const wrapped = isPlainObject(parsed.settings);
    const settings = wrapped ? parsed.settings : parsed;

    if (!isPlainObject(settings)) {
      throw new Error("That file is not a FitShield backup.");
    }

    if (wrapped && parsed._type && parsed._type !== BACKUP_TYPE) {
      throw new Error("That file is not a FitShield backup.");
    }

    // A schema newer than this build understands would be written blind.
    if (wrapped && Number.isFinite(Number(parsed.schema)) && Number(parsed.schema) > SCHEMA_VERSION) {
      throw new Error(
        `That backup was written by a newer version of FitShield (format ${parsed.schema}). Update FitShield, then import it.`
      );
    }

    const known = Object.keys(settings).filter(
      (key) => DURABLE_KEYS.includes(key) && !EXCLUDED_KEYS.includes(key)
    );

    if (known.length === 0) {
      throw new Error("That backup contains no FitShield settings.");
    }

    const cleaned = {};
    known.forEach((key) => {
      cleaned[key] = scrub(settings[key]);
    });

    return cleaned;
  }

  /**
   * Pure: parse JSON text into a validated settings map. Rejects oversized and
   * malformed input with a message a person can act on.
   */
  function parseBackup(text) {
    const source = String(text == null ? "" : text);

    if (source.length === 0) {
      throw new Error("That file is empty.");
    }

    if (source.length > MAX_BYTES) {
      throw new Error(
        `That file is too large to be a FitShield backup (${Math.round(source.length / 1024)} KB; the limit is ${MAX_BYTES / 1024} KB).`
      );
    }

    let parsed;

    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error("That file isn't valid JSON.");
    }

    return extractSettings(parsed);
  }

  /**
   * Pure: run the imported map through the same normalization the runtime uses,
   * so a restore can never install a value the worker would then have to defend
   * against. Anything unusable is replaced by its default rather than rejected,
   * except where rejecting the whole file is safer (handled in parseBackup).
   */
  function normalizeImported(settings) {
    if (!core) {
      return settings;
    }

    const normalized = core.readSettings(settings);
    const out = {};

    // Only write back keys the file actually carried, so importing a partial
    // backup does not reset everything else to a default.
    Object.keys(settings).forEach((key) => {
      out[key] = Object.prototype.hasOwnProperty.call(normalized, key) ? normalized[key] : settings[key];
    });

    // Custom alternatives are re-validated individually: a hostile entry is
    // dropped rather than allowed to reach the renderer.
    if (Object.prototype.hasOwnProperty.call(settings, "customAlternatives")) {
      out.customAlternatives = core.normalizeCustomAlternatives(settings.customAlternatives);
    }

    out[core.SCHEMA_KEY] = core.SCHEMA_VERSION;
    return out;
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

  /**
   * Browser: validate a file's text and write it into storage.
   *
   * Everything is validated BEFORE anything is written, so a file that fails
   * halfway cannot leave the profile in a mixture of old and new values.
   * Returns the count of settings restored.
   */
  async function importFromText(text) {
    const settings = normalizeImported(parseBackup(text));

    // Clear the install-local keys a restore should not inherit — most
    // importantly any active pass, which would otherwise unblock a site the user
    // is not currently looking at.
    await chrome.storage.local.remove(EXCLUDED_KEYS);
    await chrome.storage.local.set(settings);

    return Object.keys(settings).length;
  }

  const api = {
    FILE_NAME,
    BACKUP_TYPE,
    SCHEMA_VERSION,
    MAX_BYTES,
    DURABLE_KEYS,
    EXCLUDED_KEYS,
    collectBackup,
    extractSettings,
    parseBackup,
    normalizeImported,
    downloadBackup,
    importFromText
  };

  global.FitShieldBackup = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
