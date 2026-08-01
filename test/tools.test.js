"use strict";

// Runs the full validator suite (tools/) as part of `node --test`, so dataset,
// locale, documentation, and asset problems fail CI just like a unit test.
const test = require("node:test");
const assert = require("node:assert/strict");

const { validateAll } = require("../tools/validate-all");

test("validate-all passes with no errors", async () => {
  const result = await validateAll({ quiet: true });
  const failing = result.reporters
    .filter((r) => !r.ok)
    .map((r) => `${r.name}: ${r.errors.join("; ")}`)
    .join("\n");
  assert.equal(result.errors, 0, `validators reported errors:\n${failing}`);
});

test("each individual audit is runnable and returns a reporter", async () => {
  const audits = [
    "../tools/validate-datasets",
    "../tools/alias-audit",
    "../tools/country-audit",
    "../tools/category-audit",
    "../tools/android-audit",
    "../tools/locale-parity",
    "../tools/changelog-validator",
    "../tools/assets-check",
    "../tools/extension-audit",
    "../tools/service-worker-audit"
  ];
  for (const mod of audits) {
    const audit = require(mod);
    assert.equal(typeof audit, "function", `${mod} should export a function`);
    const reporter = await audit(); // sync audits return a Reporter; async ones a Promise
    assert.ok(Array.isArray(reporter.errors), `${mod} should return a Reporter`);
    assert.equal(typeof reporter.ok, "boolean");
  }
});

// tools/README.md is the map a new contributor reads before touching anything
// here. It had drifted badly — 14 of 24 tools were missing and it pointed at
// three files that do not exist — which is worse than no map, because the
// missing tools are the ones nobody knows to run. Keep it honest mechanically.
test("tools/README.md documents every tool and cites only real commands", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const ROOT = path.join(__dirname, "..");

  const readme = fs.readFileSync(path.join(ROOT, "tools", "README.md"), "utf8");
  const scripts = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts);
  const tools = fs.readdirSync(path.join(ROOT, "tools")).filter((f) => f.endsWith(".js"));

  const undocumented = tools.filter((tool) => !readme.includes(tool));
  assert.deepEqual(undocumented, [], `tools missing from tools/README.md: ${undocumented.join(", ")}`);

  const citedCommands = [...new Set((readme.match(/npm run [a-z:0-9-]+/g) || []).map((s) => s.slice(8)))];
  const unreal = citedCommands.filter((name) => !scripts.includes(name));
  assert.deepEqual(unreal, [], `tools/README.md cites npm scripts that do not exist: ${unreal.join(", ")}`);

  const citedFiles = [...new Set((readme.match(/`([a-z0-9.-]+\.js)`/g) || []).map((s) => s.replace(/`/g, "")))];
  const ghosts = citedFiles.filter(
    (file) =>
      !tools.includes(file) &&
      !fs.existsSync(path.join(ROOT, file)) &&
      !fs.existsSync(path.join(ROOT, "tools", "lib", file))
  );
  assert.deepEqual(ghosts, [], `tools/README.md cites files that do not exist: ${ghosts.join(", ")}`);
});
