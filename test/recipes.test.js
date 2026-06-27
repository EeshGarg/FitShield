"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const recipesModule = require("../recipes.js");
const { loadRecipes, selectRecipes } = recipesModule;

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "recipes.json"), "utf8"));
const RECIPES = data.recipes;

test("recipes.json has a valid recipes array", () => {
  assert.ok(Array.isArray(RECIPES));
  assert.ok(RECIPES.length >= 10);
});

test("every recipe has the required fields and a valid diet", () => {
  const ids = new Set();
  RECIPES.forEach((recipe) => {
    assert.equal(typeof recipe.id, "string");
    assert.ok(!ids.has(recipe.id), `duplicate id ${recipe.id}`);
    ids.add(recipe.id);

    assert.equal(typeof recipe.title, "string");
    assert.equal(typeof recipe.description, "string");
    assert.equal(typeof recipe.timeMinutes, "number");
    assert.ok(recipe.timeMinutes > 0);
    assert.ok(Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0);
    assert.ok(Array.isArray(recipe.steps) && recipe.steps.length > 0);
    assert.ok(Array.isArray(recipe.tags) && recipe.tags.length > 0);
    assert.ok(recipe.diet === "vegetarian" || recipe.diet === "meat", `bad diet for ${recipe.id}`);
  });
});

test("catalog has both diets and fallback options for each diet", () => {
  assert.ok(RECIPES.some((r) => r.diet === "vegetarian"));
  assert.ok(RECIPES.some((r) => r.diet === "meat"));
  assert.ok(RECIPES.some((r) => r.diet === "vegetarian" && r.tags.includes("fallback")));
  assert.ok(RECIPES.some((r) => r.diet === "meat" && r.tags.includes("fallback")));
});

test("loadRecipes (Node) returns the catalog", async () => {
  const loaded = await loadRecipes();
  assert.equal(loaded.length, RECIPES.length);
});

test("selectRecipes always returns one vegetarian and one meat recipe", () => {
  const infos = [
    { category: "pizza", type: "fast_food", specialties: ["pizza"], key: "a" },
    { category: "burger", type: "fast_food", specialties: ["burgers"], key: "b" },
    { category: "delivery", type: "delivery", specialties: ["restaurant delivery"], key: "c" },
    { category: "coffee", type: "delivery", specialties: ["espresso"], key: "d" },
    { category: "totally-unknown-xyz", type: "", specialties: [], key: "e" },
    null
  ];

  infos.forEach((info) => {
    const { vegetarian, meat } = selectRecipes(info, RECIPES);
    assert.ok(vegetarian, "expected a vegetarian recipe");
    assert.ok(meat, "expected a meat recipe");
    assert.equal(vegetarian.diet, "vegetarian");
    assert.equal(meat.diet, "meat");
  });
});

test("selectRecipes matches the category when possible", () => {
  const pizza = selectRecipes({ category: "pizza", specialties: ["pizza"], key: "p" }, RECIPES);
  assert.ok(pizza.vegetarian.tags.includes("pizza"));

  const burger = selectRecipes({ category: "burger", specialties: [], key: "b" }, RECIPES);
  assert.ok(burger.vegetarian.tags.includes("burger"));

  const taco = selectRecipes({ category: "mexican", specialties: ["tacos"], key: "t" }, RECIPES);
  assert.ok(taco.vegetarian.tags.some((tag) => ["taco", "mexican"].includes(tag)));
});

test("unknown categories fall back to general recipes", () => {
  const { vegetarian, meat } = selectRecipes({ category: "zzz", type: "", specialties: [], key: "x" }, RECIPES);
  assert.ok(vegetarian.tags.includes("fallback"));
  assert.ok(meat.tags.includes("fallback"));
});

test("selection is deterministic for the same site", () => {
  const info = { category: "pizza", specialties: ["pizza"], key: "stable-site" };
  const first = selectRecipes(info, RECIPES);
  const second = selectRecipes(info, RECIPES);
  assert.equal(first.vegetarian.id, second.vegetarian.id);
  assert.equal(first.meat.id, second.meat.id);
});
