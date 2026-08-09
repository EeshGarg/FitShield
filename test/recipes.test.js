"use strict";
/**
 * Alternatives catalog: data contract and quality gates.
 *
 * NOTE ON SCOPE: this replaces an earlier version that asserted the v1 schema
 * (`timeMinutes`, a `calories` integer, a two-value `diet` enum) and the old
 * `selectRecipes` API, which returned exactly one vegetarian and one meat
 * suggestion. Neither exists any more, and neither could express what the
 * product needs: quantities, servings, effort separate from elapsed time,
 * allergens, equipment, vegan and pescatarian diets, or lightweight
 * alternatives. Matching behaviour now lives in test/matching.test.js; the
 * per-entry semantic rules live in tools/alternatives-audit.js, which this file
 * runs as part of the suite.
 *
 * What is asserted here is the CONTRACT the runtime depends on: the file parses,
 * carries the schema version the loader expects, is freshly generated from its
 * sources, and is genuinely usable by someone who has never cooked the dish.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const recipes = require("../extension/recipes.js");
const alternativesAudit = require("../tools/alternatives-audit.js");
const generator = require("../tools/build-alternatives.js");

const CATALOG = path.join(__dirname, "..", "data", "recipes.json");
const data = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const ALL = [...data.recipes, ...data.quickAlternatives];

// ---------------------------------------------------------------------------
// File contract
// ---------------------------------------------------------------------------

test("the catalog is valid JSON with the schema version the loader expects", () => {
  assert.equal(data._version, "2.0");
  assert.ok(Array.isArray(data.recipes));
  assert.ok(Array.isArray(data.quickAlternatives));
  assert.ok(data.taxonomy && typeof data.taxonomy === "object");
});

test("the shipped catalog is freshly generated from its sources", () => {
  assert.equal(
    generator.isStale(),
    false,
    "data/recipes.json is out of date — run `npm run generate:alternatives`"
  );
});

test("the declared counts match the actual contents", () => {
  assert.equal(data._counts.recipes, data.recipes.length);
  assert.equal(data._counts.quickAlternatives, data.quickAlternatives.length);
  assert.equal(data._counts.total, ALL.length);
});

test("there are at least 60 alternatives, of both kinds", () => {
  assert.ok(ALL.length >= 60, `expected 60+ alternatives, got ${ALL.length}`);
  assert.ok(data.recipes.length >= 30, "there must be a substantial body of full recipes");
  assert.ok(data.quickAlternatives.length >= 15, "and a real set of lightweight alternatives");
});

// ---------------------------------------------------------------------------
// Every entry is executable
// ---------------------------------------------------------------------------

test("every entry has a stable id, a title, servings, and a data version", () => {
  const ids = new Set();

  ALL.forEach((entry) => {
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]*$/, `bad id: ${entry.id}`);
    assert.ok(!ids.has(entry.id), `duplicate id: ${entry.id}`);
    ids.add(entry.id);

    assert.ok(entry.title && entry.title.length > 0, `${entry.id} has no title`);
    assert.ok(entry.servings > 0, `${entry.id} has no servings`);
    assert.equal(entry.dataVersion, 2, `${entry.id} has the wrong dataVersion`);
    assert.ok(["recipe", "quick"].includes(entry.kind), `${entry.id} has an unknown kind`);
  });
});

test("every ingredient carries an exact quantity and unit", () => {
  ALL.forEach((entry) => {
    assert.ok(entry.ingredients.length > 0, `${entry.id} has no ingredients`);

    entry.ingredients.forEach((ingredient) => {
      assert.ok(
        Number.isFinite(ingredient.quantity) && ingredient.quantity > 0,
        `${entry.id}: "${ingredient.item}" has no quantity — the recipe is not executable`
      );
      assert.ok(ingredient.unit && ingredient.unit.length > 0, `${entry.id}: "${ingredient.item}" has no unit`);
      assert.ok(ingredient.item && ingredient.item.length > 0, `${entry.id} has an unnamed ingredient`);
    });
  });
});

test("no step is vague — nothing says 'until done' or 'season as desired'", () => {
  const VAGUE = /\b(until done|until ready|as desired|prepare normally|add the ingredients)\b/i;

  ALL.forEach((entry) => {
    assert.ok(entry.steps.length > 0, `${entry.id} has no steps`);

    entry.steps.forEach((step, index) => {
      assert.ok(step.trim().length > 0, `${entry.id}: step ${index + 1} is empty`);
      assert.doesNotMatch(step, VAGUE, `${entry.id}: step ${index + 1} is not actionable`);
    });
  });
});

test("active effort is separate from, and never greater than, elapsed time", () => {
  ALL.forEach((entry) => {
    assert.ok(entry.totalMinutes > 0, `${entry.id} has no total time`);
    assert.ok(entry.activeMinutes > 0, `${entry.id} has no active time`);
    assert.ok(
      entry.activeMinutes <= entry.totalMinutes,
      `${entry.id}: ${entry.activeMinutes} min hands-on cannot exceed ${entry.totalMinutes} min total`
    );
  });
});

test("full recipes split preparation from cooking; quick alternatives do not have to", () => {
  data.recipes.forEach((entry) => {
    assert.ok(Number.isFinite(entry.prepMinutes), `${entry.id} has no prepMinutes`);
    assert.ok(Number.isFinite(entry.cookMinutes), `${entry.id} has no cookMinutes`);
  });

  data.quickAlternatives.forEach((entry) => {
    assert.ok(entry.steps.length <= 4, `${entry.id} has ${entry.steps.length} steps — that is a recipe, not a quick fix`);
  });
});

test("calorie figures are honest ranges, never a single fake-precise number", () => {
  ALL.forEach((entry) => {
    if (entry.calorieRange === undefined) {
      return;
    }

    assert.ok(Array.isArray(entry.calorieRange), `${entry.id}: calorieRange must be an array`);
    assert.equal(entry.calorieRange.length, 2, `${entry.id}: calorieRange must be [low, high]`);
    assert.ok(
      entry.calorieRange[1] - entry.calorieRange[0] >= 20,
      `${entry.id}: a ${entry.calorieRange[1] - entry.calorieRange[0]}-calorie range is false precision`
    );
  });

  // No entry may carry a bare `calories` number — that was the v1 mistake.
  ALL.forEach((entry) => {
    assert.equal(entry.calories, undefined, `${entry.id} still has a single calories value`);
  });
});

// ---------------------------------------------------------------------------
// Semantic correctness (the tagging mistakes this dataset has actually had)
// ---------------------------------------------------------------------------

test("no vegetarian entry contains meat, and no vegan entry contains an animal product", () => {
  const MEAT = /\b(beef|pork|bacon|ham|chicken|turkey|lamb|duck|sausage|salami|pepperoni|prosciutto|chorizo)\b/i;
  const ANIMAL = /\b(milk|butter|cheese|yogurt|cream|paneer|feta|mozzarella|parmesan|ghee|egg|eggs|honey|mayonnaise)\b/i;
  const PLANT = /\b(plant|oat|soy|almond|coconut|dairy-free|vegan|nut|peanut)\b/i;

  ALL.forEach((entry) => {
    const required = entry.ingredients.filter((ingredient) => !ingredient.optional).map((i) => i.item.toLowerCase());

    if (entry.diet === "vegetarian" || entry.diet === "vegan") {
      required.forEach((item) => {
        assert.doesNotMatch(item, MEAT, `${entry.id} is ${entry.diet} but requires "${item}"`);
      });
    }

    if (entry.diet === "vegan") {
      required.forEach((item) => {
        if (PLANT.test(item)) return;
        assert.doesNotMatch(item, ANIMAL, `${entry.id} is vegan but requires "${item}"`);
      });
    }
  });
});

test("a chickpea or tofu dish is never presented as a chicken dish", () => {
  const chickenCravings = ["fried-chicken", "chicken-sandwich", "wings"];

  ALL.forEach((entry) => {
    const answersChicken = entry.cravings.some((craving) => chickenCravings.includes(craving));

    if (!answersChicken) {
      return;
    }

    const hasChicken = entry.ingredients.some((ingredient) => /\bchicken\b/i.test(ingredient.item));

    if (hasChicken) {
      return;
    }

    // A plant stand-in may answer the craving, but it has to say that it is one.
    const declares = /substitute|instead of|plant|alternative|not a chicken/i.test(
      `${entry.title} ${entry.description} ${JSON.stringify(entry.substitutions)}`
    );
    assert.ok(declares, `${entry.id} answers a chicken craving with no chicken and no stated substitution`);
  });
});

test("a smoothie is never categorised or tagged as coffee", () => {
  ALL.forEach((entry) => {
    if (!/smoothie|nice cream/i.test(entry.title)) {
      return;
    }

    const hasCoffee = entry.ingredients.some((ingredient) => /coffee|espresso/i.test(ingredient.item));

    if (hasCoffee) {
      return;
    }

    assert.ok(!entry.cravings.includes("coffee"), `${entry.id} is a smoothie tagged as a coffee craving`);
    assert.ok(!entry.categories.includes("coffee"), `${entry.id} is a smoothie categorised as coffee`);
  });
});

test("dessert tags do not leak onto savoury food", () => {
  const SWEET = /sugar|cocoa|chocolate|honey|syrup|banana|berries|berry|fruit|granola|yogurt|ice|apple|pear|mango/i;

  ALL.forEach((entry) => {
    if (!entry.cravings.includes("dessert") && !entry.cravings.includes("ice-cream")) {
      return;
    }

    const looksSweet = entry.ingredients
      .filter((ingredient) => !ingredient.optional)
      .some((ingredient) => SWEET.test(ingredient.item));

    assert.ok(looksSweet, `${entry.id} is tagged as a dessert but has no sweet ingredient`);
  });
});

test("every entry declares the allergens its required ingredients contain", () => {
  // A spot check on the highest-consequence allergens; the full matrix is in the
  // audit, which this file also runs.
  const CHECKS = [
    [/\bpeanut\b/i, "peanut"],
    [/\btofu\b|\bsoy sauce\b/i, "soy"],
    [/\btahini\b|\bsesame\b/i, "sesame"]
  ];

  ALL.forEach((entry) => {
    entry.ingredients
      .filter((ingredient) => !ingredient.optional)
      .forEach((ingredient) => {
        CHECKS.forEach(([pattern, allergen]) => {
          if (pattern.test(ingredient.item)) {
            assert.ok(
              entry.allergens.includes(allergen),
              `${entry.id} requires "${ingredient.item}" but does not declare ${allergen}`
            );
          }
        });
      });
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test("every craving in the taxonomy has more than one answer", () => {
  const counts = new Map();
  ALL.forEach((entry) => {
    entry.cravings.forEach((craving) => counts.set(craving, (counts.get(craving) || 0) + 1));
  });

  data.taxonomy.cravings.forEach((craving) => {
    const count = counts.get(craving) || 0;
    assert.ok(count >= 2, `craving "${craving}" has ${count} answer(s) — "show another" would have nothing to show`);
  });
});

test("every major blocked category reaches an answer", () => {
  const cravings = new Set(ALL.flatMap((entry) => entry.cravings));

  Object.entries(data.taxonomy.categoryCravings).forEach(([category, mapped]) => {
    assert.ok(
      mapped.some((craving) => cravings.has(craving)),
      `blocked category "${category}" maps to nothing that exists`
    );
  });
});

test("ingredient names read correctly with the quantity in front of them", () => {
  // The block page drops the bare "piece" counter, so a count greater than one
  // must read naturally on its own: "2 naan breads", never "2 naan bread".
  const wrong = [];

  ALL.forEach((entry) => {
    entry.ingredients.forEach((ingredient) => {
      if (ingredient.unit !== "piece" || ingredient.quantity <= 1) {
        return;
      }

      // "roti or flatbread"-style alternatives are plural if either side is.
      const looksPlural = ingredient.item.split(" or ").every((part) => /s$/.test(part.trim()));

      if (!looksPlural) {
        wrong.push(`${entry.id}: "${ingredient.quantity} ${ingredient.item}"`);
      }
    });
  });

  assert.deepEqual(wrong, [], `singular ingredient names used with a plural count:\n  ${wrong.join("\n  ")}`);
});

test("one ingredient concept has one name across the catalog", () => {
  // Divergent names for the same thing break both the pantry match and the
  // allergen exceptions (the corn form is what makes tortilla chips gluten-free).
  const names = new Set();
  ALL.forEach((entry) => entry.ingredients.forEach((ingredient) => names.add(ingredient.item.toLowerCase())));

  const CANONICAL = [
    { pattern: /tortilla chips?$/, expect: "corn tortilla chips" }
  ];

  CANONICAL.forEach(({ pattern, expect }) => {
    const variants = [...names].filter((name) => pattern.test(name));
    assert.deepEqual(variants, [expect], `expected one name for ${expect}, found: ${variants.join(", ")}`);
  });
});

test("no step treats an optional ingredient as required", () => {
  const problems = [];

  ALL.forEach((entry) => {
    const steps = entry.steps.join(" ").toLowerCase();

    entry.ingredients
      .filter((ingredient) => ingredient.optional)
      .forEach((ingredient) => {
        const word = ingredient.item.toLowerCase().split(" ").find((part) => part.length > 4);

        if (!word) {
          return;
        }

        // Flag an unconditional imperative; a step that says "if you have it",
        // "if using", or "optional" is fine.
        const unconditional = new RegExp(`\\b(add|stir in|mix in|whisk in) the ${word}\\b`).test(steps);
        const hedged = /if you (are using|have|want)|if using|optional/.test(steps);

        if (unconditional && !hedged) {
          problems.push(`${entry.id}: "${ingredient.item}"`);
        }
      });
  });

  assert.deepEqual(problems, [], `optional ingredients used unconditionally:\n  ${problems.join("\n  ")}`);
});

test("every craving has a vegetarian answer", () => {
  const missing = [];

  data.taxonomy.cravings.forEach((craving) => {
    const matches = ALL.filter((entry) => entry.cravings.includes(craving));
    const vegetarian = matches.filter((entry) => ["vegan", "vegetarian"].includes(entry.diet));

    if (vegetarian.length === 0) {
      missing.push(craving);
    }
  });

  assert.deepEqual(missing, [], `cravings with nothing a vegetarian can eat: ${missing.join(", ")}`);
});

test("every craving has an answer that needs no stove or oven, except the fried ones", () => {
  // You cannot make a burger, fried chicken, wings, or chips in a microwave.
  // Pretending otherwise would be the kind of invented answer this catalog
  // exists to avoid, so these four are documented exceptions rather than gaps.
  // The matcher relaxes the equipment filter for them and says that it did.
  const CANNOT_BE_DONE_WITHOUT_HEAT = ["burger", "fried-chicken", "wings", "fries"];
  const missing = [];

  data.taxonomy.cravings.forEach((craving) => {
    if (CANNOT_BE_DONE_WITHOUT_HEAT.includes(craving)) {
      return;
    }

    const matches = ALL.filter((entry) => entry.cravings.includes(craving));
    const stoveFree = matches.filter(
      (entry) => entry.noCook || entry.equipment.every((item) => ["microwave", "kettle", "toaster"].includes(item))
    );

    if (stoveFree.length === 0) {
      missing.push(craving);
    }
  });

  assert.deepEqual(missing, [], `cravings a microwave-only kitchen cannot answer: ${missing.join(", ")}`);
});

test("a plant answer to a chicken or wings craving says that it is a substitute", () => {
  ALL.filter((entry) => entry.cravings.some((c) => ["fried-chicken", "chicken-sandwich", "wings"].includes(c)))
    .filter((entry) => !entry.ingredients.some((i) => /\bchicken\b/i.test(i.item)))
    .forEach((entry) => {
      assert.match(
        `${entry.title} ${entry.description}`,
        /substitute|alternative|instead of|plant/i,
        `${entry.id} answers a chicken craving without saying it is a stand-in`
      );
    });
});

test("a vegetarian, a vegan, and a microwave-only kitchen all have real choice", () => {
  const vegetarian = ALL.filter((entry) => ["vegan", "vegetarian"].includes(entry.diet));
  const vegan = ALL.filter((entry) => entry.diet === "vegan");
  const noStove = ALL.filter(
    (entry) => entry.noCook || entry.equipment.every((item) => ["microwave", "kettle", "toaster"].includes(item))
  );

  assert.ok(vegetarian.length >= 20, `only ${vegetarian.length} vegetarian-or-stricter entries`);
  assert.ok(vegan.length >= 8, `only ${vegan.length} vegan entries`);
  assert.ok(noStove.length >= 12, `only ${noStove.length} entries need no stove or oven`);
});

test("cultural coverage is not exclusively North American", () => {
  const byRegion = new Map();
  ALL.forEach((entry) => byRegion.set(entry.region, (byRegion.get(entry.region) || 0) + 1));

  const REQUIRED = ["north-american", "east-asian", "south-asian", "latin-american", "mediterranean", "middle-eastern", "european"];
  REQUIRED.forEach((region) => {
    assert.ok((byRegion.get(region) || 0) > 0, `no alternatives from "${region}"`);
  });

  const northAmerican = byRegion.get("north-american") || 0;
  assert.ok(northAmerican / ALL.length < 0.5, `${northAmerican}/${ALL.length} entries are North American — too narrow`);
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

test("the Node loader returns the whole catalog with both kinds", async () => {
  const entries = await recipes.loadRecipes();

  assert.ok(entries.length >= 60);
  assert.ok(entries.some((entry) => entry.kind === "recipe"));
  assert.ok(entries.some((entry) => entry.kind === "quick"));
});

test("the catalog is parsed once and cached", async () => {
  const first = await recipes.loadCatalog();
  const second = await recipes.loadCatalog();

  assert.equal(first, second, "a second load must reuse the parsed catalog");
});

// ---------------------------------------------------------------------------
// The audit itself runs in the suite
// ---------------------------------------------------------------------------

test("the alternatives audit reports no errors", () => {
  const reporter = alternativesAudit();

  assert.deepEqual(
    reporter.errors,
    [],
    `alternatives audit found errors:\n  ${reporter.errors.join("\n  ")}`
  );
});

test("the alternatives audit distinguishes warnings from errors", () => {
  const reporter = alternativesAudit();

  // Fuzzy, natural-language findings must be warnings — a weak word-match guess
  // must never be able to stop a release.
  assert.ok(Array.isArray(reporter.warnings));
  assert.ok(reporter.notes.length > 0, "the audit produces a human-readable summary");
});

// ---------------------------------------------------------------------------
// Honesty of the catalog's own claims
//
// Every test below exists because the catalog once failed it. They are grouped
// here rather than spread through the file so that the standard they encode —
// a tag, a time, and a sentence on a card are promises to the user — is
// readable in one place.
// ---------------------------------------------------------------------------

// A salad group is easy to inflate: tag anything cold and the headline count
// doubles. It had 7 entries of which 2 were salads; a Sweetgreen interruption
// answered "cold sesame noodles". A salad-tagged entry must therefore both call
// itself a salad and be built on something you would find in one.
test("every salad-tagged entry is really a salad", () => {
  const RAW_VEGETABLE = /\b(salad|lettuce|leaves|rocket|romaine|cos|spinach|cabbage|cucumber|tomato|tomatoes|greens)\b/i;
  const salads = ALL.filter((entry) => entry.cravings.includes("salad"));
  const problems = [];

  salads.forEach((entry) => {
    if (!/salad/i.test(`${entry.title} ${entry.description}`)) {
      problems.push(`${entry.id}: tagged salad but never calls itself one`);
    }

    const hasVegetable = entry.ingredients
      .filter((ingredient) => !ingredient.optional)
      .some((ingredient) => RAW_VEGETABLE.test(ingredient.item));

    if (!hasVegetable) {
      problems.push(`${entry.id}: tagged salad but no required ingredient is a leaf or raw vegetable`);
    }
  });

  assert.deepEqual(problems, [], `padded salad group:\n  ${problems.join("\n  ")}`);
  assert.ok(salads.length >= 4, `only ${salads.length} real salads — the group needs genuine depth, not tags`);
});

// "late-night" was on 37% of the catalog. A tag that broad is not a craving, it
// is noise, and because a primary craving hit scores the same as a real
// specialty match it displaced correct answers. Two rules keep it honest: it
// only goes on things that are actually fast, and it stays a minority tag.
test("late-night is a narrow tag, not a wildcard over the catalog", () => {
  const lateNight = ALL.filter((entry) => entry.cravings.includes("late-night"));
  const slow = lateNight.filter((entry) => entry.totalMinutes > 15).map((entry) => `${entry.id} (${entry.totalMinutes} min)`);

  assert.deepEqual(slow, [], `a 26-minute recipe is not a late-night answer:\n  ${slow.join("\n  ")}`);
  assert.ok(
    lateNight.length / ALL.length <= 0.22,
    `late-night is on ${lateNight.length}/${ALL.length} entries — that is a wildcard, not a craving`
  );
});

// A vegetarian chip on "Frozen Pizza, Made Better" is a promise about a box the
// recipe cannot see inside. Claiming a diet for a generic packaged product is
// allowed only when the entry tells the reader to check it.
test("a diet claimed over a generic packaged product carries a check-the-label caveat", () => {
  const PACKAGED = /\b(frozen pizza|instant noodles|canned soup|frozen dumplings|dumpling wrappers|curry paste|pesto)\b/i;
  const problems = [];

  ALL.filter((entry) => entry.diet !== "omnivore").forEach((entry) => {
    entry.ingredients
      .filter((ingredient) => !ingredient.optional && PACKAGED.test(ingredient.item))
      .forEach((ingredient) => {
        const stated = `${ingredient.note || ""} ${JSON.stringify(entry.substitutions)}`;

        if (!/check the (label|packet|box|sachet)/i.test(stated)) {
          problems.push(`${entry.id}: "${ingredient.item}" is labelled ${entry.diet} with no check-the-label note`);
        }
      });
  });

  assert.deepEqual(problems, [], `unverifiable diet claims:\n  ${problems.join("\n  ")}`);
});

// totalMinutes is "elapsed time from starting to eating" — the number the block
// page leads with and the whole basis of the "Fastest" filter. It once excluded
// the 10-15 minutes an oven takes to reach 230 C and the 6-8 minutes a pan of
// water takes to boil, so a "12 min" pasta really took twenty.
test("elapsed time includes heating the oven and boiling the water", () => {
  const OVEN_PREHEAT = /heat the oven/i;
  const POT_OF_WATER = /\bboil the (spaghetti|pasta|noodles)\b/i;
  const problems = [];

  ALL.forEach((entry) => {
    const steps = entry.steps.join(" ");

    // A domestic oven needs 10-15 minutes to come up to a pizza temperature, so
    // nothing that starts by heating one can honestly claim under twenty.
    if (OVEN_PREHEAT.test(steps) && entry.totalMinutes < 20) {
      problems.push(`${entry.id}: heats an oven from cold but claims ${entry.totalMinutes} min`);
    }

    // A full pan of water is 6-8 minutes before the pasta even goes in.
    if (POT_OF_WATER.test(steps) && entry.totalMinutes < 18) {
      problems.push(`${entry.id}: boils a pan of water but claims ${entry.totalMinutes} min`);
    }
  });

  assert.deepEqual(problems, [], `times that exclude the waiting:\n  ${problems.join("\n  ")}`);
});

// The description is the first sentence of the card and the ingredient list is
// printed directly beneath it. "Two frozen bananas… One ingredient" above a list
// starting "3 bananas" is a small lie in exactly the place this product needs to
// be believed.
test("a number stated in a description matches the data beneath it", () => {
  const WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
    "twenty-five": 25, thirty: 30, forty: 40, sixty: 60, ninety: 90
  };
  const value = (word) => (WORDS[word.toLowerCase()] !== undefined ? WORDS[word.toLowerCase()] : (/^\d+$/.test(word) ? Number(word) : null));
  const problems = [];

  ALL.forEach((entry) => {
    // Only an explicit "N ingredients" claim is checked. "a sauce from four
    // things" is prose about part of the dish, not a count of the whole list.
    const counted = entry.description.match(/([A-Za-z-]+|\d+)\s+(?:pantry\s+)?ingredients?\b/i);

    if (counted) {
      const claimed = value(counted[1]);
      const required = entry.ingredients.filter((ingredient) => !ingredient.optional).length;

      if (claimed !== null && claimed !== required) {
        problems.push(`${entry.id}: description says "${counted[0]}" over a list of ${required}`);
      }
    }

    const times = entry.description.matchAll(/([A-Za-z-]+|\d+)[\s-](minutes?|seconds?)\b/gi);

    for (const match of times) {
      const claimed = value(match[1]);

      if (claimed === null) {
        continue;
      }

      const minutes = /second/i.test(match[2]) ? claimed / 60 : claimed;
      // For a make-ahead entry the honest headline is the hands-on work, not
      // the four hours it spends in the fridge.
      const makeAhead = entry.totalMinutes - entry.activeMinutes > 60;
      const limit = makeAhead ? entry.activeMinutes : entry.totalMinutes;

      if (minutes < limit) {
        problems.push(`${entry.id}: description promises "${match[0]}" for a ${limit}-minute job`);
      }
    }
  });

  assert.deepEqual(problems, [], `descriptions that contradict the data:\n  ${problems.join("\n  ")}`);
});

// The blended mocha listed its coffee as "cooled" and then told the cook to
// whisk cocoa "into the warm coffee" — a two-line contradiction on a five-minute
// recipe, and the recipe itself explains that getting it wrong ruins the drink.
test("no ingredient note contradicts the step that uses it", () => {
  const problems = [];

  ALL.forEach((entry) => {
    entry.ingredients.forEach((ingredient) => {
      if (!/\bcool(ed)?\b|\bcold\b/i.test(ingredient.note || "")) {
        return;
      }

      const noun = (ingredient.item.split(/[^a-z]+/i).filter((word) => word.length > 3).pop() || "").toLowerCase();

      if (!noun) {
        return;
      }

      const wantsItHot = new RegExp(`\\b(warm|hot)\\s+(?:\\w+\\s+){0,2}${noun}\\b`, "i");

      entry.steps.forEach((step, index) => {
        if (wantsItHot.test(step)) {
          problems.push(`${entry.id}: "${ingredient.item}" is listed as "${ingredient.note}" but step ${index + 1} wants it hot`);
        }
      });
    });
  });

  assert.deepEqual(problems, [], `ingredient notes fighting their own steps:\n  ${problems.join("\n  ")}`);
});

// A falafel recipe ended "Serve in warm pita with hummus and salad" — salad was
// in no list, and no step warmed the pita. You find that out at the moment the
// hot food is ready.
test("every component a step serves on or with is in the ingredient list", () => {
  const COMPONENTS = [
    { name: "pita", step: /\bpitas?\b/i, ingredient: /\bpitas?\b/i },
    { name: "bun", step: /\bbuns?\b/i, ingredient: /\bbuns?\b|\broll\b/i },
    { name: "flatbread", step: /\bflatbreads?\b|\brotis?\b/i, ingredient: /flatbread|\broti/i },
    { name: "tortilla", step: /\btortillas?\b/i, ingredient: /tortilla|\bwrap\b/i },
    { name: "salad", step: /\b(?:with|and)\s+salad\b/i, ingredient: /\bsalad\b|lettuce|\bleaves\b|cabbage|rocket/i }
  ];
  const problems = [];

  ALL.forEach((entry) => {
    const steps = entry.steps.join(" ");
    const items = entry.ingredients.map((ingredient) => ingredient.item).join(" | ");

    COMPONENTS.forEach((component) => {
      if (component.step.test(steps) && !component.ingredient.test(items)) {
        problems.push(`${entry.id}: a step calls for ${component.name}, which is in no ingredient list`);
      }
    });
  });

  assert.deepEqual(problems, [], `steps calling for things nobody was told to buy:\n  ${problems.join("\n  ")}`);
});

test("a step that promises a warmed or toasted component has a step that does it", () => {
  const PREPARED = [
    { name: "a toasted bun", promise: /toasted buns?/i, action: /toast[^.]*\bbuns?\b/i },
    { name: "warm pita", promise: /warm pitas?/i, action: /warm the pitas?/i },
    { name: "warm flatbread", promise: /warm (flatbread|roti)/i, action: /warm the (rotis?|flatbreads?)/i },
    { name: "a warm tortilla", promise: /warm tortillas?/i, action: /warm (the |each )?tortillas?/i }
  ];
  const problems = [];

  ALL.forEach((entry) => {
    const steps = entry.steps.join(" ");

    PREPARED.forEach((prepared) => {
      if (prepared.promise.test(steps) && !prepared.action.test(steps)) {
        problems.push(`${entry.id}: the steps assume ${prepared.name}, but no step prepares it`);
      }
    });
  });

  assert.deepEqual(problems, [], `prep steps that never appear:\n  ${problems.join("\n  ")}`);
});

// All three wings answers needed an air fryer and none was under 26 minutes, so
// the "I'm hungry now" path — which filters to 15 minutes — could never show one.
test("the wings craving has a fast answer that needs no air fryer", () => {
  const wings = ALL.filter((entry) => entry.cravings.includes("wings"));

  assert.ok(wings.length >= 2, "wings needs more than one answer");
  assert.ok(
    wings.some((entry) => entry.totalMinutes <= 15),
    `no wings answer is under 15 minutes: ${wings.map((entry) => `${entry.id} ${entry.totalMinutes}min`).join(", ")}`
  );
  assert.ok(
    wings.some((entry) => !entry.equipment.includes("air fryer")),
    "every wings answer needs an air fryer — a kitchen without one gets nothing"
  );
  assert.ok(
    wings.some((entry) => entry.totalMinutes <= 15 && !entry.equipment.includes("air fryer")),
    "the fast wings answer must also be the one that needs no air fryer"
  );
});

// The matcher requires EVERY declared appliance (`needed.every(...)`), so an
// entry that lists two interchangeable ones is hidden from everybody who owns
// only one of them — including the users it was written for.
test("equipment never pairs two appliances that are alternatives to each other", () => {
  const INTERCHANGEABLE = [["oven", "air fryer"], ["microwave", "kettle"]];
  const problems = [];

  ALL.forEach((entry) => {
    INTERCHANGEABLE.forEach(([first, second]) => {
      if (entry.equipment.includes(first) && entry.equipment.includes(second)) {
        problems.push(`${entry.id}: requires both "${first}" and "${second}" — the matcher reads that as AND`);
      }
    });
  });

  assert.deepEqual(
    problems,
    [],
    `equipment written as OR but enforced as AND — put the alternative in substitutions:\n  ${problems.join("\n  ")}`
  );

  // And the alternative has to be written down somewhere the user can see it.
  [
    ["frozen-fries-done-right", /air fryer/i],
    ["frozen-chicken-strip-wrap", /oven/i],
    ["microwave-miso-tofu-soup", /kettle/i]
  ].forEach(([id, mentions]) => {
    const entry = ALL.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} is missing from the catalog`);
    assert.match(
      JSON.stringify(entry.substitutions),
      mentions,
      `${id} dropped its second appliance without telling the reader how to use it`
    );
  });
});

// Every drink in the catalog was iced: no hot coffee, no hot tea, no hot
// chocolate, and nothing tea-based for a boba craving.
test("the drinks group is not all iced", () => {
  const iced = (entry) => entry.ingredients.some((ingredient) => /\bice\b/i.test(ingredient.item));
  const heated = (entry) => /steaming|simmer|scalded/i.test(entry.steps.join(" "));
  const drinks = ALL.filter((entry) => entry.cravings.includes("coffee") || entry.cravings.includes("sweet-drink"));
  const hot = drinks.filter((entry) => !iced(entry) && heated(entry));

  assert.ok(hot.length >= 3, `only ${hot.length} hot drinks in the whole catalog: ${hot.map((e) => e.id).join(", ")}`);
  assert.ok(
    hot.some((entry) => entry.cravings.includes("coffee")),
    "there is no hot coffee — the answer to a coffee-shop craving cannot only be a cold one"
  );
  assert.ok(
    hot.some((entry) => entry.cravings.includes("sweet-drink") && !entry.cravings.includes("coffee")),
    "there is no hot drink for someone who did not want coffee"
  );

  // A bubble-tea craving needs something tea-based, not a chocolate coffee drink.
  const teaBased = drinks.filter((entry) =>
    entry.ingredients.some((ingredient) => /\btea\b|teabags?|matcha|chai/i.test(ingredient.item))
  );
  assert.ok(teaBased.length >= 2, `only ${teaBased.length} tea-based drinks for the sweet-drink craving`);
});

// A major craving with no answer under 15 minutes is decided by counting
// numbers, not by matching words, so it is an error and not a guess. It was a
// warning, and `wings` sat behind three air-fryer answers of 26, 30 and 32
// minutes underneath a green summary line: the user pressed "I'm hungry now" on
// a wings page and was handed a chicken wrap and a bag of fries instead.
test("a major craving with no fast answer stops the build, it does not merely warn", () => {
  const injected = JSON.parse(JSON.stringify(data));
  const all = [...injected.recipes, ...injected.quickAlternatives];

  // Push every wings answer past the "I'm hungry now" threshold.
  const wings = all.filter((entry) => entry.cravings.includes("wings"));
  assert.ok(wings.length > 0, "the catalog must answer the wings craving at all");
  wings.forEach((entry) => {
    entry.totalMinutes = 40;
    entry.activeMinutes = Math.min(entry.activeMinutes, 40);
  });

  const reporter = alternativesAudit(injected);
  const hit = reporter.errors.filter((message) => /wings/.test(message) && /under 15 minutes/.test(message));

  assert.equal(
    hit.length,
    1,
    `a craving with no fast answer must be an ERROR. errors:\n  ${reporter.errors.join("\n  ")}`
  );
});

// A craving carried by a large share of the catalog is a shape, not a food, and
// it scores identically to a real specialty match — so it displaces correct
// answers. Broad tags are allowed, but they must be declared so the matcher can
// demote them; an undeclared one has to stop the build.
test("a craving too broad to be specific must be declared generic", () => {
  const injected = JSON.parse(JSON.stringify(data));
  injected.taxonomy.genericCravings = [];

  const reporter = alternativesAudit(injected);
  const hits = reporter.errors.filter((message) => /not declared in taxonomy\.genericCravings/.test(message));

  assert.ok(
    hits.length > 0,
    `the audit must reject an undeclared wildcard craving. errors:\n  ${reporter.errors.join("\n  ")}`
  );

  // And the shipped taxonomy really does declare every broad one.
  const clean = alternativesAudit();
  assert.deepEqual(
    clean.errors.filter((message) => /genericCravings/.test(message)),
    []
  );
});

test("every category the blocklists use reaches an answer, and the audit fails when one does not", () => {
  const injected = JSON.parse(JSON.stringify(data));
  delete injected.taxonomy.categoryCravings.grocery;

  const reporter = alternativesAudit(injected);
  const hits = reporter.errors.filter((message) => /"grocery".*no craving mapping/.test(message));

  assert.equal(hits.length, 1, `errors:\n  ${reporter.errors.join("\n  ")}`);
});
