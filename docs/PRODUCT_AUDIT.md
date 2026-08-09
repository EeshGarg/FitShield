# FitShield product-depth audit & implementation plan

Internal working document. Written before implementation, from a full read of the
repository at `b0ef409` (branch `harden/block-page-engine-boundary`). It records
what exists today, what is inconsistent, and the order the work will be done in.

Status legend: **[has]** already true · **[gap]** missing/needs work · **[risk]**
can break existing users.

---

## 1. Current architecture

Four compartments plus a recombining build (documented in `ARCHITECTURE.md`,
verified accurate):

```
FS Engine/   blocking engine, CommonJS, code only, zero data, zero deps
data/        canonical datasets (blocklists/, recipes.json, android/, generated/)
extension/   Chrome/Firefox shell (manifest, pages, shims, _locales, icons)
android/     native app reusing the engine's generated rules + shared web assets
build.js     FS Engine + data + extension  ->  dist/{chrome,firefox,apple} + zips
```

Hard contracts discovered (must not be broken silently):

| Contract | Enforced by |
| --- | --- |
| `background.js` may `importScripts` **only** `blocklist.js` and `fitshield-core.js` | `tools/service-worker-audit.js` |
| Firefox manifest `background.scripts` is exactly `build.BACKGROUND_SCRIPTS`, with `background.js` last | `tools/extension-audit.js` |
| Every `.js`/`.html` in `extension/` is staged by `build.js` (no orphans) | `tools/extension-audit.js` |
| No inline `<script>` on any page (MV3 CSP) | `tools/extension-audit.js` |
| Packaged block-page dependency graph is closed | `build.js verifyStage`, `test/block-page.test.js` |
| `extension/{blocklist.js,blocklists/,data/,changelog.json}` byte-match canonical | `tools/sync-audit.js`, `test/extension-synced.test.js` |
| `package.json` == `manifest.json` == `changelog.json[0]` version | `tools/extension-audit.js` |
| All 83 locales have the **exact** English key set | `tools/locale-parity.js`, `test/locales.test.js` |
| Permissions are exactly `storage`, `declarativeNetRequest`, `alarms` | `tools/extension-audit.js` |

Baseline before any change: `npm test` = 98 pass / 0 fail; `npm run validate` = 0
errors.

## 2. Current user flow

1. DNR redirect rule (built in `background.js` from engine entries + settings)
   sends `main_frame` requests for a blocked apex/alias to
   `warning.html?site=<key>&timer=<s>&pass=<m>`.
2. `warning.js` renders a 3-column board: block card, one vegetarian recipe, one
   meat recipe. A countdown (default 60 s) locks **Continue**.
3. Recipe columns each carry an "I'll make this instead" button that immediately
   records `caloriesAvoided` and `recipesChosen`.
4. **Continue** calls `startTemporaryBypass` -> a per-site-key expiry in
   `siteBypasses`, then navigates to the brand home page.
5. Popup: master toggle, three bucket toggles, timer slider, pass slider, one
   schedule window. Settings: everything else + stats + backup + reset.

**[gap]** The block page answers "you were interrupted" well and "what now?"
badly. Two fixed recipes, no way to ask for another, no filters, no notion of
effort/time/pantry, and the only two verbs are *Go back* and *Continue*.

## 3. Relevant storage keys (all `chrome.storage.local`, no `sync`)

| Key | Shape | Written by |
| --- | --- | --- |
| `enabled` | bool | popup, background |
| `timerSeconds` | int >= 10 | popup, settings |
| `passDurationMinutes` | int >= 1 | popup, settings |
| `scheduleEnabled` / `scheduleStart` / `scheduleEnd` | bool / "HH:MM" / "HH:MM" | popup, settings |
| `deliverySitesEnabled` / `fastFoodSitesEnabled` / `customSitesEnabled` | bool | popup, settings, welcome |
| `disabledDeliverySiteKeys` / `disabledFastFoodSiteKeys` | string[] (site keys) | settings |
| `customSites` | `{domain,enabled}[]` (legacy: `string[]`) | settings |
| `siteBypasses` | `{ [siteKey]: epochMs }` | background |
| `enabledCountries` / `enabledCategories` | string[] | settings |
| `quickAccessCountries` / `quickAccessCategories` | string[] | settings |
| `blockedVisits` | int | background |
| `caloriesAvoided` / `recipesChosen` | int | background |
| `blockedByDomain` / `blockedByCategory` / `blockedByCountry` | `{ [k]: int }` | background |
| `avgMealCost` / `avgMealCalories` / `mealStatsCustomized` / `currency` | number/bool/string | settings |
| `theme` / `themeMode` / `cardOrder` | object / string / string[] | settings |
| `uiLanguage` | locale code | i18n |
| `lastSeenVersion` | string | background, whats-new |
| `recipeFavorites` | **dead key** — listed in `PREFERENCE_KEYS` reset list only | nothing |

**[gap]** There is **no schema version key at all**. Every consumer defends with
`??` defaults. That has worked, but it makes any structural change unsafe.

## 4. Current recipe schema (`data/recipes.json`, `_version: "1.0"`)

```jsonc
{ "id", "title", "description", "timeMinutes", "calories",
  "ingredients": ["free text"], "steps": ["free text"],
  "tags": ["taco","mexican",...], "diet": "vegetarian" | "meat" }
```

24 recipes. Selection (`extension/recipes.js`) = filter by `diet`, then 4 tiers
(specialty/category tag hit -> broad `delivery`/`fast_food` -> `fallback` tag ->
anything), then a deterministic hash of the site key picks one.

Concrete defects found by reading all 24 entries:

* **[gap]** No quantities anywhere. "canned black beans", "cumin", "salt and
  pepper". Not executable by someone who has not cooked the dish.
* **[gap]** No servings, no active-vs-total time, no equipment, no temperatures.
  `naan-veggie-pizza` says "Bake or toaster-oven until melty" — no temperature,
  no duration. `baked-chicken-tenders` says "Bake until golden and cooked
  through" — no temperature, no internal temp, no time. This is a food-safety
  gap on a chicken recipe.
* **[gap]** `diet` is a two-value enum (`vegetarian` | `meat`). `black-bean-burger`
  and `chickpea-burger` contain egg/yogurt but are indistinguishable from vegan
  entries; nothing models vegan, no allergens at all.
* **[bug]** `crispy-chickpea-bowl` is tagged `"chicken"`. It is a chickpea
  recipe. It is returned as the *vegetarian* answer to fried-chicken domains
  purely because the tag string collides. This is exactly the "chickpea
  categorized as chicken" defect named in the brief.
* **[bug]** `turkey-taco-bowl` and `turkey-burger` are tagged `"chicken"`; they
  contain turkey, not chicken.
* **[bug]** `protein-smoothie` is tagged `coffee`, `cafe`, `tea`, `drinks` — a
  smoothie is returned as the answer to a coffee-shop block. Named in the brief.
* **[gap]** Coverage is thin and US-centric: no pizza-from-scratch alternative,
  no fried-chicken substitute other than one baked tender, no dessert, no ice
  cream, no bakery, no late-night/convenience, no Indian, no East/Southeast
  Asian, no Middle Eastern, no microwave-only, no no-cook category, no frozen
  shortcut. 24 entries across ~7 cravings.
* **[gap]** `calories` is a single integer presented as fact and is the *engine
  of the primary stat*.

## 5. Current schedule schema

`scheduleEnabled` + `scheduleStart` + `scheduleEnd` as `"HH:MM"`. `isScheduleActive`
handles the overnight wrap (`start > end`) correctly and treats `start === end`
as always-on. `getNextScheduleBoundary` schedules one alarm at the next start or
end, whichever is sooner.

**[gap]** One window, same every day. No weekday differences, no presets, no
"until tomorrow", no temporary schedule override.
**[risk]** DST: boundaries are computed as wall-clock `setHours` on the local
date, which is the correct behavior, but the alarm is re-armed only at a
boundary, so a DST shift can leave the alarm up to an hour off until the next
boundary fires. Blocking state itself is re-evaluated from wall clock on every
refresh, so the *decision* is always correct; only the wake-up is imprecise.

## 6. Current statistics semantics

| Stored | Presented as | Honest? |
| --- | --- | --- |
| `blockedVisits` | "Blocked visits" + `x avgMealCost` = "Estimated savings" | **No.** A block is not a prevented order, and money is not saved by seeing a page. |
| `caloriesAvoided` | "Calories avoided" | **No.** Incremented the moment a recipe *card button* is pressed, using `avgMealCalories - recipe.calories`. Nothing was cooked, nothing was eaten, and the recipe calorie figure is invented. |
| `recipesChosen` | not surfaced | neutral |
| `blockedByDomain/Category/Country` | "Most blocked …" | Yes. Aggregate counts of curated brands only. |

**[gap]** No event for *left the page*, *continued anyway*, *pass used*, or
*actually made it*. The product cannot answer "did the interruption work?".

## 7. Temporary passes

`siteBypasses = { [siteKey]: absoluteExpiryMs }`; expired entries are filtered on
every read (`getActiveBypasses`) and one `chrome.alarms` entry is armed at the
max expiry.

**[has]** Absolute timestamps, filtered on read -> already survives browser
restart, worker suspension, and sleep. Good foundation.
**[gap]** One scope only ("this site for N minutes"). No once/tab/category/global
pause. Duplicate-domain handling exists (a domain in both buckets is excluded
once by domain, not key) — keep that.
**[risk]** `startTemporaryBypass` falls back to `DELIVERY_SITES[0]` when the key
does not resolve, which grants a pass for an unrelated brand. Real bug.

## 8. Known inconsistencies (full list)

1. `crispy-chickpea-bowl` tagged `chicken`; `turkey-*` tagged `chicken`;
   `protein-smoothie` tagged `coffee`/`tea`.
2. `recipeFavorites` is a storage key that nothing reads or writes.
3. `startTemporaryBypass` unrelated-brand fallback (above).
4. `README.md` opens with "Being a fatass sucks…" and the Ethos section repeats
   it; the licensing section ends with a taunt aimed at crawlers. Directly
   contradicts the product's own non-shaming premise.
5. `docs/STORE_LISTING_DRAFT.md` promises "no guilt trips" while the README does
   the opposite.
6. `warning.html` `.recipe-steps-list` is a scroll container with no keyboard
   focusability and no accessible name; the countdown has no live region; the
   ring animates by transform on every tick.
7. Recipe count, brand count, category count are hand-written in prose in
   `README.md` / store draft rather than generated.
8. `extension/recipes.js` Node fallback resolves `data/recipes.json` by trying
   two paths; fine, but it caches into module state shared across tests.
9. The block page records `recordBlockedVisit` **and** `recordBlockedBrand` on
   every load, including a reload of the same block page — refreshing inflates
   both counters.

## 9. Risks of breaking existing users

* Any rename of `blockedVisits`/`caloriesAvoided` loses visible history. **Must
  migrate, never reset.**
* `customSites` may still be a legacy `string[]` in old profiles.
* `disabledDelivery/FastFoodSiteKeys` may contain *legacy* keys (TLD-stripped).
  `mergeSitesWithEnabledState` already checks both forms — preserve that.
* Backups in the wild are `{_type,schema:1,version,exportedAt,settings}` **and**
  bare settings objects. Restore must keep accepting both.
* Firefox users on 140+ only; Chrome MV3 service worker can be killed at any
  time — no in-memory-only state may be authoritative.

## 10. Planned migrations

Introduce `schemaVersion` (int) in local storage. `migrate(state)` is pure,
idempotent, versioned, and runs on `onInstalled`, `onStartup`, and before the
first `getSettings()` of a worker generation.

| Step | From -> To | Action |
| --- | --- | --- |
| M1 | (absent) -> 2 | Stamp `schemaVersion`. Normalize `customSites` string[] -> records. Derive `frictionProfile` from existing `timerSeconds` (<=30 light, <=90 standard, else strict) without changing the numbers. Convert the single schedule window into `scheduleWindows` (7-day map) while **keeping** `scheduleStart`/`scheduleEnd` readable. Seed `pantry`/`equipment` empty. Seed new stat counters at 0. Translate `recipesChosen` -> `alternativesSelected` (copy, keep original as legacy). Keep `caloriesAvoided` verbatim under `legacy.caloriesAvoided` **and** keep the original key so nothing is lost. |
| M2 | 2 -> 3 | Reserved for the next change; the runner is a loop over an ordered step table, so multi-version upgrades apply in sequence. |

Rules: never delete an unknown key; anything that cannot be interpreted goes to
`legacy.<key>` and is reported in settings; migration is wrapped so a throw
leaves storage untouched.

## 11. Planned test coverage

New files: `test/schema-migration.test.js`, `test/schedule.test.js`,
`test/passes.test.js`, `test/alternatives-data.test.js`,
`test/alternatives-match.test.js`, `test/custom-alternatives.test.js`,
`test/stats-semantics.test.js`, `test/backup-roundtrip.test.js`,
`test/block-page-flow.test.js`. Extended: `test/block-page.test.js`,
`test/recipes.test.js`, `test/backup.test.js`, `test/locales.test.js`.

> **As built.** Several of these landed under different names. Do not go looking
> for the ones above that no longer appear here — they were never written under
> that name, not deleted:
>
> | Planned | As built |
> | --- | --- |
> | `test/schema-migration.test.js` | `test/core-schema.test.js` |
> | `test/alternatives-data.test.js` | `test/recipes.test.js` |
> | `test/alternatives-match.test.js` | `test/matching.test.js` |
> | `test/custom-alternatives.test.js` | `test/preferences.test.js` |
> | `test/backup-roundtrip.test.js` | `test/backup.test.js` |
> | `test/block-page-flow.test.js` | `test/block-page.test.js`, `test/scenarios.test.js` |
> | `tools/recipe-audit.js` (§12.2) | `tools/alternatives-audit.js` |
>
> Added afterwards, beyond this plan: `test/validator-contract.test.js`,
> `test/page-scripts.test.js`, `test/resilience.test.js`, and the shared
> `test/helpers/background-harness.js`.

## 12. Implementation order

1. Audit (this document) + schema/migration module + tests.
2. Recipe schema v2 + validator (`tools/recipe-audit.js`) wired into
   `validate-all` and `npm test`.
3. Dataset: correct the 24 existing entries, expand to >= 60 usable entries
   across full recipes and quick alternatives.
4. Matching engine rewrite + tests.
5. Block-page decision flow.
6. Pantry/equipment, custom alternatives.
7. Friction profiles, scoped passes, repeat-access friction.
8. Advanced schedules.
9. Statistics semantics + weekly recap.
10. Onboarding, preview mode, reporting flow.
11. Backup/restore.
12. Accessibility + security pass.
13. Docs, generated metadata, language cleanup.
14. Full test + build matrix.

## 13. Localization decision

83 locales x 335 keys today, with an **exact-parity** gate. The redesign adds
~120 English keys. Machine-translating 10 000 strings would be worse than
useless, and the runtime already falls back correctly in *both* modes
(`chrome.i18n` falls back to `default_locale`; `i18n.js` falls back to the cached
English map). The parity audit is therefore changed to:

* **error** — a locale defines a key English does not have (dead string),
  a duplicate key, an empty message, an unsafe `$name$` placeholder, or a
  placeholder set that differs from English for a key it *does* define;
* **warning** — a locale is missing an English key (untranslated), reported as a
  per-locale coverage percentage.

This is strictly more informative than the old check and matches runtime
behavior. It is the only test whose strictness is reduced, and the reduction is
compensated by a new test proving the English fallback actually works.
