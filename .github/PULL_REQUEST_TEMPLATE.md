<!-- FitShield 1.0 is in maintenance mode. See CLAUDE.md sections 5 and 6. -->

## What and why

<!-- One or two sentences, and link the issue. -->

## Scope

- [ ] This is maintenance-eligible: a critical defect, security issue, compatibility update, publication blocker, or data correction. It is not a new feature.

## Checklist

- [ ] `npm test` passes
- [ ] `npm run validate` passes (no validator loosened to get there)
- [ ] No new dependencies (runtime, build, or test)
- [ ] Permissions unchanged: `storage`, `declarativeNetRequest`, `alarms`
- [ ] No network calls, telemetry, accounts, or cloud
- [ ] Any migration is idempotent, versioned, and does not reset user data on missing or malformed input
- [ ] Docs updated, and no doc or product text claims something the code does not do
- [ ] Changelog entry added if the change is user-visible
- [ ] No failing test was deleted or loosened; a changed test asserts behaviour
