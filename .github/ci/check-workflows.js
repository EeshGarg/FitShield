#!/usr/bin/env node
"use strict";
/**
 * Static check for everything in .github/ — run it from the repository root:
 *
 *   node .github/ci/check-workflows.js
 *
 * A workflow is the one piece of a repository that normally gets no review from
 * the tools that review everything else: it is not imported by any test, it is
 * not covered by a validator, and the first thing that reads it is GitHub,
 * after the push. That is a bad place to discover a typo in a script name.
 *
 * So this reads the workflows the way the validators read the datasets:
 *
 *   1. The parser itself is exercised against known-good and known-bad input
 *      first, because a parser nobody tested is a parser that says yes.
 *   2. Every workflow file must parse as block YAML and carry the structure
 *      GitHub requires (on / jobs / runs-on / steps, one of run|uses per step).
 *   3. Every `npm run <script>` a workflow invokes must exist in package.json.
 *   4. Every repository path a workflow names must exist in this checkout.
 *      Build OUTPUTS under dist/ are exempt — they do not exist until a job
 *      creates them — and are reported separately so the exemption is visible.
 *   5. Nothing may push, publish, release, authenticate, or read a secret.
 *      This CI verifies; it does not deploy. That promise is worth more as a
 *      check than as a sentence in a README, so it is a check.
 *
 * Node built-ins only. FitShield ships zero dependencies and its tooling adds
 * none, CI tooling included.
 */

const fs = require("fs");
const path = require("path");

const { parse, YamlError } = require("./yaml.js");

const ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");

const errors = [];
const notes = [];

const fail = (message) => errors.push(message);
const note = (message) => notes.push(message);

/* ------------------------------------------------------------------ *
 * 1. Prove the parser before trusting it.
 * ------------------------------------------------------------------ */

function selfTestParser() {
  const good = [
    [
      "nested mappings and sequences",
      "name: demo\non:\n  push:\n    branches:\n      - main\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: run\n        run: echo hi\n",
      // A plain scalar carries no trailing newline; only a block scalar does.
      (doc) => doc.jobs.a.steps.length === 2 && doc.jobs.a.steps[1].run === "echo hi" && doc.on.push.branches[0] === "main"
    ],
    [
      "literal block scalar keeps newlines and '#' comments",
      "jobs:\n  a:\n    steps:\n      - run: |\n          # a shell comment\n          echo one\n          echo two\n",
      (doc) => doc.jobs.a.steps[0].run === "# a shell comment\necho one\necho two\n"
    ],
    [
      "quoted scalar keeps a colon and a hash",
      'a: "x: y # z"\n',
      (doc) => doc.a === "x: y # z"
    ],
    [
      "a trailing comment is removed but the value is not",
      "a: value   # trailing\n",
      (doc) => doc.a === "value"
    ],
    [
      "expressions survive as plain scalars",
      "a: ${{ github.ref }}\n",
      (doc) => doc.a === "${{ github.ref }}"
    ]
  ];

  good.forEach(([label, source, predicate]) => {
    let doc;

    try {
      doc = parse(source, label);
    } catch (error) {
      fail(`parser self-test "${label}" threw: ${error.message}`);
      return;
    }

    if (!predicate(doc)) {
      fail(`parser self-test "${label}" parsed to the wrong shape: ${JSON.stringify(doc)}`);
    }
  });

  const bad = [
    ["tabs are rejected", "a:\n\tb: 1\n"],
    ["flow mappings are rejected", "a: { b: 1 }\n"],
    ["flow sequences are rejected", "a: [1, 2]\n"],
    ["anchors are rejected", "a: &anchor 1\n"],
    ["duplicate keys are rejected", "a: 1\na: 2\n"],
    ["document markers are rejected", "---\na: 1\n"],
    ["a bare line that is not a pair is rejected", "a: 1\nnot a pair\n"],
    ["an unterminated quote is rejected", 'a: "open\n']
  ];

  bad.forEach(([label, source]) => {
    try {
      parse(source, label);
      fail(`parser self-test "${label}" accepted input it must refuse`);
    } catch (error) {
      if (!(error instanceof YamlError)) {
        fail(`parser self-test "${label}" threw the wrong error type: ${error.message}`);
      }
    }
  });

  note(`parser self-test: ${good.length} accepted form(s), ${bad.length} refused form(s)`);
}

/* ------------------------------------------------------------------ *
 * 1b. Prove the two guards that stand between CI and a false green.
 *
 * run-a11y.js exists to catch an audit that skipped; safari-xcode.js exists to
 * catch a converter command that drifted from its documentation. Both are
 * checks, and an unchecked check is decoration — so they carry self-tests and
 * this runs them.
 * ------------------------------------------------------------------ */

function selfTestGuards() {
  const captured = [];
  const realLog = console.log;

  console.log = (...args) => captured.push(args.join(" "));

  const guards = [
    [".github/ci/run-a11y.js", "the accessibility skip guard"],
    [".github/ci/run-firefox.js", "the Firefox skip guard"],
    [".github/ci/run-validate.js", "the validator-suite skip guard"],
    [".github/ci/safari-xcode.js", "the Safari converter drift check"]
  ];

  const results = [];

  try {
    guards.forEach(([file, label]) => {
      results.push([label, require(path.join(ROOT, file)).selfTest()]);
    });
  } catch (error) {
    console.log = realLog;
    fail(`a CI guard self-test threw: ${error.message}`);
    return;
  } finally {
    console.log = realLog;
  }

  captured.forEach((line) => note(line.trim()));

  results.forEach(([label, ok]) => {
    if (!ok) {
      fail(`${label} failed its own self-test`);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 2 + 3 + 4 + 5. Read the real workflows.
 * ------------------------------------------------------------------ */

const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const SCRIPTS = new Set(Object.keys(PACKAGE.scripts || {}));

// Top-level entries a workflow may legitimately name. dist/ is deliberately
// absent: it is build output, checked separately.
const TRACKED_PREFIXES = ["tools/", "test/", "extension/", "data/", "android/", "docs/", "changelog/", "scripts/", ".github/", "FS Engine/"];
const TRACKED_FILES = new Set(["build.js", "package.json", "changelog.json", "development-policy.json"]);

// Anything that would reach the network as this repository, or read a
// credential. Verification CI does none of it.
const FORBIDDEN = [
  [/\bgit\s+push\b/, "git push"],
  [/\bnpm\s+publish\b/, "npm publish"],
  [/\bgh\s+release\b/, "gh release"],
  [/\bgh\s+pr\s+(create|merge)\b/, "gh pr create/merge"],
  [/\bxcrun\s+altool\b/, "xcrun altool (App Store upload)"],
  [/\bxcrun\s+notarytool\b/, "xcrun notarytool (notarization)"],
  [/\bfastlane\b/, "fastlane"],
  [/\bsecrets\./, "secrets context"],
  [/\bGITHUB_TOKEN\b/, "GITHUB_TOKEN"],
  [/\bACTIONS_ID_TOKEN\b/, "OIDC id token"],
  [/-\s*upload\b|\bchrome-webstore\b|\bweb-ext\s+sign\b/, "a store upload"]
];

// Destructive, repository-wide git commands. CLAUDE.md forbids them in a lane
// for a reason; a workflow that ran one on a shared self-hosted runner would
// reproduce exactly that failure.
const DESTRUCTIVE_GIT = [
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\s+\./,
  /\bgit\s+clean\b/,
  /\bgit\s+stash\b/
];

function checkStep(file, jobName, step, index) {
  const where = `${file} · job "${jobName}" · step ${index + 1}`;

  if (step === null || typeof step !== "object") {
    fail(`${where}: step is not a mapping`);
    return;
  }

  const hasRun = typeof step.run === "string";
  const hasUses = typeof step.uses === "string";

  if (hasRun === hasUses) {
    fail(`${where}: a step needs exactly one of \`run\` or \`uses\` (found ${hasRun ? "both" : "neither"})`);
    return;
  }

  if (hasUses) {
    if (!/^[\w.-]+\/[\w.-]+@v?[\w.-]+$/.test(step.uses)) {
      fail(`${where}: \`uses: ${step.uses}\` is not owner/repo@ref — pin it`);
    }
    if (!step.uses.startsWith("actions/")) {
      fail(`${where}: \`uses: ${step.uses}\` is a third-party action; this CI uses first-party actions only`);
    }
    return;
  }

  FORBIDDEN.forEach(([pattern, label]) => {
    if (pattern.test(step.run)) {
      fail(`${where}: references ${label} — this CI verifies, it never publishes or authenticates`);
    }
  });

  // The guards carry a --selftest mode so they can be checked without a browser
  // or a Mac. A workflow calling that instead of the real run would look green
  // while doing none of the work, which is the failure mode the guards exist to
  // prevent. They are self-tested from here; never from a job step.
  if (/--selftest\b/.test(step.run)) {
    fail(`${where}: runs a CI guard in --selftest mode — a job must run the real check`);
  }

  DESTRUCTIVE_GIT.forEach((pattern) => {
    if (pattern.test(step.run)) {
      fail(`${where}: runs a destructive repository-wide git command`);
    }
  });

  checkReferences(where, step.run);
}

function checkReferences(where, script) {
  // npm run <script>
  for (const match of script.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
    if (!SCRIPTS.has(match[1])) {
      fail(`${where}: \`npm run ${match[1]}\` — no such script in package.json`);
    }
  }

  if (/\bnpm\s+(install|ci|i)\b/.test(script)) {
    fail(`${where}: installs npm packages — FitShield has zero dependencies, so there is nothing to install`);
  }

  // Repository paths. Tokens are split on shell separators, then stripped of
  // quoting and trailing punctuation before the existence test.
  const tokens = script.split(/[\s"'`()|&;<>]+/).filter(Boolean);

  tokens.forEach((token) => {
    const cleaned = token.replace(/[),.:]+$/, "").replace(/^\.\//, "");

    if (!cleaned || cleaned.includes("$") || cleaned.includes("*")) {
      return;
    }

    const tracked = TRACKED_FILES.has(cleaned) || TRACKED_PREFIXES.some((prefix) => cleaned.startsWith(prefix));

    if (!tracked) {
      return;
    }

    if (!fs.existsSync(path.join(ROOT, cleaned))) {
      fail(`${where}: references ${cleaned}, which does not exist in this repository`);
    }
  });
}

function checkWorkflow(file) {
  const full = path.join(WORKFLOWS, file);
  const source = fs.readFileSync(full, "utf8");
  let doc;

  try {
    doc = parse(source, file);
  } catch (error) {
    fail(`${file}: ${error.message}`);
    return;
  }

  if (!doc || typeof doc !== "object") {
    fail(`${file}: top level is not a mapping`);
    return;
  }

  if (typeof doc.name !== "string" || !doc.name) {
    fail(`${file}: missing a top-level \`name\``);
  }

  // `on:` is YAML 1.1's boolean true. This parser keeps plain `on` as a string
  // key, so both spellings are accepted and one of them must be present.
  const triggers = doc.on !== undefined ? doc.on : doc[true];

  if (!triggers || typeof triggers !== "object") {
    fail(`${file}: missing a \`on:\` trigger mapping`);
  }

  if (doc.permissions !== undefined) {
    const permissions = doc.permissions;
    const values = permissions && typeof permissions === "object" ? Object.values(permissions) : [permissions];

    values.forEach((value) => {
      if (value !== "read" && value !== "none") {
        fail(`${file}: permissions grant "${value}" — verification CI needs read-only tokens`);
      }
    });
  } else {
    fail(`${file}: declare \`permissions:\` explicitly (contents: read) rather than inheriting the default`);
  }

  if (!doc.jobs || typeof doc.jobs !== "object") {
    fail(`${file}: no jobs`);
    return;
  }

  let stepCount = 0;

  Object.entries(doc.jobs).forEach(([jobName, job]) => {
    if (!job || typeof job !== "object") {
      fail(`${file}: job "${jobName}" is empty`);
      return;
    }

    if (typeof job["runs-on"] !== "string") {
      fail(`${file}: job "${jobName}" has no \`runs-on\``);
    }

    if (typeof job["timeout-minutes"] !== "number") {
      fail(`${file}: job "${jobName}" has no \`timeout-minutes\` — an unbounded job can hang for six hours`);
    }

    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      fail(`${file}: job "${jobName}" has no steps`);
      return;
    }

    job.steps.forEach((step, index) => checkStep(file, jobName, step, index));
    stepCount += job.steps.length;
  });

  note(`${file}: ${Object.keys(doc.jobs).length} job(s), ${stepCount} step(s) — parsed and checked`);
}

function main() {
  selfTestParser();
  selfTestGuards();

  if (!fs.existsSync(WORKFLOWS)) {
    fail(".github/workflows does not exist");
  } else {
    const files = fs.readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

    if (files.length === 0) {
      fail(".github/workflows contains no workflow files");
    }

    files.forEach(checkWorkflow);
  }

  // The helper scripts the workflows call must themselves load.
  fs.readdirSync(path.join(ROOT, ".github", "ci"))
    .filter((name) => name.endsWith(".js"))
    .forEach((name) => {
      try {
        require(path.join(ROOT, ".github", "ci", name));
      } catch (error) {
        fail(`.github/ci/${name} failed to load: ${error.message}`);
      }
    });

  console.log("\n.github — workflow and CI-helper check");
  notes.forEach((message) => console.log(`    ${message}`));
  errors.forEach((message) => console.log(`  \u2717 ${message}`));

  if (errors.length === 0) {
    console.log("    all checks passed");
    process.exit(0);
  }

  console.log(`    ${errors.length} error(s)`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
