# Archived documents

_At a glance: four working documents from earlier releases, kept because they
explain decisions the code cannot. **They are historical and not maintained.**
Do not read any of them as a statement of what FitShield does today; for that use
the [README](../../README.md), the [changelog](../../changelog/README.md) and the
docs in [`docs/`](..). Maintenance guidance is in [MAINTAINING.md](../MAINTAINING.md)._

Dates are from `git log --follow`: the date each file first appeared and the date
of its last content edit. All four were moved into this folder in the 1.0
documentation overhaul (2026-11-25); the two that were also edited that day only
got a 1.0 note or a link fix.

| Document | First / last edited | Still accurate? |
| --- | --- | --- |
| [PRODUCT_AUDIT.md](PRODUCT_AUDIT.md) | 2026-07-31 / 2026-09-23 | No, by design: pre-0.55 snapshot |
| [FIX_VERIFICATION.md](FIX_VERIFICATION.md) | 2026-07-09 / 2026-09-23 | Partly: loading and building steps still work, details are from an early release |
| [SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md](SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md) | 2026-08-08 / 2026-11-25 | Mostly: checked by tests, but it predates 1.0 for Android |
| [DEVICE_DEBUG_HANDOFF.md](DEVICE_DEBUG_HANDOFF.md) | 2026-08-26 / 2026-11-25 (1.0 banner) | Mostly no: about the VPN that 1.0 removed |

## PRODUCT_AUDIT.md

- **Written:** July 2026, before the 0.55 work, from a read of the repository at
  one commit.
- **Why:** to record what the product did, where it was inconsistent, and the
  order 0.55 would fix it in.
- **Covered:** architecture, user flow, storage keys, the recipe and schedule
  schemas, statistics and temporary-pass semantics, known inconsistencies,
  risks, planned migrations and tests, implementation order and the
  localization decision.
- **Accuracy:** deliberately in the present tense of *before 0.55*. It describes
  things that no longer exist (a three-column recipe board, "calories avoided",
  a single schedule pair). It says so in its own banner. Its value is the
  reasoning, not the facts.

## FIX_VERIFICATION.md

- **Written:** July 2026, in the Chrome/Firefox era.
- **Why:** a checklist proving the block screen works in an unpacked install and in
  a production build.
- **Covered:** loading `extension/` unpacked or `dist/chrome`, building with
  `node build.js`, automated proof, a manual browser test, the diagnostics page
  and Firefox parity.
- **Accuracy:** the unpacked-load and build instructions still describe the
  flow, but file layout and package names have moved on. Current build facts are
  in [MAINTAINING.md](../MAINTAINING.md).

## SKEPTICAL_BUYER_ACCEPTANCE_REPORT.md

- **Written:** August 2026, as the closing report of a verification pass.
- **Why:** to show, with evidence, that the then-open findings queue was empty and
  how each gate was checked, and to name the judgements only a person can make
  (see [ACCEPTANCE.md](../ACCEPTANCE.md)).
- **Covered:** completion status, what the product was as measured, the defects
  that mattered, what the author got wrong, judgement calls, the four formerly
  "impossible" items and what was still external.
- **Accuracy:** it is still read by `test/docs-claims.test.js`,
  `test/governance.test.js` and `tools/policy-audit.js`, so its brand, recipe and
  permission claims are kept in sync with the code. It does not describe the
  Android 1.0 change (no website blocking). Its verdict language predates the
  rule in `CLAUDE.md` that reports are not terminal verdicts. Do not move or
  rename it without updating those three readers.

## DEVICE_DEBUG_HANDOFF.md

- **Written:** August 2026, after the first run on a real phone (0.56).
- **Why:** hand a debugging session's findings and prompt to the next session.
- **Covered:** seven device-only defects and their fixes, the launcher icon,
  notification permission, app blocking and accessibility disclosure, pause
  screen, statistics, battery.
- **Accuracy:** most of it is about the connection filter (`VpnService`,
  `Tun2Filter`), IPv6 and Private DNS, which Google Play rejected and 1.0
  removed. Its own banner marks sections 3.1, 3.5, 3.6, 3.7, 3.8 and 3.9 as still
  current and 3.2 to 3.4 as history. The 1.0 story is in
  [changelog/1.0.md](../../changelog/1.0.md).

## Link policy

Relative links inside these files were corrected when they moved (the targets,
nothing else). The text itself is left as written.
