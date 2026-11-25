# AGENTS.md

Pointer for coding agents other than Claude Code (Codex, Cursor, Copilot and so on).

- The rules are in [`CLAUDE.md`](CLAUDE.md) (machine-readable: `development-policy.json`). Read it before editing. Where files disagree, it wins.
- Agent roles and file ownership are in [`.claude/agents/`](.claude/agents/). Stay inside the files your role owns.
- Orientation: `CLAUDE.md` "Start here", then `docs/README.md`.

## The six rules that matter most

1. A finding is work. Fix it, test it, close it; severity never lets you stop. "Probably fixed" counts as open until reproduced.
2. No terminal verdicts (NOT READY, SHIP, FAIL and the like) and no open/deferred/follow-up section for work you can still do here.
3. Never run `git reset --hard`, `git checkout -- .`, `git clean`, `git stash` or `git restore`: they destroy other agents' concurrent work.
4. No new dependencies, network calls or telemetry. Permissions are exactly `storage`, `declarativeNetRequest`, `alarms`. Never silently reset user data.
5. Do not loosen a test or validator to get green; fix the root cause. FitShield 1.0 is in maintenance mode: fixes and policy compliance only.
6. Done means `CLAUDE.md` section 5: 0 test failures, 0 validator errors, Chrome and Firefox packages build and pass the real-browser checks (`npm run validate:a11y`, `npm run validate:firefox`), no dead control, no claim the code does not honour. Only things this machine physically cannot do (on-device Android, a person with a screen reader, human acceptance) may be left, per `CLAUDE.md` section 3.

## Verify before finishing

```bash
npm test            # node --test, 0 failures
npm run validate    # all audits, 0 errors
npm run build       # Chrome and Firefox packages
npm run validate:a11y     # computed accessibility tree, real Chromium
npm run validate:firefox  # real Firefox blocks a site (skips with a warning if no browser)
```
