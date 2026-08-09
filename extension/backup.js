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

  // Resolved LAZILY, on first use, not at load time.
  //
  // This file is loaded before fitshield-core.js on both pages that use it, so a
  // load-time binding resolved to null in the browser while still working in
  // Node (where `require` is available) — which meant restore silently skipped
  // normalization in production and only in production. Looking the global up
  // when it is actually needed makes the module independent of script order.
  let cachedCore = null;

  function getCore() {
    if (cachedCore) {
      return cachedCore;
    }

    if (typeof FitShieldCore !== "undefined") {
      cachedCore = FitShieldCore;
    } else if (typeof require === "function") {
      cachedCore = require("./fitshield-core.js");
    }

    return cachedCore;
  }

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
    // `settingsDelaySeconds` was here. It was written by the Strict profile,
    // documented as a cooling-off delay, unit-tested — and read by nothing. It
    // has been removed from the runtime, so carrying it in a backup would
    // propagate a retired key to every new device.
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

  /**
   * Every rejection below is a reason a person can act on — "update FitShield",
   * "that file is 3 MB", "reload the page". They used to be thrown and then
   * discarded by the caller, which replaced all of them with one generic
   * "That file isn't a valid FitShield backup" — a message that is actively
   * wrong for a backup written by a NEWER FitShield, and that invites a user to
   * delete the only copy of their settings.
   *
   * The Error carries both forms: `message` is the English sentence (and what
   * the Node tests match on, since no i18n runtime exists there), and `i18nKey`
   * plus `i18nSubs` let a page render the same reason in the user's language.
   * This module deliberately does not depend on the i18n runtime itself — it is
   * pure, and is unit-tested outside a browser.
   */
  function backupError(i18nKey, message, substitutions) {
    const error = new Error(message);
    error.i18nKey = i18nKey;
    error.i18nSubs = (substitutions || []).map(String);
    return error;
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
    const notABackup = () =>
      backupError("backupErrorNotBackup", "That file is not a FitShield backup.");

    if (!isPlainObject(parsed)) {
      throw notABackup();
    }

    const wrapped = isPlainObject(parsed.settings);
    const settings = wrapped ? parsed.settings : parsed;

    if (!isPlainObject(settings)) {
      throw notABackup();
    }

    if (wrapped && parsed._type && parsed._type !== BACKUP_TYPE) {
      throw notABackup();
    }

    // A schema newer than this build understands would be written blind.
    if (wrapped && Number.isFinite(Number(parsed.schema)) && Number(parsed.schema) > SCHEMA_VERSION) {
      throw backupError(
        "backupErrorNewerFormat",
        `That backup was written by a newer version of FitShield (format ${parsed.schema}). Update FitShield, then import it.`,
        [parsed.schema]
      );
    }

    const known = Object.keys(settings).filter(
      (key) => DURABLE_KEYS.includes(key) && !EXCLUDED_KEYS.includes(key)
    );

    if (known.length === 0) {
      throw backupError("backupErrorNoSettings", "That backup contains no FitShield settings.");
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
      throw backupError("backupErrorEmptyFile", "That file is empty.");
    }

    if (source.length > MAX_BYTES) {
      const actualKb = Math.round(source.length / 1024);
      const limitKb = MAX_BYTES / 1024;

      throw backupError(
        "backupErrorTooLarge",
        `That file is too large to be a FitShield backup (${actualKb} KB; the limit is ${limitKb} KB).`,
        [actualKb, limitKb]
      );
    }

    let parsed;

    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw backupError("backupErrorInvalidJson", "That file isn't valid JSON.");
    }

    return extractSettings(parsed);
  }

  /**
   * Pure: guarantee every custom alternative in a list carries a DISTINCT id.
   *
   * Ids are what every surface keys on: preferences.js removes by id and the
   * block page favourites by id. `normalizeCustomAlternatives` deliberately
   * preserves whatever id an entry arrived with, and does not compare them — so
   * a hand-edited or third-party backup carrying three entries all with
   * `id: "dup"` imported as three entries all still called "dup", and deleting
   * one of the user's own recipes then silently deleted every entry sharing
   * that id, with no undo and no warning.
   *
   * A collision is re-issued a fresh id rather than dropped: the entry is the
   * user's own content and losing it would be the worse failure.
   */
  function withUniqueIds(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const original = new Set(list.map((entry) => entry && entry.id));
    const taken = new Set();
    const stamp = Date.now().toString(36);

    return list.map((entry, index) => {
      if (!taken.has(entry.id)) {
        taken.add(entry.id);
        return entry;
      }

      // Same shape as the id sanitizeCustomAlternative mints, and checked
      // against BOTH the ids already kept and every id the file carried, so a
      // replacement can never collide with an entry further down the list.
      let attempt = 0;
      let candidate = `custom-${stamp}-${index}`;

      while (taken.has(candidate) || original.has(candidate)) {
        attempt += 1;
        candidate = `custom-${stamp}-${index}-${attempt}`;
      }

      taken.add(candidate);
      return { ...entry, id: candidate };
    });
  }

  /**
   * Pure: run the imported map through the same normalization the runtime uses,
   * so a restore can never install a value the worker would then have to defend
   * against. Anything unusable is replaced by its default rather than rejected,
   * except where rejecting the whole file is safer (handled in parseBackup).
   */
  function normalizeImported(settings) {
    const core = getCore();

    // Refuse rather than degrade. Silently importing un-normalized settings is
    // exactly the failure this function exists to prevent, so if the shared
    // validator is genuinely unavailable the import stops here.
    if (!core) {
      throw backupError(
        "backupErrorValidatorMissing",
        "FitShield could not validate that backup (fitshield-core.js is not loaded). Reload and try again."
      );
    }

    // Bring an older file up to the current schema BEFORE normalizing it.
    //
    // This used to stamp SCHEMA_VERSION unconditionally at the end, which made
    // every restored file look already-migrated: migrateState then short-
    // circuited on `from >= SCHEMA_VERSION` and a 0.54 backup's blockedVisits /
    // recipesChosen were never translated into `stats`. The counters were
    // physically present in storage and every one of the seven cards read zero.
    const migrated = core.migrateState(settings);
    const upgraded = migrated.error ? settings : migrated.state;

    const normalized = core.readSettings(upgraded);
    const out = {};

    // Only write back keys the file actually carried, so importing a partial
    // backup does not reset everything else to a default. Note the migration is
    // NOT allowed to widen that set on its own — it fills in every default, and
    // adopting those would let a two-key backup overwrite the current profile's
    // schedule, passes and statistics.
    const keys = new Set(Object.keys(settings));

    // …with one exception per legacy translation: a key the migration DERIVED
    // from something the file carried belongs to that file's data, and dropping
    // it would throw the upgrade away again. Each entry is "the key produced"
    // -> "the legacy keys that produce it".
    const DERIVED_FROM = {
      stats: ["blockedVisits", "recipesChosen", "caloriesAvoided"],
      schedule: ["scheduleEnabled", "scheduleStart", "scheduleEnd"],
      passes: ["siteBypasses"],
      alternativeFavorites: ["recipeFavorites"]
    };

    Object.keys(DERIVED_FROM).forEach((derived) => {
      const carriedASource = DERIVED_FROM[derived].some((key) =>
        Object.prototype.hasOwnProperty.call(settings, key)
      );

      if (carriedASource && !Object.prototype.hasOwnProperty.call(settings, derived)) {
        keys.add(derived);
      }
    });

    keys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(normalized, key)) {
        out[key] = normalized[key];
      } else if (Object.prototype.hasOwnProperty.call(upgraded, key)) {
        out[key] = upgraded[key];
      }
    });

    // Custom alternatives are re-validated individually: a hostile entry is
    // dropped rather than allowed to reach the renderer, and duplicate ids are
    // re-issued so deleting one entry cannot delete several.
    if (Object.prototype.hasOwnProperty.call(settings, "customAlternatives")) {
      out.customAlternatives = withUniqueIds(core.normalizeCustomAlternatives(settings.customAlternatives));
    }

    out[core.SCHEMA_KEY] = core.SCHEMA_VERSION;
    return out;
  }

  /**
   * Pure: how many of the user's settings a validated import actually carries.
   *
   * `normalizeImported` stamps the internal schema marker onto every result, so
   * counting its keys reported one more setting than the file held — the number
   * shown as "Restored N settings from the backup." was off by one for any
   * backup written before that key existed, and counted an internal marker as
   * one of "your settings" for every other backup.
   */
  function restoredCount(settings) {
    const core = getCore();
    const schemaKey = core ? core.SCHEMA_KEY : "schemaVersion";

    return Object.keys(isPlainObject(settings) ? settings : {}).filter((key) => key !== schemaKey).length;
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
   * Browser: write an ALREADY-VALIDATED settings map into storage.
   *
   * Split out from `importFromText` so a caller can validate a file, show the
   * user exactly what is about to happen, wait for a yes, and only then write.
   * Import is the one destructive action in Settings, and it used to go straight
   * from file-pick to write with no confirmation at all.
   *
   * Returns the count of the user's settings restored.
   */
  async function applyImport(settings) {
    // Clear the install-local keys a restore should not inherit — most
    // importantly any active pass, which would otherwise unblock a site the user
    // is not currently looking at. The caller is expected to have said so.
    await chrome.storage.local.remove(EXCLUDED_KEYS);
    await chrome.storage.local.set(settings);

    return restoredCount(settings);
  }

  /**
   * Browser: validate a file's text and write it into storage.
   *
   * Everything is validated BEFORE anything is written, so a file that fails
   * halfway cannot leave the profile in a mixture of old and new values.
   * Returns the count of settings restored.
   */
  async function importFromText(text) {
    return applyImport(normalizeImported(parseBackup(text)));
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
    withUniqueIds,
    restoredCount,
    downloadBackup,
    applyImport,
    importFromText
  };

  global.FitShieldBackup = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
