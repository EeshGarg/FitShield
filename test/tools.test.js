"use strict";

// Runs the full validator suite (tools/) as part of `node --test`, so dataset,
// locale, documentation, and asset problems fail CI just like a unit test.
const test = require("node:test");
const assert = require("node:assert/strict");

const { validateAll } = require("../tools/validate-all");

test("validate-all passes with no errors", () => {
  const result = validateAll({ quiet: true });
  const failing = result.reporters
    .filter((r) => !r.ok)
    .map((r) => `${r.name}: ${r.errors.join("; ")}`)
    .join("\n");
  assert.equal(result.errors, 0, `validators reported errors:\n${failing}`);
});

test("each individual audit is runnable and returns a reporter", () => {
  const audits = [
    "../tools/validate-datasets",
    "../tools/alias-audit",
    "../tools/country-audit",
    "../tools/category-audit",
    "../tools/locale-parity",
    "../tools/changelog-validator",
    "../tools/assets-check"
  ];
  for (const mod of audits) {
    const audit = require(mod);
    assert.equal(typeof audit, "function", `${mod} should export a function`);
    const reporter = audit();
    assert.ok(Array.isArray(reporter.errors), `${mod} should return a Reporter`);
    assert.equal(typeof reporter.ok, "boolean");
  }
});
