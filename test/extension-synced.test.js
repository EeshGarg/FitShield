"use strict";
/**
 * Staleness guard for the committed, synced runtime artifacts in extension/
 * (the engine bundle, blocklists, recipe catalog, changelog). These let
 * `Load unpacked → extension/` work with no build; this test fails if any has
 * drifted from its canonical source, so a data or engine edit that forgets
 * `npm run sync` can't ship a source folder that loads yesterday's data.
 *
 * Same check as tools/sync-audit.js (which gates `npm run validate` and the
 * build) — mirrored here so `npm test` catches drift too.
 */

const test = require("node:test");
const assert = require("node:assert");
const sync = require("../tools/sync-extension.js");

test("extension/ committed artifacts are in sync with canonical sources", () => {
  const stale = sync.staleArtifacts();
  assert.deepStrictEqual(
    stale,
    [],
    stale.length
      ? `Stale synced artifact(s) — run \`npm run sync\`: ${stale.join(", ")}`
      : ""
  );
});

test("sync-audit reports the synced artifacts as fresh", () => {
  const reporter = require("../tools/sync-audit.js")();
  assert.strictEqual(reporter.ok, true, `sync audit failed:\n  ${reporter.errors.join("\n  ")}`);
});
