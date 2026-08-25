#!/usr/bin/env node
"use strict";
/**
 * Run the Firefox real-browser audit and REFUSE to pass if it skipped.
 *
 *   node .github/ci/run-firefox.js
 *   node .github/ci/run-firefox.js --selftest    (exercise the guard, no browser)
 *
 * Same shape, and the same reason, as run-a11y.js. tools/firefox-audit.js
 * installs the built dist/firefox package in a real Firefox over WebDriver BiDi
 * and checks that a blocked brand actually redirects to the block page. When
 * Firefox is absent it warns and returns success, which is right for a checkout
 * on a machine without it and wrong for CI.
 *
 * CLAUDE.md's definition of done requires real-browser checks to pass "for both
 * Chrome and Firefox". Until this ran off one laptop, that line was a claim
 * about one laptop. A silently skipped run would leave it that way while
 * looking green, so this fails on the skip and requires positive evidence:
 * the package installed, it was assigned a UUID, and a blocked host was
 * genuinely redirected.
 *
 * Node built-ins only.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const AUDIT = path.join(ROOT, "tools", "firefox-audit.js");

const SKIP_MARKERS = [
  "no Firefox found",
  "real-browser Firefox checks skipped",
  "dist/firefox is not built"
];

function findBrowser() {
  const fromEnv = [process.env.FS_FIREFOX, process.env.FIREFOX_BIN].filter(Boolean);

  for (const candidate of fromEnv) {
    if (fs.existsSync(candidate)) {
      return { binary: candidate, how: "environment" };
    }
  }

  const candidates = [
    "/usr/bin/firefox",
    "/usr/local/bin/firefox",
    "/snap/bin/firefox",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "C:/Program Files/Mozilla Firefox/firefox.exe",
    "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { binary: candidate, how: "well-known path" };
    }
  }

  return null;
}

/**
 * Decide whether an audit run counts. Exported so the guard can be tested
 * against fabricated output without launching Firefox.
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

  const installed = /installed as (\S+)/.exec(output);

  if (!installed) {
    problems.push("the audit never reported installing the package — Firefox did not load it");
  } else {
    facts.push(`installed as ${installed[1]}`);
  }

  const blocked = /blocking works: (\S+) was redirected to the block page/.exec(output);

  if (!blocked) {
    problems.push("the audit never confirmed a redirect to the block page — the blocking path was not exercised");
  } else {
    facts.push(`${blocked[1]} was redirected to the block page`);
  }

  const console_ = /(\d+) console error\(s\) observed across the session/.exec(output);

  if (console_) {
    facts.push(`${console_[1]} console error(s)`);
  }

  return { ok: problems.length === 0, problems, facts };
}

function selfTest() {
  const real = [
    "\u2713 Firefox \u2014 real browser, built package",
    "    installed as fitshield@usha.dev",
    "    blocking works: https://www.doordash.com/ was redirected to the block page",
    "    0 console error(s) observed across the session",
    "    all checks passed"
  ].join("\n");

  const cases = [
    ["a real, complete run passes", real, 0, true],
    [
      "a no-Firefox skip is caught even though the audit exited 0",
      "\u26a0 Firefox \u2014 real browser, built package\n  \u26a0 no Firefox found \u2014 real-browser Firefox checks skipped (set FS_FIREFOX to a binary)",
      0,
      false
    ],
    [
      "an unbuilt dist/firefox is caught even though the audit exited 0",
      "\u26a0 Firefox \u2014 real browser, built package\n  \u26a0 dist/firefox is not built \u2014 run `node build.js` first",
      0,
      false
    ],
    ["silence is caught", "", 0, false],
    ["a non-zero exit is caught", real, 1, false],
    ["an install with no blocking proof is caught", real.replace(/^ +blocking works.*$/m, ""), 0, false],
    ["blocking proof with no install line is caught", real.replace(/^ +installed as.*$/m, ""), 0, false]
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
    console.log(`    firefox guard self-test: ${cases.length} case(s), the skip paths are all caught`);
  }

  return bad === 0;
}

function main() {
  if (process.argv.includes("--selftest")) {
    process.exit(selfTest() ? 0 : 1);
  }

  if (!fs.existsSync(path.join(ROOT, "dist", "firefox", "manifest.json"))) {
    console.error("dist/firefox is not built. Run `node build.js` before the Firefox audit.");
    process.exit(1);
  }

  const browser = findBrowser();

  if (!browser) {
    console.error("No Firefox found. This job exists to run the real-browser Firefox checks, so a missing browser is a failure, not a skip.");
    console.error("Install Firefox on the runner, or point FS_FIREFOX at a binary.");
    process.exit(1);
  }

  console.log(`Firefox: ${browser.binary}  (found via ${browser.how})`);

  const result = spawnSync(process.execPath, [AUDIT], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, FS_FIREFOX: browser.binary }
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
    console.error("\nThe Firefox audit did not really run. Failing rather than reporting a guarantee nobody obtained.");
    process.exit(1);
  }

  console.log("    the built package was installed in a real Firefox and blocking was exercised");
}

module.exports = { assess, selfTest, findBrowser };

if (require.main === module) {
  main();
}
