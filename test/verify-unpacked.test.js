"use strict";
/**
 * Dynamic unpacked-readiness test: builds the package into a temp folder and
 * exercises it the way Chrome would (see tools/verify-unpacked.js). This is the
 * automated stand-in for "Load unpacked from dist/chrome and block a real site"
 * — it fails if the built package could not load, could not run the engine, or
 * could not block a real curated brand from its own packaged data.
 */

const test = require("node:test");
const assert = require("node:assert");
const verifyUnpacked = require("../tools/verify-unpacked.js");

test("a freshly built package loads, runs the engine, and blocks a real brand", async () => {
  const reporter = await verifyUnpacked();
  assert.strictEqual(
    reporter.ok,
    true,
    `unpacked-readiness failed:\n  ${reporter.errors.join("\n  ")}`
  );
});
