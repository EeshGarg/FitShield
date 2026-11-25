# Glossary

Terms as FitShield's code uses them. Each entry points at the file that defines
or implements it; when this page and the code disagree, the code is right and
this page is a bug.

Paths are relative to the repository root. `FS Engine/` contains a space.

## Blocking

**Brand.** One company FitShield knows about, such as a pizza chain or a
delivery platform. In data a brand is one object in the `entries` array of a
blocklist; in the Android data it is keyed by `brandId`, which is the brand's
canonical domain. Source: `data/blocklists/fast-food.json`,
`data/blocklists/delivery.json`.

**Entry.** The raw dataset record for a brand: `domain`, `name`, `aliases`,
`type`, `countries`, `regions`, `category`, `specialties`, `enabled`. The
field meanings are in each blocklist's `_schema`. Entries with
`enabled: false` are ignored by the engine (`FS Engine/entries.js`,
`getEnabledEntries`).

**Domain.** The apex hostname of a brand (`example.com`: no `www.`, no path).
Matching is label-anchored, so `fake-example.com` does not match `example.com`
but `order.example.com` does (`FS Engine/hostnames.js`).

**Alias.** An additional apex domain owned by the same brand (a regional or
legacy domain). It is blocked together with the primary domain, and counts as
the same brand. Audited by `tools/alias-audit.js`.

**Type.** The broad behaviour bucket of an entry: `fast_food` or `delivery`.

**Category.** One primary `snake_case` food or business id per brand
(`burger`, `pizza`, `coffee`...). It is customer-facing: it appears on the block
page and in Settings' most-blocked list, through a `catLabel<PascalCase>` key in
`extension/_locales/en/messages.json`. Audited by `tools/category-audit.js`.
Retired ids are listed in `RETIRED_CATEGORIES` in that file so their labels
survive in users' history.

**Specialties.** Searchable descriptors on an entry. They are not used for
blocking.

**Region / country.** `countries` are ISO 3166-1 alpha-2 codes with the primary
market first; `regions` are continent tags (`NA`, `EU`, `AS`, `SA`, `AF`, `OC`,
`AN`) that must agree with them. Audited by `tools/country-audit.js`.

**Engine.** The domain-matching library in `FS Engine/`: it answers "should
this hostname be blocked?" and ships no data of its own. The extension receives
it as a generated single-file bundle, `extension/blocklist.js`.

**Custom site.** A domain the user adds themselves. Stored in `customSites`
and normalised by `normalizeCustomSites` in `extension/fitshield-core.js`.

**Site key.** The stable id the UI and storage use for a blocklist entry
(derived from the hostname plus its bucket). Built identically in
`extension/background.js` (`domainToKey`) and `extension/blocklist-records.js`;
a test pins the two together.

**declarativeNetRequest (DNR) rules.** The browser's built-in request-matching
API, which FitShield uses to redirect a blocked host to the block page without
reading the pages you visit. The background worker builds the rules from the
enabled entries and installs them with `updateDynamicRules`
(`extension/background.js`). Rules are rebuilt when settings, schedules or
passes change.

**Block page / warning page.** The page a blocked navigation is redirected to:
`extension/warning.html` and `warning.js`. It shows the pause countdown, the
optional "what brought you here?" prompt, an at-home alternative and the
unlock choices. The two names mean the same thing; the file is called
`warning`.

**Nonce / redirect token.** The provenance token appended to the redirect URL
by the worker so the block page can tell a genuine redirect from someone
opening `warning.html` by hand (`extension/background.js`).

## Friction and unlocking

**Friction.** The deliberate pause or extra step before ordering. FitShield is
a decision-friction tool, not a lock.

**Friction profile.** A named bundle of friction settings: `light` (20 s timer),
`standard` (60 s, the default), `strict` (120 s), or `custom` when the values
match none. Source: `FRICTION_PROFILES`, `detectFrictionProfile` in
`extension/fitshield-core.js`.

**Timer / countdown.** The wait before "Continue" unlocks on the block page
(`timerSeconds`). The countdown announces itself to screen readers on
milestones only, not every second.

**Repeat friction.** Extra seconds added when you continue to the same site
again inside a window (`repeatFrictionFor`, `recordContinue` in
`extension/fitshield-core.js`).

**Pass / temporary unlock.** A time-limited permission to open a blocked site
without friction. A pass has a `scope` (`site`, `category` or `all`), a
`target`, `createdAt`, `expiresAt` and a `maxDurationMs` guard against a
backwards clock change. Presets: `siteDefault` (uses your own "Site open time"),
`tab` (bound to one tab), `site10`, `site30`, `all30`, `allTomorrow`
(`PASS_PRESETS`, `createPass`, `activePasses` in
`extension/fitshield-core.js`). The reason you give on the block page is
deliberately never stored on a pass. Expiry is driven by a `chrome.alarms`
alarm named `temporaryPassExpired`.

**Schedule.** The days and time windows in which blocking is active, evaluated
in local wall-clock time (`evaluateSchedule`, `nextScheduleBoundary` in
`extension/fitshield-core.js`). The worker sets a `scheduleBoundaryReached`
alarm for the next boundary. The Android port is `Schedule.kt`.

**Override (schedule).** "Block until tomorrow": a commitment stored as an
absolute `until` timestamp that keeps blocking on outside the schedule's
windows and expires on its own. While it lasts the worker refuses an all-scope
pass (`evaluateSchedule`, `scheduleOverrideActive` in
`extension/fitshield-core.js`).

**Intent prompt.** The optional "what brought you here?" question (`askIntent`).
The answer does its work on the page that asked and is never saved.

## Alternatives

**Alternative.** Something to make at home instead of ordering: either a
**recipe** (full detail) or a **quick alternative** (four steps or fewer). Both
share one shape. Source: `data/alternatives/*.json`; vocabularies in
`data/alternatives-taxonomy.json`; validated by `tools/alternatives-audit.js`.

**Catalog.** Context decides the meaning. The **alternatives catalog** is the
set of all recipes and quick alternatives, compiled into `data/recipes.json`
(generated: never edit it). The **blocklist catalog** is the set of brands
across the datasets, which the UI turns into site records
(`extension/blocklist-records.js`).

**Craving.** A craving type an alternative answers (for example `pizza`). Each
craving needs at least two alternatives so "show another" has something to
show.

**Taxonomy.** The vocabularies (method, equipment, diet, allergens, region,
cravings, categories) and the maps that decide when an alternative is offered:
`data/alternatives-taxonomy.json`.

**Custom alternative.** A recipe the user writes themselves, sanitised by
`sanitizeCustomAlternative` in `extension/fitshield-core.js`.

## Android

**App blocking.** On Android FitShield blocks food-delivery and fast-food
**apps**, not websites. It uses an opt-in `AccessibilityService` that reads only
the foreground package name. Source:
`android/app/src/main/java/com/usha/fitshield/FitShieldAccessibilityService.kt`
and `AppBlockPolicy.kt`. Website blocking on a phone is the browser
extension's job (Firefox for Android).

**Package id.** An Android application id such as `com.example.app`. Mapped to
brands in `data/android/*.json`. Never guessed.

**`packageStatus`.** How sure the Android data is about a brand's package:
`active` (has confirmed package ids), `needs_review` (id not yet confirmed; stays
empty rather than guessed), `no_app` (verified: the brand has no official app),
`shared_app` (its app is another brand's package). Defined in
`data/android/packages.schema.json`.

**Keep-alive.** An optional, off-by-default foreground service that shows a
quiet notification so aggressive battery managers keep FitShield's process
resident. It does no work and reads nothing; the accessibility service does the
blocking. Source:
`android/app/src/main/java/com/usha/fitshield/AppBlockKeepAliveService.kt`.

**WebView UI / shim.** The Android app's screens are the extension's web UI in a
WebView, with `android/web-src/android-shim.js` standing in for the browser
extension APIs and `WebAppBridge.kt` as the native side.

**versionCode.** Android's monotonically increasing build number. Play rejects
a re-used one, so `npm run bundle:android` makes `--versionCode` mandatory
(`tools/build-android.js`).

## Project and process

**Sync.** `npm run sync` copies canonical sources (`FS Engine/`, `data/`,
locales) into the committed runtime copies in `extension/` and the Android web
assets (`tools/sync-extension.js`). `validate:sync` fails when they drift.

**Generated file.** Output that must be regenerated, not edited:
`data/recipes.json`, `data/generated/android-packages.json`,
`extension/blocklist.js`.

**Validator / audit.** A script in `tools/` that checks one invariant;
`npm run validate` runs all of them (`tools/validate-all.js`). An audit that
could not run (no browser) is reported as "did not run", never as a pass.

**Locale.** A translation set in `extension/_locales/<code>/messages.json`.
English is the source of truth and must be complete; other locales may be
partial and fall back to English per key. See [`LOCALIZATION.md`](LOCALIZATION.md).

**Migration.** A versioned, idempotent upgrade of stored state, safe on missing
or malformed input and never a silent reset (`migrateState` in
`extension/fitshield-core.js`; see [`STORAGE.md`](STORAGE.md)).

**Maintenance mode.** FitShield 1.0 is the final feature release; afterwards
only fixes and policy compliance (see [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).

**Finding.** A defect, gap or inconsistency discovered during work. In this
repository a finding is work, whatever its severity ([`../CLAUDE.md`](../CLAUDE.md)).

**Terminal verdict.** A "NOT READY" / "SHIP" style conclusion. Forbidden as an
outcome by `CLAUDE.md`; a defect is an instruction to fix it.

**Lane.** One specialist agent's slice of work, partitioned by file ownership
(`.claude/agents/`).
