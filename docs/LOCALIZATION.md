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

Enforced by `tools/locale-parity.js` (`npm run validate:locales`) and
`test/locales.test.js`. `test/locales.test.js` also proves the English fallback
actually works, and that every string the block page and every `data-i18n`
attribute asks for exists in English.

## Current status

```bash
npm run locales:status              # coverage table + what to translate first
node tools/locale-status.js --locale de   # exactly what German is missing
```

As of 0.55: **536 English keys**, 82 other locales at **63%**. The 201
untranslated keys are the strings added by the decision-flow work — the block
page's new controls, the settings surfaces, onboarding, and the recap. Everything
that existed before 0.55 is fully translated everywhere.

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
to English. Then:

```bash
node tools/locale-status.js --merge de translations/de.todo.json
npm run validate:locales
npm run sync                    # refresh extension/'s committed copies
```

The merge **refuses** any string that drops or invents a `$1..$9` placeholder, or
that uses Chrome's `$name$` syntax, and tells you which and why. It writes only
the entries you filled in, keeps English key order so the diff is reviewable, and
leaves everything else untouched.

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
