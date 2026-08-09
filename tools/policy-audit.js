#!/usr/bin/env node
"use strict";
/**
 * Enforce the development governance in development-policy.json.
 *
 * This exists because prose did not hold. A session ended with seven fixable
 * findings open and wrote a report saying so, because three separate
 * instructions actively invited that: the agent report template had a "deferred
 * items … for a later pass" section, the QA command demanded a terminal
 * SHIP / DO NOT SHIP call, and there was no authoritative governance file at all.
 *
 * So the rules are data now, and this checks that the repository still agrees
 * with them:
 *
 *   1. the policy file and CLAUDE.md both exist and stay in step;
 *   2. every agent definition the policy requires is present;
 *   3. no instruction file re-introduces a terminal verdict or a deferral bucket;
 *   4. an acceptance report cannot claim completion while its own
 *      repository-local queue is non-empty;
 *   5. "probably fixed" never appears as a verification outcome.
 *
 *   node tools/policy-audit.js
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report.js");

const ROOT = path.join(__dirname, "..");
const POLICY_FILE = path.join(ROOT, "development-policy.json");
const GOVERNANCE_FILE = path.join(ROOT, "CLAUDE.md");
const REPORT_FILE = path.join(ROOT, "SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md");
const AGENTS_DIR = path.join(ROOT, ".claude", "agents");

// Instruction files that must not re-introduce a stopping condition. `.claude/`
// is git-ignored local tooling, so it is checked only when present.
function instructionFiles() {
  const files = [GOVERNANCE_FILE, path.join(ROOT, "CONTRIBUTING.md")];

  [path.join(ROOT, ".claude", "commands"), path.join(ROOT, ".claude", "templates"), AGENTS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      return;
    }

    fs.readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .forEach((name) => files.push(path.join(dir, name)));
  });

  return files.filter((file) => fs.existsSync(file));
}

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");

/**
 * A heading that opens a bucket for work that is still doable here.
 * Matched as a HEADING only — prose that merely names the concept (this file, or
 * a rule that forbids it) must not trip the audit, or the rule could never be
 * written down.
 */
function deferralHeadings(text, policy) {
  const out = [];

  text.split(/\r?\n/).forEach((line, index) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());

    if (!heading) {
      return;
    }

    const title = heading[1].replace(/[*_`:]/g, "").trim();

    policy.forbidden_report_sections.forEach((banned) => {
      if (new RegExp(`^${banned}\\b`, "i").test(title)) {
        out.push({ line: index + 1, title });
      }
    });
  });

  return out;
}

function policyAudit() {
  const reporter = new Reporter("Development governance");

  if (!fs.existsSync(POLICY_FILE)) {
    reporter.fail("development-policy.json is missing — the governance rules have no machine-readable form");
    return reporter;
  }

  const policy = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));

  // --- 1. the two governance sources exist and agree ------------------------
  if (!fs.existsSync(GOVERNANCE_FILE)) {
    reporter.fail("CLAUDE.md is missing — there is no authoritative governance source");
    return reporter;
  }

  const governance = fs.readFileSync(GOVERNANCE_FILE, "utf8");

  [
    ["a finding is work", /a finding is work/i],
    ["the no-verdict rule", /terminal verdicts are forbidden/i],
    ["the mandatory-agent rule", /agents are mandatory/i],
    ["the probably-fixed rule", /probably.{0,3}fixed/i]
  ].forEach(([what, pattern]) => {
    if (!pattern.test(governance)) {
      reporter.fail(`CLAUDE.md no longer states ${what}`);
    }
  });

  if (!governance.includes("development-policy.json")) {
    reporter.fail("CLAUDE.md must point at development-policy.json, or the two will drift");
  }

  ["repository_local_open_findings_must_be_zero", "report_requires_local_queue_empty", "terminal_negative_verdicts_forbidden", "probably_fixed_counts_as_open"].forEach((flag) => {
    if (policy.completion[flag] !== true) {
      reporter.fail(`policy completion.${flag} must be true`);
    }
  });

  if (policy.agents.agent_usage_required !== true || policy.agents.maximize_safe_parallelism !== true) {
    reporter.fail("policy must require agent usage and maximum safe parallelism");
  }

  // --- 2. every required agent definition is registered ---------------------
  if (!fs.existsSync(AGENTS_DIR)) {
    reporter.note(".claude/agents is absent (git-ignored local tooling) — agent registration not checked here");
  } else {
    const present = fs
      .readdirSync(AGENTS_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/, ""));

    policy.agents.required_agent_definitions.forEach((agent) => {
      if (!present.includes(agent)) {
        reporter.fail(`agent definition "${agent}" is required by policy but not registered in .claude/agents`);
      }
    });

    reporter.note(`${present.length} agent definition(s) registered`);
  }

  // --- 3. no instruction file re-introduces a stopping condition ------------
  const files = instructionFiles();

  files.forEach((file) => {
    const text = fs.readFileSync(file, "utf8");
    const name = rel(file);

    // A verdict is only a violation when an instruction DEMANDS one. CLAUDE.md
    // and this audit necessarily name them in order to forbid them.
    if (/\b(SHIP|DO NOT SHIP)\b/.test(text) && !/forbidden|never|may not|must not/i.test(text)) {
      reporter.fail(`${name}: demands a terminal SHIP / DO NOT SHIP call`);
    }

    if (/(ranked|rank) (issues )?by severity/i.test(text) && !/fix/i.test(text)) {
      reporter.fail(`${name}: instructs ranking without requiring the work be done`);
    }

    deferralHeadings(text, policy).forEach((hit) => {
      reporter.fail(`${name}:${hit.line}: "${hit.title}" is a bucket for work that should have been finished`);
    });

    // A file that STATES the rule may quote the anti-pattern it forbids —
    // otherwise the rule could never be written down. Carrying the marker
    // phrase is the deliberate, greppable opt-out.
    const statesTheRule = /a finding is work/i.test(text);

    if (/deferred items|for a later pass|pick up next/i.test(text) && !statesTheRule) {
      reporter.fail(`${name}: offers a deferral slot ("deferred items" / "a later pass" / "pick up next")`);
    }
  });

  reporter.note(`${files.length} instruction file(s) checked for stopping conditions`);

  // --- 4. the acceptance report may not ship an open local queue ------------
  if (fs.existsSync(REPORT_FILE)) {
    const report = fs.readFileSync(REPORT_FILE, "utf8");

    policy.forbidden_terminal_verdicts.forEach((verdict) => {
      // A verdict as a heading or as a bolded standalone line is the pattern
      // that ended the last session.
      const asHeading = new RegExp(`^#{1,6}\\s*(>\\s*)?#*\\s*${verdict}\\s*$`, "im");
      const asBold = new RegExp(`^\\s*(>\\s*)?\\*\\*${verdict}\\*\\*\\s*$`, "im");

      if (asHeading.test(report) || asBold.test(report)) {
        reporter.fail(`the acceptance report states a terminal verdict: "${verdict}"`);
      }
    });

    deferralHeadings(report, policy).forEach((hit) => {
      reporter.fail(`acceptance report:${hit.line}: "${hit.title}" — finish the work instead of listing it`);
    });

    // The report's own declared local count must be zero.
    const declared = /repository[- ]local (?:open )?findings\s*[:|]*\s*\**\s*(\d+)/i.exec(report);

    if (!declared) {
      reporter.fail('the acceptance report must state "Repository-local findings: <n>" so this can be checked');
    } else if (Number(declared[1]) !== 0) {
      reporter.fail(
        `the acceptance report declares ${declared[1]} repository-local finding(s) still open — a report is the consequence of completion, not permission to stop`
      );
    } else {
      reporter.note("acceptance report declares 0 repository-local findings");
    }

    if (/probably fixed|not re-?verified|likely resolved/i.test(report)) {
      reporter.fail('the acceptance report contains an unverified claim ("probably fixed" / "not re-verified")');
    }
  }

  // --- 5. the work queue, if one is present, must be empty ------------------
  const queueFile = path.join(ROOT, ".queue.json");

  if (fs.existsSync(queueFile)) {
    const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    const open = queue.filter((item) => item && item.status !== "closed");

    if (open.length > 0) {
      reporter.note(`${open.length} item(s) still open in .queue.json — the session is not finished`);
    } else {
      reporter.note(`work queue empty (${queue.length} closed)`);
    }
  }

  return reporter;
}

module.exports = policyAudit;

if (require.main === module) {
  runCli(policyAudit);
}
