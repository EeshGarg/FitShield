#!/usr/bin/env node
"use strict";
/**
 * Runs every FitShield validator and reports a combined result.
 *
 * Two entry points:
 *   - CLI:        `node tools/validate-all.js`  (prints all reports, exits 1 on
 *                 any error so it can gate CI and releases)
 *   - Programmatic: `require("./tools/validate-all").validateAll()` returns
 *                 { ok, errors, warnings, reporters } without exiting, so
 *                 build.js can decide whether to package.
 */

const { TICK, WARN, CROSS } = require("./lib/report");

const AUDITS = [
  require("./validate-datasets"),
  require("./alias-audit"),
  require("./country-audit"),
  require("./category-audit"),
  require("./locale-parity"),
  require("./changelog-validator"),
  require("./assets-check")
];

function validateAll(options) {
  const opts = options || {};
  const reporters = AUDITS.map((audit) => audit());

  if (!opts.quiet) {
    reporters.forEach((r) => r.print());
  }

  const errors = reporters.reduce((n, r) => n + r.errors.length, 0);
  const warnings = reporters.reduce((n, r) => n + r.warnings.length, 0);
  const ok = errors === 0;

  if (!opts.quiet) {
    const status = ok ? (warnings ? WARN : TICK) : CROSS;
    console.log(`\n${status} validate-all: ${ok ? "PASS" : "FAIL"} — ${errors} error(s), ${warnings} warning(s) across ${reporters.length} audits\n`);
  }

  return { ok, errors, warnings, reporters };
}

if (require.main === module) {
  const result = validateAll();
  process.exit(result.ok ? 0 : 1);
}

module.exports = { validateAll };
