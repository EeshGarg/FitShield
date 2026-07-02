/**
 * FitShield platform shim — BROWSER (Chrome / Firefox WebExtension).
 *
 * Defines the platform-agnostic `fitshield.*` API the UI is migrating to, by
 * delegating to the WebExtension `chrome.*` APIs. The Android build ships
 * `android-shim.js` instead, which implements the same `fitshield.*` contract
 * over a native WebView bridge. One UI, two thin platform shims.
 *
 * Contract (kept intentionally close to chrome.* semantics so migration is
 * mechanical and browser behavior is preserved 1:1):
 *
 *   fitshield.platform                      -> "browser"
 *   fitshield.storage.get(keys)             -> Promise<object>   (local storage)
 *   fitshield.storage.set(obj)              -> Promise<void>
 *   fitshield.storage.remove(keys)          -> Promise<void>
 *   fitshield.storage.clear()               -> Promise<void>
 *   fitshield.storage.onChanged(fn)         -> fn(changes) for local-area changes
 *   fitshield.runtime.sendMessage(msg)      -> Promise<any>
 *   fitshield.runtime.onMessage(fn)         -> add a message listener
 *   fitshield.runtime.getURL(path)          -> string
 *   fitshield.runtime.getManifest()         -> { version, ... }
 *   fitshield.i18n.getMessage(key, subs)    -> string
 *   fitshield.i18n.getUILanguage()          -> string
 *   fitshield.tabs.create(url)              -> void
 */
(function (global) {
  "use strict";

  const c = global.chrome;
  if (!c) {
    return; // not a WebExtension context; android-shim.js handles Android.
  }

  // Stat keys kept in local storage (shared with the engine/background).
  const STAT_KEYS = [
    "blockedVisits", "blockedByDomain", "blockedByCategory", "blockedByCountry", "blockedByApp",
    "caloriesAvoided", "avgMealCost", "avgMealCalories", "mealStatsCustomized", "currency"
  ];

  global.fitshield = {
    platform: "browser",

    storage: {
      get: (keys) => c.storage.local.get(keys),
      set: (obj) => c.storage.local.set(obj),
      remove: (keys) => c.storage.local.remove(keys),
      clear: () => c.storage.local.clear(),
      onChanged: (listener) => {
        c.storage.onChanged.addListener((changes, area) => {
          if (area === "local") {
            listener(changes);
          }
        });
      }
    },

    runtime: {
      sendMessage: (message) => c.runtime.sendMessage(message),
      onMessage: (listener) => c.runtime.onMessage.addListener(listener),
      getURL: (path) => c.runtime.getURL(path),
      getManifest: () => c.runtime.getManifest()
    },

    i18n: {
      getMessage: (key, subs) => c.i18n.getMessage(key, subs),
      getUILanguage: () => (c.i18n.getUILanguage ? c.i18n.getUILanguage() : "")
    },

    tabs: {
      create: (url) => {
        if (c.tabs && c.tabs.create) {
          c.tabs.create({ url });
        }
      }
    },

    // Native app blocking is Android-only; the browser blocks via DNR/DNS.
    appBlocking: {
      available: false,
      accessibilityEnabled: () => Promise.resolve(false),
      openSettings: () => Promise.resolve(),
      packageCount: () => Promise.resolve(0),
      list: () => Promise.resolve([]),
      overlayEnabled: () => Promise.resolve(false),
      openOverlaySettings: () => Promise.resolve(),
      vpnEnabled: () => Promise.resolve(false)
    },

    // Domain-oriented surfaces (the shape the UI targets). On the browser,
    // blocking is enforced by the extension's declarativeNetRequest rules; the
    // master on/off lives in the `enabled` storage key.
    blocking: {
      isEnabled: () => c.storage.local.get(["enabled"]).then((s) => s.enabled !== false),
      enable: () => c.storage.local.set({ enabled: true }),
      disable: () => c.storage.local.set({ enabled: false }),
      rulesVersion: () => Promise.resolve(c.runtime.getManifest().version),
      hostCount: () => Promise.resolve(null), // shown differently in the popup
      privateDnsActive: () => Promise.resolve(false), // Android-only concept
      check: () => Promise.resolve(null)      // Android-only convenience
    },

    stats: {
      get: () => c.storage.local.get(STAT_KEYS)
    },

    // Country/category metadata. Browser pages derive this from the loaded
    // engine directly, so the shim returns null (Android provides it natively).
    filters: {
      metadata: () => Promise.resolve(null),
      getSelected: () => c.storage.local.get(["enabledCountries", "enabledCategories"]),
      setSelected: (sel) => c.storage.local.set(sel || {})
    },

    // Canonical recipe catalog, fetched from the bundled data file (same path on
    // both platforms via getURL).
    recipes: {
      load: () => fetch(c.runtime.getURL("data/recipes.json")).then((r) => r.json()).then((d) => d.recipes || [])
    },

    importExport: {
      export: () => {
        if (global.FitShieldBackup) {
          return global.FitShieldBackup.downloadBackup();
        }
        return Promise.resolve();
      },
      import: (text) => {
        if (global.FitShieldBackup) {
          return global.FitShieldBackup.importFromText(text);
        }
        return Promise.reject(new Error("import unavailable"));
      }
    },

    theme: {
      getMode: () => c.storage.local.get(["themeMode"]).then((s) => s.themeMode || "system"),
      setMode: (mode) => c.storage.local.set({ themeMode: mode })
    },

    version: {
      get: () => Promise.resolve(c.runtime.getManifest().version)
    }
  };
})(typeof self !== "undefined" ? self : globalThis);
