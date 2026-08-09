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

// A user's own alternative stores its ingredients as plain strings; the catalog
// stores structured { quantity, unit, item } objects. Reading only `.item` left
// every custom entry with a list of empty strings, and `staple.includes("")` is
// true for every staple — so a custom alternative scored a FULL pantry match
// whatever was actually in it, and the block page claimed on screen that it
// "uses 5 things you keep" about a dish it had never looked at.
test("a custom alternative's pantry score reflects what is really in it", async () => {
  await catalog();
  const pantry = ["eggs", "rice", "pasta", "canned beans", "frozen vegetables", "cheese", "yogurt", "chicken"];

  const unrelated = {
    id: "custom-toast",
    kind: "custom",
    title: "Plain toast",
    ingredients: ["bread"],
    steps: ["Toast it."],
    totalMinutes: 3,
    activeMinutes: 2,
    equipment: ["toaster"],
    diet: "vegan",
    categories: [],
    cravings: []
  };

  const matching = {
    ...unrelated,
    id: "custom-egg-rice",
    title: "Egg fried rice",
    ingredients: ["2 eggs", "1 cup rice", "frozen vegetables"],
    diet: "vegetarian"
  };

  const result = recipes.rankAlternatives(PIZZA, { pantry, customAlternatives: [unrelated, matching] });
  const find = (id) => result.matches.find((match) => match.entry.id === id);

  const toast = find("custom-toast");
  assert.ok(
    !toast.reasons.some((reason) => reason.key === "pantry"),
    "nothing in it is on the list, so it must not claim a pantry match"
  );

  const rice = find("custom-egg-rice");
  const pantryReason = rice.reasons.find((reason) => reason.key === "pantry");
  assert.ok(pantryReason, "one that genuinely uses the pantry says so");
  assert.equal(pantryReason.value, "3", "eggs, rice and frozen vegetables — counted, not assumed");
  assert.ok(rice.score > toast.score, "and it outranks the one that matches nothing");
});

test("an empty pantry entry cannot match every alternative", async () => {
  await catalog();
  const result = recipes.rankAlternatives(PIZZA, { pantry: ["", "  "] });

  assert.ok(
    !result.matches.some((match) => match.reasons.some((reason) => reason.key === "pantry")),
    "a blank staple is not a staple"
  );
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

// ---------------------------------------------------------------------------
// Cravings the ranking used to get wrong
//
// Each of these reproduces a real blocked page — the brand's own category and
// specialties, copied from the blocklists — and asserts the answer a person
// would expect. They failed before the catalog and taxonomy were corrected.
// ---------------------------------------------------------------------------

const FIVE_GUYS = site({
  key: "fast-food-fiveguys-com",
  domain: "fiveguys.com",
  category: "burger",
  specialties: ["burgers", "fries", "milkshakes", "hot dogs"]
});
const SALAD_SHOP = site({
  key: "fast-food-saladchain-com",
  domain: "saladchain.com",
  category: "fast_casual",
  specialties: ["salads", "salad bar"]
});
const WINGS = site({
  key: "fast-food-buffalowildwings-com",
  domain: "buffalowildwings.com",
  category: "chicken",
  specialties: ["wings", "burgers", "sports bar"]
});
const BUBBLE_TEA = site({
  key: "fast-food-gongcha-ca",
  domain: "gongcha.ca",
  category: "smoothie",
  specialties: ["bubble tea", "milk tea", "fruit tea"]
});

// "late-night" sat on more than a third of the catalog AND was reachable as a
// PRIMARY craving through "hot dogs", "snacks" and "chips" — so it scored the
// full 100 of a real specialty match and shoved correct answers down the list.
test("late-night is never reachable as a primary craving", async () => {
  const data = await catalog();
  const viaSpecialty = Object.entries(data.taxonomy.specialtyCravings)
    .filter(([, cravings]) => cravings.includes("late-night"))
    .map(([specialty]) => specialty);

  assert.deepEqual(
    viaSpecialty,
    [],
    `these specialties resolve straight to the late-night wildcard: ${viaSpecialty.join(", ")}`
  );
});

test("a burger chain that also sells hot dogs is answered with burgers and fries", async () => {
  await catalog();
  const best = top(recipes.rankAlternatives(FIVE_GUYS, {}), 3);
  const sold = ["burger", "fries", "sandwich", "sweet-drink", "ice-cream"];

  best.forEach((entry) => {
    assert.ok(
      entry.cravings.some((craving) => sold.includes(craving)),
      `${entry.id} (${entry.cravings.join(", ")}) is not something this shop sells`
    );
  });

  assert.ok(
    best[0].cravings.includes("burger") || best[0].cravings.includes("fries"),
    `the best answer to a burger shop should be a burger or fries, got ${best[0].id}`
  );
});

test("a salad shop is answered with salads", async () => {
  await catalog();
  const best = top(recipes.rankAlternatives(SALAD_SHOP, {}), 3);

  best.forEach((entry) => {
    assert.ok(
      entry.cravings.includes("salad"),
      `${entry.id} (${entry.cravings.join(", ")}) is not a salad — the salad group must not be padded`
    );
  });
});

// The block page sets filter "fastest" (15 minutes) for the "I'm hungry now"
// intent. Every wings answer used to be a 26-32 minute air-fryer recipe, so that
// path silently swapped the craving for a chicken wrap and a bag of fries.
test("the 'I am hungry now' path can still answer a wings craving", async () => {
  await catalog();
  const result = recipes.rankAlternatives(WINGS, {}, { filter: "fastest", intent: "hungry" });

  assert.deepEqual(result.relaxed, [], "the fastest filter should not need relaxing on a wings page");
  assert.ok(
    top(result, 3).some((entry) => entry.cravings.includes("wings")),
    `no wings answer in the fastest three: ${top(result, 3).map((entry) => entry.id).join(", ")}`
  );
});

// A recipe that declares ["air fryer", "oven"] to mean "either" is read as
// "both", so it disappeared for everyone who owned one of them — including the
// oven-only user the oven instructions were written for.
test("an oven-only kitchen is offered the oven answer instead of being filtered out of it", async () => {
  await catalog();
  const result = recipes.rankAlternatives(BURGER, { equipment: ["oven"] });

  assert.deepEqual(result.relaxed, [], "an oven kitchen should not need the equipment filter relaxed");
  assert.ok(
    top(result, 3).some((entry) => entry.cravings.includes("fries")),
    `an oven user blocked on a fries page got: ${top(result, 3).map((entry) => entry.id).join(", ")}`
  );

  result.matches.forEach((match) => {
    assert.ok(
      recipes.equipmentAvailable(match.entry, ["oven"]),
      `${match.entry.id} needs ${match.entry.equipment.join(", ")}`
    );
  });
});

test("a bubble-tea shop is not answered with a chocolate coffee drink", async () => {
  await catalog();
  const best = top(recipes.rankAlternatives(BUBBLE_TEA, {}), 3);
  const hasCoffee = (entry) => (entry.ingredients || []).some((ingredient) => /coffee|espresso/i.test(ingredient.item));

  assert.ok(!hasCoffee(best[0]), `a boba craving was answered with ${best[0].id}, which is coffee`);
  assert.ok(
    best.some((entry) => (entry.ingredients || []).some((ingredient) => /\btea\b|teabags?|matcha|chai/i.test(ingredient.item))),
    `nothing tea-based in the top three: ${best.map((entry) => entry.id).join(", ")}`
  );
});

test("a coffee shop can be answered with a hot drink, not only an iced one", async () => {
  await catalog();
  const result = recipes.rankAlternatives(COFFEE, {});
  const iced = (entry) => (entry.ingredients || []).some((ingredient) => /\bice\b/i.test(ingredient.item));

  const hot = result.matches
    .slice(0, 6)
    .map((match) => match.entry)
    .filter((entry) => !iced(entry) && /steaming|simmer|scalded/i.test((entry.steps || []).join(" ")));

  assert.ok(
    hot.length > 0,
    `every answer a coffee shop gets is cold: ${top(result, 6).map((entry) => entry.id).join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// Equipment is AND, but a substitution is a real route
//
// Entries that previously listed two interchangeable appliances were read as
// needing BOTH, so the data lane declared one appliance each. That fixed the
// AND bug and opened the mirror image: the oven fries became invisible to an
// air-fryer-only kitchen, even though the recipe's own substitution line
// explains how to make them in an air fryer. The data knew; the filter did not
// read it.
// ---------------------------------------------------------------------------

test("an appliance substitution makes an entry reachable from the other kitchen", async () => {
  await catalog();

  const fries = recipes
    .rankAlternatives(BURGER, { equipment: ["oven"] })
    .matches.find((match) => match.entry.id === "frozen-fries-done-right");

  assert.ok(fries, "precondition: the oven kitchen can obviously make the oven fries");

  const swap = (fries.entry.substitutions || []).find((entry) => /oven/i.test(entry.for));
  assert.ok(swap, "precondition: the entry explains how to make it without an oven");
  assert.match(swap.use, /air fryer/i, "precondition: that explanation names an air fryer");

  const viaAirFryer = recipes
    .rankAlternatives(BURGER, { equipment: ["air fryer"] })
    .matches.find((match) => match.entry.id === "frozen-fries-done-right");

  assert.ok(viaAirFryer, "an air-fryer kitchen must be offered it too — the recipe says how");
});

test("a substitution that names no owned appliance does not unlock the entry", async () => {
  await catalog();

  // A microwave cannot make the oven fries, and no substitution says it can.
  const viaMicrowave = recipes
    .rankAlternatives(BURGER, { equipment: ["microwave"] })
    .matches.find((match) => match.entry.id === "frozen-fries-done-right");

  assert.ok(!viaMicrowave, "the filter must not wave an entry through on an unrelated substitution");
});

test("equipment is still AND when an entry genuinely needs two appliances", async () => {
  await catalog();
  const data = await catalog();

  const twoAppliance = data.entries.find((entry) => (entry.equipment || []).length >= 2);

  if (!twoAppliance) {
    return; // the catalog currently declares one appliance per entry
  }

  const partial = recipes.rankAlternatives(BURGER, { equipment: [twoAppliance.equipment[0]] });
  const hasIt = partial.matches.some((match) => match.entry.id === twoAppliance.id);
  const swaps = twoAppliance.substitutions || [];
  const excused = swaps.some((swap) => normalizeIsAppliance(swap, twoAppliance.equipment[1]));

  if (!excused) {
    assert.ok(!hasIt, `${twoAppliance.id} needs both appliances and must not appear with one`);
  }
});

// Helper: does this substitution excuse the missing appliance?
function normalizeIsAppliance(swap, missing) {
  return swap && String(swap.for || "").toLowerCase() === String(missing || "").toLowerCase();
}

// ---------------------------------------------------------------------------
// The trio must answer the block in all three slots (F001)
// ---------------------------------------------------------------------------

// The real records, read from the shipped blocklists rather than restated here,
// so a dataset edit that breaks the promise fails in this file.
const blocklistEntries = [
  ...require("../data/blocklists/fast-food.json").entries,
  ...require("../data/blocklists/delivery.json").entries
];

function siteRecord(domain) {
  const entry = blocklistEntries.find((candidate) => candidate.domain === domain);
  assert.ok(entry, `${domain} is not in the shipped blocklists`);
  return {
    key: `${entry.type}-${domain}`,
    domain,
    type: entry.type,
    category: entry.category,
    specialties: entry.specialties || []
  };
}

// What the block page derived the user wanted, computed the same way the
// matcher does — through the catalog's own vocabulary, not by matching words.
function cravingsFor(info, data) {
  return recipes.deriveCravings(info, data.taxonomy);
}

const answersOneOf = (entry, cravings) =>
  [...cravings.primary, ...cravings.secondary].some((craving) => (entry.cravings || []).includes(craving));

test("no trio slot is a constant across the blocklist", async () => {
  await catalog();

  // A spread of shapes: burger, pizza, coffee, tacos, chicken, sandwiches,
  // bubble tea, ice cream, wings, and a generic delivery marketplace.
  const domains = [
    "mcdonalds.com", "dominos.com", "starbucks.com", "tacobell.com", "kfc.com",
    "subway.com", "gong-cha.com", "baskinrobbins.com", "buffalowildwings.com", "doordash.com"
  ];

  const slots = { closest: new Set(), fastest: new Set(), easiest: new Set() };

  domains.forEach((domain) => {
    recipes.selectTrio(siteRecord(domain), {}).forEach((item) => slots[item.label].add(item.entry.id));
  });

  // The regression this pins: `fastest` sorted the whole eligible pool by
  // elapsed time, so the catalog's global minimum won every time and all ten
  // brands — pizza, tacos, wings, ice cream — returned "Two-Minute Iced
  // Coffee". One of the three shapes the page offers was a constant.
  Object.entries(slots).forEach(([label, ids]) => {
    assert.ok(
      ids.size > 1,
      `every one of ${domains.length} different brands got the same "${label}" suggestion (${[...ids][0]})`
    );
  });
});

test("every trio slot answers the craving the block derived", async () => {
  const data = await catalog();

  ["mcdonalds.com", "dominos.com", "tacobell.com", "kfc.com", "subway.com", "gong-cha.com"].forEach((domain) => {
    const info = siteRecord(domain);
    const cravings = cravingsFor(info, data);
    const trio = recipes.selectTrio(info, {});

    assert.equal(trio.length, 3, `${domain} did not produce three options`);

    trio.forEach((item) => {
      assert.ok(
        answersOneOf(item.entry, cravings),
        `${domain}: "${item.label}" offered ${item.entry.id}, which answers none of ${JSON.stringify([
          ...cravings.primary,
          ...cravings.secondary
        ])}`
      );
    });
  });
});

test("a specialty answer is never displaced by a category answer in the trio", async () => {
  await catalog();

  // A salad chain: `salads` is the specialty, and its `fast_casual` category
  // also derives rice-bowl / sandwich / burrito. The category answers are the
  // quicker ones, so a flat relevance test filled the fastest and easiest slots
  // with a turkey sandwich and a rice bowl for a salad order.
  const saladChain = site({ key: "fast-food-salad", domain: "salad.example", category: "fast_casual", specialties: ["salads"] });

  recipes.selectTrio(saladChain, {}).forEach((item) => {
    assert.ok(
      (item.entry.cravings || []).includes("salad"),
      `"${item.label}" offered ${item.entry.id} to a salad chain`
    );
  });
});

// ---------------------------------------------------------------------------
// A filter that silently removes every answer has to say so (F024)
// ---------------------------------------------------------------------------

test("a filter that removes every answer is reported, not hidden", async () => {
  await catalog();

  const pizzaOnly = site({ key: "fast-food-pizza", domain: "pizza.example", category: "pizza", specialties: ["pizza"] });

  // A blender cannot make any of the five pizza answers. The pool stays full of
  // hummus and smoothies, so the old check — "did this filter empty the pool?"
  // — never fired, and the page printed no reason at all next to a cottage
  // cheese bowl offered in place of a pizza.
  const result = recipes.rankAlternatives(pizzaOnly, { equipment: ["blender"] });

  assert.ok(result.matches.length > 0, "a fallback must still exist");
  assert.ok(
    result.matches.every((match) => !(match.entry.cravings || []).includes("pizza")),
    "this test is only meaningful while the equipment filter really does remove the pizza answers"
  );
  assert.ok(
    result.relaxed.includes("equipment"),
    "the page must be told the equipment filter is why it is not seeing pizza"
  );
});

test("a time limit that removes every answer is reported too", async () => {
  await catalog();

  const wings = site({ key: "fast-food-wings", domain: "wings.example", category: "chicken", specialties: ["wings"] });
  const result = recipes.rankAlternatives(wings, {}, { filter: "five-minutes" });

  assert.ok(result.matches.length > 0);
  assert.ok(
    result.relaxed.includes("five-minutes"),
    "no wings answer is under five minutes — the page has to say so rather than showing nachos silently"
  );
});

test("a filter that keeps the answers stays quiet", async () => {
  await catalog();

  // The counterpart: relaxing must not become noise. A microwave kitchen can
  // make Microwave Mug Pizza, so a pizza block reports nothing.
  const pizzaOnly = site({ key: "fast-food-pizza", domain: "pizza.example", category: "pizza", specialties: ["pizza"] });
  const result = recipes.rankAlternatives(pizzaOnly, { equipment: ["microwave"] });

  assert.ok(result.matches.some((match) => (match.entry.cravings || []).includes("pizza")));
  assert.deepEqual(result.relaxed, [], "nothing was lost, so nothing should be reported");
});

// ---------------------------------------------------------------------------
// Broad cravings must not outrank the craving the user actually has (F002)
// ---------------------------------------------------------------------------

test("a broad craving derived from a specialty never outranks a specific one", async () => {
  const data = await catalog();
  const generic = data.taxonomy.genericCravings;

  assert.ok(generic.length > 0, "the taxonomy must declare which cravings are broad");

  // A steakhouse listing "steak, burgers, ribs". "ribs" maps to `comfort`,
  // which sits on 28% of the catalog; "burgers" maps to `burger`, which sits on
  // 5%. Both used to score 100, so the closest answer to a steakhouse was a
  // microwave mug pizza.
  const steakhouse = site({ key: "fast-food-steak", domain: "steak.example", category: "restaurant", specialties: ["steak", "burgers", "ribs"] });
  const derived = recipes.deriveCravings(steakhouse, data.taxonomy);

  assert.ok(derived.primary.includes("burger"), "the specific craving stays primary");
  assert.ok(!derived.primary.includes("comfort"), "the broad craving must be demoted");
  assert.ok(derived.secondary.includes("comfort"), "and it must still be reachable as a fallback");

  const best = recipes.rankAlternatives(steakhouse, {}).matches[0];
  assert.ok(
    (best.entry.cravings || []).includes("burger"),
    `a steakhouse was answered with "${best.entry.title}"`
  );
});

test("a brand with nothing but a broad craving keeps it", async () => {
  const data = await catalog();

  // A plain delivery marketplace derives only `comfort` and `convenience`. If
  // demotion applied unconditionally it would lose its only signal and fall
  // through to the rule bucket.
  const marketplace = site({
    key: "delivery-example", domain: "marketplace.example", type: "delivery",
    category: "delivery", specialties: ["restaurant delivery"]
  });
  const derived = recipes.deriveCravings(marketplace, data.taxonomy);

  assert.ok(derived.primary.length > 0, "the only craving it has must stay primary");
  assert.ok(derived.primary.includes("comfort"));

  const best = recipes.rankAlternatives(marketplace, {}).matches[0];
  assert.ok(best.reasons.some((reason) => reason.key === "craving"), "it must still get a reasoned answer");
});
