/**
 * FitShield platform shim — ANDROID (native APK / WebView).
 *
 * Implements the SAME `fitshield.*` contract as extension/browser-shim.js, but
 * delegates to a native bridge object (`Android`, an @JavascriptInterface)
 * backed by SharedPreferences + the FitShieldVpnService. This keeps the web UI
 * identical across platforms; only this shim and the native bridge are
 * Android-specific.
 *
 * LOCATION: this file lives in android/web-src/ (not extension/) because it is
 * Android-authored and consumed ONLY by the Android WebView bundle — it never
 * ships in the browser packages. tools/build-android.js copies it into
 * android/app/src/main/assets/web/, and tools/android-audit.js fails the build
 * if that bundled copy ever drifts from this canonical source — the same
 * no-fork/drift guarantee as the files reused from extension/.
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

  // A stored value is a JSON string, or absent. An unparseable one reads as
  // absent rather than throwing — a corrupt preference must not take the UI down.
  function parseValue(raw) {
    if (raw === null || raw === undefined || raw === "") {
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }

  function readKey(key) {
    return parseValue(A.storageGet(key));
  }

  /**
   * Read a whole key list in ONE bridge hop.
   *
   * `storageGet` costs one synchronous @JavascriptInterface call plus one
   * JSON.parse PER KEY. `renderAppBlocking` asks for 9 keys, so 9 hops; the
   * domain-list editors ask for 1 each; and `stats.get()` asks for 5 — on the
   * dashboard's 2s status poll, which made it 2.5 bridge hops a second for the
   * whole time the app was open. WebAppBridge answers from the in-memory
   * SharedPreferences map, so serving all of them together costs it one
   * JSONObject and collapses each of those reads to a single hop.
   *
   * The contract is byte-identical to reading the keys one at a time: the native
   * side returns the same RAW stored strings, keyed by name, and simply omits
   * any key it does not hold — so a missing key is absent from the object and
   * reads as `undefined` here, exactly as it does per-key. Each value is parsed
   * independently, so one corrupt preference still costs only itself.
   *
   * A native side without the method (an older APK shell than this bundle, or a
   * harness that stubs the bridge) falls back to the per-key path, so this is an
   * optimisation and never a requirement.
   */
  function readMany(keys) {
    const perKey = () => {
      const out = {};
      keys.forEach((k) => { out[k] = readKey(k); });
      return out;
    };

    if (!A.storageGetMany) {
      return perKey();
    }

    let raw;
    try {
      raw = JSON.parse(A.storageGetMany(JSON.stringify(keys)) || "{}");
    } catch (e) {
      raw = null;
    }
    if (!raw || typeof raw !== "object") {
      return perKey();
    }

    const out = {};
    keys.forEach((k) => { out[k] = parseValue(raw[k]); });
    return out;
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

    const values = readMany(list);

    list.forEach((k) => {
      const value = values[k];
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

  // ---- values that cannot change while this process lives -------------------
  //
  // Both of these sat on the dashboard's 2s status poll, and both answer with
  // something fixed at process start:
  //
  //   A.getVersion()  the APK's own versionName, which the native side reads via
  //     PackageManager.getPackageInfo — a real binder round-trip to system_server.
  //     It cannot change without this process being replaced, because installing
  //     a new version kills it. It was being fetched twice a second, from three
  //     callers (blocking.rulesVersion, runtime.getManifest, version.get).
  //   A.ruleCount()   the size of the host set RuleEngine parses ONCE from a
  //     read-only packaged asset when the service starts.
  //
  // Memoising them removes the PackageManager IPC from the poll entirely. Only a
  // usable answer is cached, so a bridge that is not ready yet is asked again
  // rather than pinned to "" or 0 for the rest of the session.
  let cachedVersion = null;
  let cachedHostCount = 0;

  function appVersion() {
    if (!cachedVersion) {
      cachedVersion = A.getVersion();
    }
    return cachedVersion;
  }

  function hostCount() {
    if (!cachedHostCount) {
      cachedHostCount = A.ruleCount();
    }
    return cachedHostCount;
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
      getManifest: () => ({ version: appVersion() })
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
      // openSettings does nothing until consentGiven() is true. Google's
      // prominent-disclosure rules require the explanation to be shown in the
      // app and accepted by an affirmative action BEFORE the request, so the
      // native side refuses an ungated call rather than trusting this page.
      openSettings: () => { if (A.openAccessibilitySettings) A.openAccessibilitySettings(); return Promise.resolve(); },
      consentGiven: () => Promise.resolve(!!(A.accessibilityConsentGiven && A.accessibilityConsentGiven())),
      recordConsent: () => { if (A.recordAccessibilityConsent) A.recordAccessibilityConsent(); return Promise.resolve(); },
      clearConsent: () => { if (A.clearAccessibilityConsent) A.clearAccessibilityConsent(); return Promise.resolve(); },
      // Whether FitShield may post notifications at all. The restore notice
      // after a reboot is the one that matters — see MainActivity.
      notificationsEnabled: () => Promise.resolve(A.notificationsEnabled ? !!A.notificationsEnabled() : true),
      openNotificationSettings: () => { if (A.openNotificationSettings) A.openNotificationSettings(); return Promise.resolve(); },
      packageCount: () => Promise.resolve(A.appPackageCount ? A.appPackageCount() : 0),
      list: () => { try { return Promise.resolve(JSON.parse(A.blockableApps ? A.blockableApps() : "[]")); } catch (e) { return Promise.resolve([]); } },
      // "Display over other apps" — makes the block screen launch reliably.
      overlayEnabled: () => Promise.resolve(!!(A.overlayEnabled && A.overlayEnabled())),
      openOverlaySettings: () => { if (A.openOverlaySettings) A.openOverlaySettings(); return Promise.resolve(); },
      vpnEnabled: () => Promise.resolve(!!(A.vpnEnabled && A.vpnEnabled())),
      // Optional "background protection": an opt-in keep-alive foreground service
      // + battery-optimization exemption, for devices that freeze idle apps.
      keepAliveEnabled: () => Promise.resolve(!!(A.keepAliveEnabled && A.keepAliveEnabled())),
      setKeepAlive: (on) => { if (A.setKeepAlive) A.setKeepAlive(!!on); return Promise.resolve(); },
      batteryUnrestricted: () => Promise.resolve(!!(A.batteryUnrestricted && A.batteryUnrestricted())),
      openBatterySettings: () => { if (A.openBatterySettings) A.openBatterySettings(); return Promise.resolve(); }
    },

    // Domain-oriented surfaces — same shape as browser-shim.js. On Android,
    // blocking is the local DNS-filtering VpnService.
    blocking: {
      isEnabled: () => Promise.resolve(A.vpnIsEnabled()),
      enable: () => { A.vpnEnable(); return Promise.resolve(); },
      disable: () => { A.vpnDisable(); return Promise.resolve(); },
      // Memoised: see appVersion()/hostCount() above. Both of these are polled
      // every 2s by the dashboard and neither can change while this process runs.
      rulesVersion: () => Promise.resolve(appVersion()),
      hostCount: () => Promise.resolve(hostCount()),
      privateDnsActive: () => Promise.resolve(A.privateDnsActive()),
      // Convenience domain checker (reuses the on-device engine). Returns the
      // matched curated apex, or null when not blocked.
      check: (host) => {
        const apex = A.checkHost(String(host || ""));
        return Promise.resolve(apex ? { blocked: true, apex } : { blocked: false, apex: null });
      }
    },

    // Only what a surface actually renders. `caloriesAvoided`, `avgMealCost`,
    // `avgMealCalories`, `mealStatsCustomized` and `currency` are no longer read
    // by any screen: the estimate row that used them presented an assumption as
    // an outcome and was removed. The stored values are NOT deleted — they stay
    // in SharedPreferences and the "Reset statistics & estimates" control still
    // sweeps them (see the STATS/SETTINGS lists in app.js) — they are simply no
    // longer handed to a page that has nothing truthful to do with them.
    stats: {
      get: () => storageGet([
        "blockedVisits", "blockedByDomain", "blockedByCategory", "blockedByCountry", "blockedByApp"
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
      // The WHOLE document, not `d.recipes`. Keeping only that array dropped
      // all 42 quickAlternatives — half the catalog — and the taxonomy, which
      // is the category-to-craving mapping the shared selector runs on. Without
      // it Android could not use the selector at all and fell back to picking
      // by the length of the brand id.
      load: () => fetch(fitshield.runtime.getURL("data/recipes.json")).then((r) => r.json()),

      // Back-compatible: anything that wanted the flat array still gets one.
      loadEntries: () =>
        fetch(fitshield.runtime.getURL("data/recipes.json"))
          .then((r) => r.json())
          .then((d) => [...(d.recipes || []), ...(d.quickAlternatives || [])])
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
      get: () => Promise.resolve(appVersion())
    }
  };
})(typeof self !== "undefined" ? self : globalThis);
