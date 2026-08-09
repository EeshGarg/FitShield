/**
 * FitShield alternative matching.
 *
 * Answers the only question the block page really has to answer: *this ordering
 * page was interrupted — what should the user do instead, right now?*
 *
 * Everything is local and deterministic. No network, no model, no external API:
 * a set of hard eligibility filters, a transparent additive score, and a stable
 * rotation so asking for "another" walks the ranking instead of shuffling it.
 * The same inputs always produce the same output, which is what makes the
 * behaviour testable and explainable to the user.
 *
 * Runs in the block page (fetch) and in Node (fs), with no build step.
 * Public global: FitShieldRecipes.
 */
(function (global) {
  "use strict";

  const RECIPE_FILE = "data/recipes.json";

  const isExtension =
    typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function";

  // ---------------------------------------------------------------------------
  // Catalog loading
  // ---------------------------------------------------------------------------

  let catalog = null;
  let loadPromise = null;

  async function readCatalogFile() {
    if (isExtension) {
      const response = await fetch(chrome.runtime.getURL(RECIPE_FILE));

      if (!response.ok) {
        throw new Error(`Failed to load ${RECIPE_FILE}: ${response.status}`);
      }

      return response.json();
    }

    // Node (tests / tooling). In the packaged extension data/ sits next to this
    // file; in the repo the catalog is at data/ and this file is extension/.
    const fs = require("fs");
    const path = require("path");
    const candidates = [path.join(__dirname, RECIPE_FILE), path.join(__dirname, "..", RECIPE_FILE)];
    const file = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  // The catalog is parsed once per page and indexed once, so the dataset costs
  // one parse rather than a scan per interaction.
  function indexCatalog(data) {
    const taxonomy = (data && data.taxonomy) || {};
    const entries = [
      ...(Array.isArray(data && data.recipes) ? data.recipes : []),
      ...(Array.isArray(data && data.quickAlternatives) ? data.quickAlternatives : [])
    ].filter((entry) => entry && typeof entry === "object" && entry.id);

    return {
      version: (data && data._version) || "",
      taxonomy: {
        cravings: taxonomy.cravings || [],
        categories: taxonomy.categories || [],
        categoryCravings: taxonomy.categoryCravings || {},
        specialtyCravings: taxonomy.specialtyCravings || {},
        pantryStaples: taxonomy.pantryStaples || [],
        equipment: taxonomy.equipment || []
      },
      entries
    };
  }

  async function loadCatalog() {
    if (catalog) {
      return catalog;
    }

    if (!loadPromise) {
      loadPromise = readCatalogFile()
        .then((data) => {
          catalog = indexCatalog(data);
          return catalog;
        })
        .catch((error) => {
          loadPromise = null;
          throw error;
        });
    }

    return loadPromise;
  }

  // Back-compatible name: earlier builds called this and expected the array.
  async function loadRecipes() {
    return (await loadCatalog()).entries;
  }

  // ---------------------------------------------------------------------------
  // Turning a blocked page into cravings
  // ---------------------------------------------------------------------------

  const normalize = (value) => String(value == null ? "" : value).trim().toLowerCase();

  /**
   * Derive what the user probably wanted from the blocked site's metadata.
   *
   * Specialties are the most specific signal the blocklist carries ("fried
   * chicken", "bubble tea"), the category is the next ("burger", "coffee"), and
   * the rule bucket is the weakest ("delivery"). They are mapped through the
   * catalog's own vocabulary rather than by matching words, which is what stops
   * "chickpea" being read as "chicken".
   */
  function deriveCravings(info, taxonomy) {
    const source = info && typeof info === "object" ? info : {};
    const primary = [];
    const secondary = [];

    const push = (list, value) => {
      if (value && !list.includes(value)) {
        list.push(value);
      }
    };

    (Array.isArray(source.specialties) ? source.specialties : []).forEach((specialty) => {
      (taxonomy.specialtyCravings[normalize(specialty)] || []).forEach((craving) => push(primary, craving));
    });

    (taxonomy.categoryCravings[normalize(source.category)] || []).forEach((craving) => push(secondary, craving));

    // The rule bucket only speaks when nothing more specific did.
    if (primary.length === 0 && secondary.length === 0) {
      const bucket = normalize(source.type) === "delivery" ? "delivery" : "fast_food";
      (taxonomy.categoryCravings[bucket] || []).forEach((craving) => push(secondary, craving));
    }

    return { primary, secondary };
  }

  function categoriesFor(info) {
    const source = info && typeof info === "object" ? info : {};
    const list = [];

    [source.category, source.type].forEach((value) => {
      const clean = normalize(value);
      if (clean && !list.includes(clean)) {
        list.push(clean);
      }
    });

    return list;
  }

  // ---------------------------------------------------------------------------
  // Eligibility
  // ---------------------------------------------------------------------------

  // A user's diet admits everything at least as restrictive as their own.
  // Pescatarian is a special case: it admits vegan and vegetarian, and fish, but
  // never meat — so it is expressed as an explicit set rather than a rank.
  const DIET_ALLOWS = {
    vegan: ["vegan"],
    vegetarian: ["vegan", "vegetarian"],
    pescatarian: ["vegan", "vegetarian", "pescatarian"],
    omnivore: ["vegan", "vegetarian", "pescatarian", "omnivore"]
  };

  function dietAllows(userDiet, entryDiet) {
    const allowed = DIET_ALLOWS[normalize(userDiet)] || DIET_ALLOWS.omnivore;
    return allowed.includes(normalize(entryDiet));
  }

  function equipmentAvailable(entry, equipment) {
    const owned = new Set((Array.isArray(equipment) ? equipment : []).map(normalize));
    const needed = Array.isArray(entry.equipment) ? entry.equipment : [];
    return needed.every((item) => owned.has(normalize(item)));
  }

  function allergenSafe(entry, avoid) {
    const avoidSet = new Set((Array.isArray(avoid) ? avoid : []).map(normalize));

    if (avoidSet.size === 0) {
      return true;
    }

    return !(Array.isArray(entry.allergens) ? entry.allergens : []).some((allergen) =>
      avoidSet.has(normalize(allergen))
    );
  }

  // Named filters the block page exposes as buttons.
  const FILTERS = {
    all: () => true,
    fastest: (entry) => entry.totalMinutes <= 15,
    "no-cook": (entry) => entry.noCook === true,
    microwave: (entry) => entry.microwave === true || entry.noCook === true,
    "air-fryer": (entry) => entry.airFryer === true,
    "one-pan": (entry) => entry.onePan === true,
    "five-minutes": (entry) => entry.totalMinutes <= 5,
    "ten-minutes": (entry) => entry.totalMinutes <= 10,
    "fifteen-minutes": (entry) => entry.totalMinutes <= 15,
    "twenty-five-minutes": (entry) => entry.totalMinutes <= 25
  };

  const FILTER_IDS = Object.keys(FILTERS);

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------
  //
  // Every weight is a plain number here so the ranking can be explained in one
  // screen, in the settings UI, and in the documentation. Higher wins.

  const WEIGHTS = {
    cravingPrimary: 100,   // matches a specialty the blocked brand actually sells
    cravingSecondary: 55,  // matches the brand's broad category
    categoryDirect: 40,    // the entry names this blocked category itself
    pantryItem: 9,         // per pantry staple the user says they keep
    pantryCap: 45,
    pantryFriendly: 10,    // shelf-stable/freezer entries when the pantry is unknown
    favorite: 70,
    timeUnder5: 26,
    timeUnder10: 18,
    timeUnder15: 12,
    timeUnder25: 5,
    lowEffort: 8,          // active effort of 5 minutes or less
    regionMatch: 14,
    quickKind: 6,          // a lightweight alternative when speed is what matters
    recentPenalty: -80,    // shown very recently
    olderRecentPenalty: -30,
    dismissedPenalty: -120,
    customBoost: 25        // the user wrote it themselves
  };

  function pantryScore(entry, pantry) {
    const owned = new Set((Array.isArray(pantry) ? pantry : []).map(normalize));

    if (owned.size === 0) {
      // Nothing declared: prefer things that keep, since they are the ones most
      // likely to actually be in the kitchen right now.
      return entry.pantryFriendly ? WEIGHTS.pantryFriendly : 0;
    }

    const ingredients = (Array.isArray(entry.ingredients) ? entry.ingredients : [])
      .filter((ingredient) => ingredient && !ingredient.optional)
      .map((ingredient) => normalize(ingredient.item));

    let hits = 0;
    owned.forEach((staple) => {
      if (ingredients.some((item) => item.includes(staple) || staple.includes(item))) {
        hits += 1;
      }
    });

    return Math.min(WEIGHTS.pantryCap, hits * WEIGHTS.pantryItem);
  }

  function timeScore(entry) {
    let score = 0;
    const total = Number(entry.totalMinutes) || 0;

    if (total <= 5) {
      score += WEIGHTS.timeUnder5;
    } else if (total <= 10) {
      score += WEIGHTS.timeUnder10;
    } else if (total <= 15) {
      score += WEIGHTS.timeUnder15;
    } else if (total <= 25) {
      score += WEIGHTS.timeUnder25;
    }

    if ((Number(entry.activeMinutes) || 0) <= 5) {
      score += WEIGHTS.lowEffort;
    }

    return score;
  }

  // Small deterministic hash: the same site produces the same ordering between
  // visits, while different sites differ. Used only as a final tiebreaker.
  function hashString(value) {
    const text = String(value || "");
    let hash = 2166136261;

    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return Math.abs(hash | 0);
  }

  function scoreEntry(entry, context) {
    const cravings = new Set((Array.isArray(entry.cravings) ? entry.cravings : []).map(normalize));
    const categories = new Set((Array.isArray(entry.categories) ? entry.categories : []).map(normalize));
    const reasons = [];
    let score = 0;

    const primaryHits = context.cravings.primary.filter((craving) => cravings.has(craving));
    const secondaryHits = context.cravings.secondary.filter((craving) => cravings.has(craving));

    if (primaryHits.length > 0) {
      score += WEIGHTS.cravingPrimary;
      reasons.push({ key: "craving", value: primaryHits[0] });
    } else if (secondaryHits.length > 0) {
      score += WEIGHTS.cravingSecondary;
      reasons.push({ key: "craving", value: secondaryHits[0] });
    }

    if (context.categories.some((category) => categories.has(category))) {
      score += WEIGHTS.categoryDirect;
    }

    const pantry = pantryScore(entry, context.pantry);
    score += pantry;

    if (pantry > 0 && context.pantry.length > 0) {
      reasons.push({ key: "pantry", value: String(Math.round(pantry / WEIGHTS.pantryItem)) });
    }

    score += timeScore(entry);

    if (context.favorites.includes(entry.id)) {
      score += WEIGHTS.favorite;
      reasons.push({ key: "favorite", value: "" });
    }

    if (entry.kind === "custom") {
      score += WEIGHTS.customBoost;
      reasons.push({ key: "custom", value: "" });
    }

    if (context.region && normalize(entry.region) === normalize(context.region)) {
      score += WEIGHTS.regionMatch;
    }

    if (context.preferQuick && entry.kind === "quick") {
      score += WEIGHTS.quickKind;
    }

    // Recency: the most recent handful are pushed down hard so "show another"
    // genuinely moves on, but they are never removed — with a narrow craving the
    // catalog can legitimately run out.
    const recentIndex = context.recent.indexOf(entry.id);
    if (recentIndex !== -1) {
      const fromEnd = context.recent.length - 1 - recentIndex;
      score += fromEnd < 3 ? WEIGHTS.recentPenalty : WEIGHTS.olderRecentPenalty;
    }

    if (context.dismissed.includes(entry.id)) {
      score += WEIGHTS.dismissedPenalty;
      reasons.push({ key: "dismissed", value: "" });
    }

    // Deterministic jitter, small enough that it only separates genuine ties.
    const jitter = hashString(`${context.seed}:${entry.id}`) % 7;

    return { score: score + jitter, reasons };
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  function buildContext(info, settings, options) {
    const config = settings && typeof settings === "object" ? settings : {};
    const opts = options && typeof options === "object" ? options : {};
    const taxonomy = (catalog && catalog.taxonomy) || { categoryCravings: {}, specialtyCravings: {} };

    return {
      cravings: deriveCravings(info, taxonomy),
      categories: categoriesFor(info),
      diet: normalize(config.dietPreference) || "omnivore",
      pantry: Array.isArray(config.pantry) ? config.pantry.map(normalize) : [],
      equipment: Array.isArray(config.equipment) && config.equipment.length > 0 ? config.equipment : null,
      avoidAllergens: Array.isArray(config.avoidAllergens) ? config.avoidAllergens : [],
      favorites: Array.isArray(config.alternativeFavorites) ? config.alternativeFavorites : [],
      recent: Array.isArray(config.recentAlternatives) ? config.recentAlternatives : [],
      dismissed: Array.isArray(config.dismissedAlternatives) ? config.dismissedAlternatives : [],
      region: opts.region || config.region || "",
      preferQuick: opts.intent === "hungry" || opts.filter === "fastest",
      seed: opts.seed || (info && (info.key || info.domain)) || "fitshield"
    };
  }

  /**
   * Rank every alternative for this block.
   *
   * Filters are applied as a chain that RELAXES rather than fails: diet and
   * allergens are absolute, but an equipment, time, or named filter that would
   * leave nothing is dropped and reported in `relaxed`, so the page can say "no
   * five-minute option matched this, here is the closest thing" instead of
   * showing an empty screen.
   *
   * @returns {{ matches: Array, relaxed: string[], total: number, eligible: number }}
   */
  function rankAlternatives(info, settings, options) {
    const opts = options && typeof options === "object" ? options : {};
    const context = buildContext(info, settings, opts);
    const custom = Array.isArray((settings || {}).customAlternatives) ? (settings || {}).customAlternatives : [];
    const pool = [...((catalog && catalog.entries) || []), ...custom];
    const relaxed = [];

    // Absolute: never offer something the user has said they do not eat.
    const eligible = pool.filter(
      (entry) => dietAllows(context.diet, entry.diet) && allergenSafe(entry, context.avoidAllergens)
    );

    let working = eligible;

    const narrow = (predicate, label) => {
      const next = working.filter(predicate);

      if (next.length === 0) {
        relaxed.push(label);
        return;
      }

      working = next;
    };

    if (context.equipment) {
      narrow((entry) => equipmentAvailable(entry, context.equipment), "equipment");
    }

    if (Number.isFinite(Number(opts.maxMinutes))) {
      const limit = Number(opts.maxMinutes);
      narrow((entry) => (Number(entry.totalMinutes) || 0) <= limit, "time");
    }

    const filterId = FILTER_IDS.includes(opts.filter) ? opts.filter : "all";
    if (filterId !== "all") {
      narrow(FILTERS[filterId], filterId);
    }

    const matches = working
      .map((entry) => {
        const { score, reasons } = scoreEntry(entry, context);
        return { entry, score, reasons };
      })
      // Sort by score, then by id, so the order is total and reproducible.
      .sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1));

    return { matches, relaxed, total: pool.length, eligible: eligible.length };
  }

  /**
   * The single best alternative to show, plus how to walk to the next one.
   *
   * `rotation` is an index into the ranked list, so "show another" is a stable
   * step through the ranking rather than a random pick — the user can go back to
   * the same suggestion by stepping back.
   */
  function selectAlternative(info, settings, options) {
    const opts = options && typeof options === "object" ? options : {};
    const ranked = rankAlternatives(info, settings, opts);

    if (ranked.matches.length === 0) {
      return { entry: null, reasons: [], relaxed: ranked.relaxed, index: 0, count: 0, exhausted: true };
    }

    const rotation = Number.isFinite(Number(opts.rotation)) ? Math.max(0, Math.floor(Number(opts.rotation))) : 0;
    const index = rotation % ranked.matches.length;
    const chosen = ranked.matches[index];

    return {
      entry: chosen.entry,
      reasons: chosen.reasons,
      relaxed: ranked.relaxed,
      index,
      count: ranked.matches.length,
      // True once the user has stepped through everything eligible once.
      exhausted: rotation > 0 && rotation >= ranked.matches.length
    };
  }

  /**
   * The three shapes the block page offers for one craving:
   *   closest — the best craving match regardless of effort
   *   fastest — the quickest eligible thing
   *   easiest — the least hands-on thing
   * Duplicates are removed, so a single entry that is all three is returned once.
   */
  function selectTrio(info, settings, options) {
    const ranked = rankAlternatives(info, settings, options);
    const seen = new Set();
    const trio = [];

    const take = (label, list) => {
      const pick = list.find((match) => !seen.has(match.entry.id));

      if (pick) {
        seen.add(pick.entry.id);
        trio.push({ label, entry: pick.entry, reasons: pick.reasons });
      }
    };

    take("closest", ranked.matches);
    take(
      "fastest",
      [...ranked.matches].sort(
        (a, b) => (Number(a.entry.totalMinutes) || 0) - (Number(b.entry.totalMinutes) || 0) || b.score - a.score
      )
    );
    take(
      "easiest",
      [...ranked.matches].sort(
        (a, b) => (Number(a.entry.activeMinutes) || 0) - (Number(b.entry.activeMinutes) || 0) || b.score - a.score
      )
    );

    return trio;
  }

  const api = {
    RECIPE_FILE,
    FILTER_IDS,
    FILTERS,
    WEIGHTS,
    DIET_ALLOWS,
    loadCatalog,
    loadRecipes,
    deriveCravings,
    dietAllows,
    equipmentAvailable,
    buildContext,
    rankAlternatives,
    selectAlternative,
    selectTrio,
    getCatalog: () => catalog
  };

  global.FitShieldRecipes = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
