"use strict";
/**
 * Tiny reporting helper shared by every validator in tools/.
 *
 * A Reporter collects pass / warn / fail messages for one audit. It is used in
 * two ways:
 *   - CLI: run a tool directly; it prints a human-readable report and exits
 *     non-zero when there are errors (warnings never fail).
 *   - Programmatic: build.js and validate-all.js import an audit, read
 *     `reporter.ok`, and decide whether to continue — no process.exit.
 *
 * No dependencies (Node built-ins only); developer-only, never bundled.
 */

const TICK = "✓"; // ✓
const WARN = "⚠"; // ⚠
const CROSS = "✗"; // ✗

class Reporter {
  constructor(name) {
    this.name = name;
    this.errors = [];
    this.warnings = [];
    this.notes = [];
  }

  fail(message) {
    this.errors.push(message);
    return this;
  }

  warn(message) {
    this.warnings.push(message);
    return this;
  }

  note(message) {
    this.notes.push(message);
    return this;
  }

  // Convenience: fail when `condition` is false.
  check(condition, failMessage) {
    if (!condition) {
      this.fail(failMessage);
    }
    return !!condition;
  }

  get ok() {
    return this.errors.length === 0;
  }

  // Pretty, scannable block for one audit.
  print() {
    const status = this.ok ? (this.warnings.length ? WARN : TICK) : CROSS;
    console.log(`\n${status} ${this.name}`);

    this.notes.forEach((m) => console.log(`    ${m}`));
    this.warnings.forEach((m) => console.log(`  ${WARN} ${m}`));
    this.errors.forEach((m) => console.log(`  ${CROSS} ${m}`));

    if (this.ok && this.warnings.length === 0) {
      console.log("    all checks passed");
    } else {
      console.log(`    ${this.errors.length} error(s), ${this.warnings.length} warning(s)`);
    }
  }
}

// Run a single audit module from the command line: print + exit code.
function runCli(auditFn) {
  const reporter = auditFn();
  reporter.print();
  process.exit(reporter.ok ? 0 : 1);
}

module.exports = { Reporter, runCli, TICK, WARN, CROSS };
