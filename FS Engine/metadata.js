"use strict";
/**
 * FS Engine — metadata-aware helpers (countries, categories, block policies).
 *
 * All of these are defensive: entries may be plain strings or may be missing
 * `countries`, `category`, or `specialties` without crashing. Like entries.js,
 * everything is stateless — the entry list is always explicit.
 */

// Minimal ISO code -> display name map for the codes used in the blocklists.
// Unknown codes fall back to the code itself, so adding new codes never breaks.
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
  ES: "Spain"
};

function getCountryName(code) {
  const normalized = String(code || "").trim().toUpperCase();
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
// Returns [{ code, name, count }] sorted by display name.
function getAvailableCountries(entries) {
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
    .map(([code, count]) => ({ code, count, name: getCountryName(code) }))
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

// True when the entry is active in any of the enabled country codes. A domain
// belonging to multiple countries matches if ANY of them is enabled.
function shouldBlockByCountry(entry, enabledCountries) {
  if (!entry || !Array.isArray(entry.countries) || entry.countries.length === 0) {
    return false;
  }

  const enabled = toCodeSet(enabledCountries, toUpper);

  if (enabled.size === 0) {
    return false;
  }

  return entry.countries.some((code) => enabled.has(String(code || "").trim().toUpperCase()));
}

// True when the entry's primary category is one of the enabled categories.
// Matching is on `category` only (specialties stay search-only, per spec).
function shouldBlockByCategory(entry, enabledCategories) {
  if (!entry || typeof entry.category !== "string" || !entry.category.trim()) {
    return false;
  }

  const enabled = toCodeSet(enabledCategories, toLower);

  if (enabled.size === 0) {
    return false;
  }

  return enabled.has(entry.category.trim().toLowerCase());
}

module.exports = {
  getCountryName,
  getAvailableCountries,
  getAvailableCategories,
  shouldBlockByCountry,
  shouldBlockByCategory
};
