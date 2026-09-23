"use strict";
/**
 * An audit that could not run must never be counted as an audit that passed.
 *
 * tools/validate-all.js decides that by matching each reporter's warnings
 * against one regex. The regex once listed "is not built" while an audit said
 * "is not staged" — so with no dist/, validate-all reported
 * "PASS — 0 error(s), N warning(s) across 18 audits" while one of those 18 had
 * opened nothing at all. A detector that misses a phrasing is worse than no
 * detector, because the headline it produces is the one people read.
 *
 * So this pins the two halves to each other: every "I could not run" warning any
 * tool actually emits must be recognised, and the recogniser must not be so
 * loose that a real finding is mistaken for a skip.
 *
 * Runs under `node --test`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const TOOLS = path.join(__dirname, "..", "tools");

/** The live pattern out of validate-all.js, not a copy of it. */
function skipPattern() {
  const source = fs.readFileSync(path.join(TOOLS, "validate-all.js"), "utf8");
  const m = /const SKIPPED = (\/.+\/[a-z]*);/.exec(source);
  assert.ok(m, "validate-all.js no longer assigns SKIPPED a regex literal — this guard cannot read it");

  const body = m[1].slice(1, m[1].lastIndexOf("/"));
  const flags = m[1].slice(m[1].lastIndexOf("/") + 1);
  return new RegExp(body, flags);
}

/** Every literal passed to reporter.warn() anywhere in tools/. */
function warningStrings() {
  const out = [];

  fs.readdirSync(TOOLS)
    .filter((f) => f.endsWith(".js"))
    .forEach((file) => {
      const source = fs.readFileSync(path.join(TOOLS, file), "utf8");
      [...source.matchAll(/reporter\.warn\(\s*"((?:[^"\\]|\\.)*)"/g)].forEach((m) => {
        out.push({ file, text: m[1].replace(/\\"/g, '"') });
      });
    });

  return out;
}

// A warning is a SKIP when it says the audit did not examine anything: the
// package was absent, or the browser it drives was. Listed explicitly, because
// the point is to notice when a tool starts saying something new.
const MUST_BE_SKIPS = [
  /is not built/,
  /no Chromium found/,
  /no Firefox found/,
  /audit skipped/,
  /checks skipped/
];

test("every 'could not run' warning a tool emits is recognised as a skip", () => {
  const SKIPPED = skipPattern();
  const warnings = warningStrings();

  assert.ok(warnings.length > 0, "no reporter.warn() literals found in tools/ — the scan is broken, not the tools");

  const skips = warnings.filter((w) => MUST_BE_SKIPS.some((rx) => rx.test(w.text)));

  assert.ok(
    skips.length >= 4,
    `expected the built/staged and no-browser warnings to be present, found ${skips.length}`
  );

  const unrecognised = skips
    .filter((w) => !SKIPPED.test(w.text))
    .map((w) => `${w.file}: ${JSON.stringify(w.text)}`);

  assert.deepEqual(
    unrecognised,
    [],
    "these warnings mean the audit examined nothing, and validate-all would still count it as an audit that " +
      `passed:\n  ${unrecognised.join("\n  ")}`
  );
});

test("the skip pattern does not swallow a real finding", () => {
  const SKIPPED = skipPattern();

  // Warnings that report something WRONG with what was examined. If the pattern
  // matched one of these, validate-all would quietly stop counting a real audit
  // and its finding would be filed as "could not run".
  const realFindings = [
    // "not staged" used to be read as a skip. Nothing skips with that wording any
    // more; the only tool that says it says it about a REAL packaging defect, so
    // the skip pattern must not claim it.
    "extension/ambient.js is not staged by build.js — ship it or delete it",
    "Branding/ is missing or empty",
    "missing top-level README.md",
    "missing changelog/README.md index",
    "2 locale(s) are missing keys the English file defines",
    "the block page declares no CSP at all"
  ];

  const swallowed = realFindings.filter((text) => SKIPPED.test(text));

  assert.deepEqual(
    swallowed,
    [],
    `the skip pattern matches real findings, which would be reported as skipped audits: ${swallowed.join("; ")}`
  );
});
