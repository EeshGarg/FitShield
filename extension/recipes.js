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
        genericCravings: taxonomy.genericCravings || [],
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
   *
   * `taxonomy.genericCravings` are the ones that describe a shape of food
   * rather than a food — comfort, convenience, late-night, high-protein. Each
   * necessarily sits on a quarter or more of the catalog, so a specialty that
   * derives one must not outrank a specialty that derives a real dish. A
   * steakhouse listing "steak, burgers, ribs" derived `burger` AND `comfort` at
   * the same weight, and comfort sits on 28% of the catalog, so the closest
   * answer to a steakhouse was a microwave mug pizza. Generic cravings are
   * therefore demoted to the secondary tier — but only when something specific
   * was derived too, because a plain delivery marketplace has nothing else and
   * must keep its only signal.
   */
  function deriveCravings(info, taxonomy) {
    const source = info && typeof info === "object" ? info : {};
    const generic = new Set((taxonomy.genericCravings || []).map(normalize));
    const primary = [];
    const secondary = [];

    const push = (list, value) => {
      if (value && !list.includes(value)) {
        list.push(value);
      }
    };

    const fromSpecialties = [];
    (Array.isArray(source.specialties) ? source.specialties : []).forEach((specialty) => {
      (taxonomy.specialtyCravings[normalize(specialty)] || []).forEach((craving) => {
        if (!fromSpecialties.includes(craving)) {
          fromSpecialties.push(craving);
        }
      });
    });

    const specific = fromSpecialties.filter((craving) => !generic.has(craving));
    fromSpecialties.forEach((craving) => push(specific.length > 0 && generic.has(craving) ? secondary : primary, craving));

    (taxonomy.categoryCravings[normalize(source.category)] || []).forEach((craving) => push(secondary, craving));

    // The rule bucket only speaks when nothing more specific did.
    if (primary.length === 0 && secondary.length === 0) {
      const bucket = normalize(source.type) === "delivery" ? "delivery" : "fast_food";
      (taxonomy.categoryCravings[bucket] || []).forEach((craving) => push(secondary, craving));
    }

    return { primary, secondary };
  }

  // How well an entry answers the block, on the same two-tier split the scoring
  // uses: 2 = it answers a SPECIALTY the brand actually sells, 1 = it answers
  // the brand's broad category, 0 = it answers neither and is only in the list
  // because nothing better survived the filters.
  const ANSWER_NONE = 0;
  const ANSWER_CATEGORY = 1;
  const ANSWER_SPECIALTY = 2;

  /**
   * Which tier does this entry answer the block at?
   *
   * Two places have to agree on this, and neither used to ask it at all:
   *
   *   1. the `relaxed` signal — a filter that removes every answer to the
   *      craving has to be reported even when it leaves the pool non-empty,
   *      otherwise a pizza order is silently answered with a mango lassi and
   *      the page prints no explanation;
   *   2. the trio — "fastest" and "easiest" have to be the fastest and easiest
   *      ANSWERS, not simply the fastest and easiest rows in the catalog.
   *
   * Deliberately craving-only. A direct `categories` hit still scores, but
   * those are broad groupings (39% of the catalog carries `delivery`), so
   * treating one as an answer would make almost everything an answer and mean
   * nothing.
   */
  function answerTier(entry, cravings) {
    const tags = new Set((Array.isArray(entry && entry.cravings) ? entry.cravings : []).map(normalize));
    const wanted = cravings || { primary: [], secondary: [] };

    if ((wanted.primary || []).some((craving) => tags.has(craving))) {
      return ANSWER_SPECIALTY;
    }

    if ((wanted.secondary || []).some((craving) => tags.has(craving))) {
      return ANSWER_CATEGORY;
    }

    return ANSWER_NONE;
  }

  const bestAnswerTier = (list, cravings) =>
    list.reduce((best, entry) => Math.max(best, answerTier(entry, cravings)), ANSWER_NONE);

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

  // The appliance vocabulary, so a substitution can be read for one by name.
  const APPLIANCES = ["microwave", "stove", "oven", "air fryer", "toaster", "blender", "rice cooker", "kettle"];

  /**
   * Can this kitchen make this entry?
   *
   * `equipment` is AND — an entry listing oven AND air fryer needs both. But an
   * entry that lists ONE appliance and then carries a substitution telling you
   * how to do it with another is genuinely makeable by someone who owns the
   * other one, and the entry says so in its own words.
   *
   * Without this, declaring a single appliance per entry (the fix for entries
   * that previously listed two alternatives as if both were required) made them
   * invisible in the opposite direction: the oven fries vanished for an
   * air-fryer-only kitchen even though the recipe's own substitution line reads
   * "air fryer at 200 C for 18 minutes". The data already knew; the filter did
   * not read it.
   */
  function equipmentAvailable(entry, equipment) {
    const owned = new Set((Array.isArray(equipment) ? equipment : []).map(normalize));
    const needed = Array.isArray(entry.equipment) ? entry.equipment : [];
    const swaps = Array.isArray(entry.substitutions) ? entry.substitutions : [];

    return needed.every((item) => {
      if (owned.has(normalize(item))) {
        return true;
      }

      const swap = swaps.find((entry_) => entry_ && normalize(entry_.for) === normalize(item));

      if (!swap) {
        return false;
      }

      // The swap counts only if it names an appliance this kitchen actually has.
      const how = normalize(swap.use);
      return APPLIANCES.some((appliance) => owned.has(appliance) && how.includes(appliance));
    });
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

  /**
   * How well this entry matches what the user says they keep.
   *
   * Returns the score AND the hit count, because the block page shows the count
   * to the user ("uses 3 things you keep"). Deriving it back out of the score
   * got it wrong twice over: the shelf-stable consolation bonus, which is not a
   * pantry match at all, read as one hit, and any entry past the cap under-
   * reported. The count is now the thing that was actually counted.
   *
   * @returns {{ score: number, hits: number }}
   */
  function pantryScore(entry, pantry) {
    const owned = new Set((Array.isArray(pantry) ? pantry : []).map(normalize).filter(Boolean));

    if (owned.size === 0) {
      // Nothing declared: prefer things that keep, since they are the ones most
      // likely to actually be in the kitchen right now.
      return { score: entry.pantryFriendly ? WEIGHTS.pantryFriendly : 0, hits: 0 };
    }

    // Two shapes reach this: catalog entries carry structured ingredients
    // ({ quantity, unit, item }), while a user's own alternative stores plain
    // strings. Reading only `.item` left every custom entry with a list of
    // empty strings — and `staple.includes("")` is true for every staple, so a
    // custom alternative scored a FULL pantry match whatever was in it, and the
    // block page told the user it "uses 5 things you keep" about a dish it had
    // never looked at. Empties are dropped, and both shapes match on their text.
    const ingredients = (Array.isArray(entry.ingredients) ? entry.ingredients : [])
      .filter((ingredient) => ingredient && !ingredient.optional)
      .map((ingredient) => normalize(typeof ingredient === "string" ? ingredient : ingredient.item))
      .filter(Boolean);

    let hits = 0;
    owned.forEach((staple) => {
      if (ingredients.some((item) => item.includes(staple) || staple.includes(item))) {
        hits += 1;
      }
    });

    return { score: Math.min(WEIGHTS.pantryCap, hits * WEIGHTS.pantryItem), hits };
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
    score += pantry.score;

    if (pantry.hits > 0) {
      reasons.push({ key: "pantry", value: String(pantry.hits) });
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

    return {
      score: score + jitter,
      reasons,
      tier: primaryHits.length > 0 ? ANSWER_SPECIALTY : secondaryHits.length > 0 ? ANSWER_CATEGORY : ANSWER_NONE
    };
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

      // The filter is real and it stays — a kitchen with no oven genuinely
      // cannot bake, and offering something the user cannot make is worse than
      // saying so. But a filter that leaves the pool full while knocking the
      // best answer DOWN A TIER has to be reported too. Without this, a
      // blender-only kitchen blocked on a pizza order lost all five pizza
      // entries and was handed a cottage cheese bowl with `relaxed: []`, so
      // the page printed no reason at all and the suggestion read as random.
      if (
        !relaxed.includes(label) &&
        bestAnswerTier(next, context.cravings) < bestAnswerTier(working, context.cravings)
      ) {
        relaxed.push(label);
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
        const { score, reasons, tier } = scoreEntry(entry, context);
        return { entry, score, reasons, tier };
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

    // All three slots are drawn from the entries that actually ANSWER the block,
    // at the best tier available — a specialty answer if there is one, the
    // brand's category otherwise, and only then the whole ranking.
    //
    // The fastest and easiest slots used to sort the whole eligible pool by
    // elapsed and active time, with the score only as a tiebreak. Elapsed time
    // has nothing to do with the craving, so the sort returned the catalog's
    // global minimum every single time: McDonald's, Domino's, Taco Bell, KFC,
    // Subway, Gong Cha, Baskin-Robbins and a salad chain ALL produced
    // "Two-Minute Iced Coffee" in the fastest slot. One of the three shapes the
    // page offers was a constant, and the docstring above it claimed all three
    // answered "one craving".
    //
    // Tiering matters as much as filtering: a salad chain derives `salad` from
    // its specialty and `rice-bowl`/`sandwich` from its `fast_casual` category,
    // and the category answers are the quicker ones — so a flat "is it an
    // answer" test still filled two of three slots with a turkey sandwich and a
    // rice bowl for a salad order.
    const byTier = [ANSWER_SPECIALTY, ANSWER_CATEGORY]
      .map((tier) => ranked.matches.filter((match) => match.tier === tier))
      .find((list) => list.length > 0);
    const pool = byTier || ranked.matches;

    const take = (label, list) => {
      const pick = list.find((match) => !seen.has(match.entry.id));

      if (pick) {
        seen.add(pick.entry.id);
        trio.push({ label, entry: pick.entry, reasons: pick.reasons });
      }
    };

    take("closest", pool);
    take(
      "fastest",
      [...pool].sort(
        (a, b) => (Number(a.entry.totalMinutes) || 0) - (Number(b.entry.totalMinutes) || 0) || b.score - a.score
      )
    );
    take(
      "easiest",
      [...pool].sort(
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
