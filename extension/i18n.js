/**
 * FitShield lightweight i18n helper.
 *
 * Uses the standard Chrome/Google `chrome.i18n` localization data backed by
 * `_locales/<lang>/messages.json`. As of the platform-abstraction work it talks
 * to the host through `fitshield.*` (see browser-shim.js / android-shim.js)
 * rather than `chrome.*` directly, so the SAME i18n module runs unchanged in the
 * browser extension and in the Android WebView. Its public `FitShieldI18n` API
 * is unchanged.
 *
 * Two localization modes:
 *   - Browser default: strings come from `fitshield.i18n.getMessage()`, which the
 *     browser resolves from the user's UI locale (falling back to default_locale).
 *   - Manual override: the user pinned a language (or the Android host has no
 *     getMessage); the matching `_locales/<locale>/messages.json` is fetched once,
 *     cached, and used (with English cached as a fallback for any gap).
 *
 * Markup localization:
 *     <h1 data-i18n="settingsTitle"></h1>
 *     <input data-i18n-placeholder="searchSitePlaceholder">
 *     <button data-i18n-title="deliveryToggleTitle"></button>
 *     <span data-i18n-aria-label="removeShortcut"></span>
 *     <img data-i18n-alt="bmcAlt">
 *
 * Script localization:
 *     FitShieldI18n.t("messageKey", ["sub1", "sub2"]);
 *
 * Messages use positional substitutions $1..$9 (and $$ for a literal $).
 */
(function (global) {
  "use strict";

  // Stored override locale code. "" / "system" => browser default.
  const STORAGE_KEY = "uiLanguage";

  // Manual-override locales (must match the _locales folders).
  const SUPPORTED_LOCALES = [
    "en",
    "ja",
    "zh_CN",
    "ko",
    "hi",
    "es_419",
    "es",
    "fr",
    "de",
    "yue",
    "th",
    "pa",
    "ta",
    "zh_TW",
    "af",
    "sq",
    "eu",
    "be",
    "bg",
    "ca",
    "hr",
    "cs",
    "da",
    "nl",
    "et",
    "fi",
    "el",
    "hu",
    "is",
    "ga",
    "it",
    "lv",
    "lt",
    "mk",
    "mt",
    "no",
    "pl",
    "pt_PT",
    "ro",
    "ru",
    "sr",
    "sk",
    "sl",
    "sv",
    "tr",
    "uk",
    "cy",
    "bn",
    "gu",
    "kn",
    "ml",
    "mr",
    "ne",
    "or",
    "si",
    "te",
    "ur",
    "as",
    "id",
    "ms",
    "vi",
    "km",
    "lo",
    "my",
    "tl",
    "jv",
    "su",
    "ar",
    "fa",
    "he",
    "hy",
    "ka",
    "kk",
    "ky",
    "mn",
    "ps",
    "tg",
    "tk",
    "ug",
    "uz",
    "pt_BR",
    "sw",
    "am"
  ];

  // Host platform abstraction (browser-shim.js or android-shim.js defines it).
  const FS = global.fitshield;
  const hasI18n = !!(FS && FS.i18n && typeof FS.i18n.getMessage === "function");
  const hasRuntime = !!(FS && FS.runtime && typeof FS.runtime.getURL === "function");
  const hasStorage = !!(FS && FS.storage);

  let overrideLocale = "";          // "" => browser default via fitshield.i18n
  const localeCache = {};           // locale code -> { key: message } (parsed once)
  const changeListeners = new Set();

  function normalizeLocale(locale) {
    return SUPPORTED_LOCALES.includes(locale) ? locale : "";
  }

  // Resolve positional substitutions the way chrome.i18n does: $1..$9 and $$.
  function applySubstitutions(message, substitutions) {
    if (substitutions == null) {
      return message;
    }

    const list = Array.isArray(substitutions) ? substitutions : [substitutions];

    return message.replace(/\$([1-9])|\$\$/g, (match, index) => {
      if (match === "$$") {
        return "$";
      }

      const value = list[Number(index) - 1];
      return value == null ? "" : String(value);
    });
  }

  // Fetch + cache a locale's messages map. Cached so we never reparse JSON.
  async function fetchLocaleMessages(locale) {
    if (localeCache[locale]) {
      return localeCache[locale];
    }

    if (!hasRuntime) {
      return null;
    }

    try {
      const response = await fetch(FS.runtime.getURL(`_locales/${locale}/messages.json`));

      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }

      const raw = await response.json();
      const map = {};

      Object.keys(raw).forEach((key) => {
        map[key] = raw[key] && typeof raw[key].message === "string" ? raw[key].message : "";
      });

      localeCache[locale] = map;
      return map;
    } catch (error) {
      console.error(`Failed to load locale "${locale}":`, error);
      return null;
    }
  }

  // Translate a key. Override messages win; otherwise fitshield.i18n (browser
  // default). Falls back to English override cache, then the raw key, so a gap
  // stays visible rather than rendering blank.
  function t(key, substitutions) {
    if (!key) {
      return "";
    }

    if (overrideLocale) {
      const messages = localeCache[overrideLocale];

      if (messages && messages[key]) {
        return applySubstitutions(messages[key], substitutions);
      }

      const english = localeCache.en;

      if (english && english[key]) {
        return applySubstitutions(english[key], substitutions);
      }
    }

    if (hasI18n) {
      const message = FS.i18n.getMessage(key, substitutions);

      if (message) {
        return message;
      }
    }

    return key;
  }

  // Map of data attribute (camelCase dataset key) -> how to apply the string.
  const TARGETS = [
    ["i18n", (el, value) => { el.textContent = value; }],
    ["i18nPlaceholder", (el, value) => { el.setAttribute("placeholder", value); }],
    ["i18nTitle", (el, value) => { el.setAttribute("title", value); }],
    ["i18nAriaLabel", (el, value) => { el.setAttribute("aria-label", value); }],
    ["i18nAlt", (el, value) => { el.setAttribute("alt", value); }]
  ];

  // Walk the document (or a subtree) and localize every tagged element.
  // Languages written right to left. FitShield ships all six, and until the
  // document says so the browser lays every one of them out left to right:
  // paragraphs align to the wrong edge, list markers sit on the wrong side, and
  // the whole screen reads as an untranslated English page with Arabic words in
  // it. Setting `dir` is what makes the CSS logical properties do their job.
  const RTL_LANGUAGES = ["ar", "fa", "he", "ps", "ug", "ur", "yi", "iw", "dv", "ku", "sd"];

  function isRtl(locale) {
    const base = String(locale || "").toLowerCase().split(/[-_]/)[0];
    return RTL_LANGUAGES.includes(base);
  }

  /**
   * Stamp the document with the language actually in effect and its direction.
   *
   * Also fixes a smaller correctness bug: every page is authored `<html lang="en">`,
   * so without this a screen reader announces Japanese or Arabic content in an
   * English voice whatever language the user picked.
   */
  function applyDocumentLanguage() {
    if (typeof document === "undefined" || !document.documentElement) {
      return;
    }

    const active =
      overrideLocale ||
      ((FS && FS.i18n && FS.i18n.getUILanguage) ? FS.i18n.getUILanguage() : "") ||
      "en";

    document.documentElement.lang = String(active).replace(/_/g, "-");
    document.documentElement.dir = isRtl(active) ? "rtl" : "ltr";
  }

  function localizeDocument(root) {
    const scope = root || document;

    if (!root) {
      applyDocumentLanguage();
    }

    TARGETS.forEach(([datasetKey, apply]) => {
      const attribute = `data-${datasetKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      scope.querySelectorAll(`[${attribute}]`).forEach((element) => {
        const value = t(element.dataset[datasetKey]);

        if (value) {
          apply(element, value);
        }
      });
    });
  }

  function onChange(listener) {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  }

  function notify() {
    changeListeners.forEach((listener) => {
      try {
        listener(overrideLocale);
      } catch (error) {
        console.error("i18n change listener failed:", error);
      }
    });
  }

  // Apply a language: load its messages (plus English as fallback), re-localize
  // the static DOM, and notify pages so they can re-render dynamic strings.
  async function setLanguage(locale, options) {
    const opts = options || {};
    const normalized = normalizeLocale(locale);
    overrideLocale = normalized;

    if (normalized) {
      await fetchLocaleMessages(normalized);

      if (normalized !== "en") {
        await fetchLocaleMessages("en");
      }
    }

    if (opts.persist && hasStorage) {
      try {
        await FS.storage.set({ [STORAGE_KEY]: normalized });
      } catch (error) {
        console.error("Failed to persist language:", error);
      }
    }

    localizeDocument();
    notify();
    return normalized;
  }

  function getLanguage() {
    return overrideLocale;
  }

  async function init() {
    let stored = "";

    if (hasStorage) {
      try {
        const result = await FS.storage.get([STORAGE_KEY]);
        stored = typeof result[STORAGE_KEY] === "string" ? result[STORAGE_KEY] : "";
      } catch (error) {
        console.error("Failed to read stored language:", error);
      }
    }

    // On a host without a native getMessage (e.g. Android), force the override
    // path so strings come from the bundled _locales files.
    if (!stored && !hasI18n) {
      const ui = (FS && FS.i18n && FS.i18n.getUILanguage) ? FS.i18n.getUILanguage() : "";
      stored = normalizeLocale(ui) || "en";
    }

    await setLanguage(stored);
  }

  // Keep any open surface (popup, settings, block screen) in sync when the
  // language changes in another context.
  if (hasStorage && FS.storage.onChanged) {
    FS.storage.onChanged((changes) => {
      if (!changes[STORAGE_KEY]) {
        return;
      }

      const next = normalizeLocale(changes[STORAGE_KEY].newValue || "");

      if (next !== overrideLocale) {
        setLanguage(next);
      }
    });
  }

  // ready resolves once the stored language has been applied, so pages can
  // gate their first dynamic render on it and avoid a flash of the wrong locale.
  const ready = init();

  global.FitShieldI18n = {
    t,
    localizeDocument,
    setLanguage,
    getLanguage,
    onChange,
    ready,
    isRtl,
    SUPPORTED_LOCALES,
    STORAGE_KEY
  };
})(typeof self !== "undefined" ? self : globalThis);
