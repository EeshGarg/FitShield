# Localization

FitShield ships in **83 locales**. English is the source of truth and is always
complete; the others may be partial.

## The canonical vocabulary

English is the source of truth for *wording*, not only for strings. One concept
gets one name, and a synonym is a defect even when every individual sentence
reads well — because a buyer reads two screens at once, and two words for one
thing is what makes a product look assembled by different people.

Enforced by `test/locales.test.js`. Every row below is a test, and each one was
written against a real drift found in the shipped corpus.

| Concept | Say | Never say |
| --- | --- | --- |
| The product, in any status sentence | **FitShield** ("FitShield is on/off…") | "the blocker", "Blocker is on", "Blocker is armed", "Shield up" |
| The countdown on the block page before Continue unlocks | **pause** | "timer", "delay", "cooldown" |
| Going to a blocked site anyway, for a set time | **temporary pass** (short: **pass**) | "bypass", "exception", "unlock", "temporary access", "allowlist" |
| How long that lasts | **how long the site stays open** / "Site open time" | "pass length", "grace period" |
| Switching blocking off everywhere for a while | **turn off all blocking** | "pause everything", "snooze", "disable FitShield" |
| Whether a country or category is blocked | **Blocking** / **Not blocking** | "On"/"Off", "Block", "Paused" |
| An ordering page being replaced by the block page | **interrupted** | "blocked" (in stats copy), "stopped" |
| The rolling seven-day stats window | **Last 7 days** | "This week", "the last seven days", "weekly" |
| The curated site lists | **blocklist** (one word) | "block list", "blacklist" |
| Spelling | **American** (favorite, summarize, canceled) | British (-our, -ise, -lled) |
| Headings, buttons, page and tab titles | **Sentence case** | Title Case |
| Category, language and weekday labels | **Title Case** — they are names, not headings | — |

### "Pause" is the countdown, and only the countdown

It used to mean three things at once, two of them reachable from the same
screen: the block-page countdown, switching *all* blocking off ("Pause
everything for 30 minutes"), and un-blocking *one* country ("Blocking — click to
pause"). The test allowlists the eleven keys that describe the countdown; any
other English string containing "pause" fails.

### The statistic verbs

Each event has exactly one verb, and they may not borrow each other's:

| Event | Verb | Keys |
| --- | --- | --- |
| An ordering page was replaced by the block page | **interrupted** | `recapInterrupted` |
| The user went back | **left** | `recapLeft` |
| The user went on to the site | **continued** | `recapContinued` |
| An alternative was displayed | **shown** | `recapViewed` |
| The user picked an alternative | **selected** / chose | `recapSelected`, `alternativeChooseButton`, `alternativeChosenButton` |
| The user confirmed afterwards that they cooked it | **made** | `recapMade`, `popupMarkMade*`, `estimateBasis*` |

`made` is load-bearing: it is the only event in the whole vocabulary the user
personally confirmed, and the optional savings estimate is built on it alone. So
the button that merely *selects* an alternative may not use that verb. It read
"I'll make this", which put the confirmed-event word on an unconfirmed action one
screen before the confirmation was even asked for. It now reads "Choose this".

### Case is a house style, not a meaning

Restyling English capitalisation does **not** invalidate a translation: every
language capitalises by its own rules regardless of ours. `tools/locale-prune.js`
digests case-insensitively for exactly that reason — the one pass that moved
eighteen headings and buttons to sentence case would otherwise have deleted
roughly 1,400 genuine translations to record a change of capital letter. Nothing
looser than case is forgiven; a single changed word still raises the
stale-translation error.

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
| A locale is missing an English key | **Note** — translation debt, measured and reported |
| A locale defines a key English does not have | **Error** — a dead string that can never be shown, usually a half-applied rename |
| A message is empty, or uses `$name$` syntax | **Error** — it will fail to load |
| A message's `$1..$9` set differs from English | **Error** — it will render with holes |
| A translation whose English source has since changed | **Error** — the fallback cannot reach it; see below |
| A locale entry byte-identical to an English sentence | **Error** — English filed as a translation |
| A pure-Latin English value in a non-Latin-script locale | **Error** — English filed as a translation, in a form the rule above cannot see |
| A stray `\|` in any message | **Error** — no English message has one; it is machine-translation residue |
| Latin letters welded onto a word in a spaced non-Latin script | **Error** — "блокироватьing" is gibberish in the reader's own script |

### Why missing keys are a note and not a warning

Every other row is a fault. A missing key is the **designed** behaviour: both
runtime paths fall back to English, a test proves the fallback works, and this
document commits to partial locales on purpose.

Reporting it per locale produced 82 warnings that never went down and never
could, because the condition they described is the policy. Eighty-two standing
warnings for an accepted condition is how the one warning that matters gets
scrolled past — so the coverage figure moved to the notes, where measurements
belong, and the defect channel was left for defects.

Nothing stopped being checked. The debt is still computed, still printed with its
full range and its lowest locales, and `npm run locales:status` still breaks it
down per locale and per surface. The same pass that moved it *added* three error
classes to the channel it vacated, and those three found 978 real defects that
the 82 warnings had been loud enough to hide.

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

### The third gap: markup that quotes English it no longer says

`data-i18n` makes an element's inline text a **fallback**, not decoration. It is
what the page paints before `i18n.js` runs, what anyone reading the markup
believes the product says, and what a reader sees if the locale layer ever fails
to start. When English moves and the markup does not, the two disagree — and
every check above still passes, because the *key* resolves perfectly.

`npm run validate:locales` now compares them and reports each mismatch with its
file, line, and both texts. It is a **warning**, for the same reason untranslated
keys are: nothing is broken on screen, and the fix belongs to whoever owns the
markup, not to whoever owns the strings. Four of these predated the terminology
pass — `warning.html` was still quoting an earlier draft of `warningIntro`, and
Settings' export and import buttons were two releases behind their own labels.

### A key written ahead of the code that renders it

Locale files and page scripts have different owners, and a string cannot land in
both at once: whoever edits `diagnostics.js` cannot add the message it needs, and
whoever writes the message cannot wire it up. With no way to say so the two
halves deadlock — which is how sixteen customer-visible diagnostics sentences
stayed hardcoded in English inside `diagnostics.js`, where no locale could ever
reach them, including the one that told a Chrome Web Store customer to run
`node build.js`.

So an English entry may name its consumer in its own `description`:

```jsonc
"diagWorkerDown": {
  "message": "FitShield's background service is not responding, so nothing is being blocked.",
  "description": "Banner shown when the diagnostics page gets no answer. [staged: diagnostics.js]"
}
```

The marker means one thing: **this key has no reader yet, and the file named is
the one that must grow one.** It excuses the unreferenced-key scan and nothing
else — the key is still parity-checked, still placeholder-checked, and still
offered to translators, so staging cannot be used to smuggle a string past
review. Three things keep it honest:

- `npm run validate:locales` warns for every staged key on every run, so an
  unfulfilled handoff is stated rather than remembered;
- a marker naming a file that does not exist is an **error**, not an exemption;
- once the named file does reference the key, the audit says so and asks for the
  note to be deleted, so the marker cannot outlive the work it described.

A staged key is a promise, not a parking space. If the code change is not coming,
delete the string.

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
  translates the old wording. (Capitalisation is the one exception, and it is
  deliberate — see "Case is a house style, not a meaning" above.)
  Re-translate it, or run
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

After the honesty pass: **579 English keys across 83 locales**. No locale but
English is complete. The other 82 sit between **30% and 51%**, median 39%,
averaging 240 translated and 338 untranslated each — 27,678 untranslated strings
across the corpus, every one of which renders in English. **281** of the English
keys are translated in no locale at all: those are the strings added since the
last translation pass, and they are the actionable half of the debt.

Seven locales are lowest, at 30% — the six Cyrillic-script ones (be, bg, mk, ru,
sr, uk) and Greek (el) — because successive passes removed mangled
machine-translated strings from them. That is the gap working as intended: a
missing string reads in English, a mangled one reads as nonsense.

The percentages have fallen several times now while the corpus got *more* honest,
not less. Everything that moved the numerator down removed something that was
never a translation:

- verbatim-English entries, deleted rather than counted as translated;
- translations of rewritten English, deleted rather than left rendering retired
  copy;
- **761 English strings stranded in non-Latin-script locales** — "Bakery",
  "Grocery" and "Restaurant" sitting in Cyrillic and Devanagari lists, and
  `ug.clearButton` rendering the word "Clear" in a page of Uyghur. Now translated
  or deleted, and gated by `englishInNonLatinScript()`;
- **3,545 language names that were the endonym already printed beside them.** The
  picker renders `label · native`, so `ru.languageHebrew` = "עברית" produced
  "עברית · עברית". Deleting them renders "Hebrew · עברית" instead: informative
  rather than doubled, and honestly marked as untranslated. A language naming
  *itself* is correct and was kept;
- **174 stray pipes in Odia**, 154 of them a leading `" |"` and newline, so every
  label rendered with a vertical bar and a line break in front of it;
- **43 words welding an English suffix onto a translated stem** —
  "блокироватьing", "Customize Блокироватьlist" — and 52 Latin-script locales
  reading "Blocca by paese" where the preposition was never translated.

And English strings were added that no locale has yet — the backup and import
failure reasons, the diagnostics page, and the strings the terminology pass
introduced. Every one of them is **English-only by design**: the rest fall back,
and none has been machine translated to make the number look better.

The terminology pass itself cost 817 translations across eleven keys, deleted
rather than left rendering a synonym the product had dropped — "On"/"Off" for a
control whose sibling now says "Blocking"/"Not blocking", "Blocker is armed" for
a product that calls itself FitShield. Those eleven keys are the honest cost of
picking one word per concept; they are back in every translator worklist. The
same pass restyled eighteen headings and buttons to sentence case and cost
**nothing**, because case is not meaning (see above).

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
