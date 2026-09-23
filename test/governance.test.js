"use strict";
/**
 * Development-governance contract tests.
 *
 * A session once ended with seven fixable defects open, and wrote a report
 * saying so. Three instructions actively invited that: the agent report template
 * had a "deferred items … for a later pass" section, the QA command demanded a
 * terminal SHIP / DO NOT SHIP call, and there was no authoritative governance
 * file at all.
 *
 * Prose alone did not hold, so the rules are data (development-policy.json),
 * tools/policy-audit.js enforces them, and these tests prove the enforcement is
 * real by feeding it the exact shapes that failed before.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const policyAudit = require("../tools/policy-audit.js");
const POLICY = JSON.parse(fs.readFileSync(path.join(ROOT, "development-policy.json"), "utf8"));

// ---------------------------------------------------------------------------
// The policy exists, is machine-readable, and says what CLAUDE.md says
// ---------------------------------------------------------------------------

test("the machine-readable policy encodes every completion rule", () => {
  assert.equal(POLICY.completion.repository_local_open_findings_must_be_zero, true);
  assert.equal(POLICY.completion.report_requires_local_queue_empty, true);
  assert.equal(POLICY.completion.terminal_negative_verdicts_forbidden, true);
  assert.equal(POLICY.completion.probably_fixed_counts_as_open, true);
  assert.equal(POLICY.completion.severity_changes_priority_not_completion, true);
  assert.equal(POLICY.completion.validators_may_not_be_loosened_to_pass, true);
});

test("the machine-readable policy requires agents and parallelism", () => {
  assert.equal(POLICY.agents.agent_usage_required, true);
  assert.equal(POLICY.agents.maximize_safe_parallelism, true);
  assert.equal(POLICY.agents.lanes_partitioned_by_file_ownership, true);
  assert.equal(POLICY.agents.reviewer_may_not_terminate_task, true);
  assert.ok(POLICY.agents.required_agent_definitions.length >= 7);
});

test("CLAUDE.md exists and states the four rules the audit checks for", () => {
  const governance = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");

  assert.match(governance, /a finding is work/i);
  assert.match(governance, /terminal verdicts are forbidden/i);
  assert.match(governance, /agents are mandatory/i);
  assert.match(governance, /probably.{0,3}fixed/i);
  assert.ok(governance.includes("development-policy.json"), "it must point at its machine-readable form");
});

test("every agent the policy requires is actually registered", () => {
  const dir = path.join(ROOT, ".claude", "agents");

  if (!fs.existsSync(dir)) {
    // .claude/ is git-ignored local tooling; a clean clone legitimately lacks it.
    return;
  }

  const present = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, ""));

  POLICY.agents.required_agent_definitions.forEach((agent) => {
    assert.ok(present.includes(agent), `agent definition "${agent}" is missing`);
  });
});

test("the repository currently satisfies its own governance", () => {
  const reporter = policyAudit();
  assert.deepEqual(reporter.errors, [], reporter.errors.join("\n"));
});

// ---------------------------------------------------------------------------
// The audit actually catches the shapes that failed before
// ---------------------------------------------------------------------------

// policy-audit reads from the repo root, so a probe is written in place and
// removed again. Each one is the literal thing that slipped through last time.
function withReport(contents, fn) {
  const file = path.join(ROOT, "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md");
  const had = fs.existsSync(file);
  const previous = had ? fs.readFileSync(file, "utf8") : null;

  fs.writeFileSync(file, contents);

  try {
    return fn();
  } finally {
    if (had) fs.writeFileSync(file, previous);
    else fs.unlinkSync(file);
  }
}

const CLEAN_REPORT = [
  "# Completion status",
  "",
  "Repository-local findings: 0",
  "",
  "## Executive summary",
  "Everything closed."
].join("\n");

test("a clean report passes", () => {
  withReport(CLEAN_REPORT, () => {
    assert.deepEqual(policyAudit().errors, []);
  });
});

test("a report cannot claim completion while its own local queue is non-empty", () => {
  withReport(CLEAN_REPORT.replace("Repository-local findings: 0", "Repository-local findings: 7"), () => {
    const errors = policyAudit().errors;
    assert.ok(
      errors.some((e) => /7 repository-local finding/.test(e)),
      `expected the open-queue failure, got:\n${errors.join("\n")}`
    );
  });
});

test("a report that never states its local count is rejected", () => {
  withReport("# Completion status\n\nAll good, trust me.\n", () => {
    const errors = policyAudit().errors;
    assert.ok(errors.some((e) => /must state/.test(e)), errors.join("\n"));
  });
});

test('"probably fixed" cannot satisfy verification', () => {
  ["probably fixed", "not re-verified", "likely resolved"].forEach((phrase) => {
    withReport(`${CLEAN_REPORT}\n\nThe popup issue is ${phrase} by the schedule projection.\n`, () => {
      const errors = policyAudit().errors;
      assert.ok(
        errors.some((e) => /unverified claim/.test(e)),
        `"${phrase}" should have been rejected; got:\n${errors.join("\n")}`
      );
    });
  });
});

test("a terminal verdict in the report is rejected", () => {
  POLICY.forbidden_terminal_verdicts.forEach((verdict) => {
    withReport(`# Completion status\n\nRepository-local findings: 0\n\n## ${verdict}\n`, () => {
      const errors = policyAudit().errors;
      assert.ok(
        errors.some((e) => e.includes(verdict)),
        `"${verdict}" should have been rejected; got:\n${errors.join("\n")}`
      );
    });
  });
});

test("a deferral bucket in the report is rejected", () => {
  ["Deferred", "Follow-ups", "Remaining work", "Open findings", "Next session"].forEach((heading) => {
    withReport(`${CLEAN_REPORT}\n\n## ${heading}\n\n- something for later\n`, () => {
      const errors = policyAudit().errors;
      assert.ok(
        errors.some((e) => e.includes(heading)),
        `"${heading}" should have been rejected; got:\n${errors.join("\n")}`
      );
    });
  });
});

test("external-only items are classified separately from repository-local work", () => {
  // The three genuinely-unavailable environments are named in the policy, each
  // with its local prerequisites already complete — so they can never be used to
  // shelter unrelated repository work.
  const ids = POLICY.external_only_allowed.map((item) => item.id);

  assert.deepEqual(ids.sort(), ["android-apk", "human-acceptance", "screen-reader"]);

  POLICY.external_only_allowed.forEach((item) => {
    assert.ok(item.reason && item.requires, `${item.id} must say why and what it needs`);
    assert.equal(item.local_prerequisites_complete, true, `${item.id} must have its local prerequisites done`);
  });

  // A report may list these; they are not repository-local findings.
  withReport(
    `${CLEAN_REPORT}\n\n## External validation items\n\n- On-device Android blocking — needs a physical device\n`,
    () => assert.deepEqual(policyAudit().errors, [])
  );
});

test("the product invariants the policy pins match the shipped manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));

  assert.deepEqual(
    manifest.permissions.slice().sort(),
    POLICY.product_invariants.permissions.slice().sort(),
    "the policy and the manifest must agree on the permission set"
  );
  assert.equal(POLICY.product_invariants.runtime_network_requests_allowed, false);
  assert.equal(POLICY.product_invariants.new_dependencies_allowed, false);
  assert.equal(POLICY.product_invariants.telemetry_allowed, false);
});

test("the project still ships with no dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, "no runtime dependencies");
  assert.ok(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0, "no dev dependencies either");
  assert.ok(!fs.existsSync(path.join(ROOT, "node_modules")), "and nothing installed");
});

// ---------------------------------------------------------------------------
// Closing a queue item has to cost more than one word
// ---------------------------------------------------------------------------

// The queue check originally read `item.status !== "closed"`, so the cheapest
// way to empty a 77-item queue was to write "closed" 77 times. That is the same
// failure this whole audit exists to prevent, one file over: an assertion of
// completion standing in for the work. Closure now needs a narrative and an
// anchor, and the narrative is held to the report's language rules.
//
// These run against a temp fixture rather than the repository's own queue.
// Reading the live one made them fail whenever a lane landed a closure while
// the suite was running — a test asserting against a moving tree, which is a
// defect in the test and not in the tree.

let fixtureSeq = 0;

// `items` become the findings list; `closures` is {laneName: [records]}.
function withFixture({ items = [], closures = {} }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fs-queue-${fixtureSeq++}-`));
  const queueFile = path.join(dir, ".queue.json");
  const closureDir = path.join(dir, ".queue.closures");

  fs.writeFileSync(queueFile, JSON.stringify(items, null, 2));

  if (Object.keys(closures).length > 0) {
    fs.mkdirSync(closureDir, { recursive: true });
    Object.entries(closures).forEach(([lane, records]) => {
      fs.writeFileSync(path.join(closureDir, `${lane}.json`), JSON.stringify(records, null, 2));
    });
  }

  try {
    return fn({ queueFile, closureDir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const audit = (paths) => policyAudit(paths);

const PROBE = { id: "F900", dimension: "probe", severity: "HIGH", title: "probe" };
const PROVEN = {
  id: "F900",
  status: "closed",
  verification:
    "Reproduced against the built package in Chrome 149, fixed, then re-ran with the fix reverted to confirm the check fails without it.",
  test: "test/probe.test.js"
};

test("a queue item closed with proof and an anchor is accepted", () => {
  withFixture({ items: [{ ...PROBE, ...PROVEN }] }, (paths) => {
    const reporter = audit(paths);
    assert.deepEqual(reporter.errors, [], reporter.errors.join("\n"));
    assert.ok(
      reporter.notes.some((n) => /work queue empty/.test(n)),
      `expected an empty queue, got:\n${reporter.notes.join("\n")}`
    );
  });
});

test("a queue item cannot be closed by the word alone", () => {
  withFixture({ items: [{ ...PROBE, status: "closed" }] }, (paths) => {
    const errors = audit(paths).errors;
    assert.ok(
      errors.some((e) => /F900: no verification narrative/.test(e)),
      `expected the unproven-closure failure, got:\n${errors.join("\n")}`
    );
  });
});

test("a verified queue item still needs somewhere the proof lives", () => {
  const { test: _dropped, ...unanchored } = PROVEN;

  withFixture({ items: [{ ...PROBE, ...unanchored }] }, (paths) => {
    const errors = audit(paths).errors;
    assert.ok(errors.some((e) => /F900: verified but unanchored/.test(e)), errors.join("\n"));
  });
});

test("closure prose is held to the same language rules as the report", () => {
  [
    "probably fixed",
    "not re-verified",
    "likely resolved",
    "appears to be fixed",
    "assumed closed",
    "should now be resolved"
  ].forEach((phrase) => {
    const item = { ...PROBE, ...PROVEN, verification: `This one ${phrase} by the earlier catalog work in the other lane.` };

    withFixture({ items: [item] }, (paths) => {
      const errors = audit(paths).errors;
      assert.ok(
        errors.some((e) => /forbidden language/.test(e)),
        `"${phrase}" was accepted as verification; errors:\n${errors.join("\n")}`
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Closures land one file per lane, so concurrent agents never collide
// ---------------------------------------------------------------------------

test("a lane's closure record closes its finding without touching the queue file", () => {
  withFixture({ items: [PROBE], closures: { "probe-lane": [PROVEN] } }, (paths) => {
    const reporter = audit(paths);
    assert.deepEqual(reporter.errors, [], reporter.errors.join("\n"));
    assert.ok(
      reporter.notes.some((n) => /work queue empty/.test(n)),
      `expected an empty queue, got:\n${reporter.notes.join("\n")}`
    );

    // The findings list is the record of what was found; closing is additive.
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.queueFile, "utf8")), [PROBE]);
  });
});

test("two lanes cannot both claim the same finding", () => {
  withFixture({ items: [PROBE], closures: { "lane-a": [PROVEN], "lane-b": [PROVEN] } }, (paths) => {
    const errors = audit(paths).errors;
    assert.ok(errors.some((e) => /claimed closed by two lanes/.test(e)), errors.join("\n"));
  });
});

test("a closure for a finding nobody recorded is rejected", () => {
  withFixture({ items: [PROBE], closures: { "lane-a": [{ ...PROVEN, id: "F999" }] } }, (paths) => {
    const errors = audit(paths).errors;
    assert.ok(errors.some((e) => /unknown finding/.test(e)), errors.join("\n"));
  });
});
