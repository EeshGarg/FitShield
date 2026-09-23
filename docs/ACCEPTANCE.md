# Human acceptance

Everything a machine can settle about this build is settled: `npm test` green,
`npm run validate` reporting 18 audits at zero errors, the computed accessibility
tree checked in a real browser, and the Chrome, Firefox and Android packages all
building. (The commands are named rather than a run frozen into a count — a
stale number invites a reader to trust it instead of running the command beside
it.) None of that answers the one question that matters most.

**Does the friction feel fair, or does it feel manipulative?**

That is a judgement, and it is yours. This document exists to make it a short
judgement rather than an afternoon: everything around it that is not judgement
has been removed.

---

## Before you start

```
node build.js
node tools/capture-surfaces.js
```

That writes 20 screenshots to `dist/acceptance/` — every surface, in both
palettes, at the sizes where layouts break. Reviewing them is faster than
installing a build and clicking through twice, and it is the same pixels.

Load the real extension too, from `dist/chrome`, for the parts below that are
about *timing* rather than appearance. Screenshots cannot show you what sixty
seconds feels like.

---

## The four judgements

Everything else has an automated answer. These do not.

### 1. Is the pause the right length?

The default is a 60-second countdown before **Continue** unlocks.

Open a blocked site and sit through it once, actually waiting. Then ask:

- Long enough that the impulse has a chance to pass?
- Short enough that it reads as friction rather than punishment?
- Did you feel *helped*, or did you feel *handled*?

The number is a setting; the question is whether the default is defensible for
someone who has not chosen it yet.

### 2. Does the block page respect the user's decision?

The page offers an alternative, then lets the person continue anyway.

- Does "Continue anyway" feel like a real door, or a discouraged one?
- Does anything on the page shame the person for being there?
- Is "Go back" the visually dominant button? Should it be?
- If you genuinely needed to order — a real delivery, someone else's meal — does
  the page let you, without making you feel you failed?

A blocker that makes the honest answer feel shameful has stopped being a tool.

### 3. Is the recipe suggestion credible?

The block page answers a craving with something you could make instead.

Open five different brands — a pizza chain, a coffee shop, a fried-chicken
chain, a grocery delivery service, a bubble-tea shop — and read what comes back.

- Is it plausibly something a hungry person would actually make?
- Does the time estimate look honest?
- Is it obviously a *substitute* for what was wanted, or a non-sequitur?

An incredible suggestion is worse than none: it tells the user the product does
not understand them.

### 4. Do the statistics feel honest?

Settings shows interruptions, continues, and a savings estimate.

- Does any number feel inflated, or like it is being used to flatter you?
- Is the money estimate presented as an estimate?
- Would you be comfortable if a skeptical friend read this panel over your
  shoulder?

---

## What you are NOT being asked to check

These are already verified, and re-checking them by hand is wasted effort:

| Already settled | How |
| --- | --- |
| Every control has an accessible name and correct role | `npm run validate:a11y` — computed accessibility tree, real browser |
| Keyboard focus is visible and trapped correctly in dialogs | `test/accessibility.test.js`, `test/ui-hardening.test.js` |
| Contrast ratios in both palettes | `test/accessibility.test.js`, measured |
| Zero network requests | measured in a real browser across a full session |
| Blocking survives corrupt storage | 22 corrupt profiles, each keeping its rules |
| Backup import rejects hostile files | 16-case fuzz |
| Countries, categories and brand names are correct | `npm run validate` |
| Nothing is announced every second to a screen reader | the countdown announces at milestones only |

---

## The one thing still genuinely open

**Screen-reader announcement quality.** The accessibility *tree* is verified —
every control has a name, a role, and exposed state, and no heading level is
skipped. What a machine cannot judge is whether hearing it is *useful*: whether
the block page announces things in an order that makes sense, whether the
countdown milestones land at helpful moments, whether the reason panel reads
coherently rather than as a list of fragments.

If you have VoiceOver, NVDA or Narrator available, the block page is the surface
worth ten minutes. Everything else is secondary.

---

## Recording the outcome

There is no sign-off form. If something in the four judgements is wrong, it is a
finding, and a finding is work — file it and it gets fixed, exactly like any
other. If nothing is wrong, say so and the build is done.
