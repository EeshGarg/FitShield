/**
 * FitShield recipe suggestions.
 *
 * Loads the local recipe catalog (data/recipes.json) and picks a vegetarian and
 * a meat/protein suggestion based on the blocked site's metadata (category,
 * type, specialties). Works in two environments without a build step:
 *   - The block page (warning.html): JSON via fetch(chrome.runtime.getURL(...)).
 *   - Node.js (tests): JSON read from disk with fs.
 *
 * No network calls, no dependencies. The catalog is parsed once and cached.
 */
(function (global) {
  "use strict";

  const RECIPE_FILE = "data/recipes.json";

  let loadedRecipes = [];

  const isExtension =
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    typeof chrome.runtime.getURL === "function";

  async function readRecipeFile() {
    if (isExtension) {
      const response = await fetch(chrome.runtime.getURL(RECIPE_FILE));

      if (!response.ok) {
        throw new Error(`Failed to load ${RECIPE_FILE}: ${response.status}`);
      }

      return response.json();
    }

    const fs = require("fs");
    const path = require("path");
    return JSON.parse(fs.readFileSync(path.join(__dirname, RECIPE_FILE), "utf8"));
  }

  // Load and cache the recipe catalog. Reads only the `recipes` array.
  async function loadRecipes() {
    if (loadedRecipes.length > 0) {
      return loadedRecipes;
    }

    const data = await readRecipeFile();
    loadedRecipes = data && Array.isArray(data.recipes)
      ? data.recipes.filter((recipe) => recipe && typeof recipe === "object")
      : [];
    return loadedRecipes;
  }

  function addTag(set, value) {
    const text = String(value || "").toLowerCase().trim();

    if (!text) {
      return;
    }

    set.add(text);
    // Also index individual words so a specialty like "fried chicken" matches
    // both "fried" and "chicken" recipe tags.
    text.split(/[^a-z0-9]+/).forEach((word) => {
      if (word) {
        set.add(word);
      }
    });
  }

  // Build two tag pools from the blocked-site metadata:
  //   primary   - the food category + searchable specialties (most specific)
  //   secondary - the broad behavior bucket (delivery / fast_food)
  function buildTagSets(info) {
    const primary = new Set();
    const secondary = new Set();

    if (info && typeof info === "object") {
      addTag(primary, info.category);
      (Array.isArray(info.specialties) ? info.specialties : []).forEach((value) => addTag(primary, value));
      addTag(secondary, info.type);
    }

    return { primary, secondary };
  }

  // Small deterministic string hash so the same site shows the same suggestion
  // while different sites vary.
  function hashString(value) {
    const text = String(value || "");
    let hash = 0;

    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }

    return Math.abs(hash);
  }

  function tagsIntersect(recipe, tagSet) {
    return (Array.isArray(recipe.tags) ? recipe.tags : []).some((tag) =>
      tagSet.has(String(tag || "").toLowerCase())
    );
  }

  function chooseForDiet(recipes, diet, tagSets, seed) {
    const pool = recipes.filter((recipe) => recipe.diet === diet);

    if (pool.length === 0) {
      return null;
    }

    // Tier 1: match the specific category / specialties.
    let matches = pool.filter((recipe) => tagsIntersect(recipe, tagSets.primary));

    // Tier 2: fall back to the broad behavior bucket (delivery / fast_food).
    if (matches.length === 0) {
      const combined = new Set([...tagSets.primary, ...tagSets.secondary]);
      matches = pool.filter((recipe) => tagsIntersect(recipe, combined));
    }

    // Tier 3: explicit general-purpose fallbacks.
    if (matches.length === 0) {
      matches = pool.filter((recipe) => (recipe.tags || []).includes("fallback"));
    }

    // Tier 4: anything of the right diet.
    if (matches.length === 0) {
      matches = pool;
    }

    return matches[hashString(`${seed}:${diet}`) % matches.length];
  }

  /**
   * Pick one vegetarian and one meat recipe for the given block metadata.
   * @param {object} info    - { category, type, specialties, key/domain }
   * @param {Array}  [recipes] - defaults to the cached catalog.
   * @param {object} [options] - { seed } overrides the per-site variety seed.
   * @returns {{ vegetarian: object|null, meat: object|null }}
   */
  function selectRecipes(info, recipes, options) {
    const catalog = Array.isArray(recipes) ? recipes : loadedRecipes;
    const opts = options || {};
    const tagSets = buildTagSets(info);
    const seed = opts.seed || (info && (info.key || info.domain || info.label)) || "fitshield";

    return {
      vegetarian: chooseForDiet(catalog, "vegetarian", tagSets, seed),
      meat: chooseForDiet(catalog, "meat", tagSets, seed)
    };
  }

  const api = {
    RECIPE_FILE,
    loadRecipes,
    buildTagSets,
    selectRecipes,
    getLoadedRecipes: () => loadedRecipes.slice()
  };

  global.FitShieldRecipes = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
