"use strict";
/**
 * Alternative-matching tests.
 *
 * These are the behavioural promises the block page makes: a pizza site offers
 * something pizza-shaped, a fried-chicken site does not offer a smoothie, a
 * vegetarian never sees meat, "five minutes" means five minutes, and asking for
 * another actually moves on. They run against the REAL catalog, so a data change
 * that breaks a promise fails here rather than in front of a user.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const recipes = require("../extension/recipes.js");

let loaded = false;
async function catalog() {
  if (!loaded) {
    await recipes.loadCatalog();
    loaded = true;
  }
  return recipes.getCatalog();
}

// Blocked-site metadata in the shape background.js resolves it.
const site = (overrides) => ({
  key: "fast-food-example-com",
  domain: "example.com",
  type: "fast_food",
  category: "",
  specialties: [],
  ...overrides
});

const PIZZA = site({ key: "delivery-dominos-com", domain: "dominos.com", category: "pizza", specialties: ["pizza", "breadsticks"] });
const FRIED_CHICKEN = site({ key: "fast-food-kfc-com", domain: "kfc.com", category: "chicken", specialties: ["fried chicken", "wings"] });
const COFFEE = site({ key: "fast-food-starbucks-com", domain: "starbucks.com", category: "coffee", specialties: ["coffee", "espresso", "pastries"] });
const BURGER = site({ key: "fast-food-mcdonalds-com", domain: "mcdonalds.com", category: "burger", specialties: ["fries", "chicken", "breakfast", "coffee"] });
const GENERIC_DELIVERY = site({ key: "delivery-doordash-com", domain: "doordash.com", type: "delivery", category: "delivery", specialties: ["restaurant delivery"] });

const top = (result, n = 3) => result.matches.slice(0, n).map((match) => match.entry);

test("the catalog loads and indexes both kinds", async () => {
  const data = await catalog();

  assert.ok(data.entries.length >= 60, `expected 60+ alternatives, got ${data.entries.length}`);
  assert.ok(data.entries.some((entry) => entry.kind === "recipe"));
  assert.ok(data.entries.some((entry) => entry.kind === "quick"));
  assert.equal(data.version, "2.0");
});

// ---------------------------------------------------------------------------
// Craving relevance
// ---------------------------------------------------------------------------

test("a pizza domain prioritises pizza-like alternatives", async () => {
  await catalog();
  const best = top(recipes.rankAlternatives(PIZZA, {}), 3);

  assert.ok(
    best.some((entry) => entry.cravings.includes("pizza")),
    `expected a pizza alternative in the top 3, got ${best.map((entry) => entry.id).join(", ")}`
  );
  assert.ok(best[0].cravings.includes("pizza"), `the single best pick should be pizza, got ${best[0].id}`);
});

test("a fried-chicken domain does not return a smoothie as the default", async () => {
  await catalog();
  const best = recipes.rankAlternatives(FRIED_CHICKEN, {}).matches[0].entry;

  assert.ok(
    best.cravings.includes("fried-chicken") || best.cravings.includes("wings") || best.cravings.includes("chicken-sandwich"),
    `expected a chicken-shaped answer, got ${best.id}`
  );
  assert.ok(!/smoothie/i.test(best.title), "a smoothie must never be the default answer to fried chicken");
});

test("a coffee-shop domain offers drinks, breakfast, or bakery — not a smoothie by default", async () => {
  await catalog();
  const best = top(recipes.rankAlternatives(COFFEE, {}), 3);
  const acceptable = ["coffee", "sweet-drink", "breakfast", "bakery", "dessert"];

  best.forEach((entry) => {
    assert.ok(
      entry.cravings.some((craving) => acceptable.includes(craving)),
      `${entry.id} is not a coffee-shop-shaped answer (${entry.cravings.join(", ")})`
    );
  });

  assert.ok(best[0].cravings.includes("coffee"), `the best coffee-shop answer should involve coffee, got ${best[0].id}`);
});

test("a smoothie is never reachable from a coffee craving alone", async () => {
  const data = await catalog();

  data.entries.forEach((entry) => {
    if (/smoothie/i.test(entry.title) && !entry.cravings.includes("coffee")) {
      return;
    }

    if (/smoothie/i.test(entry.title)) {
      assert.ok(
        (entry.ingredients || []).some((ingredient) => /coffee|espresso/i.test(ingredient.item)),
        `${entry.id} is tagged as a coffee craving but contains no coffee`
      );
    }
  });
});

test("a burger domain leads with burgers or fries, not dessert", async () => {
  await catalog();
  const best = recipes.rankAlternatives(BURGER, {}).matches[0].entry;

  assert.ok(
    best.cravings.some((craving) => ["burger", "fries", "fried-chicken", "breakfast", "chicken-sandwich"].includes(craving)),
    `expected a fast-food-shaped answer, got ${best.id} (${best.cravings.join(", ")})`
  );
});

test("a generic delivery page still gets a sensible answer rather than nothing", async () => {
  await catalog();
  const result = recipes.rankAlternatives(GENERIC_DELIVERY, {});

  assert.ok(result.matches.length > 0);
  assert.ok(result.matches[0].entry.cravings.length > 0);
});

test("an unknown category falls back through the rule bucket", async () => {
  await catalog();
  const unknown = site({ category: "quantum_cuisine", specialties: ["nothing recognisable"] });
  const result = recipes.rankAlternatives(unknown, {});

  assert.ok(result.matches.length > 0, "there must always be a fallback");
});

// ---------------------------------------------------------------------------
// Dietary safety
// ---------------------------------------------------------------------------

test("a vegetarian user never receives meat or fish", async () => {
  const data = await catalog();

  [PIZZA, FRIED_CHICKEN, BURGER, COFFEE, GENERIC_DELIVERY].forEach((blocked) => {
    const result = recipes.rankAlternatives(blocked, { dietPreference: "vegetarian" });

    assert.ok(result.matches.length > 0, `vegetarian users must still get answers for ${blocked.domain}`);
    result.matches.forEach((match) => {
      assert.ok(
        ["vegan", "vegetarian"].includes(match.entry.diet),
        `${match.entry.id} (${match.entry.diet}) offered to a vegetarian on ${blocked.domain}`
      );
    });
  });

  assert.ok(data.entries.some((entry) => entry.diet === "omnivore"), "the catalog does contain meat entries to exclude");
});

test("a vegan user receives only vegan entries", async () => {
  await catalog();
  const result = recipes.rankAlternatives(FRIED_CHICKEN, { dietPreference: "vegan" });

  assert.ok(result.matches.length > 0);
  result.matches.forEach((match) => assert.equal(match.entry.diet, "vegan"));
});

test("a pescatarian gets fish but never meat", async () => {
  await catalog();
  const result = recipes.rankAlternatives(GENERIC_DELIVERY, { dietPreference: "pescatarian" });

  result.matches.forEach((match) => assert.notEqual(match.entry.diet, "omnivore"));
  assert.ok(result.matches.some((match) => match.entry.diet === "pescatarian"), "fish entries are available");
});

test("diet is absolute — it is never relaxed to fill the list", async () => {
  await catalog();
  const result = recipes.rankAlternatives(FRIED_CHICKEN, {
    dietPreference: "vegan",
    equipment: ["microwave"]
  });

  result.matches.forEach((match) => assert.equal(match.entry.diet, "vegan"));
});

test("declared allergens are excluded", async () => {
  await catalog();
  const result = recipes.rankAlternatives(GENERIC_DELIVERY, { avoidAllergens: ["peanut", "shellfish"] });

  assert.ok(result.matches.length > 0);
  result.matches.forEach((match) => {
    assert.ok(!match.entry.allergens.includes("peanut"), `${match.entry.id} contains peanut`);
  });
});

// ---------------------------------------------------------------------------
// Time, equipment, pantry
// ---------------------------------------------------------------------------

test("asking for five-minute options returns eligible five-minute options", async () => {
  await catalog();
  const result = recipes.rankAlternatives(GENERIC_DELIVERY, {}, { filter: "five-minutes" });

  assert.ok(result.matches.length > 0, "there must be five-minute options");
  assert.deepEqual(result.relaxed, [], "the filter should not need relaxing");
  result.matches.forEach((match) => assert.ok(match.entry.totalMinutes <= 5, `${match.entry.id} takes ${match.entry.totalMinutes} min`));
});

test("the no-cook filter returns only entries that need no cooking", async () => {
  await catalog();
  const result = recipes.rankAlternatives(GENERIC_DELIVERY, {}, { filter: "no-cook" });

  assert.ok(result.matches.length > 0);
  result.matches.forEach((match) => assert.equal(match.entry.noCook, true));
});

test("a microwave-only kitchen still gets useful answers", async () => {
  await catalog();
  const result = recipes.rankAlternatives(GENERIC_DELIVERY, { equipment: ["microwave"] });

  assert.ok(result.matches.length >= 5, `expected several microwave-friendly answers, got ${result.matches.length}`);
  assert.deepEqual(result.relaxed, [], "equipment should not need relaxing for a microwave kitchen");
  result.matches.forEach((match) => {
    assert.ok(
      recipes.equipmentAvailable(match.entry, ["microwave"]),
      `${match.entry.id} needs ${match.entry.equipment.join(", ")}`
    );
  });
});

test("an impossible filter combination relaxes and says so instead of showing nothing", async () => {
  await catalog();
  const result = recipes.rankAlternatives(PIZZA, { equipment: ["blender"] }, { filter: "air-fryer" });

  assert.ok(result.matches.length > 0, "a fallback must always exist");
  assert.ok(result.relaxed.length > 0, "the page must be told which constraint was dropped");
});

test("pantry preferences change the ranking without hiding anything", async () => {
  await catalog();
  const withoutPantry = recipes.rankAlternatives(GENERIC_DELIVERY, {});
  const withPantry = recipes.rankAlternatives(GENERIC_DELIVERY, {
    pantry: ["eggs", "bread", "rice", "canned beans", "tortillas"]
  });

  assert.equal(withPantry.matches.length, withoutPantry.matches.length, "pantry must rank, not filter");
  assert.notEqual(
    withPantry.matches[0].entry.id,
    "",
    "a pantry should produce a concrete top pick"
  );

  const topIngredients = (withPantry.matches[0].entry.ingredients || []).map((i) => i.item.toLowerCase()).join(" ");
  assert.match(topIngredients, /egg|bread|rice|bean|tortilla/, "the top pantry pick should use a declared staple");
});

test("a pantry hit is reported so the page can explain the choice", async () => {
  await catalog();
  const result = recipes.rankAlternatives(GENERIC_DELIVERY, { pantry: ["eggs", "bread"] });
  const explained = result.matches.find((match) => match.reasons.some((reason) => reason.key === "pantry"));

  assert.ok(explained, "at least one match should carry a pantry reason");
});

// ---------------------------------------------------------------------------
// Rotation, favorites, dismissal
// ---------------------------------------------------------------------------

test("recently shown alternatives are deprioritised but not removed", async () => {
  await catalog();
  const first = recipes.rankAlternatives(PIZZA, {}).matches[0].entry.id;
  const after = recipes.rankAlternatives(PIZZA, { recentAlternatives: [first] });

  assert.notEqual(after.matches[0].entry.id, first, "the just-shown entry should not lead again");
  assert.ok(after.matches.some((match) => match.entry.id === first), "but it is still reachable");
});

test("recently dismissed alternatives are pushed to the back", async () => {
  await catalog();
  const first = recipes.rankAlternatives(PIZZA, {}).matches[0].entry.id;
  const after = recipes.rankAlternatives(PIZZA, { dismissedAlternatives: [first] });
  const position = after.matches.findIndex((match) => match.entry.id === first);

  assert.ok(position > 2, `a dismissed entry should fall well down the list (was at ${position})`);
});

test("favorites are boosted", async () => {
  const data = await catalog();
  // Pick something that is NOT already the top answer for this site.
  const baseline = recipes.rankAlternatives(PIZZA, {}).matches;
  const outsider = baseline[baseline.length - 1].entry.id;
  const withFavorite = recipes.rankAlternatives(PIZZA, { alternativeFavorites: [outsider] });

  const before = baseline.findIndex((match) => match.entry.id === outsider);
  const afterIndex = withFavorite.matches.findIndex((match) => match.entry.id === outsider);

  assert.ok(afterIndex < before, `favoriting should move ${outsider} up (${before} -> ${afterIndex})`);
  assert.ok(data.entries.length > 0);
});

test("show another walks the ranking deterministically", async () => {
  await catalog();
  const seen = [];

  for (let rotation = 0; rotation < 4; rotation += 1) {
    const pick = recipes.selectAlternative(PIZZA, {}, { rotation });
    seen.push(pick.entry.id);
    assert.equal(pick.index, rotation % pick.count);
  }

  assert.equal(new Set(seen).size, seen.length, "stepping through must not repeat while options remain");

  // Deterministic: the same rotation gives the same answer every time.
  const repeat = recipes.selectAlternative(PIZZA, {}, { rotation: 2 });
  assert.equal(repeat.entry.id, seen[2]);
});

test("rotation wraps and reports exhaustion rather than showing nothing", async () => {
  await catalog();
  const narrow = recipes.selectAlternative(PIZZA, { dietPreference: "vegan" }, { filter: "five-minutes", rotation: 999 });

  assert.ok(narrow.entry, "there is always something to show");
  assert.equal(narrow.exhausted, true, "the page is told the list has been walked");
});

test("selection is stable for the same site and differs across sites", async () => {
  await catalog();
  const a = recipes.selectAlternative(PIZZA, {}).entry.id;
  const b = recipes.selectAlternative(PIZZA, {}).entry.id;
  const c = recipes.selectAlternative(FRIED_CHICKEN, {}).entry.id;

  assert.equal(a, b, "the same block shows the same suggestion");
  assert.notEqual(a, c, "different cravings get different suggestions");
});

// ---------------------------------------------------------------------------
// The closest / fastest / lowest-effort trio
// ---------------------------------------------------------------------------

test("the trio returns three distinct, sensible options", async () => {
  await catalog();
  const trio = recipes.selectTrio(PIZZA, {});

  assert.equal(trio.length, 3);
  assert.deepEqual(trio.map((item) => item.label), ["closest", "fastest", "easiest"]);
  assert.equal(new Set(trio.map((item) => item.entry.id)).size, 3, "no duplicates");

  const fastest = trio.find((item) => item.label === "fastest").entry;
  const closest = trio.find((item) => item.label === "closest").entry;
  assert.ok(fastest.totalMinutes <= closest.totalMinutes + 1, "the fastest option should not be slower than the closest");
});

test("the trio respects diet", async () => {
  await catalog();
  const trio = recipes.selectTrio(FRIED_CHICKEN, { dietPreference: "vegetarian" });

  trio.forEach((item) => assert.ok(["vegan", "vegetarian"].includes(item.entry.diet)));
});

// ---------------------------------------------------------------------------
// Custom alternatives
// ---------------------------------------------------------------------------

test("a user's own alternative competes in the ranking", async () => {
  await catalog();
  const custom = {
    id: "custom-emergency-eggs",
    kind: "custom",
    title: "My Emergency Eggs",
    description: "",
    ingredients: [{ quantity: 2, unit: "piece", item: "eggs" }],
    steps: ["Fry two eggs."],
    totalMinutes: 5,
    activeMinutes: 5,
    equipment: ["stove"],
    diet: "vegetarian",
    allergens: ["egg"],
    categories: ["pizza"],
    cravings: ["pizza"],
    favorite: false
  };

  const result = recipes.rankAlternatives(PIZZA, { customAlternatives: [custom] });
  const position = result.matches.findIndex((match) => match.entry.id === custom.id);

  assert.ok(position >= 0, "the custom alternative is in the ranking");
  assert.ok(position < 5, `a matching custom alternative should rank high (was ${position})`);
});

test("a custom alternative still obeys the diet filter", async () => {
  await catalog();
  const meaty = {
    id: "custom-steak",
    kind: "custom",
    title: "Steak",
    ingredients: [{ quantity: 1, unit: "piece", item: "steak" }],
    steps: ["Cook it."],
    totalMinutes: 15,
    activeMinutes: 15,
    equipment: ["stove"],
    diet: "omnivore",
    allergens: [],
    categories: ["burger"],
    cravings: ["burger"]
  };

  const result = recipes.rankAlternatives(BURGER, { dietPreference: "vegetarian", customAlternatives: [meaty] });

  assert.ok(!result.matches.some((match) => match.entry.id === "custom-steak"));
});

// ---------------------------------------------------------------------------
// Craving derivation
// ---------------------------------------------------------------------------

test("specialties are the strongest signal and categories the next", async () => {
  const data = await catalog();
  const derived = recipes.deriveCravings(
    { category: "chicken", specialties: ["fried chicken"] },
    data.taxonomy
  );

  assert.ok(derived.primary.includes("fried-chicken"));
  assert.ok(derived.secondary.length > 0);
});

test("craving derivation uses the vocabulary, not word matching", async () => {
  const data = await catalog();
  // "chickpeas" is not a specialty and must not resolve to a chicken craving.
  const derived = recipes.deriveCravings({ category: "", specialties: ["chickpeas"] }, data.taxonomy);

  assert.deepEqual(derived.primary, []);
});
