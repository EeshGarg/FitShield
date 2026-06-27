"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backup = require("../backup.js");
const { parseBackup, extractSettings } = backup;

test("extractSettings accepts the wrapped backup shape", () => {
  const settings = extractSettings({ _type: "fitshield-settings-backup", version: "0.51", settings: { enabled: true, timerSeconds: 60 } });
  assert.deepEqual(settings, { enabled: true, timerSeconds: 60 });
});

test("extractSettings accepts a bare settings object", () => {
  const settings = extractSettings({ enabled: false, deliverySitesEnabled: true });
  assert.deepEqual(settings, { enabled: false, deliverySitesEnabled: true });
});

test("parseBackup parses JSON text into a settings map", () => {
  const text = JSON.stringify({ settings: { timerSeconds: 120 } });
  assert.deepEqual(parseBackup(text), { timerSeconds: 120 });
});

test("parseBackup rejects invalid JSON", () => {
  assert.throws(() => parseBackup("{not json"), /valid JSON/);
});

test("extractSettings rejects non-objects and arrays", () => {
  assert.throws(() => extractSettings(null), /FitShield backup/);
  assert.throws(() => extractSettings([1, 2, 3]), /FitShield backup/);
  assert.throws(() => extractSettings("nope"), /FitShield backup/);
});

test("extractSettings falls back to a bare object when .settings is not an object", () => {
  // A wrapper whose `settings` is not a plain object is treated as bare settings.
  assert.deepEqual(extractSettings({ enabled: true, settings: 5 }), { enabled: true, settings: 5 });
});

test("changelog.json is valid and lists the current version", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const changelog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "changelog.json"), "utf8"));

  assert.ok(Array.isArray(changelog.entries) && changelog.entries.length > 0);
  changelog.entries.forEach((entry) => {
    assert.equal(typeof entry.version, "string");
    assert.equal(typeof entry.title, "string");
    assert.ok(Array.isArray(entry.changes) && entry.changes.length > 0);
  });

  assert.ok(changelog.entries.some((entry) => entry.version === manifest.version),
    "changelog should include the current manifest version");
});
