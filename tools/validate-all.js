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
  require("./alternatives-audit"),
  require("./alias-audit"),
  require("./country-audit"),
  require("./category-audit"),
  require("./android-audit"),
  require("./validate-android-packages"),
  require("./locale-parity"),
  require("./locale-hybrid-audit"),
  require("./policy-audit"),
  require("./changelog-validator"),
  require("./assets-check"),
  require("./extension-audit"),
  require("./service-worker-audit"),
  require("./sync-audit"),
  // Drives the built package in a real browser and reads the computed
  // accessibility tree. Self-skips with a warning when no Chromium is present,
  // so a checkout without one still validates everything else.
  require("./browser-a11y-audit"),
  require("./safari-audit"),
  // Firefox, driven over WebDriver BiDi. The redirect is decided by the browser
  // before a request leaves, so this does not depend on the probe domain being
  // reachable — a tab that is NOT redirected means blocking failed, online or
  // off. Self-skips with a warning when Firefox is absent.
  require("./firefox-audit")
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
