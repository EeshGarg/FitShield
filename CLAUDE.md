# FitShield — development governance

Authoritative rules for any automated or assisted development session in this
repository. Where any other file disagrees with this one, this file wins.

Machine-readable form: [`development-policy.json`](development-policy.json).
Enforced by `tools/policy-audit.js`, which runs inside `npm run validate` and
`npm test`. If you change a rule here, change it there too — a test fails
otherwise.

---

## 1. A finding is work

**Severity changes priority. Severity does not change completion requirements.**

A repository-local issue may not be left open because it is non-blocking, medium,
low, editorial, UX, information architecture, cleanup, "probably already fixed",
deferred, follow-up, out of the original scope, raised by a reviewer, or found
late in the session.

If it is safely fixable in this repository it must be **fixed, tested, reviewed
where appropriate, and closed.** The task does not end while such work remains.

### Non-terminal classifications

These words describe *priority or origin*. None of them ends a task:

> verdict · ready · not ready · blocker · high · medium · low · finding ·
> deferred · follow-up · next session · remaining · open · out of scope ·
> recommendation · handoff · probably fixed · needs a decision

### "Probably fixed" is forbidden

An item believed fixed as a side effect of other work is **unverified, therefore
open**. Reproduce it. If it is fixed, add or strengthen the regression test and
close it. If it is not, fix it. There is no "probably".

---

## 2. Terminal verdicts are forbidden

No session, agent, review, or report may conclude with `NOT READY`,
`RELEASE CANDIDATE`, `SKEPTICAL-BUYER READY`, `SHIP` / `DO NOT SHIP`,
`PASS WITH LIMITATIONS`, `FAIL`, `BLOCKED`, `NEEDS ANOTHER PASS`, or any
equivalent, as the outcome of the work.

A discovered defect is an instruction to fix it. A failed scenario is an
instruction to fix it. A missing test is an instruction to add it. A dead control
is an instruction to remove or repair it.

**A reviewer may not end the task.** A reviewer saying "incorrect", "unsafe",
"high severity", or "retest required" has *created work*. Apply the correction and
invoke review again.

---

## 3. Reports are a consequence of completion

A final report may not contain an `OPEN`, `REMAINING`, `DEFERRED`, `FOLLOW-UP`,
`NEXT SESSION`, or `NOT VERIFIED` section for repository-local work that can still
be performed here.

If such an item would appear in the report: **do not write the report.** Assign the
work and continue.

The only unfinished items permitted in a final report are things this machine
physically cannot do. For each one:

1. complete every repository-local prerequisite;
2. automate everything automatable;
3. state the exact external validation step;
4. state why this environment cannot perform it.

Current genuinely-external items: macOS/Xcode for the Safari wrapper, the Android
SDK for an APK, assistive technology for real screen-reader validation, and a
human for subjective acceptance. These never justify leaving unrelated repository
work unfinished.

---

## 4. Specialist agents are mandatory

Before substantial work: inspect [`.claude/agents/`](.claude/agents/), build a
lane map, and launch every safe independent lane. Keep writer slots filled as
lanes finish. Run reviewers concurrently where technically safe.

**A coordinator manually performing parallelizable specialist work while an
applicable agent sits idle is a governance violation.**

Lanes are partitioned by **file ownership**, because parallel writers to one file
lose each other's edits. Give every agent an explicit owned-files list and an
explicit do-not-edit list.

| Agent | Owns |
| --- | --- |
| `curated-data-engineer` | `data/**` |
| `localization-engineer` | `extension/_locales/**`, locale tools |
| `ui-ux-engineer` | page markup and `<style>` blocks |
| `privacy-security-engineer` | `extension/fitshield-core.js`, `extension/background.js` |
| `build-infrastructure-engineer` | `build.js`, `tools/**`, `test/**` |
| `release-engineer` | `changelog/**`, version metadata, release docs |
| `qa-engineer` | adversarial verification; may add `test/**` |

---

## 5. Definition of done

A session ends only when all of the following hold:

- repository-local open findings: **0**
- automated tests: **0 failures**
- validators: **0 errors** (no validator loosened to achieve it)
- Chrome, Firefox and Safari-nightly packages build
- real-browser checks pass for both Chrome and Firefox
- no known data-loss path
- no dead customer-facing control
- no claim in the product or its docs that the code does not honour

A green suite is necessary, not sufficient. Reason about behaviour.

---

## 6. Working rules

- **Verify, don't trust.** Check claims against the code and the built packages,
  not against documentation or a previous report.
- **Fix root causes.** Do not delete or loosen a failing test to get green. If a
  test is genuinely wrong, explain precisely why before replacing it — and prefer
  rewriting it to assert *behaviour* over source-text greps, which pass while the
  behaviour underneath is broken.
- **No new dependencies.** This project ships with zero. Test harnesses included.
- **Permissions are exactly** `storage`, `declarativeNetRequest`, `alarms`. Never
  add one for convenience.
- **No telemetry, network calls, accounts, or cloud.** Local-first is the product.
- **Never silently reset user data.** Migrations are idempotent, versioned, and
  safe on missing or malformed input.
- **Scope discipline.** FitShield is a blocker and a decision-friction tool. It is
  not a fitness app, calorie tracker, meal planner, or social product.
