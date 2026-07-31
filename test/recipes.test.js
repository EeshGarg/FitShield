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
