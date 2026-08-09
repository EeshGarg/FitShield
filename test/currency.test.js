"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const currency = require("../extension/currency.js");
const languageOptions = require("../extension/languages.js");

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

// The picker's first entry means "follow my display language". When the display
// language already resolves to the currency being named, that entry and the
// pinned entry for the same currency render the same name and the same symbol.
// A globe emoji used to be the only difference, which is precisely the
// character a screen reader is free to drop — leaving two identical options.
// The distinguishing part must therefore be words.
test("the auto currency entry is distinguishable from the pinned one without emoji", () => {
  const messages = JSON.parse(
    require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "extension", "_locales", "en", "messages.json"),
      "utf8"
    )
  );

  const template = messages.currencyAuto && messages.currencyAuto.message;
  assert.ok(template, "currencyAuto must exist in the English catalog");
  assert.ok(template.includes("$1") && template.includes("$2"), "it takes the name and the symbol");

  for (const [code, locale] of [["USD", "en"], ["JPY", "ja"], ["EUR", "de"]]) {
    const name = currency.displayName(code, locale);
    const symbol = currency.symbolFor(code, locale);
    const auto = template.replace("$1", name).replace("$2", symbol);
    const pinned = `${name} (${symbol})`;

    assert.notEqual(auto, pinned, `${code}: the two entries must not render identically`);

    // Strip everything a screen reader may skip — emoji and other symbols —
    // and the two must STILL differ, i.e. by actual words.
    const words = (s) => s.replace(/[^\p{Letter}\p{Number}\s]/gu, " ").split(/\s+/).filter(Boolean).join(" ");
    assert.notEqual(words(auto), words(pinned), `${code}: they differ only by symbols a reader may drop`);
  }
});
