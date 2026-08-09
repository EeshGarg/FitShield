#!/usr/bin/env node
"use strict";
/**
 * Alternatives (recipes + quick alternatives) data audit.
 *
 * Two classes of finding, deliberately separated:
 *
 *   ERRORS   — structural and semantic facts that can be decided exactly:
 *              a missing id, a duplicate, an ingredient with no quantity, a
 *              vegan entry containing cheese, a tag outside the taxonomy, a
 *              chicken recipe with no temperature or doneness cue. These gate
 *              the build.
 *
 *   WARNINGS — anything decided by matching words in free text: possible
 *              near-duplicates, an ingredient that looks unreferenced, thin
 *              coverage for a craving. Natural-language matching guesses, and a
 *              guess must never be able to stop a release. They are printed in
 *              full so they still get looked at.
 *
 * The semantic checks exist because of specific mistakes this dataset has
 * actually had: a chickpea recipe tagged "chicken", turkey tagged "chicken", and
 * a smoothie tagged "coffee" because both are drinks.
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report");

const ROOT = path.join(__dirname, "..");
const CATALOG_FILE = path.join(ROOT, "data", "recipes.json");

const SCHEMA_VERSION = "2.0";
const DATA_VERSION = 2;

// --- vocabularies decided by the data itself -------------------------------

const DIET_RANK = { vegan: 0, vegetarian: 1, pescatarian: 2, omnivore: 3 };
const DIFFICULTIES = ["easy", "medium"];

// Ingredient words that decide a diet. Matched on word boundaries against the
// ingredient `item` only — never against free text — so "chickpeas" can never
// be read as "chicken" and "coconut milk" can never be read as "milk".
const MEAT_WORDS = [
  "beef", "pork", "bacon", "ham", "chicken", "turkey", "lamb", "duck", "sausage",
  "salami", "pepperoni", "prosciutto", "chorizo", "mince", "meat", "gelatin"
];
const FISH_WORDS = ["fish", "salmon", "tuna", "anchovy", "anchovies", "sardine", "sardines", "cod", "prawn", "prawns", "shrimp", "crab", "mussels", "squid"];
const DAIRY_WORDS = ["milk", "butter", "cheese", "yogurt", "yoghurt", "cream", "paneer", "feta", "mozzarella", "parmesan", "ghee", "buttermilk", "custard"];
const EGG_WORDS = ["egg", "eggs", "mayonnaise", "mayo"];
const HONEY_WORDS = ["honey"];

// Allergen detection. Each allergen lists the ingredient words that imply it.
const ALLERGEN_WORDS = {
  gluten: ["flour", "bread", "breadcrumbs", "pasta", "spaghetti", "noodles", "tortilla", "tortillas", "pita", "naan", "bun", "buns", "roll", "crackers", "cereal", "granola", "oats", "couscous", "soy sauce", "cornflakes", "muffins", "biscuits", "flatbread", "flatbreads", "roti", "dumplings", "pesto", "croutons", "wrap", "ciabatta", "bagel", "pizza", "panko"],
  dairy: DAIRY_WORDS,
  egg: EGG_WORDS,
  peanut: ["peanut", "peanuts", "peanut butter"],
  "tree-nut": ["almond", "almonds", "cashew", "cashews", "walnut", "walnuts", "pecan", "pistachio", "hazelnut", "nuts", "pine nuts", "pesto", "granola"],
  soy: ["soy sauce", "tofu", "soy", "edamame", "tamari", "miso", "gochujang", "instant noodles"],
  fish: ["fish", "salmon", "tuna", "anchovy", "anchovies", "sardine", "sardines", "cod"],
  shellfish: ["prawn", "prawns", "shrimp", "crab", "lobster", "mussels", "clams", "scallops"],
  sesame: ["sesame", "tahini", "hummus"]
};

// Words that cancel an allergen match on the SAME ingredient. Corn tortillas and
// tortilla chips are maize, not wheat; peanut butter is not dairy butter; coconut
// milk is not milk. Without these the audit reports confident nonsense.
const ALLERGEN_EXCEPTIONS = {
  gluten: [/\bcorn\b/i, /gluten-free/i, /\brice noodles\b/i],
  dairy: [/\b(peanut|nut|seed|almond|cashew|sunflower)\s+butter\b/i, /\bcocoa butter\b/i],
  egg: [/\b(vegan|eggless|egg-free|plant)\b/i],
  "tree-nut": [/\bnut-free\b/i],
  soy: [/\bsoy-free\b/i]
};

function allergenApplies(allergen, text) {
  const words = ALLERGEN_WORDS[allergen] || [];

  if (!words.some((word) => hasWord(text, word))) {
    return false;
  }

  if (allergen === "dairy" && isPlantQualified(text)) {
    return false;
  }

  return !(ALLERGEN_EXCEPTIONS[allergen] || []).some((pattern) => pattern.test(text));
}

// Words in a step that mean heat is being applied, and therefore that a
// duration or a doneness cue is required.
const COOK_VERBS = /\b(bake|baked|baking|roast|roasted|fry|fried|frying|grill|grilled|simmer|simmered|boil|boiled|boiling|saute|sauté|cook|cooked|cooking|microwave|steam|steamed|toast|toasted|heat|heated|air fry|air-fry)\b/i;
const OVEN_VERBS = /\b(bake|baked|baking|roast|roasted|grill|air fry|air-fry|oven)\b/i;
const TEMPERATURE = /\b\d{2,3}\s*(?:C|F)\b|\bhigh heat\b|\bmedium-high\b|\bmedium-low\b|\bmedium heat\b|\blow heat\b|\bfull power\b|\bhigh\b/i;
const DURATION = /\b\d+(?:\.\d+)?\s*(?:-\s*\d+\s*)?(?:second|seconds|minute|minutes|hour|hours|s|min)\b/i;
// A physical or visual cue the cook can check, rather than "until done".
const DONENESS = /\b(golden|browned?|crisp\w*|melted|bubbl\w+|tender|thickens?|thickened|set|firm|steaming|piping hot|no pink|clear|soft|translucent|smooth|charred|blistered|fragrant|sizzl\w+|coats?|caramelis\w+|carameliz\w+|puff\w*|wrinkl\w+|toasted|75 C|74 C|165 F)\b/i;
const VAGUE_STEP = /\b(until done|until ready|cook until cooked|as desired|season as desired|prepare normally|add the ingredients|to taste and cook)\b/i;

// Raw proteins that carry a food-safety obligation. Meat and fish must reach a
// stated safe state; eggs need a "set / firm / no longer runny" cue instead,
// because nobody probes a scrambled egg with a thermometer.
const RAW_MEAT = /\b(chicken|turkey|pork|beef|lamb|mince|prawns?|shrimp|fish|salmon)\b/i;
const RAW_EGG = /\beggs?\b/i;
const SAFE_CUE = /\b(74 C|165 F|75 C|no pink|juices run clear|cooked through|piping hot|right through|no longer pink|white all the way through|steaming hot|hot right through)\b/i;
const EGG_CUE = /\b(set|firm|no longer soft|no longer runny|cooked through|poach\w*|curds|piping hot|hot right through)\b/i;

// Ingredients uncommon enough that an entry depending on one owes the reader a
// swap. Deliberately short: it lists things a typical kitchen genuinely may not
// have, not things that merely sound specialised.
const UNCOMMON_INGREDIENTS = [
  "gochujang", "tahini", "paneer", "matcha", "kimchi", "buttermilk", "panko",
  "garam masala", "miso", "cumin seeds", "protein powder"
];

// A craving is only useful if the user can be offered more than one answer.
const MIN_PER_CRAVING = 2;
const MIN_FAST_PER_MAJOR = 1;
const MAJOR_CRAVINGS = [
  "pizza", "burger", "fried-chicken", "chicken-sandwich", "taco", "burrito",
  "rice-bowl", "pasta", "sandwich", "breakfast", "coffee", "sweet-drink",
  "dessert", "ice-cream", "bakery", "late-night", "convenience", "chinese",
  "indian", "middle-eastern", "mediterranean", "noodles", "high-protein",
  "smoothie", "soup", "seafood", "salad", "dumplings", "comfort", "wings",
  "fries", "japanese", "korean", "thai"
];

// --- helpers ---------------------------------------------------------------

const lower = (value) => String(value == null ? "" : value).toLowerCase();

// Whole-word containment. "chickpeas" does not contain the word "chicken";
// "coconut milk" does contain the word "milk", which is why dairy checks look at
// the specific ingredient and allow an explicit plant qualifier.
function hasWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`, "i").test(text);
}

function ingredientText(ingredient) {
  return lower(ingredient && typeof ingredient === "object" ? ingredient.item : ingredient);
}

// "milk or plant milk", "plant yogurt", "dairy-free cheese" are not dairy.
function isPlantQualified(text) {
  return /\b(plant|oat|soy|almond|coconut|dairy-free|vegan|nut)\b/i.test(text);
}

function titleKey(title) {
  return lower(title).replace(/[^a-z0-9]+/g, " ").trim();
}

// Bag-of-words similarity, used only for the near-duplicate WARNING.
function similarity(a, b) {
  const setA = new Set(titleKey(a).split(" ").filter(Boolean));
  const setB = new Set(titleKey(b).split(" ").filter(Boolean));

  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  const shared = [...setA].filter((word) => setB.has(word)).length;
  return shared / Math.max(setA.size, setB.size);
}

// --- checks ----------------------------------------------------------------

function checkStructure(reporter, entry, where) {
  const id = entry.id || "(no id)";

  if (!entry.id || typeof entry.id !== "string") {
    reporter.fail(`${where}: entry is missing an id`);
    return false;
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
    reporter.fail(`${id}: id must be lower-case kebab-case`);
  }

  ["title", "description", "storage", "region", "method", "diet", "difficulty"].forEach((field) => {
    if (typeof entry[field] !== "string" || !entry[field].trim()) {
      reporter.fail(`${id}: "${field}" is required and must be a non-empty string`);
    }
  });

  ["ingredients", "steps", "equipment", "allergens", "categories", "cravings", "substitutions"].forEach((field) => {
    if (!Array.isArray(entry[field])) {
      reporter.fail(`${id}: "${field}" must be an array`);
    }
  });

  if (!DIFFICULTIES.includes(entry.difficulty)) {
    reporter.fail(`${id}: difficulty "${entry.difficulty}" is not one of ${DIFFICULTIES.join(", ")}`);
  }

  if (entry.dataVersion !== DATA_VERSION) {
    reporter.fail(`${id}: dataVersion must be ${DATA_VERSION} (got ${JSON.stringify(entry.dataVersion)})`);
  }

  ["noCook", "microwave", "airFryer", "onePan", "pantryFriendly"].forEach((flag) => {
    if (typeof entry[flag] !== "boolean") {
      reporter.fail(`${id}: "${flag}" must be true or false`);
    }
  });

  return true;
}

function checkServingsAndIngredients(reporter, entry, taxonomy) {
  const id = entry.id;

  if (!Number.isFinite(entry.servings) || entry.servings <= 0) {
    reporter.fail(`${id}: servings must be a positive number (got ${JSON.stringify(entry.servings)})`);
  }

  const ingredients = Array.isArray(entry.ingredients) ? entry.ingredients : [];

  if (ingredients.length === 0) {
    reporter.fail(`${id}: has no ingredients`);
  }

  ingredients.forEach((ingredient, index) => {
    const at = `${id}: ingredient ${index + 1}`;

    if (!ingredient || typeof ingredient !== "object") {
      reporter.fail(`${at} must be an object with quantity, unit, and item`);
      return;
    }

    if (!Number.isFinite(ingredient.quantity) || ingredient.quantity <= 0) {
      reporter.fail(`${at} ("${ingredient.item}") has no usable quantity`);
    }

    if (typeof ingredient.unit !== "string" || !ingredient.unit.trim()) {
      reporter.fail(`${at} ("${ingredient.item}") has no unit`);
    }

    if (typeof ingredient.item !== "string" || !ingredient.item.trim()) {
      reporter.fail(`${at} has no item name`);
    }

    if (ingredient.optional !== undefined && typeof ingredient.optional !== "boolean") {
      reporter.fail(`${at}: "optional" must be true or false`);
    }
  });

  const required = ingredients.filter((ingredient) => ingredient && !ingredient.optional);

  if (ingredients.length > 0 && required.length === 0) {
    reporter.fail(`${id}: every ingredient is optional — at least one must be required`);
  }

  // Equipment must come from the vocabulary; [] legitimately means "nothing".
  (entry.equipment || []).forEach((item) => {
    if (!taxonomy.equipment.includes(item)) {
      reporter.fail(`${id}: unknown equipment "${item}"`);
    }
  });

  if (!taxonomy.methods.includes(entry.method)) {
    reporter.fail(`${id}: unknown cooking method "${entry.method}"`);
  }

  if (!taxonomy.regions.includes(entry.region)) {
    reporter.fail(`${id}: unknown region "${entry.region}"`);
  }
}

function checkTimes(reporter, entry) {
  const id = entry.id;
  const { totalMinutes, activeMinutes, prepMinutes, cookMinutes } = entry;

  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
    reporter.fail(`${id}: totalMinutes must be a positive number`);
    return;
  }

  if (!Number.isFinite(activeMinutes) || activeMinutes <= 0) {
    reporter.fail(`${id}: activeMinutes must be a positive number`);
    return;
  }

  if (activeMinutes > totalMinutes) {
    reporter.fail(`${id}: activeMinutes (${activeMinutes}) cannot exceed totalMinutes (${totalMinutes})`);
  }

  if (entry.kind === "recipe") {
    if (!Number.isFinite(prepMinutes) || !Number.isFinite(cookMinutes)) {
      reporter.fail(`${id}: full recipes need both prepMinutes and cookMinutes`);
      return;
    }

    if (prepMinutes < 0 || cookMinutes < 0) {
      reporter.fail(`${id}: prepMinutes and cookMinutes cannot be negative`);
    }

    // Prep and cook usually overlap, so their sum may exceed the total; what
    // cannot happen is either one alone exceeding it.
    if (prepMinutes > totalMinutes || cookMinutes > totalMinutes) {
      reporter.fail(`${id}: prepMinutes/cookMinutes cannot individually exceed totalMinutes`);
    }
  }
}

function checkSteps(reporter, entry) {
  const id = entry.id;
  const steps = Array.isArray(entry.steps) ? entry.steps : [];

  if (steps.length === 0) {
    reporter.fail(`${id}: has no steps`);
    return;
  }

  if (entry.kind === "quick" && steps.length > 4) {
    reporter.fail(`${id}: a quick alternative may have at most 4 steps (has ${steps.length})`);
  }

  steps.forEach((step, index) => {
    if (typeof step !== "string" || !step.trim()) {
      reporter.fail(`${id}: step ${index + 1} is empty`);
      return;
    }

    if (VAGUE_STEP.test(step)) {
      reporter.fail(`${id}: step ${index + 1} is not actionable ("${step.trim().slice(0, 60)}…")`);
    }
  });

  const joined = steps.join(" ");

  // A no-cook entry may still say "toast the bread if you like". Those optional
  // asides are not the heat instructions this section is about, and demanding a
  // temperature for them produces noise, so the heat checks are skipped when the
  // entry declares itself no-cook (the noCook flag is separately checked against
  // the declared equipment).
  const appliesHeat = COOK_VERBS.test(joined) && entry.noCook !== true;

  if (appliesHeat) {
    if (!DURATION.test(joined)) {
      reporter.fail(`${id}: steps apply heat but never state how long`);
    }

    // A microwave has one setting that matters for this kind of cooking, so
    // "microwave for 2 minutes" is a complete instruction on its own.
    const microwaveOnly = (entry.equipment || []).length > 0 &&
      (entry.equipment || []).every((item) => ["microwave", "kettle", "toaster"].includes(item));

    if (!TEMPERATURE.test(joined) && !microwaveOnly) {
      reporter.fail(`${id}: steps apply heat but never state a temperature or heat level`);
    }

    if (!DONENESS.test(joined)) {
      reporter.fail(`${id}: steps apply heat but give no doneness cue the cook can check`);
    }
  }

  // Baking and roasting need a real number. Grilling does not — a domestic grill
  // has a heat level, not a dial in degrees — so it is excluded here.
  const bakes = /\b(bake|baked|baking|roast|roasted|air fry|air-fry)\b/i.test(joined);
  if (appliesHeat && bakes && !/\b\d{2,3}\s*(?:C|F)\b/.test(joined) && !/full power/i.test(joined)) {
    const usesOven = (entry.equipment || []).some((item) => item === "oven" || item === "air fryer");
    if (usesOven) {
      reporter.fail(`${id}: bakes or air-fries but no numeric temperature is given`);
    }
  }

  // Food safety. Anything already cooked when it enters the recipe (rotisserie
  // chicken, tinned tuna, deli slices) carries no raw-protein obligation.
  const preCooked = /\bcooked\b|rotisserie|canned|tinned|sliced turkey|sliced ham|deli|frozen breaded/;
  const ingredientTexts = (entry.ingredients || [])
    .map(ingredientText)
    .filter((text) => !preCooked.test(text));

  if (ingredientTexts.some((text) => RAW_MEAT.test(text)) && !SAFE_CUE.test(joined)) {
    reporter.fail(`${id}: contains raw meat or fish but no food-safety cue (temperature, "no pink", "cooked through")`);
  }

  if (appliesHeat && ingredientTexts.some((text) => RAW_EGG.test(text)) && !EGG_CUE.test(joined) && !SAFE_CUE.test(joined)) {
    reporter.fail(`${id}: cooks egg but never says how to tell it is set`);
  }
}

function checkDietAndAllergens(reporter, entry) {
  const id = entry.id;

  if (!Object.prototype.hasOwnProperty.call(DIET_RANK, entry.diet)) {
    reporter.fail(`${id}: unknown diet "${entry.diet}"`);
    return;
  }

  const required = (entry.ingredients || []).filter((ingredient) => ingredient && !ingredient.optional);
  const requiredText = required.map(ingredientText);
  const allText = (entry.ingredients || []).map(ingredientText);

  const hasAny = (list, words) => list.some((text) => words.some((word) => hasWord(text, word)));

  const meat = hasAny(requiredText, MEAT_WORDS);
  const fish = hasAny(requiredText, FISH_WORDS);
  // Both go through allergenApplies so the same exceptions hold: peanut butter
  // is not dairy, and vegan mayonnaise is not egg.
  const dairy = requiredText.some((text) => allergenApplies("dairy", text));
  const egg = requiredText.some((text) => allergenApplies("egg", text));
  const honey = hasAny(requiredText, HONEY_WORDS);

  if (entry.diet === "vegetarian" && meat) {
    reporter.fail(`${id}: labelled vegetarian but a required ingredient is meat`);
  }

  if (entry.diet === "vegetarian" && fish) {
    reporter.fail(`${id}: labelled vegetarian but a required ingredient is fish or shellfish`);
  }

  if (entry.diet === "vegan" && (meat || fish || dairy || egg || honey)) {
    reporter.fail(`${id}: labelled vegan but a required ingredient is an animal product`);
  }

  if (entry.diet === "pescatarian" && meat) {
    reporter.fail(`${id}: labelled pescatarian but a required ingredient is meat`);
  }

  // An entry claiming to be less restrictive than it is wastes eligible matches.
  // An entry whose ingredients are all plant-based but that is labelled omnivore
  // is usually a tagging slip. It is a warning, not an error, because a packaged
  // ingredient (dumplings, stock, a sauce) can legitimately contain meat — and
  // when the entry says so in a substitution, there is nothing to report.
  if (entry.diet === "omnivore" && !meat && !fish) {
    const explains = /vegetarian|vegan|check the packet|check the label/i.test(
      JSON.stringify(entry.substitutions || [])
    );

    if (!explains) {
      reporter.warn(`${id}: labelled omnivore but no required ingredient is meat or fish — could it be vegetarian?`);
    }
  }

  // Allergens: every allergen implied by a REQUIRED ingredient must be declared.
  // Optional ingredients may add to the declaration but cannot force one.
  const declared = new Set(entry.allergens || []);

  Object.keys(ALLERGEN_WORDS).forEach((allergen) => {
    if (requiredText.some((text) => allergenApplies(allergen, text)) && !declared.has(allergen)) {
      reporter.fail(`${id}: contains "${allergen}" in a required ingredient but does not declare it`);
    }
  });

  declared.forEach((allergen) => {
    if (!Object.prototype.hasOwnProperty.call(ALLERGEN_WORDS, allergen)) {
      reporter.fail(`${id}: unknown allergen "${allergen}"`);
      return;
    }

    // Declaring an allergen is always the safe direction, so this only warns
    // when NOTHING in the list resembles it at all. The plant-milk qualifier is
    // ignored here on purpose: "milk or plant milk" genuinely is dairy for the
    // reader who reaches for the dairy one, so declaring it is correct.
    const resembles = allText.some((text) =>
      (ALLERGEN_WORDS[allergen] || []).some((word) => hasWord(text, word))
    );

    if (!resembles) {
      reporter.warn(`${id}: declares allergen "${allergen}" but no ingredient obviously contains it`);
    }
  });
}

function checkTags(reporter, entry, taxonomy) {
  const id = entry.id;
  const categories = entry.categories || [];
  const cravings = entry.cravings || [];

  if (categories.length === 0) {
    reporter.fail(`${id}: has no categories — it can never be matched to a blocked page`);
  }

  if (cravings.length === 0) {
    reporter.fail(`${id}: has no cravings`);
  }

  categories.forEach((category) => {
    if (!taxonomy.categories.includes(category)) {
      reporter.fail(`${id}: unknown category "${category}"`);
    }
  });

  cravings.forEach((craving) => {
    if (!taxonomy.cravings.includes(craving)) {
      reporter.fail(`${id}: unknown craving "${craving}"`);
    }
  });

  // --- the specific semantic mistakes this dataset has had before -----------

  const requiredText = (entry.ingredients || [])
    .filter((ingredient) => ingredient && !ingredient.optional)
    .map(ingredientText);
  const hasChicken = requiredText.some((text) => hasWord(text, "chicken"));
  const isChickenCraving = cravings.includes("fried-chicken") || cravings.includes("chicken-sandwich") || cravings.includes("wings");

  // A chickpea/tofu/plant entry may answer a chicken craving, but only when it
  // says so — a substitution entry, or a title/description that frames it as a
  // stand-in. What it must never do is pass as a chicken dish.
  if (isChickenCraving && !hasChicken) {
    const declaresSubstitute = /substitute|instead of|plant|alternative|not a chicken/i.test(
      `${entry.title} ${entry.description} ${JSON.stringify(entry.substitutions || [])}`
    );

    if (!declaresSubstitute) {
      reporter.fail(
        `${id}: answers a chicken craving with no chicken and no stated substitute relationship ` +
          `(this is the "chickpeas tagged as chicken" mistake)`
      );
    }
  }

  // A smoothie is not coffee. They are both cold drinks, which is exactly why
  // this went wrong before.
  const isSmoothie = /smoothie|nice cream|shake/i.test(entry.title);
  const hasCoffeeIngredient = requiredText.some((text) => hasWord(text, "coffee") || hasWord(text, "espresso"));

  if (cravings.includes("coffee") && !hasCoffeeIngredient && isSmoothie) {
    reporter.fail(`${id}: a smoothie is tagged as a coffee craving without containing coffee`);
  }

  if (categories.includes("coffee") && !hasCoffeeIngredient && isSmoothie) {
    reporter.fail(`${id}: a smoothie is categorised as coffee without containing coffee`);
  }

  // Dessert tags must not leak onto savoury food. Word-bounded on purpose:
  // an unbounded /ice/ matches inside "rice", "juice", and "spice", which let a
  // savoury rice dish pass as a dessert.
  const dessertish = /\b(sugar|cocoa|chocolate|honey|syrup|banana|bananas|berries|berry|fruit|granola|yogurt|ice|ice cream|maple|jam|cinnamon)\b/i;
  if (cravings.includes("dessert") || cravings.includes("ice-cream")) {
    const looksSweet = requiredText.some((text) => dessertish.test(text));

    if (!looksSweet) {
      reporter.fail(`${id}: tagged as a dessert craving but no required ingredient is sweet`);
    }
  }

  // Flag claims must agree with the declared equipment and method.
  if (entry.noCook && (entry.equipment || []).some((item) => ["stove", "oven", "air fryer", "microwave"].includes(item))) {
    reporter.fail(`${id}: marked noCook but declares heating equipment`);
  }

  if (entry.microwave && !(entry.equipment || []).includes("microwave")) {
    reporter.fail(`${id}: marked microwave but does not list a microwave`);
  }

  if (entry.airFryer && !(entry.equipment || []).includes("air fryer")) {
    reporter.fail(`${id}: marked airFryer but does not list an air fryer`);
  }

  if (entry.method === "no-cook" && !entry.noCook) {
    reporter.fail(`${id}: method is no-cook but the noCook flag is false`);
  }
}

function checkSubstitutionsAndCalories(reporter, entry) {
  const id = entry.id;
  const substitutions = entry.substitutions || [];

  substitutions.forEach((substitution, index) => {
    if (!substitution || typeof substitution !== "object") {
      reporter.fail(`${id}: substitution ${index + 1} must be an object with "for" and "use"`);
      return;
    }

    ["for", "use"].forEach((field) => {
      if (typeof substitution[field] !== "string" || !substitution[field].trim()) {
        reporter.fail(`${id}: substitution ${index + 1} is missing "${field}"`);
      }
    });
  });

  const covered = new Set(substitutions.map((substitution) => lower(substitution.for)));

  (entry.ingredients || [])
    .filter((ingredient) => ingredient && !ingredient.optional)
    .forEach((ingredient) => {
      const text = ingredientText(ingredient);
      const uncommon = UNCOMMON_INGREDIENTS.find((word) => hasWord(text, word));

      if (uncommon && !covered.has(text) && ![...covered].some((entryFor) => hasWord(entryFor, uncommon))) {
        reporter.fail(`${id}: depends on "${ingredient.item}" but offers no substitution for it`);
      }
    });

  if (entry.calorieRange !== undefined) {
    const range = entry.calorieRange;
    const valid =
      Array.isArray(range) &&
      range.length === 2 &&
      range.every((value) => Number.isFinite(value) && value > 0) &&
      range[0] < range[1];

    if (!valid) {
      reporter.fail(`${id}: calorieRange must be [low, high] with low < high`);
      return;
    }

    if (range[0] < 40 || range[1] > 1600) {
      reporter.fail(`${id}: calorieRange ${JSON.stringify(range)} is outside a believable per-serving range`);
    }

    // A range implies imprecision. A 1-calorie "range" is false precision.
    if (range[1] - range[0] < 20) {
      reporter.fail(`${id}: calorieRange ${JSON.stringify(range)} is too narrow to be honest for a home recipe`);
    }
  }
}

// A step naturally says "the cheese", not "the shredded mozzarella". Without a
// synonym table this check would report a false positive on almost every recipe,
// which is the fastest way to teach people to ignore a validator.
//
// Matched as a SUBSTRING of the joined step text, not as a whole word, so one
// generic covers its own inflections: "vegetable" finds "vegetables", "floret"
// finds "florets", "crunch" finds "crunchy".
const INGREDIENT_SYNONYMS = [
  [/mozzarella|cheddar|parmesan|feta|paneer|halloumi|cottage cheese/, "cheese"],
  [/naan|pita|tortilla|bun|muffin|ciabatta|flatbread|roti|bagel|roll/, "bread"],
  [/spaghetti|penne|fusilli|noodle/, "pasta"],
  [/salsa|passata|pesto|hot sauce|sriracha|gochujang/, "sauce"],
  [/mayonnaise|mayo|ranch/, "sauce"],
  [/berries|banana|apple|pear|mango|peach/, "fruit"],
  [/chickpeas|black beans|pinto|kidney|lentils/, "beans"],
  [/turkey|ham|beef|pork|chicken/, "meat"],
  [/tuna|salmon|cod|prawns/, "fish"],
  [/crackers|tortilla chips|granola|cereal|cornflakes/, "crunch"],
  [/frozen pizza/, "pizza"],
  // A step pours "the liquid" into the blender, arranges "the florets", steams
  // "the frozen vegetables", rolls up "the chicken and salad". Each of these is
  // the word a cook actually writes once the ingredient is in the pan.
  //
  // Widening a row here can only ever SUPPRESS a warning when the step text
  // genuinely contains the generic word, so a mapping cannot hide an ingredient
  // the steps never refer to at all.
  [/milk|stock|broth|juice/, "liquid"],
  [/cauliflower|broccoli/, "floret"],
  [
    /tomato|cucumber|onion|pepper|carrot|lettuce|spinach|courgette|zucchini|cabbage|broccoli|green beans|peas|sweetcorn|mushroom/,
    "vegetable"
  ],
  [/lettuce|rocket|arugula|slaw|salad leaves|mixed leaves/, "salad"]
];

// Some steps refer to the ingredient list COLLECTIVELY, and that is correct
// recipe prose rather than an omission: "stir everything together" genuinely
// does account for every ingredient, and a burrito's "pile the filling" accounts
// for the things going inside it. Deliberately short and literal — phrases like
// "the dressing" or "the batter" are NOT here, because those name something a
// step has just built out of named ingredients, so they would exempt a recipe
// that really had left an ingredient stranded.
const COLLECTIVE_STEP_REFERENCE =
  /\b(everything|all (?:the )?ingredients|the (?:remaining|rest of the) ingredients|the filling)\b/;

// Words that are never evidence that an ingredient was used: articles,
// prepositions, and the prep adjectives that decorate an ingredient name
// ("shredded cheese", "cut into strips"). Filtering them makes the check
// STRICTER — an ingredient whose only overlap with the steps is the word
// "chopped" is still reported.
const NON_EVIDENCE_WORDS = new Set([
  "and", "the", "for", "with", "into", "from", "plus", "about", "each", "any",
  "some", "more", "less", "cut", "your", "them", "then", "over", "onto", "per",
  "optional", "fresh", "freshly", "large", "small", "medium", "warm", "cold",
  "hot", "room", "temperature", "drained", "rinsed", "thinly", "roughly",
  "finely", "coarse", "coarsely", "beaten", "crushed", "ripe", "raw", "dried",
  "ground", "chopped", "sliced", "diced", "grated", "shredded", "mixed",
  "whole", "plain", "canned", "frozen", "packed", "level", "heaped"
]);

// English plurals, enough of them to stop the check lying. The previous rule
// stripped a bare trailing "s", which turns "tomatoes" into "tomatoe" and so
// never matches a step that says "tomato" — a false positive produced purely by
// the stemmer. Applied to BOTH sides so the comparison is symmetric.
function singular(word) {
  if (word.length > 4 && /ies$/.test(word)) {
    return `${word.slice(0, -3)}y`; // berries -> berry
  }
  if (word.length > 4 && /(?:oes|ches|shes|sses|xes|zes)$/.test(word)) {
    return word.slice(0, -2); // tomatoes -> tomato, dishes -> dish
  }
  if (word.length > 3 && /[^s]s$/.test(word)) {
    return word.slice(0, -1); // strips -> strip
  }
  return word;
}

// Content words of a phrase, singularised. Minimum length 3, not 4: "bun",
// "egg", "ham" and "oat" are head nouns, and dropping them made the check miss
// the very word the step used.
function evidenceWords(text) {
  return lower(text)
    .split(/[^a-z]+/)
    .filter((word) => word.length >= 3 && !NON_EVIDENCE_WORDS.has(word))
    .map(singular);
}

// Free-text cross-referencing. WARNINGS only — these are word guesses.
function checkIngredientReferences(reporter, entry) {
  const id = entry.id;
  const stepText = lower((entry.steps || []).join(" "));
  const stepWords = new Set(evidenceWords(stepText));

  if (COLLECTIVE_STEP_REFERENCE.test(stepText)) {
    return;
  }

  // Seasonings and fats are used without being named in a step all the time.
  const IGNORE = /^(salt|pepper|salt and pepper|water|black pepper|neutral oil|olive oil|oil|sugar|ice|hot water|seasonings)$/;

  (entry.ingredients || [])
    .filter((ingredient) => ingredient && !ingredient.optional)
    .forEach((ingredient) => {
      const item = ingredientText(ingredient);

      if (IGNORE.test(item)) {
        return;
      }

      // The `note` is part of the ingredient as the reader sees it, and it is
      // routinely what names the FORM the steps then refer to: "chicken breast,
      // cut into 8 strips" is why step 3 can say "coat each strip". Reading only
      // `item` reported that recipe as broken when it is exemplary.
      const words = [...evidenceWords(item), ...evidenceWords(ingredient.note || "")];
      const byWord = words.some((word) => stepWords.has(word) || stepText.includes(word));
      const bySynonym = INGREDIENT_SYNONYMS.some(([pattern, generic]) => pattern.test(item) && stepText.includes(generic));

      if (words.length > 0 && !byWord && !bySynonym) {
        reporter.warn(`${id}: required ingredient "${ingredient.item}" is never mentioned in the steps`);
      }
    });
}

function checkCoverage(reporter, entries, taxonomy) {
  const byCraving = new Map();

  entries.forEach((entry) => {
    (entry.cravings || []).forEach((craving) => {
      byCraving.set(craving, [...(byCraving.get(craving) || []), entry]);
    });
  });

  taxonomy.cravings.forEach((craving) => {
    const matches = byCraving.get(craving) || [];

    if (matches.length === 0) {
      reporter.fail(`craving "${craving}" is in the taxonomy but nothing answers it (orphaned tag)`);
      return;
    }

    if (matches.length < MIN_PER_CRAVING) {
      reporter.fail(
        `craving "${craving}" has only ${matches.length} alternative — the block page must be able to show another`
      );
    }
  });

  // Every major craving needs at least one genuinely fast answer, or the "I am
  // hungry now" path has nothing to offer.
  //
  // This is an ERROR, not a warning. It is decided exactly — a count of entries
  // whose totalMinutes is a number — so the "natural-language matching guesses"
  // reason for warning does not apply. It used to warn, and the consequence was
  // that `wings` sat with three air-fryer answers of 26, 30 and 32 minutes for
  // as long as it took someone to read past a green summary line: the user
  // picked "I'm hungry now" on a wings page and the product quietly swapped
  // their craving for a chicken wrap and a bag of fries.
  MAJOR_CRAVINGS.forEach((craving) => {
    const matches = byCraving.get(craving) || [];
    const fast = matches.filter((entry) => entry.totalMinutes <= 15);

    if (matches.length > 0 && fast.length < MIN_FAST_PER_MAJOR) {
      reporter.fail(`craving "${craving}" has no answer under 15 minutes — the "I'm hungry now" path cannot serve it`);
    }
  });

  // Every blocked category the mapping knows about must reach something.
  Object.entries(taxonomy.categoryCravings).forEach(([category, cravings]) => {
    const reachable = cravings.some((craving) => (byCraving.get(craving) || []).length > 0);

    if (!reachable) {
      reporter.fail(`blocked category "${category}" maps to cravings that nothing answers`);
    }
  });

  Object.values(taxonomy.specialtyCravings).forEach((cravings) => {
    cravings.forEach((craving) => {
      if (!taxonomy.cravings.includes(craving)) {
        reporter.fail(`specialtyCravings references unknown craving "${craving}"`);
      }
    });
  });

  // Diet coverage: a vegetarian or vegan user must have real choice.
  const vegetarian = entries.filter((entry) => DIET_RANK[entry.diet] <= DIET_RANK.vegetarian);
  const vegan = entries.filter((entry) => entry.diet === "vegan");

  if (vegetarian.length < 20) {
    reporter.fail(`only ${vegetarian.length} vegetarian-or-stricter alternatives — a vegetarian user needs real choice`);
  }

  if (vegan.length < 8) {
    reporter.fail(`only ${vegan.length} vegan alternatives`);
  }

  // Minimal-kitchen coverage.
  const microwaveOnly = entries.filter(
    (entry) => entry.noCook || (entry.equipment || []).every((item) => ["microwave", "kettle", "toaster"].includes(item))
  );

  if (microwaveOnly.length < 12) {
    reporter.fail(`only ${microwaveOnly.length} alternatives work without a stove or oven`);
  }

  reporter.note(`${vegetarian.length} vegetarian-or-stricter · ${vegan.length} vegan · ${microwaveOnly.length} no stove/oven needed`);
}

function checkDuplicates(reporter, entries) {
  const seenIds = new Map();
  const seenTitles = new Map();

  entries.forEach((entry) => {
    if (seenIds.has(entry.id)) {
      reporter.fail(`duplicate id "${entry.id}"`);
    }
    seenIds.set(entry.id, entry);

    const key = titleKey(entry.title);
    if (seenTitles.has(key)) {
      reporter.fail(`duplicate title "${entry.title}" (also ${seenTitles.get(key)})`);
    }
    seenTitles.set(key, entry.id);
  });

  // Near-duplicates are a judgement call, so they warn rather than fail.
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const score = similarity(entries[i].title, entries[j].title);

      if (score >= 0.7) {
        reporter.warn(
          `"${entries[i].title}" and "${entries[j].title}" look like near-duplicates (${Math.round(score * 100)}% title overlap)`
        );
      }
    }
  }
}

/**
 * @param {object} [catalogOverride] an in-memory catalog to audit instead of
 *   data/recipes.json. Used by test/validator-contract.test.js to feed the audit
 *   a deliberately-broken entry per documented rule and prove the rule is really
 *   enforced — otherwise the documentation and the implementation can only be
 *   compared by reading them, which is how they drift.
 */
function alternativesAudit(catalogOverride) {
  const reporter = new Reporter("Alternatives catalog (recipes + quick alternatives)");

  let catalog;

  if (catalogOverride) {
    catalog = catalogOverride;
  } else {
    try {
      catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    } catch (error) {
      reporter.fail(`data/recipes.json is unreadable or invalid JSON: ${error.message}`);
      return reporter;
    }
  }

  if (catalog._version !== SCHEMA_VERSION) {
    reporter.fail(`catalog _version must be "${SCHEMA_VERSION}" (got ${JSON.stringify(catalog._version)})`);
  }

  const taxonomy = catalog.taxonomy;

  if (!taxonomy || typeof taxonomy !== "object") {
    reporter.fail("catalog has no taxonomy — nothing can be validated against a vocabulary");
    return reporter;
  }

  ["methods", "equipment", "diets", "allergens", "regions", "cravings", "categories", "categoryCravings", "specialtyCravings"].forEach(
    (key) => {
      if (!taxonomy[key]) {
        reporter.fail(`taxonomy is missing "${key}"`);
      }
    }
  );

  if (reporter.errors.length > 0) {
    return reporter;
  }

  const recipes = Array.isArray(catalog.recipes) ? catalog.recipes : [];
  const quick = Array.isArray(catalog.quickAlternatives) ? catalog.quickAlternatives : [];
  const entries = [...recipes, ...quick];

  if (entries.length < 60) {
    reporter.fail(`only ${entries.length} alternatives — the catalog must carry at least 60`);
  }

  recipes.forEach((entry) => {
    if (entry.kind !== "recipe") {
      reporter.fail(`${entry.id || "(no id)"}: entries in "recipes" must have kind "recipe"`);
    }
  });

  quick.forEach((entry) => {
    if (entry.kind !== "quick") {
      reporter.fail(`${entry.id || "(no id)"}: entries in "quickAlternatives" must have kind "quick"`);
    }
  });

  entries.forEach((entry, index) => {
    const where = `entry ${index + 1}`;

    if (!checkStructure(reporter, entry, where)) {
      return;
    }

    checkServingsAndIngredients(reporter, entry, taxonomy);
    checkTimes(reporter, entry);
    checkSteps(reporter, entry);
    checkDietAndAllergens(reporter, entry);
    checkTags(reporter, entry, taxonomy);
    checkSubstitutionsAndCalories(reporter, entry);
    checkIngredientReferences(reporter, entry);
  });

  checkDuplicates(reporter, entries);
  checkCoverage(reporter, entries, taxonomy);

  // The generated file must match its sources. Skipped when auditing an
  // in-memory catalog, which by definition is not the generated file.
  try {
    const generator = require("./build-alternatives");
    if (!catalogOverride && generator.isStale()) {
      reporter.fail("data/recipes.json is stale — run `npm run generate:alternatives`");
    }
  } catch (error) {
    reporter.fail(`could not verify the catalog is freshly generated: ${error.message}`);
  }

  const fast = entries.filter((entry) => entry.totalMinutes <= 15).length;
  const noCook = entries.filter((entry) => entry.noCook).length;
  reporter.note(`${recipes.length} full recipes + ${quick.length} quick alternatives = ${entries.length}`);
  reporter.note(`${fast} ready in 15 minutes or less · ${noCook} need no cooking at all`);
  reporter.note(`${taxonomy.cravings.length} cravings · ${taxonomy.categories.length} categories in the vocabulary`);

  return reporter;
}

if (require.main === module) {
  runCli(alternativesAudit);
}

module.exports = alternativesAudit;
