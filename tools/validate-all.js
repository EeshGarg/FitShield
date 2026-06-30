#!/usr/bin/env node
"use strict";
/**
 * Runs every FitShield validator and reports a combined result.
 *
 * Two entry points:
 *   - CLI:        `node tools/validate-all.js`  (prints all reports, exits 1 on
 *                 any error so it can gate CI and releases)
 *   - Programmatic: `await require("./tools/validate-all").validateAll()` resolves
 *                 to { ok, errors, warnings, reporters } without exiting, so
 *                 build.js can decide whether to package.
 *
 * Audits may be sync (return a Reporter) or async (return a Promise<Reporter>),
 * so the runner awaits each one.
 */

const { TICK, WARN, CROSS } = require("./lib/report");

const AUDITS = [
  require("./validate-datasets"),
  require("./alias-audit"),
  require("./country-audit"),
  require("./category-audit"),
  require("./android-audit"),
  require("./locale-parity"),
  require("./changelog-validator"),
  require("./assets-check")
];

async function validateAll(options) {
  const opts = options || {};
  const reporters = [];
  for (const audit of AUDITS) {
    reporters.push(await audit());
  }

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
  validateAll()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      console.error("validate-all failed:", error);
      process.exit(1);
    });
}

module.exports = { validateAll };
