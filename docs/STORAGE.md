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
| `repeatHistory` | `{ "domain": number[] }` | See [Repeat-access history](#repeat-access-history). **Expires.** |
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
mean 18:00 local after a daylight-saving shift. The single alarm the worker arms
is computed the same way: an all-day window's real transition is local midnight,
and a wall-clock time that daylight saving *skips* resolves to the instant the
clock jumps rather than to the hour it rolls forward into.

`until` is the "Block until tomorrow" override. While it is in the future the
worker **refuses** an all-scope ("pause everything") temporary pass, so the
commitment cannot be cancelled from the next block page. Site-scoped passes,
and the master switch, still work. On an always-on schedule the override changes
no reported state — `evaluateSchedule` keeps saying `always`, because a
commitment button must never make the protection FitShield reports smaller than
the protection it enforces.

### Repeat-access history

```jsonc
"repeatHistory": { "doordash.com": [1767225600000, 1767227400000] }
```

Written only when the user deliberately continues to a blocked brand, and read
only by `repeatFrictionFor` to decide whether this is a second visit inside the
repeat window. It is bounded three ways:

- **by age** — entries older than three times the repeat window are dropped, and
  a domain left with no entries loses its row entirely. The window is a constant
  (60 minutes, `DEFAULT_REPEAT_WINDOW_MINUTES` in `fitshield-core.js`), so
  retention is a flat 3 hours. It was briefly a stored key, `repeatWindowMinutes`
  — but no control, no friction preset and no install seed ever wrote it, so the
  only value it could hold was that default while it was carried in every backup
  and named by a reset button. A stored value is now ignored outright: adding a
  control for it means adding the control and reading the key back together.
  Expiry is applied on every read (`readSettings`) **and** on every write
  (`recordContinue`), and the worker writes the pruned map back on every refresh
  — so a profile nobody touches cannot keep it on disk either.
- **by whether the feature is on at all** — switching repeat friction off deletes
  the map. Nothing else reads it, and a record of when the user gave in has no
  business outliving the feature it was kept for.
- **by domain count** — at most 60 domains.
- **by entries per domain** — at most 12.

Before 0.55 the caps were on count only and nothing expired, which made this a
permanent per-brand record of the exact moments a user gave in. It is not backed
up, and it is the one stored map that is browsing-adjacent, so its lifetime is
part of the privacy contract rather than an implementation detail.

### Temporary passes

`passes: Pass[]`, where a pass is:

```jsonc
{
  "id": "p1767225600000-1",
  "preset": "siteDefault" | "site10" | "site30" | "tab" | "all30" | "allTomorrow" | "custom",
  "scope": "site" | "category" | "all",
  "target": "doordash.com",     // "" for scope "all"
  "createdAt": 1767225600000,
  "expiresAt": 1767226200000,   // ABSOLUTE, never "minutes remaining"
  "maxDurationMs": 600000,      // ceiling on the granted duration
  "tabId": null                 // set for the "until this tab closes" scope
}
```

There is deliberately **no field for why the user continued.** An earlier build
stored the block page's "what brought you here?" answer here as `reason`, which
made the promise printed beside that toggle — *the answer is never saved* —
false, and left a `{domain, exact timestamp, why I gave in}` triple on disk.
Nothing ever read it back. A pass written by that build has the field dropped
the next time the passes array is written.

Every preset is **scope plus duration**, because that is the whole of what the
blocking layer can enforce: dynamic `declarativeNetRequest` rules are global and
report nothing back when a request matches, so the worker cannot observe a single
visit and stand down after it. A genuine single-use pass would need a
browser-wide navigation listener — a permission and an observation surface
FitShield does not take. During 0.55's development this menu carried a `once`
preset labelled "Just this once" that was in fact a five-minute site pass, plus
`oneShot`/`used` fields nothing ever read or wrote. It is now `siteDefault`,
which carries no baked-in duration and therefore honours the user’s own “Site
open time” setting, and the dead fields are gone. 0.57 removed the named shim that
read `once`/`site5` as `siteDefault`: neither label ever shipped and a pass lives
minutes to hours, so no profile can hold one. An unrecognised preset still reads as
`custom` with its scope, target and expiry untouched, so no pass is ever dropped
out from under the user who was granted it.

The `preset` union above is the complete set a screen can produce. There is
**no** `category30`: it was defined, exported, documented here and unit-tested
while no UI could select it, which turned a constant into an apparent feature.
`scope: "category"` is still honoured on read, so a pass granted by an older
build keeps working for the minutes it was granted; nothing creates a new one.
Bringing category passes back means adding the option to the block page's
chooser first.

An all-scope pass is refused entirely while a "Block until tomorrow" override is
in force — see [Schedule shape](#schedule-shape).

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
| `pendingAlternatives` | `{id, at}[]` | Choices awaiting an optional "did you make it?" answer. Capped at 10, and **dropped 48 hours after the choice** — see below. |

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

`continued` and `passesUsed` currently count **the same event**: every exit from
the block page to the interrupted brand goes through `grantPass`, which is the
only writer of either, so the two numbers cannot differ. Separating them would
need a browser-wide navigation listener — a permission FitShield does not take.
A surface should therefore show one of them, not both side by side as if they
were independent measurements.

A pending "did you make it?" entry expires 48 hours after the choice, applied
when the popup asks the worker for state and again on every write. Before that,
the `at` field was stored and never read: entries resurfaced one popup-open at a
time, indefinitely, so a customer could be asked weeks later about a dish they
did not remember choosing — and that answer is the sole input to
`alternativesMade`, which the optional estimate multiplies by a meal price.

Also stored: `blockedByDomain`, `blockedByCategory`, `blockedByCountry` — counts
keyed by **curated blocklist metadata only** (the brand's apex domain, its food
category, and its primary listed market). Never a URL, a path, a query string, a
timestamp, or anything from browsing history. Only the brand's *first-listed*
market is counted, so one block by a brand operating in fifty countries cannot
flood the breakdown.

`blockedVisits`, `recipesChosen`, and `caloriesAvoided` are pre-0.55 counters,
kept in place after migration so nothing a user watched grow disappears. They
are **read only by the migration**. Nothing writes them and no surface displays
them — Settings' "Your Stats" reads `stats.totals`, the same object the popup's
weekly recap reads.

`showEstimates` gates the one optional estimate in Settings. It is off for new
profiles and on for anyone who had already customised their meal cost. The
estimate is `stats.totals.alternativesMade x avgMealCost`: the count of meals
the user *voluntarily confirmed they made*, times a price they set. It is
deliberately not derived from interruptions — a page being interrupted says
nothing about whether an order would have been placed — and the basis is printed
under the figure so it cannot read as a measurement.

`avgMealCalories` is retained and backed up for anyone who set it, but no
surface reads it. The "calories avoided" figure it fed was removed: FitShield
cannot observe what was eaten, and estimating a calorie saving from a displayed
recipe card was the clearest false claim in the old statistics.

### Presentation

`theme`, `themeMode`, `cardOrder`, `uiLanguage`, `currency`, `avgMealCost`,
`avgMealCalories`, `mealStatsCustomized`, `showEstimates`, `recapEnabled`,
`lastSeenVersion`.

Two keys were **retired** in 0.55 because nothing read them, and a stored value
nothing reads is a claim the product does not honour:

- `recapDismissedFor` — defaulted, normalized, excluded from backups and cleared
  by the reset, in five files, for a "dismiss this week's recap" behaviour no
  surface has. The recap is gated by `recapEnabled`, which is real.
- `settingsDelaySeconds` — written as 60 by the Strict friction profile and
  documented here as "a cooling-off delay before weakening protection". No code
  applied it. It is gone rather than left inert; reinstating it means
  implementing the delay where protection settings are weakened first.

Neither is deleted from an existing profile: the migration never removes a key it
does not understand, so an old value simply sits there unread until a reset.

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
| `siteBypasses: {key: expiry}` | `passes[]` | Active bypasses become site-scoped passes. Expired ones are not resurrected. The original map is preserved at `legacy.siteBypasses` because the old key format is not fully reversible to a domain — see below. |
| `blockedVisits` | `stats.totals.interruptions` | Translated. The original key is kept. |
| `recipesChosen` | `stats.totals.alternativesSelected` | Translated. The original key is kept. |
| `caloriesAvoided` | kept + `legacy.caloriesAvoided` | No longer displayed anywhere. The number is preserved, not shown: it counted a card being rendered, not a meal. |
| `recipeFavorites` | `alternativeFavorites` | A key nothing ever wrote; migrated anyway rather than dropped. |

Anything a step cannot interpret is preserved under `legacy.<key>` rather than
discarded.

#### Recovering a 0.54 site key

`siteBypasses` was keyed by site key, and the key builder flattened **every** run
of non-alphanumeric characters to a single `-` — dots and hyphens alike. So
`just-eat.com` and `just.eat.com` produce the same `delivery-just-eat-com`, and
the mapping cannot be inverted on its own. The migration therefore enumerates the
readings a key could have had and confirms one against the real blocklist, which
the worker passes in as `migrateState(state, { resolveDomain })`.

- A key that resolves to a catalog brand becomes a site pass for that brand.
- A key with a single separator (`delivery-doordash-com`) resolves without a
  catalog at all, because a dot is the only reading that yields a hostname.
- Anything still ambiguous is **dropped**, not guessed. A pass pointing at a host
  that does not exist reads as active and blocks the user anyway, which is worse
  than granting nothing — and `legacy.siteBypasses` keeps the original either
  way.

Earlier builds replaced every `-` with `.`, so a pass taken on Just Eat minutes
before the update targeted the non-existent `just.eat.com`. 128 catalog domains
contain a hyphen.

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
silently unblock something the user did not ask for *now*), `repeatHistory` (it
expires in hours; carrying it between installs would be the one browsing-adjacent
map outliving the device it was recorded on), `recentAlternatives`,
`dismissedAlternatives`, `pendingAlternatives`, `lastSeenVersion`. The exclusion
list also still names the retired `recapDismissedFor`, which is harmless — an
excluded key that no longer exists is simply never seen.

Backups written by 0.54 and earlier still import, including the pre-wrapper bare
form.

## What is never stored

- A URL, path, query string, or page title. A problem report reduces whatever the
  user typed to a bare host before it is shown to them — every URL, including one
  whose host is an IP literal, a single-label intranet name, or a fully-qualified
  name with a trailing dot.
- Any browsing history, including for sites FitShield did not interrupt. The one
  brand-keyed, time-stamped map — [`repeatHistory`](#repeat-access-history) —
  expires in hours by design, is never backed up, and holds no URL or path.
- Your location. Country selection is a blocklist filter you choose; onboarding
  may *suggest* a region from the browser's language, and says so.
- The answer to "what brought you here?" — it shapes the current screen and is
  discarded.
- Anything at all in preview mode.
- Anything on a server, because there isn't one. This is enforced rather than
  asserted: the packages declare an `extension_pages` content security policy of
  `connect-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'`
  (plus `script-src 'self'` and `object-src 'self'`), so no page FitShield ships
  can reach a remote host even if a future change tried to. Verified in Chrome
  against the built package: an injected remote `<img>` and a remote `fetch()`
  are both blocked, and a full session — blocking a site, the block page, taking
  a pass, Settings, a backup export, every page — produced zero requests to any
  non-extension origin.
