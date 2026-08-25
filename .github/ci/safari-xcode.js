#!/usr/bin/env node
"use strict";
/**
 * Prove the Safari payload converts and compiles — the one FitShield gate that
 * has never actually been run.
 *
 *   node .github/ci/safari-xcode.js            (macOS: verify + build)
 *   node .github/ci/safari-xcode.js --selftest (any OS: verify the drift check)
 *
 * WHY THIS EXISTS
 *   `xcrun safari-web-extension-converter` and `xcodebuild` are macOS-only, so
 *   for the whole life of this project the Safari wrapper has been filed as
 *   something the development machine physically cannot do. That was a fact
 *   about the desk, not about the project: a macOS runner can do it, and this
 *   script is what it runs.
 *
 * WHAT IT CHECKS, IN ORDER
 *   1. dist/apple/BUILD.txt exists — i.e. `node build.js` staged the payload.
 *   2. The converter command PRINTED in BUILD.txt is the same command
 *      tools/build-safari.js EXECUTES. Both come from converterArgs(), so they
 *      agree today; comparing them here means they cannot quietly stop
 *      agreeing, and CI can never end up proving a command the documentation
 *      does not describe.
 *   3. The conversion really happened. build.js runs the converter when it
 *      finds one and merely logs when it does not — correct off a Mac, fatal
 *      here, because a job that skipped the conversion and went green would be
 *      the exact false guarantee this whole exercise is meant to remove.
 *   4. xcodebuild compiles the generated project, UNSIGNED. Signing needs an
 *      Apple Developer team and a secret, and this CI holds neither; unsigned
 *      still establishes the part that was never established — that the payload
 *      converts and the wrapper compiles.
 *
 * Node built-ins only.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const DIST_APPLE = path.join(ROOT, "dist", "apple");
const BUILD_TXT = path.join(DIST_APPLE, "BUILD.txt");
const XCODE_DIR = path.join(DIST_APPLE, "xcode");
const LOG_DIR = path.join(ROOT, "dist", "apple", "logs");

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

/**
 * Pull the `xcrun safari-web-extension-converter …` invocation out of BUILD.txt
 * and return it as argv tokens. Backslash-newline continuations are joined and
 * quoting is unwrapped, so the result compares directly against an argv array.
 */
function extractConverterCommand(text) {
  const start = text.indexOf("xcrun safari-web-extension-converter");

  if (start === -1) {
    return null;
  }

  const lines = text.slice(start).split("\n");
  const collected = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const continues = trimmed.endsWith("\\");

    collected.push(continues ? trimmed.slice(0, -1) : trimmed);

    if (!continues) {
      break;
    }
  }

  return tokenize(collected.join(" "));
}

function tokenize(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;

  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }

  return tokens;
}

/**
 * The command tools/build-safari.js actually spawns, normalised to the same
 * shape BUILD.txt prints: `xcrun` prefixed, absolute paths made repo-relative.
 */
function expectedConverterCommand() {
  const args = require(path.join(ROOT, "tools", "build-safari.js")).converterArgs();

  return ["xcrun", ...args.map((arg) => (path.isAbsolute(arg) ? rel(arg) : arg))];
}

function compareCommands(documented, executed) {
  if (!documented) {
    return ["dist/apple/BUILD.txt does not contain an `xcrun safari-web-extension-converter` command"];
  }

  if (documented.length !== executed.length || documented.some((token, i) => token !== executed[i])) {
    return [
      "the converter command in dist/apple/BUILD.txt has drifted from the one tools/build-safari.js runs",
      `  documented: ${documented.join(" ")}`,
      `  executed  : ${executed.join(" ")}`
    ];
  }

  return [];
}

function conversionReported(text) {
  const match = /^Xcode project built:\s*(\S+)/m.exec(text);

  return match ? match[1].toUpperCase() : null;
}

function findXcodeProject() {
  if (!fs.existsSync(XCODE_DIR)) {
    return null;
  }

  const found = [];

  (function walk(dir, depth) {
    if (depth > 3) return;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.endsWith(".xcodeproj")) {
          found.push(full);
        } else {
          walk(full, depth + 1);
        }
      }
    }
  })(XCODE_DIR, 0);

  return found[0] || null;
}

function xcodebuild(args, { capture = true } = {}) {
  return spawnSync("xcodebuild", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
}

/**
 * The converter emits one scheme per platform when it targets macOS and iOS
 * together, named like "FitShield Nightly (macOS)". Reading the list rather
 * than guessing the name keeps this working if Apple changes the convention.
 */
function pickMacScheme(project) {
  const listed = xcodebuild(["-list", "-json", "-project", project]);

  if (listed.status !== 0) {
    return { error: `xcodebuild -list failed:\n${listed.stderr || listed.stdout}` };
  }

  let parsed;

  try {
    // -list -json can emit a note before the JSON body.
    const body = listed.stdout.slice(listed.stdout.indexOf("{"));
    parsed = JSON.parse(body);
  } catch (error) {
    return { error: `could not parse xcodebuild -list -json output: ${error.message}` };
  }

  const schemes = (parsed.project && parsed.project.schemes) || [];

  if (schemes.length === 0) {
    return { error: "the generated Xcode project exposes no schemes" };
  }

  const mac = schemes.find((name) => /macos/i.test(name));

  if (mac) {
    return { scheme: mac, schemes };
  }

  // A single-platform conversion produces one unsuffixed scheme.
  if (schemes.length === 1) {
    return { scheme: schemes[0], schemes };
  }

  return { error: `no macOS scheme among: ${schemes.join(", ")}`, schemes };
}

function selfTest() {
  const problems = [];

  // The drift check must accept the real, current BUILD.txt command and reject
  // a mutated one. Both halves matter: a comparison that always passes is not a
  // comparison.
  const executed = expectedConverterCommand();
  const documentedText = fs.existsSync(BUILD_TXT) ? fs.readFileSync(BUILD_TXT, "utf8") : null;

  if (documentedText) {
    const documented = extractConverterCommand(documentedText);
    const drift = compareCommands(documented, executed);

    if (drift.length) {
      problems.push(...drift);
    }
  }

  const mutated = extractConverterCommand(
    "xcrun safari-web-extension-converter \\\n" +
      '    "dist/apple/extension" \\\n' +
      '    --project-location "dist/apple/SOMEWHERE-ELSE" \\\n' +
      '    --app-name "FitShield Nightly" \\\n' +
      "    --bundle-identifier us.ushacorp.fitshield.nightly \\\n" +
      "    --swift --copy-resources --force --no-open --no-prompt"
  );

  if (compareCommands(mutated, executed).length === 0) {
    problems.push("the drift check accepted a command with a different --project-location");
  }

  if (compareCommands(null, executed).length === 0) {
    problems.push("the drift check accepted a BUILD.txt with no converter command at all");
  }

  // The conversion gate must read NO as NO.
  const gates = [
    ["Xcode project built:  YES\n", "YES"],
    ["Xcode project built:  NO\n", "NO"],
    ["nothing of the sort\n", null]
  ];

  gates.forEach(([text, expected]) => {
    if (conversionReported(text) !== expected) {
      problems.push(`the conversion gate read ${JSON.stringify(text)} as ${conversionReported(text)}, expected ${expected}`);
    }
  });

  if (problems.length) {
    problems.forEach((problem) => console.log(`  ✗ ${problem}`));
    return false;
  }

  // Whether the real BUILD.txt was available matters, because the mutation
  // cases alone only prove the comparison works — not that the file on disk
  // agrees with the code. Say which happened rather than implying the stronger
  // one. The workflows run this after `node build.js` so it is always the
  // stronger one in CI.
  console.log(
    documentedText
      ? "    safari drift check self-test: dist/apple/BUILD.txt matches the command tools/build-safari.js runs, and mutations are caught"
      : "    safari drift check self-test: mutations are caught (dist/apple/BUILD.txt absent, so the real file was not compared — run `node build.js` first)"
  );
  return true;
}

function main() {
  if (process.argv.includes("--selftest")) {
    process.exit(selfTest() ? 0 : 1);
  }

  if (process.platform !== "darwin") {
    console.error(`This step needs macOS — safari-web-extension-converter and xcodebuild do not exist on ${process.platform}.`);
    process.exit(1);
  }

  if (!fs.existsSync(BUILD_TXT)) {
    console.error("dist/apple/BUILD.txt is missing. Run `node build.js` before this step.");
    process.exit(1);
  }

  const text = fs.readFileSync(BUILD_TXT, "utf8");

  // --- 2. documented command === executed command -------------------------
  const executed = expectedConverterCommand();
  const documented = extractConverterCommand(text);
  const drift = compareCommands(documented, executed);

  console.log("Converter command (from dist/apple/BUILD.txt, which is what tools/build-safari.js runs):");
  console.log(`  ${(documented || []).join(" ")}`);

  if (drift.length) {
    drift.forEach((line) => console.error(`  ✗ ${line}`));
    process.exit(1);
  }

  console.log("  the documented command and the executed command are identical\n");

  // --- 3. the conversion really happened -----------------------------------
  const reported = conversionReported(text);

  if (reported !== "YES") {
    console.error(`dist/apple/BUILD.txt reports "Xcode project built: ${reported}".`);
    console.error("The converter did not run. On a macOS runner that is a failure, not a skip —");
    console.error("check that Xcode is selected (`xcode-select -p`) and that");
    console.error("`xcrun --find safari-web-extension-converter` resolves.");
    process.exit(1);
  }

  const project = findXcodeProject();

  if (!project) {
    console.error(`No .xcodeproj under ${rel(XCODE_DIR)} even though BUILD.txt reports a successful conversion.`);
    process.exit(1);
  }

  console.log(`Generated Xcode project: ${rel(project)}`);

  // --- 4. compile it, unsigned ---------------------------------------------
  const picked = pickMacScheme(project);

  if (picked.error) {
    console.error(picked.error);
    process.exit(1);
  }

  console.log(`Schemes: ${picked.schemes.join(", ")}`);
  console.log(`Building scheme "${picked.scheme}" (unsigned)\n`);

  const derived = path.join(DIST_APPLE, "DerivedData");

  const result = xcodebuild([
    "-project", project,
    "-scheme", picked.scheme,
    "-configuration", "Debug",
    "-destination", "generic/platform=macOS",
    "-derivedDataPath", derived,
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
    "CODE_SIGN_IDENTITY=",
    "CODE_SIGN_ENTITLEMENTS=",
    "build"
  ]);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = path.join(LOG_DIR, "xcodebuild.log");
  fs.writeFileSync(log, `${result.stdout || ""}\n${result.stderr || ""}`);
  console.log(`xcodebuild log -> ${rel(log)}`);

  if (result.status !== 0) {
    console.error("\nxcodebuild FAILED. Last 120 lines:\n");
    console.error(`${result.stdout || ""}\n${result.stderr || ""}`.split("\n").slice(-120).join("\n"));
    process.exit(1);
  }

  // "BUILD SUCCEEDED" plus a real product on disk. Either alone can lie: a
  // scheme with nothing in it succeeds and builds nothing.
  const combined = `${result.stdout || ""}${result.stderr || ""}`;

  if (!/\bBUILD SUCCEEDED\b/.test(combined)) {
    console.error("xcodebuild exited 0 without reporting BUILD SUCCEEDED — treating that as a failure.");
    process.exit(1);
  }

  const products = path.join(derived, "Build", "Products");
  const apps = [];

  if (fs.existsSync(products)) {
    (function walk(dir, depth) {
      if (depth > 3) return;

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        if (entry.name.endsWith(".app") || entry.name.endsWith(".appex")) {
          apps.push(path.join(dir, entry.name));
        } else {
          walk(path.join(dir, entry.name), depth + 1);
        }
      }
    })(products, 0);
  }

  if (apps.length === 0) {
    console.error(`BUILD SUCCEEDED but no .app or .appex was produced under ${rel(products)}.`);
    process.exit(1);
  }

  console.log("\nBUILD SUCCEEDED (unsigned). Products:");
  apps.forEach((app) => console.log(`    ${rel(app)}`));
  console.log("\nThe Safari payload converts and the wrapper compiles.");
  console.log("Signing and notarization are NOT done here: both need an Apple Developer team,");
  console.log("and this CI holds no secrets by design.");
}

module.exports = {
  extractConverterCommand,
  expectedConverterCommand,
  compareCommands,
  conversionReported,
  tokenize,
  selfTest
};

if (require.main === module) {
  main();
}
