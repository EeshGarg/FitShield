# Storage schema, migrations, and privacy

Everything FitShield knows lives in `chrome.storage.local` on one device. There
is no `storage.sync`, no server, and no account, so this document is also the
complete list of what the extension holds about you.

Owned by [`extension/fitshield-core.js`](../extension/fitshield-core.js).

## Current version

`schemaVersion: 2` — written by `FitShieldCore.SCHEMA_VERSION`.

A profile with **no** `schemaVersion` key is version 1: every profile created
before 0.55.

## Keys

### Blocking

| Key | Type | Meaning |
| --- | --- | --- |
| `enabled` | bool | Master switch. |
| `timerSeconds` | int, 10–900 | Length of the pause. |
| `passDurationMinutes` | int, 1–240 | Default pass length. |
| `frictionProfile` | `"light" \| "standard" \| "strict" \| "custom"` | Which preset the current values match. |
| `askIntent` | bool | Show the optional "what brought you here?" prompt. |
| `repeatFrictionEnabled` | bool | Add extra pause on a repeat visit. |
| `repeatExtraSeconds` | int, 0–120 | How much extra. Capped; never compounds. |
| `repeatWindowMinutes` | int, 5–720 | How long a repeat counts as recent. |
| `settingsDelaySeconds` | int, 0–600 | Cooling-off delay before weakening protection (strict only). |
| `schedule` | `{ mode, windows[], until }` | See below. |
| `scheduleEnabled` / `scheduleStart` / `scheduleEnd` | bool / `"HH:MM"` / `"HH:MM"` | Legacy mirror of a single window. Kept in step in both directions so the popup and older builds still work. |
| `deliverySitesEnabled` / `fastFoodSitesEnabled` / `customSitesEnabled` | bool | Bucket toggles. |
| `disabledDeliverySiteKeys` / `disabledFastFoodSiteKeys` | string[] | Per-site exceptions. Accepts both current (`delivery-doordash-com`) and pre-0.55 TLD-stripped (`doordash`) keys. |
| `customSites` | `{domain, enabled}[]` | Your own domains. A pre-0.55 `string[]` is migrated. |
| `enabledCountries` / `enabledCategories` | string[] | Metadata-driven blocking. |
| `quickAccessCountries` / `quickAccessCategories` | string[] | Pinned chips in settings. |

### Schedule shape

```jsonc
{
  "mode": "always" | "windows",
  "windows": [ { "days": [0..6], "start": "HH:MM", "end": "HH:MM" } ],
  "until": null | 1767225600000   // absolute ms; "block until tomorrow"
}
```

`days` uses `Date.getDay()` numbering (0 = Sunday). A window whose `end` is
earlier than its `start` crosses midnight and belongs to the day it **starts**
on, so `{days:[5], start:"22:00", end:"02:00"}` is Friday night into Saturday
morning and does not also cover Saturday night. `start === end` means the whole
of that day.

Everything is evaluated against the device's local wall clock. There is no stored
offset and no remote time service, which is what makes an "evenings" window still
mean 18:00 local after a daylight-saving shift.

### Temporary passes

`passes: Pass[]`, where a pass is:

```jsonc
{
  "id": "p1767225600000-1",
  "preset": "site5" | "tab" | "site10" | "site30" | "category30" | "all30" | "allTomorrow" | "custom",
  "scope": "site" | "category" | "all",
  "target": "doordash.com",     // "" for scope "all"
  "createdAt": 1767225600000,
  "expiresAt": 1767226200000,   // ABSOLUTE, never "minutes remaining"
  "maxDurationMs": 600000,      // ceiling on the granted duration
  "tabId": null,                // set for the "until this tab closes" scope
  "reason": ""                  // the intent answered on the block page, if any
}
```

Every preset is **scope plus duration**, because that is the whole of what the
blocking layer can enforce: dynamic `declarativeNetRequest` rules are global and
report nothing back when a request matches, so the worker cannot observe a single
visit and stand down after it. A genuine single-use pass would need a
browser-wide navigation listener — a permission and an observation surface
FitShield does not take. During 0.55's development this menu carried a `once`
preset labelled "Just this once" that was in fact a five-minute site pass, plus
`oneShot`/`used` fields nothing ever read or wrote. It is now `site5`, labelled
"For 5 minutes", and the dead fields are gone; a pass persisted under the old
name is read as `site5` with its scope, target, and expiry untouched.

Expiry is decided in exactly one place (`FitShieldCore.activePasses`) and
re-checked on every read. That single fact is what makes passes end correctly
after a browser restart, a suspended service worker, a long system sleep, and an
extension update: all four reduce to "the next read happens at a later `now`".

`maxDurationMs` exists because an absolute timestamp alone is not enough — a
clock moved *backwards* would otherwise stretch a pass indefinitely. A pass whose
apparent age exceeds the duration it was granted for is treated as expired
regardless of the wall clock.

Passes are **not** included in backups; see [Backups](#backups).

### Kitchen and alternatives

| Key | Type | Notes |
| --- | --- | --- |
| `dietPreference` | `"omnivore" \| "vegetarian" \| "vegan" \| "pescatarian"` | Hard filter. |
| `avoidAllergens` | string[] | Hard filter, from the nine tracked allergens. |
| `pantry` | string[] | Staples you usually keep. Ranking only — never hides anything. **No quantities, no purchase dates, no expiry, no shopping history.** |
| `equipment` | string[] | What you can cook with. |
| `alternativeFavorites` | string[] | Alternative ids. |
| `customAlternatives` | object[] | Your own entries, validated by `sanitizeCustomAlternative`. |
| `recentAlternatives` / `dismissedAlternatives` | string[] | Rotation state, capped at 24 each. |
| `pendingAlternatives` | `{id, at}[]` | Choices awaiting an optional "did you make it?" answer. Capped at 10. |

### Statistics

```jsonc
"stats": {
  "totals":  { "interruptions": 0, "left": 0, "continued": 0, "passesUsed": 0,
               "alternativesViewed": 0, "alternativesSelected": 0, "alternativesMade": 0 },
  "history": [ { "day": "2026-07-31", ...the same counters } ]   // last 70 local days
}
```

Every name describes something FitShield **observed**. Nothing here asserts that
an order was prevented, that a meal was skipped, or that money or calories changed
hands, because the extension cannot see any of those.

`alternativesSelected` is an intention expressed on the block page.
`alternativesMade` is a separate, voluntary confirmation the user gives later from
the popup. Declining to confirm records nothing at all.

Also stored: `blockedByDomain`, `blockedByCategory`, `blockedByCountry` — counts
keyed by **curated blocklist metadata only** (the brand's apex domain, its food
category, and its primary listed market). Never a URL, a path, a query string, a
timestamp, or anything from browsing history. Only the brand's *first-listed*
market is counted, so one block by a brand operating in fifty countries cannot
flood the breakdown.

`blockedVisits`, `recipesChosen`, and `caloriesAvoided` are pre-0.55 counters,
kept in place after migration so nothing a user watched grow disappears.

### Presentation

`theme`, `themeMode`, `cardOrder`, `uiLanguage`, `currency`, `avgMealCost`,
`avgMealCalories`, `mealStatsCustomized`, `showEstimates`, `recapEnabled`,
`recapDismissedFor`, `lastSeenVersion`.

## Migrations

`FitShieldCore.migrateState(state)` runs an ordered table of steps. It is:

- **idempotent** — running it twice changes nothing;
- **versioned** — each step declares the version it upgrades *from*;
- **safe on missing and malformed data** — every step tolerates `undefined`,
  `null`, wrong types, and junk;
- **safe across several versions** — steps run in sequence, so a v1 profile
  reaching a future v4 build applies 1→2→3→4;
- **atomic** — if any step throws, the **original** state is returned untouched
  and the failure is reported through diagnostics. A broken migration must never
  reset a user's data.

It is invoked once per service-worker generation (`ensureMigrated`), which is
safe precisely because it is idempotent: an MV3 worker can be torn down at any
moment and will run it again on the next wake-up.

### v1 → v2 (0.55)

| Before | After | Note |
| --- | --- | --- |
| (no marker) | `schemaVersion: 2` | |
| `customSites: string[]` | `{domain, enabled}[]` | |
| `scheduleEnabled/Start/End` | `schedule` object | Flat keys **kept** so an older build still reads them. `scheduleEnabled:false` keeps the window under `mode:"always"`, so switching it back on restores the original hours. |
| (inferred) | `frictionProfile` | Derived from the existing `timerSeconds`. **No value is changed.** |
| `siteBypasses: {key: expiry}` | `passes[]` | Active bypasses become site-scoped passes. Expired ones are not resurrected. The original map is preserved at `legacy.siteBypasses` because the old key format is not fully reversible to a domain. |
| `blockedVisits` | `stats.totals.interruptions` | Translated. The original key is kept. |
| `recipesChosen` | `stats.totals.alternativesSelected` | Translated. The original key is kept. |
| `caloriesAvoided` | kept + `legacy.caloriesAvoided` | No longer a headline number; the estimate panel stays switched on for anyone who already had one. |
| `recipeFavorites` | `alternativeFavorites` | A key nothing ever wrote; migrated anyway rather than dropped. |

Anything a step cannot interpret is preserved under `legacy.<key>` rather than
discarded.

Tested in [`test/core-schema.test.js`](../test/core-schema.test.js) and, through
the real worker, in [`test/blocking.test.js`](../test/blocking.test.js).

## Backups

`extension/backup.js`. Format version 2.

```jsonc
{
  "_type": "fitshield-settings-backup",
  "schema": 2,
  "version": "0.55",
  "exportedAt": "2026-07-31T00:00:00.000Z",
  "keyCount": 31,
  "settings": { ... }
}
```

Export uses an **allowlist** (`DURABLE_KEYS`). Import treats the file as hostile
input, because it is — it is written straight into the store the service worker
trusts:

- capped at 2 MB and rejected before parsing if larger;
- rejected if `_type` is foreign, if the format version is newer than this build
  understands, or if it carries nothing FitShield recognises;
- every key outside the allowlist is **dropped**, not stored;
- `__proto__` / `constructor` / `prototype` are stripped recursively;
- values are re-normalized through the same rules the runtime uses, so a restore
  cannot install something the worker would then have to defend against;
- custom alternatives are re-validated individually;
- validated **in full before anything is written**, so a file that fails halfway
  cannot leave a profile half-old and half-new.

Deliberately **not** backed up: `passes` and `siteBypasses` (an active permission
to reach a blocked site — restoring one on another machine, or days later, would
silently unblock something the user did not ask for *now*), `repeatHistory`,
`recentAlternatives`, `dismissedAlternatives`, `pendingAlternatives`,
`lastSeenVersion`, `recapDismissedFor`.

Backups written by 0.54 and earlier still import, including the pre-wrapper bare
form.

## What is never stored

- A URL, path, query string, or page title.
- Any browsing history, including for sites FitShield did not interrupt.
- Your location. Country selection is a blocklist filter you choose; onboarding
  may *suggest* a region from the browser's language, and says so.
- The answer to "what brought you here?" — it shapes the current screen and is
  discarded.
- Anything at all in preview mode.
- Anything on a server, because there isn't one.
