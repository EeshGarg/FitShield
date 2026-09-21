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
  require("./announcement-audit"),
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

  // An audit that could not run is not an audit that passed. The browser-driven
  // ones warn and skip when the package is unbuilt or no browser is installed —
  // deliberately, so a checkout without Chromium still validates everything else
  // — but the summary counted them among the audits and reported PASS. With no
  // dist/ that read "0 error(s), 3 warning(s) across 18 audits" and exited 0
  // while two audits did nothing at all. The count is the headline most people
  // read, so it has to say what actually happened.
  // "is not staged" is here because the Safari audit says that, not "is not
  // built", and the one phrasing this pattern did not cover was the one audit
  // that then reported PASS over a payload it had never opened — the exact
  // failure the paragraph above describes, surviving in the detector written to
  // stop it. The three built/staged messages and the three "no <browser> found"
  // ones are now all matched; tools/validate-all.test.js pins each string.
  const SKIPPED = /\b(skipped|is not (?:built|staged)|not installed|no [A-Za-z]+ found)\b/i;
  const skipped = reporters.filter((r) => r.warnings.some((w) => SKIPPED.test(w)));

  if (!opts.quiet) {
    const status = ok ? (warnings || skipped.length ? WARN : TICK) : CROSS;
    const ran = reporters.length - skipped.length;
    const scope = skipped.length
      ? `${ran} of ${reporters.length} audits (${skipped.length} could not run)`
      : `${reporters.length} audits`;

    console.log(`
${status} validate-all: ${ok ? "PASS" : "FAIL"} — ${errors} error(s), ${warnings} warning(s) across ${scope}
`);

    skipped.forEach((r) => console.log(`  ${WARN} did not run: ${r.name}`));

    if (skipped.length) {
      console.log("");
    }
  }

  return { ok, errors, warnings, skipped: skipped.map((r) => r.name), reporters };
}

if (require.main === module) {
  validateAll()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      console.error("validate-all failed:", error);
      process.exit(1);
    });
}

module.exports = { AUDITS, validateAll };
