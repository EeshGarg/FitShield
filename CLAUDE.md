# FitShield — development governance

Authoritative rules for any automated or assisted development session in this
repository. Where any other file disagrees with this one, this file wins.

Machine-readable form: [`development-policy.json`](development-policy.json).
Enforced by `tools/policy-audit.js`, which runs inside `npm run validate` and
`npm test`. If you change a rule here, change it there too — a test fails
otherwise.

---

## Start here (for agents)

FitShield blocks fast-food and delivery sites and apps (browser extension plus
Android app). Local-first, zero dependencies, three permissions.

Repo map:

- `extension/` — the shipped MV3 extension; `fitshield-core.js` engine, `background.js` worker, pages, `_locales/` (83)
- `FS Engine/` — canonical engine source; `npm run sync` copies it and `data/` into `extension/`
- `data/` — curated brand blocklists, recipes, Android package maps
- `android/` — Kotlin app (`app/src/main/java`), WebView UI in `assets/web/`: hand-written `index.html`/`app.js`/`fitshield.css` (plus `block.*`, `theme.js`), the rest copied by `tools/lib/android-web.js`
- `tools/` — validators and generators (`tools/README.md`); `build.js` packages Chrome and Firefox
- `test/` — `node --test` suite; `changelog/` — release notes; `.claude/agents/` — lane definitions

Commands: `npm test` · `npm run validate` · `npm run build` · `npm run sync` ·
`npm run build:android`.

Docs: [`docs/README.md`](docs/README.md) is the index. Then
[`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md),
[`ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/MAINTAINING.md`](docs/MAINTAINING.md)
and [`docs/GLOSSARY.md`](docs/GLOSSARY.md).

Scope: FitShield 1.0 is the final feature release. This is maintenance mode —
fixes and policy compliance only, no new features. The lane map in §4 says who
owns which files; agent definitions are in [`.claude/agents/`](.claude/agents/).

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

Current genuinely-external items are **hardware and people**, not tooling. Two
things that used to sit on this list were never impossible — they were
unattempted, and calling them external was this same failure wearing a different
costume:

- the Android APK builds here (`npm run toolchain:android`) and in CI;
- the computed accessibility tree is verified in a real browser
  (`npm run validate:a11y`), which is most of what "screen-reader validation"
  was standing in for.

What is left: a physical Android device to check the accessibility app-block flow on-device, a person
listening with a screen reader to judge whether the announcements are *useful*
rather than merely present, and a person answering the four questions in
`docs/ACCEPTANCE.md`.

Before writing any item down as external, try it. These never justify leaving
unrelated repository work unfinished.

FitShield 1.0 is the final feature release; afterwards the project is in
maintenance mode (fixes and policy compliance only, no new features).

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
| `privacy-security-engineer` | `extension/fitshield-core.js`, `extension/background.js`, Android Kotlin `android/app/src/main/java/**`, `AndroidManifest.xml`, Gradle files |
| `build-infrastructure-engineer` | `build.js`, `tools/**`, `test/**`; runs generators for synced and generated copies (`extension/blocklists`, `extension/data`, and the copied files in `android/app/src/main/assets/web/`) |
| `release-engineer` | `changelog/**`, version metadata, release docs |
| `qa-engineer` | adversarial verification; may add `test/**` |

Android is assigned as follows: native code and manifest to
`privacy-security-engineer`; the web layer source `android/web-src/**` to
`ui-ux-engineer`, together with the hand-written WebView files in
`android/app/src/main/assets/web/` (`index.html`, `app.js`, `fitshield.css`, `block.html`, `block.js`, `theme.js`). The rest of that folder
(`android-shim.js`, `i18n.js`, `languages.js`, `ambient.js`, `recipes.js`, `icon-128.png`, `data/recipes.json` and `_locales/`) is copied from `extension/`, `data/` and `android/web-src/` by
`tools/lib/android-web.js` during `npm run build:android`; never hand-edit it,
because `npm run validate:android` fails on drift. Full per-lane owned and
do-not-edit lists are in each file under [`.claude/agents/`](.claude/agents/).

### Never run a destructive or repository-wide git command in a lane

`git reset --hard`, `git checkout -- .`, `git clean`, `git stash`, and `git restore` are
**repository-wide**. A lane that runs one does not roll back its own work — it
rolls back every other lane writing concurrently, silently, with no error.

This happened. One lane reset the tree and stashed it; another lane's completed
locale work vanished from disk mid-session. It survived only because the stash
was popped and that lane noticed and re-verified. Nothing warned anyone.

A lane may only:

- write the files it owns;
- `git add` / `git commit` those exact paths;
- read anything.

To undo its own change a lane rewrites the file. If a lane believes the tree is
broken it reports that to the coordinator rather than repairing it — the
coordinator is the only role that can see every lane.


---

## 5. Definition of done

A session ends only when all of the following hold:

- repository-local open findings: **0**
- automated tests: **0 failures**
- validators: **0 errors** (no validator loosened to achieve it)
- Chrome and Firefox packages build
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
