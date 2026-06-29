"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const currency = require("../currency.js");
const languageOptions = require("../languages.js");

// Every display language (except the "" system entry) must resolve to a default
// currency that actually exists in the cost table, so the picker and the
// auto-seeded meal cost are always coherent.
test("every display language maps to a known currency", () => {
  for (const opt of languageOptions) {
    if (!opt.value) {
      continue; // "" => system default, resolved at runtime from the browser locale
    }
    const def = currency.LOCALE_DEFAULTS[opt.value];
    assert.ok(def, `${opt.value} has a LOCALE_DEFAULTS entry`);
    assert.ok(
      currency.CURRENCY_DEFAULT_COST[def.currency] != null,
      `${opt.value} currency ${def.currency} has a default cost`
    );
    assert.ok(def.calories > 0, `${opt.value} has a positive calorie estimate`);
  }
});

test("localeDefaults falls back gracefully", () => {
  // Unknown locale -> USD fallback.
  assert.equal(currency.localeDefaults("xx").currency, "USD");
  // Region override on a known base language.
  assert.equal(currency.localeDefaults("en_GB").currency, "GBP");
  assert.equal(currency.localeDefaults("en-GB").currency, "GBP");
  // Exact regional locale wins over its base language.
  assert.equal(currency.localeDefaults("es_419").currency, "MXN");
  assert.equal(currency.localeDefaults("es").currency, "EUR");
});

test("resolveCurrency honors an explicit choice, else the locale", () => {
  assert.equal(currency.resolveCurrency("JPY", "en"), "JPY");
  assert.equal(currency.resolveCurrency("", "ja"), "JPY");
  assert.equal(currency.resolveCurrency("bogus", "ja"), "JPY"); // invalid choice ignored
});

test("defaultCost / defaultCalories return positive numbers", () => {
  assert.ok(currency.defaultCost("JPY") > 0);
  assert.equal(currency.defaultCost("nope"), currency.CURRENCY_DEFAULT_COST.USD);
  assert.ok(currency.defaultCalories("ko") > 0);
});

test("formatMoney and symbolFor produce non-empty output", () => {
  const usd = currency.formatMoney(1234, "USD", "en");
  assert.ok(usd.includes("1,234"));
  // Whole numbers omit decimals.
  assert.ok(!currency.formatMoney(15, "USD", "en").includes(".0"));
  assert.ok(currency.symbolFor("USD", "en").length > 0);
  assert.ok(currency.symbolFor("JPY", "ja").length > 0);
});

test("currencyCodes lists every cost-table currency, majors first", () => {
  const codes = currency.currencyCodes();
  assert.equal(codes[0], "USD");
  assert.equal(codes.length, Object.keys(currency.CURRENCY_DEFAULT_COST).length);
  assert.ok(codes.includes("INR"));
});
