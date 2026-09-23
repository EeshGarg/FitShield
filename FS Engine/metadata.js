"use strict";
/**
 * FS Engine — metadata-aware helpers (countries, categories, block policies).
 *
 * All of these are defensive: entries may be plain strings or may be missing
 * `countries`, `category`, or `specialties` without crashing. Like entries.js,
 * everything is stateless — the entry list is always explicit.
 */

// Curated display names. These pin common markets to stable, short English
// forms (and cover any runtime lacking a full-ICU Intl.DisplayNames). Anything
// NOT here is resolved by Intl.DisplayNames — complete for every ISO 3166-1
// alpha-2 code in modern browsers (Chrome/Firefox) and Node 18+ — before
// finally echoing the raw code. So the engine names every country the datasets
// use (111+ and counting) while staying dependency-free. HK is overridden
// because Intl's "Hong Kong SAR China" is too verbose for the picker.
const COUNTRY_NAMES = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
  BR: "Brazil",
  MX: "Mexico",
  IN: "India",
  CN: "China",
  JP: "Japan",
  KR: "South Korea",
  AU: "Australia",
  NZ: "New Zealand",
  IT: "Italy",
  ES: "Spain",
  HK: "Hong Kong"
};

// Memoized Intl.DisplayNames (region type) per locale. Guarded so a runtime
// without Intl.DisplayNames just falls back to the curated map / raw code.
const regionNamerCache = new Map();

function regionNamer(locale) {
  const key = locale || "en";

  if (regionNamerCache.has(key)) {
    return regionNamerCache.get(key);
  }

  let namer = null;
  try {
    if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
      namer = new Intl.DisplayNames([key], { type: "region" });
    }
  } catch (error) {
    namer = null;
  }

  regionNamerCache.set(key, namer);
  return namer;
}

// Display name for an ISO 3166-1 alpha-2 code. English by default (curated short
// forms win); pass a BCP-47 `locale` to localize via Intl. Unknown codes echo.
function getCountryName(code, locale) {
  const normalized = String(code || "").trim().toUpperCase();

  if (!normalized) {
    return "";
  }

  const wantLocale = locale || "en";

  // English: curated short forms win (stable, test-pinned); other locales prefer
  // Intl so the name is actually localized.
  if (wantLocale === "en" && COUNTRY_NAMES[normalized]) {
    return COUNTRY_NAMES[normalized];
  }

  const namer = regionNamer(wantLocale);
  if (namer) {
    try {
      const name = namer.of(normalized);
      if (name && name !== normalized) {
        return name;
      }
    } catch (error) {
      // Invalid code for Intl — fall through to the curated map / raw code.
    }
  }

  return COUNTRY_NAMES[normalized] || normalized;
}

function toCodeSet(values, transform) {
  const set = new Set();

  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = transform(String(value || "").trim());

    if (normalized) {
      set.add(normalized);
    }
  });

  return set;
}

const toUpper = (value) => value.toUpperCase();
const toLower = (value) => value.toLowerCase();

// Discover the distinct country codes present in the blocklist metadata.
// Returns [{ code, name, count }] sorted by display name. Pass a BCP-47 `locale`
// to localize the names (defaults to English).
function getAvailableCountries(entries, locale) {
  const source = Array.isArray(entries) ? entries : [];
  const counts = new Map();

  source.forEach((entry) => {
    const countries = entry && Array.isArray(entry.countries) ? entry.countries : [];

    countries.forEach((rawCode) => {
      const code = String(rawCode || "").trim().toUpperCase();

      if (code) {
        counts.set(code, (counts.get(code) || 0) + 1);
      }
    });
  });

  return [...counts.entries()]
    .map(([code, count]) => ({ code, count, name: getCountryName(code, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Discover the distinct categories present in the blocklist metadata, plus the
// specialties seen under each one (used to make search results richer).
// Returns [{ category, count, specialties }] sorted by category.
function getAvailableCategories(entries) {
  const source = Array.isArray(entries) ? entries : [];
  const info = new Map();

  source.forEach((entry) => {
    const category = entry && typeof entry.category === "string" ? entry.category.trim() : "";

    if (!category) {
      return;
    }

    if (!info.has(category)) {
      info.set(category, { category, count: 0, specialties: new Set() });
    }

    const record = info.get(category);
    record.count += 1;

    const specialties = entry && Array.isArray(entry.specialties) ? entry.specialties : [];
    specialties.forEach((rawSpecialty) => {
      const specialty = String(rawSpecialty || "").trim();

      if (specialty) {
        record.specialties.add(specialty);
      }
    });
  });

  return [...info.values()]
    .map((record) => ({
      category: record.category,
      count: record.count,
      specialties: [...record.specialties]
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Build the country predicate ONCE for a given enabled-country list.
 *
 * The policy itself is unchanged: an entry is active when ANY of its countries
 * is enabled. What changes is where the code set is built. Callers that test a
 * whole catalog — the extension worker tests all ~2,500 entries per rule
 * rebuild — were paying one `new Set()` per entry per predicate, ~5,000 sets per
 * pass and ~10,000 per refresh. Hoisting it is ~4x faster on that pass and stops
 * handing the collector thousands of short-lived objects.
 *
 * No cache and no memoization on purpose: a stale set here would silently change
 * what is blocked, which is the one failure this engine must not have. The set
 * is built when you ask for the predicate, from the list you hand it.
 */
function countryFilter(enabledCountries) {
  const enabled = toCodeSet(enabledCountries, toUpper);

  if (enabled.size === 0) {
    return () => false;
  }

  return (entry) => {
    if (!entry || !Array.isArray(entry.countries) || entry.countries.length === 0) {
      return false;
    }

    return entry.countries.some((code) => enabled.has(String(code || "").trim().toUpperCase()));
  };
}

// The same, for the entry's primary category. Matching is on `category` only
// (specialties stay search-only, per spec).
function categoryFilter(enabledCategories) {
  const enabled = toCodeSet(enabledCategories, toLower);

  if (enabled.size === 0) {
    return () => false;
  }

  return (entry) => {
    if (!entry || typeof entry.category !== "string" || !entry.category.trim()) {
      return false;
    }

    return enabled.has(entry.category.trim().toLowerCase());
  };
}

// True when the entry is active in any of the enabled country codes. A domain
// belonging to multiple countries matches if ANY of them is enabled.
//
// Kept as the documented single-entry form, now expressed through the factory so
// there is exactly one implementation of the policy. Testing many entries against
// one list should use countryFilter directly.
function shouldBlockByCountry(entry, enabledCountries) {
  return countryFilter(enabledCountries)(entry);
}

// True when the entry's primary category is one of the enabled categories.
function shouldBlockByCategory(entry, enabledCategories) {
  return categoryFilter(enabledCategories)(entry);
}

module.exports = {
  getCountryName,
  getAvailableCountries,
  getAvailableCategories,
  countryFilter,
  categoryFilter,
  shouldBlockByCountry,
  shouldBlockByCategory
};
