"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// _locales lives at the extension root.
const localesDir = path.join(__dirname, "..", "_locales");
const enKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(localesDir, "en", "messages.json"), "utf8"))).sort();
const dirs = fs.readdirSync(localesDir).filter((d) => fs.existsSync(path.join(localesDir, d, "messages.json")));

// Chrome treats $name$ as a named placeholder that must be declared. Positional
// $1..$9 are fine. Any $name$ (including accidental $1$2 adjacency) fails to load.
const NAMED_PLACEHOLDER = /\$[A-Za-z0-9_@]+\$/;

test("there is at least the English base locale", () => {
  assert.ok(dirs.includes("en"));
  assert.ok(enKeys.length > 0);
});

test("every locale has the exact same key set as English", () => {
  for (const loc of dirs) {
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(localesDir, loc, "messages.json"), "utf8"))).sort();
    assert.equal(keys.length, enKeys.length, `${loc} key count`);
    assert.deepEqual(keys, enKeys, `${loc} key set matches en`);
  }
});

test("every message is a non-empty string with no unsafe $name$ placeholders", () => {
  for (const loc of dirs) {
    const data = JSON.parse(fs.readFileSync(path.join(localesDir, loc, "messages.json"), "utf8"));
    for (const [key, entry] of Object.entries(data)) {
      assert.equal(typeof entry.message, "string", `${loc}.${key} message is a string`);
      assert.ok(entry.message.length > 0, `${loc}.${key} is non-empty`);
      assert.ok(!NAMED_PLACEHOLDER.test(entry.message), `${loc}.${key} has no $name$ placeholder ("${entry.message}")`);
    }
  }
});

test("placeholder counts match English for every locale", () => {
  const positional = (s) => (s.match(/\$[1-9]/g) || []).sort().join(",");
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, "en", "messages.json"), "utf8"));

  for (const loc of dirs) {
    if (loc === "en") continue;
    const data = JSON.parse(fs.readFileSync(path.join(localesDir, loc, "messages.json"), "utf8"));
    for (const key of Object.keys(en)) {
      assert.equal(positional(data[key].message), positional(en[key].message), `${loc}.${key} placeholder set`);
    }
  }
});
