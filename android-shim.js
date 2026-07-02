/**
 * FitShield platform shim — ANDROID (native APK / WebView).
 *
 * Implements the SAME `fitshield.*` contract as browser-shim.js, but delegates
 * to a native bridge object (`Android`, an @JavascriptInterface) backed by
 * SharedPreferences + the FitShieldVpnService. This keeps the web UI identical
 * across platforms; only this shim and the native bridge are Android-specific.
 *
 * The native `Android` bridge (see WebAppBridge.kt) exposes synchronous methods;
 * this shim wraps them to match the Promise-based fitshield.storage contract.
 */
(function (global) {
  "use strict";

  const A = global.Android;
  if (!A) {
    return; // not the Android WebView; browser-shim.js handles browsers.
  }

  function readKey(key) {
    const raw = A.storageGet(key);
    if (raw === null || raw === undefined || raw === "") {
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }

  function allKeys() {
    try {
      return JSON.parse(A.storageKeys() || "[]");
    } catch (e) {
      return [];
    }
  }

  // Mirror chrome.storage.local.get(keys): string | string[] | object | null.
  function storageGet(keys) {
    const out = {};
    let list;
    let defaults = null;

    if (keys === null || keys === undefined) {
      list = allKeys();
    } else if (typeof keys === "string") {
      list = [keys];
    } else if (Array.isArray(keys)) {
      list = keys;
    } else if (typeof keys === "object") {
      defaults = keys;
      list = Object.keys(keys);
    } else {
      list = [];
    }

    list.forEach((k) => {
      const value = readKey(k);
      if (value !== undefined) {
        out[k] = value;
      } else if (defaults && k in defaults) {
        out[k] = defaults[k];
      }
    });

    return Promise.resolve(out);
  }

  function storageSet(obj) {
    Object.keys(obj || {}).forEach((k) => {
      A.storageSet(k, JSON.stringify(obj[k]));
    });
    return Promise.resolve();
  }

  function storageRemove(keys) {
    (Array.isArray(keys) ? keys : [keys]).forEach((k) => A.storageRemove(k));
    return Promise.resolve();
  }

  global.fitshield = {
    platform: "android",

    storage: {
      get: storageGet,
      set: storageSet,
      remove: storageRemove,
      clear: () => { A.storageClear(); return Promise.resolve(); },
      // Single WebView context: no cross-context change events needed. The UI
      // re-reads after actions / on resume.
      onChanged: () => {}
    },

    runtime: {
      // No background service worker on Android; the UI talks to the VPN via
      // fitshield.vpn (below). Kept as a resolved no-op for API parity.
      sendMessage: () => Promise.resolve(null),
      onMessage: () => {},
      // The WebView base is the bundled web/ dir, so relative paths resolve to
      // the bundled assets (e.g. _locales/en/messages.json).
      getURL: (path) => path,
      getManifest: () => ({ version: A.getVersion() })
    },

    i18n: {
      // Intentionally NO getMessage: with no native i18n, i18n.js switches to
      // override mode and loads the bundled _locales/<lang>/messages.json
      // (falling back to en). Exposing a getMessage here would make i18n.js
      // think the host localizes natively and render raw keys instead.
      getUILanguage: () => A.getUiLanguage()
    },

    tabs: {
      create: (url) => A.openUrl(url)
    },

    // Native app blocking (AccessibilityService). Settings are stored via
    // fitshield.storage; the service reads them. These expose the accessibility
    // enable-state + the count of blockable app packages.
    appBlocking: {
      available: true,
      accessibilityEnabled: () => Promise.resolve(!!(A.accessibilityEnabled && A.accessibilityEnabled())),
      openSettings: () => { if (A.openAccessibilitySettings) A.openAccessibilitySettings(); return Promise.resolve(); },
      packageCount: () => Promise.resolve(A.appPackageCount ? A.appPackageCount() : 0),
      list: () => { try { return Promise.resolve(JSON.parse(A.blockableApps ? A.blockableApps() : "[]")); } catch (e) { return Promise.resolve([]); } },
      // "Display over other apps" — makes the block screen launch reliably.
      overlayEnabled: () => Promise.resolve(!!(A.overlayEnabled && A.overlayEnabled())),
      openOverlaySettings: () => { if (A.openOverlaySettings) A.openOverlaySettings(); return Promise.resolve(); },
      vpnEnabled: () => Promise.resolve(!!(A.vpnEnabled && A.vpnEnabled()))
    },

    // Domain-oriented surfaces — same shape as browser-shim.js. On Android,
    // blocking is the local DNS-filtering VpnService.
    blocking: {
      isEnabled: () => Promise.resolve(A.vpnIsEnabled()),
      enable: () => { A.vpnEnable(); return Promise.resolve(); },
      disable: () => { A.vpnDisable(); return Promise.resolve(); },
      rulesVersion: () => Promise.resolve(A.getVersion()),
      hostCount: () => Promise.resolve(A.ruleCount()),
      privateDnsActive: () => Promise.resolve(A.privateDnsActive()),
      // Convenience domain checker (reuses the on-device engine). Returns the
      // matched curated apex, or null when not blocked.
      check: (host) => {
        const apex = A.checkHost(String(host || ""));
        return Promise.resolve(apex ? { blocked: true, apex } : { blocked: false, apex: null });
      }
    },

    stats: {
      get: () => storageGet([
        "blockedVisits", "blockedByDomain", "blockedByCategory", "blockedByCountry", "blockedByApp",
        "caloriesAvoided", "avgMealCost", "avgMealCalories", "mealStatsCustomized", "currency"
      ])
    },

    // Engine-derived country/category metadata from the native bridge (which
    // reads it out of the generated rules asset). Selections are stored locally;
    // enforcement is wired in the later DNS step.
    filters: {
      metadata: () => {
        try {
          return Promise.resolve(JSON.parse(A.getRulesMetadata() || "{}"));
        } catch (e) {
          return Promise.resolve({});
        }
      },
      getSelected: () => storageGet(["enabledCountries", "enabledCategories"]),
      setSelected: (sel) => storageSet(sel || {})
    },

    recipes: {
      load: () => fetch(fitshield.runtime.getURL("data/recipes.json")).then((r) => r.json()).then((d) => d.recipes || [])
    },

    importExport: {
      // Export collects all settings/stats and hands them to the Android share
      // sheet (permission-free). Import opens the system document picker; the
      // native side merges the backup and reloads the UI when the user confirms.
      export: () => { A.exportSettings(); return Promise.resolve(); },
      import: () => { if (A.importSettings) { A.importSettings(); } return Promise.resolve({ supported: true }); }
    },

    theme: {
      getMode: () => storageGet(["themeMode"]).then((s) => s.themeMode || "system"),
      setMode: (mode) => storageSet({ themeMode: mode })
    },

    version: {
      get: () => Promise.resolve(A.getVersion())
    }
  };
})(typeof self !== "undefined" ? self : globalThis);
