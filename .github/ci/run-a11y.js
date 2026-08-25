#!/usr/bin/env node
"use strict";
/**
 * Run the computed-accessibility-tree audit and REFUSE to pass if it skipped.
 *
 *   node .github/ci/run-a11y.js
 *   node .github/ci/run-a11y.js --selftest     (exercise the guard, no browser)
 *
 * tools/browser-a11y-audit.js drives the built package in Chromium and reads
 * Accessibility.getFullAXTree. On a checkout with no Chromium it deliberately
 * warns and returns success, so that a developer without a browser can still
 * run `npm run validate`. That is the right behaviour for a laptop and the
 * wrong behaviour for CI: a job that goes green because the audit did not
 * happen is worse than no job, because it reports a guarantee nobody obtained.
 *
 * So this wrapper inverts the default. It resolves a browser and hard-fails if
 * it cannot; it fails on the skip warnings; and — the part that actually
 * matters — it requires POSITIVE evidence in the output: every surface audited,
 * a non-zero count of named controls, and at least one live region. Checking
 * for the absence of a skip message is weak, because a future rewording of the
 * message would silently restore the hole. Checking for the presence of the
 * work is not.
 *
 * Node built-ins only.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const AUDIT = path.join(ROOT, "tools", "browser-a11y-audit.js");

// The audit walks six surfaces; anything less means pages were dropped.
const EXPECTED_SURFACES = 6;

const SKIP_MARKERS = [
  "no Chromium found",
  "computed-tree audit skipped",
  "dist/chrome is not built"
];

function findBrowser() {
  const fromEnv = [process.env.FS_CHROME, process.env.CHROME_BIN, process.env.CHROME_PATH].filter(Boolean);

  for (const candidate of fromEnv) {
    if (fs.existsSync(candidate)) {
      return { binary: candidate, how: "environment" };
    }
  }

  const candidates = [
    // GitHub's Ubuntu runner images install Google Chrome stable; the deb puts
    // both of these in place.
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { binary: candidate, how: "well-known path" };
    }
  }

  // Whatever a Playwright install left behind, if anything.
  const cdp = require(path.join(ROOT, "tools", "lib", "cdp.js"));
  const discovered = cdp.findChrome();

  return discovered ? { binary: discovered, how: "tools/lib/cdp.js discovery" } : null;
}

/**
 * Decide whether an audit run counts. Exported so the guard itself can be
 * tested against fabricated output without launching a browser — otherwise the
 * only way to learn that the guard is broken is to ship a broken guard.
 *
 * @param {string} output    combined stdout + stderr of the audit
 * @param {number} exitCode
 * @returns {{ok: boolean, problems: string[], facts: string[]}}
 */
function assess(output, exitCode) {
  const problems = [];
  const facts = [];

  if (exitCode !== 0) {
    problems.push(`the audit exited ${exitCode}`);
  }

  SKIP_MARKERS.forEach((marker) => {
    if (output.includes(marker)) {
      problems.push(`the audit skipped: it reported "${marker}"`);
    }
  });

  const summary = /(\d+) control\(s\) across (\d+) surfaces carry a computed accessible name/.exec(output);

  if (!summary) {
    problems.push("the audit produced no summary line — it did not reach the accessibility tree");
  } else {
    const controls = Number(summary[1]);
    const surfaces = Number(summary[2]);

    facts.push(`${controls} named control(s) across ${surfaces} surface(s)`);

    if (controls === 0) {
      problems.push("the audit found zero named controls — the extension did not load");
    }

    if (surfaces !== EXPECTED_SURFACES) {
      problems.push(`the audit covered ${surfaces} surface(s), expected ${EXPECTED_SURFACES}`);
    }
  }

  const pages = [...output.matchAll(/^\s*(.+?): (\d+) named control\(s\), (\d+) heading\(s\), (\d+) live region\(s\)$/gm)];

  facts.push(`${pages.length} per-surface report(s)`);

  if (pages.length !== EXPECTED_SURFACES) {
    problems.push(`${pages.length} surface report(s) present, expected ${EXPECTED_SURFACES}`);
  }

  const liveRegions = pages.reduce((total, match) => total + Number(match[4]), 0);

  facts.push(`${liveRegions} live region(s)`);

  if (pages.length && liveRegions === 0) {
    problems.push("no surface exposed a live region — the tree was not really read");
  }

  return { ok: problems.length === 0, problems, facts };
}

function selfTest() {
  const real = [
    "\u2713 Accessibility \u2014 computed tree, real browser",
    "    popup: 22 named control(s), 1 heading(s), 0 live region(s)",
    "    settings: 232 named control(s), 26 heading(s), 7 live region(s)",
    "    welcome: 3 named control(s), 2 heading(s), 0 live region(s)",
    "    block page: 9 named control(s), 1 heading(s), 2 live region(s)",
    "    what's new: 2 named control(s), 1 heading(s), 0 live region(s)",
    "    diagnostics: 4 named control(s), 4 heading(s), 1 live region(s)",
    "    272 control(s) across 6 surfaces carry a computed accessible name",
    "    all checks passed"
  ].join("\n");

  const skipped = [
    "\u26a0 Accessibility \u2014 computed tree, real browser",
    "  \u26a0 no Chromium found \u2014 computed-tree audit skipped (set FS_CHROME to a browser binary)",
    "    0 error(s), 1 warning(s)"
  ].join("\n");

  const unbuilt = [
    "\u26a0 Accessibility \u2014 computed tree, real browser",
    "  \u26a0 dist/chrome is not built \u2014 run `node build.js` first",
    "    0 error(s), 1 warning(s)"
  ].join("\n");

  const cases = [
    ["a real, complete run passes", real, 0, true],
    ["a no-Chromium skip is caught even though the audit exited 0", skipped, 0, false],
    ["an unbuilt dist/chrome is caught even though the audit exited 0", unbuilt, 0, false],
    ["silence is caught", "", 0, false],
    ["a non-zero exit is caught", real, 1, false],
    ["a run missing surfaces is caught", real.replace("    diagnostics: 4 named control(s), 4 heading(s), 1 live region(s)\n", ""), 0, false],
    ["a run with no live regions anywhere is caught", real.replace(/(\d+) live region/g, "0 live region"), 0, false]
  ];

  let bad = 0;

  cases.forEach(([label, output, code, expected]) => {
    const result = assess(output, code);

    if (result.ok !== expected) {
      bad++;
      console.log(`  \u2717 guard self-test failed: ${label} (got ok=${result.ok}) ${result.problems.join("; ")}`);
    }
  });

  if (bad === 0) {
    console.log(`    a11y guard self-test: ${cases.length} case(s), the skip paths are all caught`);
  }

  return bad === 0;
}

function main() {
  if (process.argv.includes("--selftest")) {
    process.exit(selfTest() ? 0 : 1);
  }

  if (!fs.existsSync(path.join(ROOT, "dist", "chrome", "manifest.json"))) {
    console.error("dist/chrome is not built. Run `node build.js` before the accessibility audit.");
    process.exit(1);
  }

  const browser = findBrowser();

  if (!browser) {
    console.error("No Chromium found. This job exists to run the computed-tree audit, so a missing browser is a failure, not a skip.");
    console.error("Install Google Chrome or Chromium on the runner, or point FS_CHROME at a binary.");
    process.exit(1);
  }

  console.log(`Chromium: ${browser.binary}  (found via ${browser.how})`);

  const result = spawnSync(process.execPath, [AUDIT], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, FS_CHROME: browser.binary }
  });

  const output = `${result.stdout || ""}${result.stderr || ""}`;

  process.stdout.write(output);

  if (result.error) {
    console.error(`Could not run the audit: ${result.error.message}`);
    process.exit(1);
  }

  const verdict = assess(output, result.status);

  console.log("\nGuard: did the audit actually run?");
  verdict.facts.forEach((factual) => console.log(`    ${factual}`));

  if (!verdict.ok) {
    verdict.problems.forEach((problem) => console.log(`  \u2717 ${problem}`));
    console.error("\nThe accessibility audit did not really run. Failing rather than reporting a guarantee nobody obtained.");
    process.exit(1);
  }

  console.log("    the computed accessibility tree was read on every surface");
}

module.exports = { assess, selfTest, findBrowser, EXPECTED_SURFACES };

if (require.main === module) {
  main();
}
