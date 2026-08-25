#!/usr/bin/env node
"use strict";
/**
 * Run the full validator suite and REFUSE to pass if an audit skipped itself.
 *
 *   node .github/ci/run-validate.js
 *   node .github/ci/run-validate.js --selftest    (no browsers needed)
 *
 * `npm run validate` is 18 audits, and two of them drive a real browser:
 * tools/browser-a11y-audit.js reads the computed accessibility tree in
 * Chromium, and tools/firefox-audit.js installs the built package in Firefox
 * and checks that a blocked brand really redirects. Both warn-and-pass when
 * their browser is absent, which is right for a checkout and wrong on a runner.
 *
 * Without this wrapper the gate job would print "validate-all: PASS - 0
 * error(s)" on an image with no browser installed, indistinguishable from a run
 * that proved something. That is the failure this whole CI lane exists to
 * remove, so it is not allowed to survive in the one job named "gate".
 *
 * Two nets:
 *   - the specific one: the same assess() functions run-a11y.js and
 *     run-firefox.js use, which demand POSITIVE evidence - six surfaces
 *     audited, live regions seen, the package installed, a host redirected -
 *     rather than merely the absence of a skip message.
 *   - the general one: any WARNING whose text says a check did not happen.
 *     Ordinary warnings stay allowed, because validate-all allows them by
 *     design; this catches a future audit that learns to self-skip in a
 *     phrasing nobody here anticipated.
 *
 * Node built-ins only.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const a11y = require("./run-a11y.js");
const firefox = require("./run-firefox.js");

const ROOT = path.resolve(__dirname, "..", "..");
const SUITE = path.join(ROOT, "tools", "validate-all.js");

// What `npm run validate` is, pinned rather than assumed. If the script ever
// becomes something else, this guard would be vouching for a command nobody
// runs, so it stops instead.
const EXPECTED_SCRIPT = "node tools/validate-all.js";

// A warning that says a check did not happen, as opposed to a warning about
// something a check found. Only the first kind is a problem.
const SKIP_SHAPES = [/\bskipped\b/i, /\bis not built\b/i, /\bno \S+ found\b/i, /\bnot installed\b/i];

// Reporter.print() writes a warning as exactly two spaces, U+26A0, a space,
// then the message. Audit headings carry the same glyph at column zero, so the
// indent is what separates a warning from the title above it.
const WARNING_LINE = /^ {2}⚠ (.+)$/gm;

/**
 * @param {string} output    combined stdout + stderr of the suite
 * @param {number} exitCode
 * @returns {{ok: boolean, problems: string[], facts: string[]}}
 */
function assess(output, exitCode) {
  const problems = [];
  const facts = [];

  if (exitCode !== 0) {
    problems.push("the validator suite exited " + exitCode);
  }

  const summary = /validate-all: (PASS|FAIL).*?(\d+) error\(s\), (\d+) warning\(s\) across (\d+) audits/.exec(output);

  if (!summary) {
    problems.push("the suite printed no summary line - it did not finish");
  } else {
    const errors = Number(summary[2]);
    const warnings = Number(summary[3]);

    facts.push(summary[4] + " audits, " + errors + " error(s), " + warnings + " warning(s)");

    if (summary[1] !== "PASS" || errors !== 0) {
      problems.push("the suite reported " + errors + " error(s)");
    }
  }

  // General net.
  const warned = [];

  let match;
  WARNING_LINE.lastIndex = 0;

  while ((match = WARNING_LINE.exec(output)) !== null) {
    warned.push(match[1].trim());
  }

  const skipped = warned.filter((message) => SKIP_SHAPES.some((shape) => shape.test(message)));

  skipped.forEach((message) => {
    problems.push("an audit did not run: " + JSON.stringify(message));
  });

  if (warned.length) {
    // Reported as two numbers rather than one, because "3 warnings" reads as
    // benign right up until two of them are checks that never happened.
    facts.push(
      warned.length + " warning(s): " + skipped.length + " skipped check(s), " + (warned.length - skipped.length) + " ordinary"
    );
  }

  // Specific net: the two browser audits must show their work. The exit code is
  // judged above, so 0 is passed here to stop the two verdicts double-reporting
  // the same failure.
  [["accessibility", a11y], ["firefox", firefox]].forEach((entry) => {
    const verdict = entry[1].assess(output, 0);

    verdict.problems.forEach((problem) => problems.push(entry[0] + ": " + problem));
    verdict.facts.forEach((factual) => facts.push(entry[0] + ": " + factual));
  });

  return { ok: problems.length === 0, problems, facts };
}

/** A stand-in for real suite output, so the guard can be tested without browsers. */
function fixture(options) {
  const opts = options || {};

  const a11yBlock = opts.a11ySkipped
    ? "  ⚠ no Chromium found — computed-tree audit skipped (set FS_CHROME to a browser binary)"
    : [
        "    popup: 22 named control(s), 1 heading(s), 0 live region(s)",
        "    settings: 232 named control(s), 26 heading(s), 7 live region(s)",
        "    welcome: 3 named control(s), 2 heading(s), 0 live region(s)",
        "    block page: 9 named control(s), 1 heading(s), 2 live region(s)",
        "    what's new: 2 named control(s), 1 heading(s), 0 live region(s)",
        "    diagnostics: 4 named control(s), 4 heading(s), 1 live region(s)",
        "    272 control(s) across 6 surfaces carry a computed accessible name"
      ].join("\n");

  const firefoxBlock = opts.firefoxSkipped
    ? "  ⚠ no Firefox found — real-browser Firefox checks skipped (set FS_FIREFOX to a binary)"
    : [
        "    installed as fitshield@usha.dev",
        "    blocking works: https://www.doordash.com/ was redirected to the block page",
        "    0 console error(s) observed across the session"
      ].join("\n");

  return [
    "✓ Datasets",
    "    all checks passed",
    "",
    "✓ Accessibility — computed tree, real browser",
    a11yBlock,
    "",
    "✓ Firefox — real browser, built package",
    firefoxBlock,
    "",
    opts.harmlessWarning ? "  ⚠ 3 recipe title(s) are near-duplicates of another entry" : "",
    "✓ validate-all: " +
      (opts.failing ? "FAIL" : "PASS") +
      " — " +
      (opts.failing ? "2" : "0") +
      " error(s), " +
      (opts.harmlessWarning ? "1" : "0") +
      " warning(s) across 18 audits",
    ""
  ].join("\n");
}

function selfTest() {
  const cases = [
    ["a clean run passes", fixture(), 0, true],
    ["an ordinary, non-skip warning still passes", fixture({ harmlessWarning: true }), 0, true],
    ["a skipped accessibility audit is caught despite PASS and exit 0", fixture({ a11ySkipped: true }), 0, false],
    ["a skipped Firefox audit is caught despite PASS and exit 0", fixture({ firefoxSkipped: true }), 0, false],
    ["both skipped is caught", fixture({ a11ySkipped: true, firefoxSkipped: true }), 0, false],
    ["a real validator error is caught", fixture({ failing: true }), 1, false],
    ["silence is caught", "", 0, false]
  ];

  let bad = 0;

  cases.forEach((entry) => {
    const result = assess(entry[1], entry[2]);

    if (result.ok !== entry[3]) {
      bad++;
      console.log("  ✗ guard self-test failed: " + entry[0] + " (got ok=" + result.ok + ") " + result.problems.join("; "));
    }
  });

  if (bad === 0) {
    console.log(
      "    validate guard self-test: " + cases.length + " case(s); a skipped browser audit cannot pass, an ordinary warning still can"
    );
  }

  return bad === 0;
}

function main() {
  if (process.argv.includes("--selftest")) {
    process.exit(selfTest() ? 0 : 1);
  }

  const script = (require(path.join(ROOT, "package.json")).scripts || {}).validate;

  if (script !== EXPECTED_SCRIPT) {
    console.error("package.json \"validate\" is " + JSON.stringify(script) + ", expected " + JSON.stringify(EXPECTED_SCRIPT) + ".");
    console.error("This guard runs the suite directly, so it must be kept in step with the script it stands in for.");
    process.exit(1);
  }

  if (!fs.existsSync(SUITE)) {
    console.error("tools/validate-all.js is missing.");
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [SUITE], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const output = (result.stdout || "") + (result.stderr || "");

  process.stdout.write(output);

  if (result.error) {
    console.error("Could not run the suite: " + result.error.message);
    process.exit(1);
  }

  const verdict = assess(output, result.status);

  console.log("\nGuard: did every audit actually run?");
  verdict.facts.forEach((factual) => console.log("    " + factual));

  if (!verdict.ok) {
    verdict.problems.forEach((problem) => console.log("  ✗ " + problem));
    console.error("\nThe validator suite did not really run in full. Failing rather than reporting a guarantee nobody obtained.");
    process.exit(1);
  }

  console.log("    every audit ran, including both real-browser audits");
}

module.exports = { assess, selfTest, fixture, EXPECTED_SCRIPT };

if (require.main === module) {
  main();
}
