# Localization

FitShield ships in **83 locales**. English is the source of truth and is always
complete; the others may be partial.

## The policy, and why

A key a locale does not define **falls back to English at runtime**, in both
paths FitShield uses:

- `chrome.i18n.getMessage()` falls back to `default_locale` (`en`);
- `i18n.js`'s manual-override path falls back to its cached English map, then to
  the key itself.

So an untranslated string renders **in English**, not blank and not broken. That
is what makes a partial locale a safe state to ship.

The alternative — refusing to ship any new English string until it has been
translated into 82 languages — sounds stricter but is worse in practice. It
either blocks product work indefinitely or invites bulk machine translation,
which produces fluent, confident, wrong copy in languages nobody on the project
can review. A cooking instruction that has been mistranslated is not a cosmetic
bug; "cook until no pink remains" becoming its opposite is a food-safety problem.

So the rule is:

| Situation | Treated as |
| --- | --- |
| A locale is missing an English key | **Warning** — translation debt, measured and reported |
| A locale defines a key English does not have | **Error** — a dead string that can never be shown, usually a half-applied rename |
| A message is empty, or uses `$name$` syntax | **Error** — it will fail to load |
| A message's `$1..$9` set differs from English | **Error** — it will render with holes |
| A translation whose English source has since changed | **Error** — the fallback cannot reach it; see below |
| A locale entry byte-identical to an English sentence | **Error** — English filed as a translation |

Enforced by `tools/locale-parity.js` (`npm run validate:locales`) and
`test/locales.test.js`. `test/locales.test.js` also proves the English fallback
actually works, and that every string the block page and every `data-i18n`
attribute asks for exists in English.

### The other direction: a key the code asks for and no locale has

The table above is about locales disagreeing with English. The opposite gap is
worse and was invisible for longer: code that asks for a key **English does not
have**. `t()` returns the key when the message is missing — the right behaviour
for a label, where the gap is meant to be obvious, and the wrong one for a
sentence, because the user reads the identifier.

`backup.js` shipped that way. It goes to real trouble to give every import
failure an actionable reason — "that backup was written by a newer version of
FitShield (format 9)", "that file is empty", "that file isn't valid JSON" — under
seven keys that existed in no locale at all, English included. The settings page
rendered `backupErrorNewerFormat` at a user who had just tried to restore the
only copy of their settings. `settings.js` had three more
(`confirmImportBackup`, `importCancelledNotice`, `exportErrorNotice`) and carried
hand-written English fallbacks through its `tOr` helper to stay readable.

`test/locales.test.js` now scans every page script for keys named as string
literals — `t("…")`, `tOr("…", …)`, `backupError("…", …)`, and the `labelKey:`
style tables — and fails if any is missing from English. Ten keys were missing
when it was added. Keys the code *composes* (`catLabel${pascal}`, `diet_${…}`)
are template literals and out of scope there; `tools/locale-prune.js` exempts
them by prefix and re-verifies each construction site instead.

The `data-i18n` check enumerates `extension/*.html` rather than listing pages,
because a hardcoded list silently fails to cover a page added later.

### The one gap the fallback does not cover

"Untranslated is safe" holds only while the translation and the English say the
same thing. When an English string is **rewritten**, a locale that still carries
the old translation is in the one state nothing can repair: the key *is* defined,
so neither `chrome.i18n` nor `i18n.js` will reach for English, and the locale
goes on rendering a sentence the product retired.

That is not hypothetical. `learnMoreLink` moved from "Visit fitshield.net" to
"About FitShield" in the block-page rework, and all 82 other locales kept the old
English verbatim — so every non-English block page ended with an instruction the
English build no longer gave. Six more strings on the same page (`warningTitle`,
`warningIntro`, `warningEyebrow`, `warningContinueButton`, `warningLockedButton`,
`blockReasonHeading`) had the same break, translated faithfully into wording the
product had dropped. All 567 of those entries were deleted; the English fallback
now renders the current copy.

Two more English strings were rewritten in the same 0.55 pass, and their
translations went the same way — 164 entries across 82 locales, deleted so the
new English falls through:

- `statusShieldUp` said "Shield up. 5 seconds countdown, 15 minutes pass." Read
  aloud, "15 minutes pass" is a verb phrase, and "pass" was jargon the popup
  never defined — the same value is labelled "Site open time" on one control and
  "Temporary pass" on another. It now uses the wording `frictionSummary` already
  had: "Shield up. 5-second pause, then the site stays open for 15 minutes."
- `welcomeDeliveryBody` described delivery only ("Adds a pause screen on delivery
  platforms like DoorDash and Uber Eats"), while sitting under the onboarding
  question "What should FitShield interrupt?" whose answers include fast food. It
  now matches the fallback the HTML already carried.

Two guards keep it from recurring:

- `tools/locale-source-baseline.json` records a digest of the English text every
  surviving translation was cut against. Change an English string and its digest
  changes, and `npm run validate:locales` fails naming every locale that still
  translates the old wording. Re-translate it, or run
  `node tools/locale-prune.js --apply` to drop the stale translations and
  re-record the baseline. Never hand-edit the file to silence a failure.
- The retired wordings above are additionally **pinned by exact string** in
  `tools/locale-parity.js`, so deleting or editing the baseline cannot bring them
  back.

### Keeping the corpus honest

`node tools/locale-prune.js` reports, and `--apply` removes, every locale entry
that should not exist — in four families:

| Family | What it is |
| --- | --- |
| Unreferenced English key | English defines it; no source file asks for it |
| Orphaned translation | A locale defines it; English no longer does |
| Stale translation | Its English source has been rewritten since |
| Verbatim English copy | The English sentence, filed under another language |

The first two are unreachable, the last two are reachable but dishonest, and all
four are fixed the same way: delete the entry and let English fall back. That is
safe by construction — a removed entry renders exactly what it rendered before.

One trap worth knowing about, because it cost a release. The unreferenced-key
scan used to ask whether the source text *contained* the key name, so a key stayed
"live" whenever a longer key starting with it was still in use — which is precisely
what a rename leaves behind. `warningTriggeredBy` survived that way while the code
had already moved to `warningTriggeredByPrefix`: 82 translations of a sentence
nothing could render, and the live line reading "You opened DoorDash." in English
in every locale. The scan now matches whole keys, and `test/locales.test.js` pins
that exact collision.

### English is not a translation

A locale file that repeats the English sentence verbatim is not partially
translated — it is English filed under another language's key. It renders exactly
what the fallback would render, and it costs two real things: the coverage figure
counts it as done, and `--todo` never offers the string to a translator, because
as far as the corpus is concerned it already has one.

`appDescription` — the Chrome Web Store description, the first sentence a shopper
in that language reads — was English verbatim in 33 locales. 849 such entries
across 26 keys were removed. Nothing on screen changed; the numbers stopped
lying.

Only prose is treated this way. Names and loanwords are legitimately identical
across languages — Italian really does call it "Pizza", every locale calls the
product "FitShield" — so the rule requires two or more words *and* an English
function word before it fires.

## Current status

```bash
npm run locales:status              # coverage table + what to translate first
node tools/locale-status.js --locale de   # exactly what German is missing
```

**`npm run locales:status` is the authority for every number in this section.**
It reads the corpus; this paragraph is a transcription of what it printed, and a
transcription can go stale. If the two disagree, the tool is right — and the
number to quote anywhere else (a store listing, a release note, a README badge)
is the tool's, not this one's.

As of 0.55: **535 English keys across 83 locales**. No locale but English is
complete. The other 82 sit between **43% and 53%**, median 53%, averaging 274
translated and 261 untranslated each — 21,383 untranslated strings across the
corpus, every one of which renders in English.

Seven locales are lowest, at 43% — the six Cyrillic-script ones (be, bg, mk, ru,
sr, uk) and Greek (el) — because an earlier pass removed mangled
machine-translated strings from them. That is the gap working as intended: a
missing string reads in English, a mangled one reads as nonsense.

The percentages fell during 0.55 while the corpus got *more* honest, not less.
Three things moved the denominator and the numerator in opposite directions:
verbatim-English entries were deleted rather than counted as translations,
translations of rewritten English were deleted rather than left rendering retired
copy, and 29 English strings were added that no locale has yet — the ten backup
and import failure reasons above, and the nineteen the diagnostics page needs.
All 29 are **English-only by design**: every other locale falls back, and none
has been machine-translated to make the number look better.

Do not read "pre-0.55 strings are all translated" into that figure — an earlier
version of this document claimed exactly that, and it was false in the most
visible place in the product. Seven block-page strings that predate 0.55 were
translated into wording the product had since dropped, and `appDescription` was
English verbatim in 33 locales. Both classes are now removed and both are gated
(see above), so the coverage figure means what it says: a key counted as
translated has a translation of the current English text.

The report groups the gap by surface, because that is the order worth fixing it
in. The block page is the highest-value surface: it is the one a user sees at the
moment the product is actually doing its job.

## Translating

You do not need to diff two JSON files by hand.

```bash
node tools/locale-status.js --todo de       # writes translations/de.todo.json
```

That file lists only the missing strings, each with its English source, the
surface it appears on, and the placeholders it must keep:

```jsonc
{
  "locale": "de",
  "missing": 201,
  "strings": {
    "timerRemainingAnnounce": {
      "english": "$1 seconds left in the pause.",
      "translation": "",
      "surface": "block page",
      "placeholders": "$1"
    }
  }
}
```

Fill in `translation`. Leave any entry empty to skip it — it keeps falling back
to English, which is a supported state. Pasting the English sentence into the box
is not: it renders identically and then nobody is ever asked to translate it
again, so the merge rejects it. Then:

```bash
node tools/locale-status.js --merge de translations/de.todo.json
npm run validate:locales
npm run sync                    # refresh extension/'s committed copies
```

The merge **refuses** any string that drops or invents a `$1..$9` placeholder,
that uses Chrome's `$name$` syntax, or that hands the English sentence back
unchanged — and tells you which and why. It writes only the entries you filled
in, records the English each one was translated from (so a later English edit
raises the stale-translation error rather than passing silently), keeps English
key order so the diff is reviewable, and leaves everything else untouched.

`translations/` is git-ignored — worklists are scratch space, not source.

## Notes for translators

- **Placeholders are positional.** `$1`, `$2` … may appear in whatever order your
  language needs, but every one English uses must appear.
- **Space is tight on the block page.** Button labels sit next to each other on a
  phone-width screen; a label roughly the length of the English one will fit.
- **Nothing should shame the reader.** FitShield's copy never blames, ranks, or
  judges. If a natural translation lands harsher than the English, prefer the
  gentler wording. A test fails the build if shaming vocabulary appears in
  English; please hold the same line in your language.
- **Leaving a string out is a real answer.** An empty entry renders in English,
  which is correct and expected. Copying the English in is not the same thing: it
  looks translated to every tool that counts, so the string disappears from the
  work queue forever.
- **Cooking instructions are not in `_locales`.** The alternatives catalog
  (`data/recipes.json`) is English-only for now — see below.

## Known limitation: the catalog is English-only

Recipe titles, ingredients, and steps are not localized. The schema has no
translation fields and the matcher does not look for any.

This is deliberate for 0.55 rather than an oversight. Machine-translated cooking
instructions are genuinely unsafe — temperatures, doneness cues, and food-safety
wording are exactly the sentences that must not drift. Localizing the catalog
properly means per-locale review by someone who cooks, and probably per-region
entries rather than translations of the same 81 dishes, since the "fastest thing
you can make instead" is not the same food everywhere.

The UI around a recipe **is** localized, so the labels, filters, times, and diet
badges read in the user's language even while the recipe body is English.
