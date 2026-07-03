/**
 * FitShield currency + regional defaults.
 *
 * Maps a display locale to a sensible default currency and an estimated
 * fast-food / delivery meal size (calories), and maps a currency to a typical
 * single-order meal price in that currency. Everything is a local, offline
 * estimate used only to seed the "money saved" / "calories avoided" stats —
 * nothing here is uploaded and the user can override every value.
 *
 * Formatting and currency names lean on the platform's Intl APIs so symbols
 * ($, ¥, €, ₹ …), decimal rules, and grouping match the locale automatically —
 * no per-currency table to maintain and no new translation strings.
 *
 * Loads in two environments without a build step:
 *   - Extension pages, via <script src="currency.js"> (exposes window.FitShieldCurrency).
 *   - Node.js (tests), via require("./currency.js").
 */
(function (global) {
  "use strict";

  // Per-currency typical price of one fast-food combo / delivery order, in that
  // currency's main unit. Deliberately round, local estimates — the user edits
  // this in Settings. Also the source for the currency picker's option list.
  const CURRENCY_DEFAULT_COST = {
    USD: 15, EUR: 12, GBP: 10, CAD: 18, AUD: 20, NZD: 22, CHF: 16, SGD: 14,
    JPY: 1000, CNY: 35, KRW: 12000, HKD: 60, TWD: 150, THB: 180, MYR: 15,
    IDR: 50000, VND: 60000, KHR: 20000, LAK: 80000, MMK: 8000, PHP: 200,
    INR: 350, BDT: 400, NPR: 500, LKR: 1500, PKR: 800,
    AED: 30, SAR: 30, QAR: 30, ILS: 50, EGP: 200, IRR: 1500000, AFN: 500,
    TRY: 400, RUB: 700, UAH: 400, BYN: 25, KZT: 4000, KGS: 600, UZS: 70000,
    TJS: 70, TMT: 50, AMD: 3000, GEL: 25, AZN: 18, MNT: 25000,
    PLN: 45, CZK: 250, HUF: 4000, RON: 50, BGN: 16, RSD: 1200, MKD: 600,
    ALL: 700, DKK: 90, NOK: 180, SEK: 150, ISK: 2500,
    BRL: 40, MXN: 180, ARS: 6000, CLP: 9000, COP: 35000,
    ZAR: 120, KES: 800, NGN: 6000, ETB: 600
  };

  // Locale -> default currency + an estimated meal size for that country. Meal
  // calories vary by regional fast-food portion norms (US large, East Asia
  // smaller); these are gentle estimates, never exact. Keys mirror languages.js.
  const LOCALE_DEFAULTS = {
    en: { currency: "USD", calories: 1100 },
    ja: { currency: "JPY", calories: 720 },
    zh_CN: { currency: "CNY", calories: 850 },
    ko: { currency: "KRW", calories: 900 },
    hi: { currency: "INR", calories: 950 },
    es_419: { currency: "MXN", calories: 1000 },
    es: { currency: "EUR", calories: 950 },
    fr: { currency: "EUR", calories: 950 },
    de: { currency: "EUR", calories: 950 },
    yue: { currency: "HKD", calories: 850 },
    th: { currency: "THB", calories: 850 },
    pa: { currency: "INR", calories: 950 },
    ta: { currency: "INR", calories: 950 },
    zh_TW: { currency: "TWD", calories: 850 },
    af: { currency: "ZAR", calories: 1000 },
    sq: { currency: "ALL", calories: 950 },
    eu: { currency: "EUR", calories: 950 },
    be: { currency: "BYN", calories: 1000 },
    bg: { currency: "BGN", calories: 1000 },
    ca: { currency: "EUR", calories: 950 },
    hr: { currency: "EUR", calories: 1000 },
    cs: { currency: "CZK", calories: 1000 },
    da: { currency: "DKK", calories: 1000 },
    nl: { currency: "EUR", calories: 1000 },
    et: { currency: "EUR", calories: 1000 },
    fi: { currency: "EUR", calories: 1000 },
    el: { currency: "EUR", calories: 1000 },
    hu: { currency: "HUF", calories: 1000 },
    is: { currency: "ISK", calories: 1000 },
    ga: { currency: "EUR", calories: 1000 },
    it: { currency: "EUR", calories: 950 },
    lv: { currency: "EUR", calories: 1000 },
    lt: { currency: "EUR", calories: 1000 },
    mk: { currency: "MKD", calories: 1000 },
    mt: { currency: "EUR", calories: 1000 },
    no: { currency: "NOK", calories: 1000 },
    pl: { currency: "PLN", calories: 1000 },
    pt_PT: { currency: "EUR", calories: 950 },
    ro: { currency: "RON", calories: 1000 },
    ru: { currency: "RUB", calories: 1000 },
    sr: { currency: "RSD", calories: 1000 },
    sk: { currency: "EUR", calories: 1000 },
    sl: { currency: "EUR", calories: 1000 },
    sv: { currency: "SEK", calories: 1000 },
    tr: { currency: "TRY", calories: 1000 },
    uk: { currency: "UAH", calories: 1000 },
    cy: { currency: "GBP", calories: 1050 },
    bn: { currency: "BDT", calories: 950 },
    gu: { currency: "INR", calories: 950 },
    kn: { currency: "INR", calories: 950 },
    ml: { currency: "INR", calories: 950 },
    mr: { currency: "INR", calories: 950 },
    ne: { currency: "NPR", calories: 950 },
    or: { currency: "INR", calories: 950 },
    si: { currency: "LKR", calories: 950 },
    te: { currency: "INR", calories: 950 },
    ur: { currency: "PKR", calories: 950 },
    as: { currency: "INR", calories: 950 },
    id: { currency: "IDR", calories: 950 },
    ms: { currency: "MYR", calories: 950 },
    vi: { currency: "VND", calories: 850 },
    km: { currency: "KHR", calories: 900 },
    lo: { currency: "LAK", calories: 900 },
    my: { currency: "MMK", calories: 900 },
    tl: { currency: "PHP", calories: 950 },
    jv: { currency: "IDR", calories: 950 },
    su: { currency: "IDR", calories: 950 },
    ar: { currency: "AED", calories: 1000 },
    fa: { currency: "IRR", calories: 950 },
    he: { currency: "ILS", calories: 1000 },
    hy: { currency: "AMD", calories: 1000 },
    ka: { currency: "GEL", calories: 1000 },
    kk: { currency: "KZT", calories: 1000 },
    ky: { currency: "KGS", calories: 1000 },
    mn: { currency: "MNT", calories: 1000 },
    ps: { currency: "AFN", calories: 950 },
    tg: { currency: "TJS", calories: 1000 },
    tk: { currency: "TMT", calories: 1000 },
    ug: { currency: "CNY", calories: 850 },
    uz: { currency: "UZS", calories: 1000 },
    pt_BR: { currency: "BRL", calories: 1000 },
    sw: { currency: "KES", calories: 1000 },
    am: { currency: "ETB", calories: 1000 }
  };

  // When the locale is unknown but the region is, fall back by region so the
  // "follow my language" / system-locale path still picks a fitting currency
  // (e.g. en-GB -> GBP rather than USD).
  const REGION_CURRENCY = {
    US: "USD", GB: "GBP", UK: "GBP", IE: "EUR", CA: "CAD", AU: "AUD", NZ: "NZD",
    IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR",
    SG: "SGD", HK: "HKD", TW: "TWD", PH: "PHP", MY: "MYR", ID: "IDR",
    ZA: "ZAR", NG: "NGN", KE: "KES", EG: "EGP",
    BR: "BRL", MX: "MXN", AR: "ARS", CL: "CLP", CO: "COP",
    CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK"
  };

  const FALLBACK = { currency: "USD", calories: 1000 };

  // Minimal symbol fallbacks for environments where Intl can't resolve a symbol
  // (older runtimes / Node without full ICU). Intl is preferred when available.
  const SYMBOL_FALLBACK = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩",
    AUD: "$", CAD: "$", BRL: "R$", RUB: "₽", TRY: "₺", THB: "฿", PHP: "₱",
    VND: "₫", IDR: "Rp", ILS: "₪", ZAR: "R", NGN: "₦", UAH: "₴"
  };

  function normalizeLocale(locale) {
    return String(locale || "").trim().replace(/-/g, "_");
  }

  // Resolve a locale string to its default { currency, calories }. Tries the
  // exact key, then a region fallback, then the base language, then USD.
  function localeDefaults(locale) {
    const norm = normalizeLocale(locale);

    if (LOCALE_DEFAULTS[norm]) {
      return { ...LOCALE_DEFAULTS[norm] };
    }

    const parts = norm.split("_");
    const region = parts.length > 1 ? parts[parts.length - 1].toUpperCase() : "";
    const base = parts[0];

    if (LOCALE_DEFAULTS[base]) {
      const fromBase = { ...LOCALE_DEFAULTS[base] };
      // A known region can override the base language's default currency
      // (e.g. "en" -> USD, but "en_GB" -> GBP) while keeping the calorie norm.
      if (region && REGION_CURRENCY[region]) {
        fromBase.currency = REGION_CURRENCY[region];
      }
      return fromBase;
    }

    if (region && REGION_CURRENCY[region]) {
      return { currency: REGION_CURRENCY[region], calories: FALLBACK.calories };
    }

    return { ...FALLBACK };
  }

  // The currency the stats should use: an explicit user choice wins, otherwise
  // the locale default.
  function resolveCurrency(storedCurrency, locale) {
    const code = String(storedCurrency || "").toUpperCase();
    if (code && CURRENCY_DEFAULT_COST[code]) {
      return code;
    }
    return localeDefaults(locale).currency;
  }

  function defaultCost(currencyCode) {
    const code = String(currencyCode || "").toUpperCase();
    return CURRENCY_DEFAULT_COST[code] != null ? CURRENCY_DEFAULT_COST[code] : CURRENCY_DEFAULT_COST.USD;
  }

  function defaultCalories(locale) {
    return localeDefaults(locale).calories;
  }

  // Sorted currency codes for the picker. Major currencies float to the top,
  // the rest follow alphabetically.
  const PRIORITY = ["USD", "EUR", "GBP", "JPY", "CNY", "INR", "CAD", "AUD"];
  function currencyCodes() {
    const all = Object.keys(CURRENCY_DEFAULT_COST);
    const rest = all.filter((c) => !PRIORITY.includes(c)).sort();
    return [...PRIORITY, ...rest];
  }

  // How many fractional digits a currency normally shows (JPY/KRW/etc. show 0).
  function currencyFractionDigits(code, locale) {
    try {
      const fmt = new Intl.NumberFormat(locale || "en", { style: "currency", currency: code });
      const opts = fmt.resolvedOptions();
      return typeof opts.maximumFractionDigits === "number" ? opts.maximumFractionDigits : 2;
    } catch (error) {
      return 2;
    }
  }

  // Format an amount as currency for the given locale, e.g. "$1,234" / "¥1,234".
  // Whole numbers drop the decimals so the stat reads cleanly.
  function formatMoney(amount, code, locale) {
    const value = Number(amount) || 0;
    const currency = String(code || "USD").toUpperCase();

    try {
      const fractionDigits = Number.isInteger(value) ? 0 : undefined;
      return new Intl.NumberFormat(locale || "en", {
        style: "currency",
        currency,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits
      }).format(value);
    } catch (error) {
      const symbol = SYMBOL_FALLBACK[currency] || (currency + " ");
      return symbol + value.toLocaleString();
    }
  }

  // Just the currency symbol ("$", "¥", "₹"), pulled from Intl when possible.
  function symbolFor(code, locale) {
    const currency = String(code || "USD").toUpperCase();
    try {
      const parts = new Intl.NumberFormat(locale || "en", {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      }).formatToParts(0);
      const part = parts.find((p) => p.type === "currency");
      if (part && part.value) {
        return part.value;
      }
    } catch (error) {
      // fall through to table
    }
    return SYMBOL_FALLBACK[currency] || currency;
  }

  // Localized display name for a currency ("US Dollar", "日元" …) for the picker.
  function displayName(code, locale) {
    const currency = String(code || "USD").toUpperCase();
    try {
      const names = new Intl.DisplayNames([locale || "en"], { type: "currency" });
      const name = names.of(currency);
      if (name && name !== currency) {
        return name;
      }
    } catch (error) {
      // fall through
    }
    return currency;
  }

  const api = {
    LOCALE_DEFAULTS,
    CURRENCY_DEFAULT_COST,
    REGION_CURRENCY,
    FALLBACK,
    localeDefaults,
    resolveCurrency,
    defaultCost,
    defaultCalories,
    currencyCodes,
    currencyFractionDigits,
    formatMoney,
    symbolFor,
    displayName
  };

  global.FitShieldCurrency = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
