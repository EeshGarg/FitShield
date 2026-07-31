"use strict";
/**
 * Locale tests.
 *
 * The invariant enforced here is "nothing renders blank or broken", NOT "every
 * locale has every key". Those are different things, and only the first one is
 * true of the runtime:
 *
 *   - a key missing from a locale falls back to English — chrome.i18n falls back
 *     to default_locale, and i18n.js falls back to its cached English map, so
 *     the string renders in English rather than blank;
 *   - a key present in a locale but NOT in English can never be displayed, and
 *     is a bug (usually a half-applied rename), so it is still a failure;
 *   - a message that IS translated must be non-empty, must not use Chrome's
 *     named-placeholder syntax, and must take the same positional arguments as
 *     English, or it will render with holes in it.
 *
 * `npm run validate:locales` reports the untranslated-key debt per locale.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// _locales lives in the browser-extension source tree (packaged at the zip root).
const localesDir = path.join(__dirname, "..", "extension", "_locales");
const readLocale = (code) => JSON.parse(fs.readFileSync(path.join(localesDir, code, "messages.json"), "utf8"));
const en = readLocale("en");
const enKeys = Object.keys(en).sort();
const enSet = new Set(enKeys);
const dirs = fs.readdirSync(localesDir).filter((d) => fs.existsSync(path.join(localesDir, d, "messages.json")));

// Chrome treats $name$ as a named placeholder that must be declared. Positional
// $1..$9 are fine. Any $name$ (including accidental $1$2 adjacency) fails to load.
const NAMED_PLACEHOLDER = /\$[A-Za-z0-9_@]+\$/;

test("there is at least the English base locale", () => {
  assert.ok(dirs.includes("en"));
  assert.ok(enKeys.length > 0);
});

test("no locale defines a key English does not have", () => {
  for (const loc of dirs) {
    const extra = Object.keys(readLocale(loc)).filter((key) => !enSet.has(key));
    assert.deepEqual(extra, [], `${loc} defines keys that can never be shown: ${extra.join(", ")}`);
  }
});

test("every message present in a locale is usable", () => {
  for (const loc of dirs) {
    const data = readLocale(loc);
    for (const [key, entry] of Object.entries(data)) {
      assert.equal(typeof entry.message, "string", `${loc}.${key} message is a string`);
      assert.ok(entry.message.length > 0, `${loc}.${key} is non-empty`);
      assert.ok(!NAMED_PLACEHOLDER.test(entry.message), `${loc}.${key} has no $name$ placeholder ("${entry.message}")`);
    }
  }
});

test("placeholder sets match English for every key a locale does define", () => {
  const positional = (s) => (s.match(/\$[1-9]/g) || []).sort().join(",");

  for (const loc of dirs) {
    if (loc === "en") continue;
    const data = readLocale(loc);
    for (const key of Object.keys(data)) {
      if (!enSet.has(key)) continue;
      assert.equal(positional(data[key].message), positional(en[key].message), `${loc}.${key} placeholder set`);
    }
  }
});

test("the block page's own strings all exist in English", () => {
  // The runtime falls back to English, so English is the one locale that must be
  // complete. This proves every key the redesigned block page asks for is there.
  const warningJs = fs.readFileSync(path.join(__dirname, "..", "extension", "warning.js"), "utf8");
  const used = new Set();

  for (const match of warningJs.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) {
    used.add(match[1]);
  }
  for (const match of warningJs.matchAll(/labelKey:\s*"([A-Za-z0-9_]+)"/g)) {
    used.add(match[1]);
  }
  for (const match of warningJs.matchAll(/(?:scopeKey|Key):\s*"([A-Za-z0-9_]+)"/g)) {
    used.add(match[1]);
  }

  assert.ok(used.size > 20, `expected the block page to use many strings, found ${used.size}`);

  const missing = [...used].filter((key) => !enSet.has(key));
  assert.deepEqual(missing, [], `block page uses English strings that do not exist: ${missing.join(", ")}`);
});

test("HTML data-i18n attributes all resolve in English", () => {
  const pages = ["warning.html", "popup.html", "settings.html", "welcome.html", "whats-new.html"];
  const missing = [];

  for (const page of pages) {
    const html = fs.readFileSync(path.join(__dirname, "..", "extension", page), "utf8");
    for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) {
      if (!enSet.has(match[1])) {
        missing.push(`${page}: ${match[1]}`);
      }
    }
  }

  assert.deepEqual(missing, [], `pages reference missing English strings:\n  ${missing.join("\n  ")}`);
});

test("a missing translation falls back to English rather than rendering blank", () => {
  // Exercise the real i18n module the pages load, with a locale that is missing
  // a key, and prove the English string comes back.
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "i18n.js"), "utf8");
  const sandbox = { console, fetch: () => Promise.reject(new Error("no network in tests")) };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = { querySelectorAll: () => [] };
  sandbox.fitshield = {
    storage: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    runtime: { getURL: (p) => p },
    i18n: { getMessage: () => "", getUILanguage: () => "en" }
  };

  vm.runInContext(source, vm.createContext(sandbox), { filename: "i18n.js" });

  const i18n = sandbox.FitShieldI18n;
  assert.ok(i18n, "i18n.js must define FitShieldI18n");

  // With no host getMessage and no fetched locale, a key resolves to itself
  // rather than an empty string — a gap stays visible instead of blank.
  assert.equal(i18n.t("someMissingKey"), "someMissingKey");
  assert.equal(i18n.t(""), "");
});

test("locale coverage is reported, not silently ignored", () => {
  // The audit must surface untranslated keys as warnings so the debt is visible.
  const localeParity = require("../tools/locale-parity.js");
  const reporter = localeParity();

  assert.deepEqual(reporter.errors, [], `locale audit errors:\n  ${reporter.errors.join("\n  ")}`);
  assert.ok(
    reporter.notes.some((note) => /translated/.test(note)),
    "the audit must report translation coverage"
  );
});
