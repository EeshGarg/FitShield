"use strict";
/**
 * Documentation ↔ implementation contract.
 *
 * CONTRIBUTING.md tells contributors exactly which data mistakes the validator
 * will reject. docs/STORAGE.md and ARCHITECTURE.md make comparable promises
 * about storage and packaging. Those promises are only worth anything if the
 * code actually enforces them — and reading two documents side by side is
 * precisely how they drift apart.
 *
 * So every documented rule below is exercised by feeding the real validator a
 * deliberately-broken entry and asserting it is rejected. A rule that stops
 * being enforced fails here, in the same commit that weakens it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const alternativesAudit = require("../tools/alternatives-audit.js");
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "recipes.json"), "utf8"));

// A minimal entry that PASSES every rule, used as the base for each violation.
function validRecipe(overrides) {
  return {
    id: "contract-probe",
    kind: "recipe",
    title: "Contract Probe",
    description: "A valid entry used to test one rule at a time.",
    servings: 2,
    ingredients: [
      { quantity: 2, unit: "cup", item: "cooked rice" },
      { quantity: 1, unit: "tbsp", item: "olive oil" }
    ],
    steps: [
      "Heat the oil in a pan over medium heat for 1 minute, until it shimmers.",
      "Add the rice and cook 3 minutes, until it is steaming hot and starting to crisp."
    ],
    totalMinutes: 10,
    activeMinutes: 8,
    prepMinutes: 3,
    cookMinutes: 5,
    difficulty: "easy",
    equipment: ["stove"],
    method: "quick-cook",
    diet: "vegan",
    allergens: [],
    substitutions: [],
    storage: "Keeps 2 days.",
    categories: ["delivery"],
    cravings: ["comfort"],
    region: "global",
    noCook: false,
    microwave: false,
    airFryer: false,
    onePan: true,
    pantryFriendly: true,
    dataVersion: 2,
    ...overrides
  };
}

// Audit a catalog consisting of the REAL entries plus one probe, so coverage
// rules (every craving needs two answers, etc.) stay satisfied and only the
// rule under test can fail.
function auditWithProbe(probe) {
  const withProbe = {
    ...catalog,
    recipes: [...catalog.recipes, probe],
    quickAlternatives: catalog.quickAlternatives
  };

  return alternativesAudit(withProbe);
}

function errorsFor(probe) {
  return auditWithProbe(probe).errors.filter((message) => /contract[- ]probe/i.test(message));
}

test("the probe itself is valid — otherwise every case below is meaningless", () => {
  assert.deepEqual(errorsFor(validRecipe()), []);
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: "every ingredient needs a quantity and a unit"
// ---------------------------------------------------------------------------

test("an ingredient with no quantity is rejected", () => {
  const errors = errorsFor(validRecipe({ ingredients: [{ unit: "cup", item: "cooked rice" }] }));
  assert.ok(errors.some((e) => /quantity/i.test(e)), errors.join("; "));
});

test("an ingredient with no unit is rejected", () => {
  const errors = errorsFor(validRecipe({ ingredients: [{ quantity: 2, item: "cooked rice" }] }));
  assert.ok(errors.some((e) => /unit/i.test(e)), errors.join("; "));
});

test("an entry where every ingredient is optional is rejected", () => {
  const errors = errorsFor(
    validRecipe({ ingredients: [{ quantity: 2, unit: "cup", item: "cooked rice", optional: true }] })
  );
  assert.ok(errors.some((e) => /optional/i.test(e)), errors.join("; "));
});

test("missing servings is rejected", () => {
  assert.ok(errorsFor(validRecipe({ servings: 0 })).some((e) => /servings/i.test(e)));
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: heat needs a duration, a heat level, and a doneness cue
// ---------------------------------------------------------------------------

test("a heat step with no duration is rejected", () => {
  const errors = errorsFor(
    validRecipe({ steps: ["Heat the oil in a pan over medium heat until it is golden and shimmering."] })
  );
  assert.ok(errors.some((e) => /how long/i.test(e)), errors.join("; "));
});

test("a heat step with no temperature or heat level is rejected", () => {
  const errors = errorsFor(
    validRecipe({ steps: ["Fry the rice for 3 minutes until it is golden and crisp."] })
  );
  assert.ok(errors.some((e) => /temperature or heat level/i.test(e)), errors.join("; "));
});

test("a heat step with no doneness cue is rejected", () => {
  const errors = errorsFor(
    validRecipe({ steps: ["Fry the rice over medium heat for 3 minutes.", "Serve it."] })
  );
  assert.ok(errors.some((e) => /doneness cue/i.test(e)), errors.join("; "));
});

test("'until done' is rejected as unactionable", () => {
  const errors = errorsFor(
    validRecipe({ steps: ["Fry the rice over medium heat for 3 minutes until done."] })
  );
  assert.ok(errors.some((e) => /not actionable/i.test(e)), errors.join("; "));
});

test("baking without a numeric temperature is rejected", () => {
  const errors = errorsFor(
    validRecipe({
      equipment: ["oven"],
      steps: ["Bake the rice on a high heat for 20 minutes, until golden and crisp."]
    })
  );
  assert.ok(errors.some((e) => /numeric temperature/i.test(e)), errors.join("; "));
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: raw meat or fish needs an explicit food-safety cue
// ---------------------------------------------------------------------------

test("raw chicken with no food-safety cue is rejected", () => {
  const errors = errorsFor(
    validRecipe({
      diet: "omnivore",
      ingredients: [{ quantity: 300, unit: "g", item: "chicken breast" }],
      steps: ["Fry the chicken over medium heat for 8 minutes, until golden and browned."]
    })
  );
  assert.ok(errors.some((e) => /food-safety cue/i.test(e)), errors.join("; "));
});

test("raw chicken WITH a food-safety cue is accepted", () => {
  const errors = errorsFor(
    validRecipe({
      diet: "omnivore",
      cravings: ["comfort", "high-protein"],
      ingredients: [{ quantity: 300, unit: "g", item: "chicken breast" }],
      steps: [
        "Fry the chicken over medium heat for 8 minutes, until golden and browned.",
        "It is done when no piece shows pink inside and the juices run clear."
      ]
    })
  );
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: diet labels must match the ingredients
// ---------------------------------------------------------------------------

test("a vegan entry requiring dairy is rejected", () => {
  const errors = errorsFor(
    validRecipe({
      ingredients: [{ quantity: 2, unit: "cup", item: "cooked rice" }, { quantity: 50, unit: "g", item: "cheddar cheese" }],
      allergens: ["dairy"]
    })
  );
  assert.ok(errors.some((e) => /vegan but a required ingredient is an animal product/i.test(e)), errors.join("; "));
});

test("a vegetarian entry requiring meat is rejected", () => {
  const errors = errorsFor(
    validRecipe({
      diet: "vegetarian",
      ingredients: [{ quantity: 2, unit: "cup", item: "cooked rice" }, { quantity: 100, unit: "g", item: "bacon" }]
    })
  );
  assert.ok(errors.some((e) => /vegetarian but a required ingredient is meat/i.test(e)), errors.join("; "));
});

test("a vegetarian entry requiring fish is rejected", () => {
  const errors = errorsFor(
    validRecipe({
      diet: "vegetarian",
      ingredients: [{ quantity: 2, unit: "cup", item: "cooked rice" }, { quantity: 100, unit: "g", item: "salmon" }],
      allergens: ["fish"]
    })
  );
  assert.ok(errors.some((e) => /fish or shellfish/i.test(e)), errors.join("; "));
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: declared allergens must match the ingredients
// ---------------------------------------------------------------------------

test("an undeclared allergen in a required ingredient is rejected", () => {
  const errors = errorsFor(
    validRecipe({
      ingredients: [{ quantity: 2, unit: "tbsp", item: "peanut butter" }],
      allergens: []
    })
  );
  assert.ok(errors.some((e) => /contains "peanut"/i.test(e)), errors.join("; "));
});

test("an unknown allergen name is rejected", () => {
  assert.ok(errorsFor(validRecipe({ allergens: ["gluten-ish"] })).some((e) => /unknown allergen/i.test(e)));
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: uncommon ingredients need a substitution
// ---------------------------------------------------------------------------

test("depending on an uncommon ingredient with no substitution is rejected", () => {
  const errors = errorsFor(
    validRecipe({
      ingredients: [{ quantity: 2, unit: "cup", item: "cooked rice" }, { quantity: 1, unit: "tbsp", item: "gochujang" }],
      allergens: ["soy"],
      substitutions: []
    })
  );
  assert.ok(errors.some((e) => /offers no substitution/i.test(e)), errors.join("; "));
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: calorie ranges must be honest
// ---------------------------------------------------------------------------

test("a calorie range narrower than 20 kcal is rejected as false precision", () => {
  assert.ok(errorsFor(validRecipe({ calorieRange: [500, 505] })).some((e) => /too narrow/i.test(e)));
});

test("an impossible calorie range is rejected", () => {
  assert.ok(errorsFor(validRecipe({ calorieRange: [10, 5000] })).some((e) => /believable/i.test(e)));
});

test("a reversed calorie range is rejected", () => {
  assert.ok(errorsFor(validRecipe({ calorieRange: [600, 400] })).some((e) => /low < high/i.test(e)));
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: vocabulary and flags
// ---------------------------------------------------------------------------

test("unknown equipment, method, region, category, and craving are all rejected", () => {
  assert.ok(errorsFor(validRecipe({ equipment: ["plasma cutter"] })).some((e) => /unknown equipment/i.test(e)));
  assert.ok(errorsFor(validRecipe({ method: "sous-vide" })).some((e) => /unknown cooking method/i.test(e)));
  assert.ok(errorsFor(validRecipe({ region: "atlantis" })).some((e) => /unknown region/i.test(e)));
  assert.ok(errorsFor(validRecipe({ categories: ["banquet"] })).some((e) => /unknown category/i.test(e)));
  assert.ok(errorsFor(validRecipe({ cravings: ["elevenses"] })).some((e) => /unknown craving/i.test(e)));
});

test("flags that contradict the declared equipment are rejected", () => {
  assert.ok(errorsFor(validRecipe({ noCook: true })).some((e) => /noCook but declares heating equipment/i.test(e)));
  assert.ok(errorsFor(validRecipe({ microwave: true })).some((e) => /marked microwave/i.test(e)));
  assert.ok(errorsFor(validRecipe({ airFryer: true })).some((e) => /marked airFryer/i.test(e)));
});

test("an entry with no categories or no cravings is rejected", () => {
  assert.ok(errorsFor(validRecipe({ categories: [] })).some((e) => /no categories/i.test(e)));
  assert.ok(errorsFor(validRecipe({ cravings: [] })).some((e) => /no cravings/i.test(e)));
});

test("a bad id, a wrong dataVersion, and a non-boolean flag are all rejected", () => {
  assert.ok(errorsFor(validRecipe({ id: "Contract Probe" })).some((e) => /kebab-case/i.test(e)));
  assert.ok(errorsFor(validRecipe({ dataVersion: 1 })).some((e) => /dataVersion/i.test(e)));
  assert.ok(errorsFor(validRecipe({ onePan: "yes" })).some((e) => /true or false/i.test(e)));
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: time fields
// ---------------------------------------------------------------------------

test("active effort greater than elapsed time is rejected", () => {
  assert.ok(errorsFor(validRecipe({ activeMinutes: 30, totalMinutes: 10 })).some((e) => /cannot exceed/i.test(e)));
});

test("a full recipe without prep and cook times is rejected", () => {
  const probe = validRecipe();
  delete probe.prepMinutes;
  assert.ok(errorsFor(probe).some((e) => /prepMinutes and cookMinutes/i.test(e)));
});

test("a quick alternative with more than four steps is rejected", () => {
  const withProbe = {
    ...catalog,
    quickAlternatives: [
      ...catalog.quickAlternatives,
      validRecipe({
        kind: "quick",
        steps: [
          "Heat the oil over medium heat for 1 minute, until it shimmers.",
          "Add the rice and stir.",
          "Cook 3 minutes until steaming hot.",
          "Season it.",
          "Serve it."
        ]
      })
    ]
  };

  const errors = alternativesAudit(withProbe).errors.filter((m) => /contract[- ]probe/i.test(m));
  assert.ok(errors.some((e) => /at most 4 steps/i.test(e)), errors.join("; "));
});

// ---------------------------------------------------------------------------
// CONTRIBUTING.md: the two semantic rules that exist because of real mistakes
// ---------------------------------------------------------------------------

test("a plant dish answering a chicken craving without saying so is rejected", () => {
  const errors = errorsFor(
    validRecipe({
      title: "Rice Bowl",
      description: "A rice bowl.",
      cravings: ["fried-chicken"],
      categories: ["chicken"]
    })
  );
  assert.ok(errors.some((e) => /chickpeas tagged as chicken/i.test(e)), errors.join("; "));
});

test("the same dish IS accepted when it declares itself a substitute", () => {
  const errors = errorsFor(
    validRecipe({
      title: "Rice Bowl",
      description: "A plant substitute for a fried-chicken craving.",
      cravings: ["fried-chicken"],
      categories: ["chicken"]
    })
  );
  assert.deepEqual(errors, []);
});

test("a smoothie tagged as coffee is rejected", () => {
  const errors = errorsFor(
    validRecipe({
      title: "Berry Smoothie",
      description: "A smoothie.",
      cravings: ["coffee"],
      categories: ["coffee"],
      equipment: ["blender"],
      method: "no-cook",
      noCook: true,
      steps: ["Blend the fruit for 45 seconds until it is completely smooth."],
      ingredients: [{ quantity: 1, unit: "cup", item: "frozen berries" }]
    })
  );
  assert.ok(errors.some((e) => /smoothie/i.test(e)), errors.join("; "));
});

test("a dessert craving on savoury food is rejected", () => {
  const errors = errorsFor(validRecipe({ cravings: ["dessert"], categories: ["dessert"] }));
  assert.ok(errors.some((e) => /no required ingredient is sweet/i.test(e)), errors.join("; "));
});

// ---------------------------------------------------------------------------
// Fuzzy findings must stay WARNINGS — a word-match guess cannot fail a release
// ---------------------------------------------------------------------------

test("near-duplicate titles warn but never fail", () => {
  const probe = validRecipe({ title: catalog.recipes[0].title + " Bowl", id: "contract-probe" });
  const reporter = auditWithProbe(probe);

  assert.deepEqual(
    reporter.errors.filter((e) => /near-duplicate/i.test(e)),
    [],
    "a title-similarity guess must not be an error"
  );
});

test("an unreferenced ingredient warns but never fails", () => {
  const reporter = auditWithProbe(
    validRecipe({
      ingredients: [
        { quantity: 2, unit: "cup", item: "cooked rice" },
        { quantity: 1, unit: "tbsp", item: "olive oil" },
        { quantity: 1, unit: "tsp", item: "smoked paprika" }
      ]
    })
  );

  assert.deepEqual(
    reporter.errors.filter((e) => /never mentioned in the steps/i.test(e)),
    [],
    "a word-match guess must not be an error"
  );
  assert.ok(reporter.warnings.some((w) => /never mentioned in the steps/i.test(w)));
});

// ---------------------------------------------------------------------------
// The ingredient-reference heuristic, in BOTH directions.
//
// This check used to report eleven healthy recipes as broken, for four separate
// reasons in the matcher rather than anything wrong with the data: it stemmed
// "tomatoes" to "tomatoe" so a step saying "tomato" never matched, it discarded
// three-letter head nouns so "burger bun" could not see "the bun", it never read
// `ingredient.note` so "cut into 8 strips" could not license "each strip", and
// its synonym table had no entry for the words steps actually use ("the liquid",
// "the florets", "the vegetables", "the salad").
//
// Relaxing a fuzzy matcher is how a check quietly becomes decorative, so every
// relaxation below is pinned by a PAIR: the healthy recipe it must now accept,
// and the stranded ingredient it must still report. If a future edit widens the
// matcher into uselessness, the negative half of the pair fails.
// ---------------------------------------------------------------------------

function strandedWarningsFor(probe) {
  return auditWithProbe(probe).warnings.filter(
    (w) => /contract-probe/.test(w) && /never mentioned in the steps/i.test(w)
  );
}

const OMNIVORE = { diet: "omnivore", allergens: ["gluten", "dairy"] };

test("the shipped catalog has no unreferenced-ingredient warnings", () => {
  const reporter = alternativesAudit();
  const stranded = reporter.warnings.filter((w) => /never mentioned in the steps/i.test(w));

  assert.deepEqual(
    stranded,
    [],
    "Either a step stopped referring to an ingredient, or the matcher in " +
      "tools/alternatives-audit.js needs the word the step actually uses. Do not " +
      "delete the check — fix whichever side is wrong.\n  " +
      stranded.join("\n  ")
  );
});

test("a plural ingredient matches a singular step, but an absent one still warns", () => {
  const ingredients = [
    { quantity: 2, unit: "cup", item: "cooked rice" },
    { quantity: 3, unit: "piece", item: "tomatoes" }
  ];

  assert.deepEqual(
    strandedWarningsFor(
      validRecipe({
        ingredients,
        steps: ["Toss the tomato and the rice with the oil over medium heat for 2 minutes, until steaming hot."]
      })
    ),
    [],
    '"tomatoes" must match a step that says "tomato"'
  );

  assert.equal(
    strandedWarningsFor(validRecipe({ ingredients })).length,
    1,
    "stemming must not make an ingredient the steps never touch look referenced"
  );
});

test("a three-letter head noun is evidence, but only when the step contains it", () => {
  const ingredients = [
    { quantity: 1, unit: "piece", item: "burger bun" },
    { quantity: 1, unit: "tbsp", item: "olive oil" }
  ];

  assert.deepEqual(
    strandedWarningsFor(
      validRecipe({
        ...OMNIVORE,
        ingredients,
        steps: ["Toast the bun cut-side down in the oil for 1 minute, until golden."]
      })
    ),
    [],
    '"burger bun" must match a step that says "the bun"'
  );

  assert.equal(
    strandedWarningsFor(validRecipe({ ...OMNIVORE, ingredients })).length,
    1,
    "a short head noun must not match a step that never names it"
  );
});

test("an ingredient note licenses the word the steps use, and nothing more", () => {
  const withNote = (steps) =>
    strandedWarningsFor(
      validRecipe({
        ...OMNIVORE,
        ingredients: [
          { quantity: 400, unit: "g", item: "chicken breast", note: "cut into 8 strips" },
          { quantity: 1, unit: "tbsp", item: "olive oil" }
        ],
        steps
      })
    );

  assert.deepEqual(
    withNote(["Coat each strip in the oil and bake 15 minutes, until golden and white all the way through."]),
    [],
    'the note "cut into 8 strips" must license a step that says "each strip"'
  );

  assert.equal(
    withNote(["Heat the oil in a pan over medium heat for 5 minutes, until it is piping hot."]).length,
    1,
    "reading the note must not excuse an ingredient no step uses"
  );
});

test("a prep adjective shared with a step is not evidence the ingredient was used", () => {
  const stranded = strandedWarningsFor(
    validRecipe({
      ingredients: [
        { quantity: 2, unit: "cup", item: "cooked rice" },
        { quantity: 1, unit: "tsp", item: "smoked paprika", note: "finely chopped" }
      ],
      steps: ["Add the finely chopped rice to the oil and cook 3 minutes, until it is steaming hot."]
    })
  );

  assert.equal(
    stranded.length,
    1,
    'sharing only "finely"/"chopped" with a step must still be reported — those words describe every ingredient'
  );
});

test("a synonym only excuses an ingredient when the step really uses the generic word", () => {
  const ingredients = [
    { quantity: 1, unit: "piece", item: "cauliflower" },
    { quantity: 1, unit: "tbsp", item: "olive oil" }
  ];

  assert.deepEqual(
    strandedWarningsFor(
      validRecipe({
        ingredients,
        steps: ["Toss the florets through the oil and air fry 14 minutes, until golden and crisp."]
      })
    ),
    [],
    '"cauliflower" must match a step that says "the florets"'
  );

  assert.equal(
    strandedWarningsFor(
      validRecipe({
        ingredients,
        steps: ["Heat the oil in a pan over medium heat for 3 minutes, until it is piping hot."]
      })
    ).length,
    1,
    "a synonym must not fire when its generic word is absent from the steps"
  );
});

test("a collective step reference excuses the list; a step that merely names a mixture does not", () => {
  const ingredients = [
    { quantity: 1, unit: "cup", item: "rolled oats" },
    { quantity: 2, unit: "tbsp", item: "cocoa powder" }
  ];

  assert.deepEqual(
    strandedWarningsFor(
      validRecipe({
        ingredients,
        steps: ["Stir everything together in a bowl until it is stiff but holds together when squeezed."]
      })
    ),
    [],
    '"stir everything together" genuinely accounts for every ingredient'
  );

  assert.equal(
    strandedWarningsFor(
      validRecipe({
        ingredients,
        steps: ["Whisk the oats and the oil until the dressing thickens slightly, about 1 minute."]
      })
    ).length,
    1,
    '"the dressing" names something a step just built — it must not exempt the whole recipe'
  );
});

// ---------------------------------------------------------------------------
// ARCHITECTURE.md: the packaging contracts
// ---------------------------------------------------------------------------

test("every packaging contract ARCHITECTURE.md claims has a live audit", () => {
  const architecture = fs.readFileSync(path.join(ROOT, "ARCHITECTURE.md"), "utf8");

  // Each row of the contracts table names the tool that enforces it. Every named
  // tool must exist and be runnable, or the table is a promise nothing keeps.
  const named = [...architecture.matchAll(/`(tools\/[a-z-]+\.js)`/g)].map((match) => match[1]);
  assert.ok(named.length >= 4, `expected the contracts table to name its enforcers, found ${named.length}`);

  [...new Set(named)].forEach((tool) => {
    const file = path.join(ROOT, tool);
    assert.ok(fs.existsSync(file), `ARCHITECTURE.md names ${tool}, which does not exist`);

    // Audits export the audit function directly; builders (build-safari,
    // build-alternatives) export an object of callables. Either is runnable —
    // what must not happen is the document naming a tool that does nothing.
    const exported = require(file);
    const runnable =
      typeof exported === "function" ||
      (exported && typeof exported === "object" && Object.values(exported).some((v) => typeof v === "function"));

    assert.ok(runnable, `${tool} is named in ARCHITECTURE.md but exports nothing runnable`);
  });
});

test("every audit named in validate-all is reachable and returns a reporter", async () => {
  const { validateAll } = require("../tools/validate-all.js");
  const result = await validateAll({ quiet: true });

  assert.ok(result.reporters.length >= 12, `expected the full audit set, got ${result.reporters.length}`);
  result.reporters.forEach((reporter) => {
    assert.ok(Array.isArray(reporter.errors));
    assert.ok(Array.isArray(reporter.warnings));
    assert.equal(typeof reporter.name, "string");
  });
});
