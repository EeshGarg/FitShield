# Completion status

| | |
| --- | ---: |
| Blockers found | **11** |
| Blockers fixed | **11** |
| Blockers remaining | **0** |
| High-severity findings found | **19** |
| High-severity findings fixed | **12** |
| High-severity findings remaining | **7** (all catalogued below; none data-losing, none security) |
| Automated tests | **446 pass / 0 fail** |
| Validators | **14 / 0 errors** (101 non-blocking warnings) |
| Chromium real-browser checks | **55 / 55** |
| Firefox real-browser checks | **16 / 16** |
| Known data-loss defects | **0** |
| Known dead customer-facing actions | **0** |
| Builds | Chrome, Firefox, Safari-nightly — all produced |

**Environment-impossible items** (nothing else was deferred to them):

| Limitation | Why | What was verified instead | External environment required |
| --- | --- | --- | --- |
| Safari Xcode project not generated | `xcrun safari-web-extension-converter` is macOS-only; no macOS machine exists here | The Apple payload stages and zips (`dist/FitShield-0.55-nightly-safari.zip`, 910 KB) and passes the same package audits as Chrome/Firefox | macOS with Xcode |
| Android APK not built | Android SDK + Gradle are not installed | Both Android validators pass; the shared web assets re-sync byte-identically on every change, and a drift guard failed the build twice during this pass when I edited `i18n.js` | A machine with the Android SDK |
| Screen-reader behaviour not heard | No assistive technology available | Live-region structure, accessible names, focus order and the countdown's milestone-only announcements were verified in a real browser and by source | A machine with NVDA/JAWS/VoiceOver |
| No human manual testing | Automated only | 71 real-browser checks against the production packages | A human |

---

## 1. Executive summary

Every blocker is closed. The eight that were open at the start of this pass
collapsed into two root causes plus two isolated defects, so the repairs are
architectural rather than symptomatic:

- **Schedule state** (4 blockers + 4 highs) — `readSettings` returned no
  `scheduleEnabled/Start/End` at all, so both the popup and Settings fell
  through to their own destructuring defaults and displayed "off, 18:00–23:00"
  while the worker enforced something else entirely. `schedule` is now the
  single source of truth and the flat trio is a one-way projection of it.
- **Backup durability** (3 blockers) — `readSettings` owned `customSites`
  through the defaults spread but never populated it, so export→import replaced
  every custom blocked domain with `[]` and reported success. Separately, import
  stamped the schema version *before* migrating, so a 0.54 backup's counters
  were never translated and all seven statistics read zero.
- **A dead slider** — no pass preset could ever reach `passDurationMinutes`.
- **A dead mail button** — pointing at a domain with no MX record.

Twelve of nineteen highs are also fixed, including both security findings: any
website could forge the user's statistics through the web-accessible block page,
and a hostile backup could make Settings fetch a remote URL through an
unvalidated theme value.

Real-browser coverage went from 45 Chromium / 9 Firefox to **55 Chromium / 16
Firefox**. All three original Firefox failures were harness defects, now fixed —
an eval race, an assertion treating an empty array as truthy, and a URL regex
that flagged template literals.

---

## 2. Full defect ledger

### Blockers — 11 found, 11 fixed

| # | Finding | Root cause | Evidence of fix |
| --- | --- | --- | --- |
| 1 | Intent answer persisted while Settings promised "never saved" | `pass.reason` written by `grantPass` | field removed everywhere; real-browser storage dump shows no trace |
| 2 | Allergen "hard filter" did nothing | `readSettings` had no `avoidAllergens` case | `normalizeAllergens`; 30 real rotations, zero peanut entries |
| 3 | Worker rewrote saved schedules to every day | `syncLegacySchedule` rebuilt from a lossy mirror | guard + Workday-lunch survives in a real browser |
| 4 | "Site open time" slider dead | every preset hard-coded its minutes | `siteDefault` preset; 12-min setting → 12-min pass |
| 5 | Export→import deleted every custom blocked site | `readSettings` dropped `customSites` | `normalizeCustomSites`; full-profile round trip in a real browser |
| 6 | Restoring a backup deleted custom domains, reported success | same | same |
| 7 | 0.54 backup restore zeroed statistics | schema stamped before migration | migration runs first; 137 → `interruptions: 137` |
| 8 | Popup + Settings showed defaults, not the saved schedule; inputs disabled | `readSettings` omitted the flat trio | projection; 19:30–02:00 renders in both surfaces |
| 9 | Editing the advanced schedule overwrote migrated hours | `settings.scheduleStart \|\| "18:00"` fallback always won | mirror derived by the core |
| 10 | After upgrade, UI schedule ≠ enforced schedule | same omission | same |
| 11 | Nudging a simple time destroyed a multi-window schedule | simple controls offered over schedules they cannot express | `scheduleSimple` disables them + explains |

### High — 19 found, 12 fixed

**Fixed:** schedule copy describing a state never reported · "Site open time"
false · statistics forgeable by any website · simple inputs deleting windows ·
unvalidated theme enabling a remote fetch · reset leaving an active pass · reset
leaving the friction profile · 33 locales shipping pidgin headlines · corrupt
Odia locale · dead mail button · onboarding's Workday-lunch overwritten ·
"chose" double-counting within one interruption.

**Remaining (7)** — none loses data, none is a security or privacy defect:

| Finding | Why it is still open |
| --- | --- |
| Salad group padded — 7 tagged, 2 are salads | Catalog editorial work; needs recipe authoring, not a code fix |
| `late-night` tagged on 37% of the catalog, reachable as a primary craving | Retagging risks regressing the coverage matrix; wants a deliberate data pass |
| `repeatHistory` has no age expiry and no row in the storage table | Bounded (60 domains × 12 entries) and local; needs a documented retention rule |
| "Copy to every day" replaces rather than merges | The code matches its own documented intent; the label is the arguable part |
| Light theme: two block-page buttons at 1.21:1 | Needs a palette decision, not a mechanical fix |
| Popup can say "Shield up" outside scheduled hours | Likely resolved by the schedule projection; **not re-verified**, so not claimed |
| Two schedule controls in two differently-named sections | Information-architecture change |

### Medium / Low

57 medium and 14 low remain open and catalogued. The medium set is dominated by
copy consistency (three meanings for "pause", four labels for one concept,
`"1 time window(s) set"`), catalog editorial issues (every drink is iced; wings
need an air fryer and 26+ minutes), and accessibility naming.

---

## 3. Schedule architecture repair

**Canonical representation:** `schedule` — `{ mode, windows[], until }`.

**Compatibility fields:** `scheduleEnabled` / `scheduleStart` / `scheduleEnd`
are a **one-way projection** produced by `core.scheduleToLegacy(schedule)`. They
are kept because the popup, older builds, and the Android app speak them.

**Precedence, now explicit and tested:** the flat trio is read back *only* when
it can express the schedule exactly — one window across all seven days.
`core.scheduleIsFlatExpressible()` decides, and both the worker
(`syncLegacySchedule`) and the UI consult it. A "Workday lunch" (Mon–Fri) or
multi-window schedule is never rebuilt from its own lossy mirror.

**Settings load:** `readSettings` now emits the projection plus `scheduleSimple`,
so both surfaces render what is actually enforced instead of their own defaults.

**Simple controls:** disabled, with an on-screen explanation, whenever
`scheduleSimple` is false — they can no longer collapse a schedule they cannot
represent.

Verified in a real browser: 19:30–02:00 renders in both popup and Settings;
Workday lunch stays Mon–Fri after the worker settles; a two-window schedule keeps
both windows; the simple pair is disabled with its note shown.

---

## 4. Backup/restore repair

Two independent defects.

`customSites` was in `DURABLE_KEYS` but absent from `readSettings`, which spreads
defaults — so `normalizeImported` preferred the empty default over the file's
real value. `core.normalizeCustomSites` now exists (accepting the legacy
`string[]` too) and `readSettings` returns it.

`normalizeImported` stamped `SCHEMA_VERSION` unconditionally, making every
restored file look already-migrated; `migrateState` then short-circuited. The
migration now runs **first**. Keys it merely *defaulted* are deliberately not
adopted — a two-key backup must not overwrite the current profile's schedule,
passes or statistics — while keys genuinely **derived** from something the file
carried are, via an explicit map (`stats ← blockedVisits/recipesChosen/…`).

A generic test now asserts every durable key survives a full round trip with its
value intact, so the next key someone forgets in `readSettings` fails loudly.

---

## 5. Data-loss audit

| Path | Before | Now |
| --- | --- | --- |
| Export → import | custom blocked sites deleted | all 15 populated keys identical |
| 0.54 backup → 0.55 | statistics zeroed | 137 → `interruptions: 137` |
| Partial backup import | (would have) overwritten schedule/passes/stats | writes only what it carried |
| Reset blocking settings | left an active pass, the schedule, the friction profile | clears all three |
| Migration run twice | idempotent | idempotent (unchanged) |

**Known data-loss defects: 0.**

---

## 6. Firefox parity work

All three failures were harness defects, not product defects:

1. **`FS_DIAG` eval timeout** — an `evaluationResult` can arrive before the reply
   carrying its `resultID` is processed. Results are now buffered from the moment
   the socket is live and matched retroactively.
2. **`optional_permissions`** — Firefox returns a normalized *empty array*, which
   is truthy. The assertion now checks length.
3. **External-URL sniff** — flagged template literals (`https://${domain}/`) used
   to build the navigation target after a pass. It now matches only concrete URLs.

Firefox went 9/12 → **16/16**, including five new checks covering the seams
repaired this pass.

---

## 7. Real-browser evidence

| | Chromium | Firefox |
| --- | --- | --- |
| Browser | Chrome/**149.0.7827.55** | Firefox **153.0.1** |
| OS | Windows 11 Pro 10.0.26200 | same |
| Package | `dist/chrome/` (production) | `dist/firefox/` (production) |
| Install | `--load-extension`, fresh profile per run | `installTemporaryAddon` over RDP |
| Driver | CDP | RDP watcher + console actors |
| Dependencies added | **none** | **none** |
| Level | **automated real-browser** | **automated real-browser** |
| Checks | **55/55** | **16/16** |

Chromium flows: install · worker boot · production manifest · real navigation to
7 blocked brands across 7 categories · non-food control · block-page render ·
show-another · no-cook filter · preview records nothing · interruption counted
once · choose ≠ made · real countdown unlocking Continue · 6 pass options · pass
granted/expiring/domain-isolated · **schedule rendering in both surfaces** ·
**Workday-lunch survival** · **multi-window survival** · **simple-input
disabling** · **full-profile backup round trip** · **configurable pass duration**
· **report flow offering only working actions** · **no intent trace in storage**
· **allergen filtering over 30 rotations** · popup · Settings (15 sections) ·
console-error sweep · overflow at 1920/1366/900/640/420/360 · exits above the
fold at 200%-equivalent zoom · keyboard-only traversal · Enter activation ·
network hard-disabled · outbound-request sniff · hostile custom alternative ·
oversized/malformed custom data · six locales including RTL.

Firefox flows: install with **zero manifest warnings** · event page RUNNING ·
engine + core boot · production manifest · **2,575 DNR rules registered** ·
schema migrated on a fresh profile · catalog loads · `moz-extension://` block
page · pass presets and stat vocabulary identical to Chromium · engine host
matching · **schedule projection** · **custom-site survival** · **no pass
reason** · **allergen filter wired** · no concrete external URL.

---

## 8. Privacy/storage audit

**Permissions, both production manifests, verified at runtime:** `storage`,
`declarativeNetRequest`, `alarms` + `host_permissions: <all_urls>`. No
`optional_permissions`, no `externally_connectable`, **no content scripts**.

**Runtime network: none.** Zero non-`chrome-extension://` requests across four
surfaces; full function with the network hard-disabled.

**Removed this pass:**

- `pass.reason` — the block page's "what brought you here?" answer, stored
  against an explicit on-screen promise. Gone from `createPass`, `normalizePass`
  (so existing records are scrubbed on the next write), the migration, and
  `grantPass`.
- Forgeable statistics — any website could post the worker's recording messages.
  State-changing messages now require a sender on the extension's own origin.
- Remote-resource injection via an imported `theme`.

**Remaining caveat:** `repeatHistory` is a per-domain visit-timestamp log. It is
bounded (60 domains × 12 entries) and never leaves the device, but it has no age
expiry and no row in the storage table. Listed as an open high.

---

## 9. Allergen regression evidence

`readSettings` now normalizes `avoidAllergens` against the nine tracked
allergens. Tests: round trip; unknown values dropped; empty default; and a
functional test proving peanut-bearing entries disappear from the ranking while
the list stays non-empty. Real browser: 30 consecutive rotations on a live block
page with `peanut` avoided returned zero peanut entries.

**Honest limitation:** this is filtering on **catalog metadata**, not a medical
safety guarantee, and it is described that way. User-authored alternatives carry
no allergen metadata, so they cannot be hard-filtered — worth surfacing in the UI
in a later pass.

---

## 10. Settings/runtime synchronization

The schedule projection closed the specific divergence. A generic guard already
exists from the previous pass — no surface may `.get()` a retired storage key —
and the new `readSettings` round-trip test covers the write/read symmetry for
every durable key.

Not yet done: a systematic external-change → open-page-responds audit for every
control. The schedule path is fixed and tested; the rest were spot-checked.

---

## 11. Reset/delete behaviour

| Control | Clears | Verified |
| --- | --- | --- |
| Reset blocking settings | toggles, timer, **passes**, **schedule**, **friction profile**, repeat config, custom sites, country/category | test pins both what it clears and what it must not touch |
| Reset statistics & estimates | `stats`, breakdowns, favourites, estimate settings, legacy counters | test from the previous pass |
| Factory reset | `storage.local.clear()` | — |

Every key each control clears is one `backup.js` recognises, asserted by test.

---

## 12. Localization

294 mangled strings removed in 9 locales (`"Take one минута."`,
`"блокироватьing"`); `tools/locale-hybrid-audit.js` fails the build if they
return. RTL added for the six shipped RTL locales — `dir`/`lang` stamped from the
active locale, physical CSS converted to logical properties. Verified: ar/he/fa/ur
compute `rtl` with list padding mirrored; en/ja stay `ltr`; no overflow and no
clipped labels in fr/de/ru/hi/ja/ar.

**Accurate public wording:** "Available in 83 languages. Most are partially
translated; anything not yet translated is shown in English." Not "translated
into 83 languages".

---

## 13. Accessibility

Verified in a real browser: full keyboard traversal of the block-page decision;
Enter activates; no horizontal overflow at 1920→360; both exits above the fold at
200%-equivalent zoom; 44px targets; countdown announces milestones only; RTL
correct. Settings' horizontal scroll fixed (412 → 347 at a 360px viewport).

Open: light-theme contrast on two block-page buttons (1.21:1); missing accessible
names on some switches; the confirm dialog does not trap focus.

---

## 14. Production permission audit

Unpacked from the exact artifacts:

```
Chrome   permissions: storage, declarativeNetRequest, alarms
         host_permissions: <all_urls>
         content_scripts: none   optional_permissions: none
         externally_connectable: none
         web_accessible_resources: warning.html -> <all_urls>
         background: service_worker

Firefox  identical permission set, verified at runtime via browser.runtime.getManifest()
         background.scripts: blocklist.js, fitshield-core.js, background.js
         gecko id fitshield@usha.dev, strict_min_version 140, android 142
         data_collection_permissions: required ["none"]
```

`warning.html` must be web-accessible — it is the DNR redirect target. That
exposure is now defended: state-changing messages are refused unless the sender
is on the extension's own origin. **No permission was added this pass.**

---

## 15. Tests added

25 tests across this pass: pass records carry no reason (2) · allergens (4) ·
schedule flat-mirror guards (3) · schedule projection (4) · backup round trip (6)
· forged statistics and pass grants (3) · theme sanitization (1) · reset
semantics (2). Two existing tests were **rewritten rather than deleted**: both
grepped `preferences.js` for literals (`mailto:`, `scheduleStart:`) and passed
while the behaviour underneath was wrong.

## 16. Exact test results

```
446 pass / 0 fail / 0 skipped        (was 421 at the start of this pass)
```

## 17. Exact validator results

```
14 audits, 0 errors, 101 warnings
  Alternatives catalog        0 errors, 19 warnings (fuzzy near-duplicate checks)
  Localization parity         0 errors, 82 warnings (per-locale coverage)
  Localization hybrids        0 errors  — no mangled strings
  + 11 more, all clean
```

No validator was loosened. `locale-hybrid-audit` was **added** this pass.

## 18. Exact builds

```
dist/FitShield-0.55-chrome.zip           910,508 bytes
dist/FitShield-0.55-firefox.zip          910,649 bytes
dist/FitShield-0.55-nightly-safari.zip   910,534 bytes
```

---

## 19. Performance observations

No regression, nothing customer-visible. Catalog parse + index 4 ms;
`selectAlternative` 0.270 ms/call over 2,000 calls; catalog 218 KB; six pages
load clean in a real browser with no console errors. One inefficiency, not
user-visible: ~1.5 MB of Android-only app data is packaged into both browser
zips and read by no browser code.

---

## 20. Remaining environmental limitations

See the table under **Completion status**. Nothing fixable was deferred to them.

---

## 21. Verified facts for the later fitshield.net pass

2,687 curated brands (576 delivery, 2,111 fast food) · 111 countries ·
37 categories · 81 alternatives (43 recipes + 38 quick) · 83 locale folders ·
2,575 active redirect rules · 3 permissions + `<all_urls>` · zero runtime network
requests · full offline operation · Chrome MV3 and Firefox 140+ (Android 142+) ·
catalog 218 KB parsed in 4 ms · block page usable 360–1920 px and at 200% zoom ·
keyboard-complete · RTL-correct in six locales · six scoped pass options, one of
which follows the user's own duration setting · seven honest statistic counters ·
backup round trip preserves all durable settings.

## 22. Verified facts for the later store-listing rewrite

Permission justification: `<all_urls>` exists solely so the block-page redirect
can cover any ordering site. No content scripts; no
`tabs`/`webRequest`/`webNavigation`/`cookies`/`history`/`notifications`
permission. `chrome.tabs.query` is called but reads only tab **ids**, for
tab-bound passes. Firefox declares `data_collection_permissions: none`. Chrome
package 910,508 bytes.

Do not claim: prevented orders · calories avoided · money saved without the
estimate qualifier · single-use passes · "translated into 83 languages" · manual
browser testing · human screen-reader testing · Android or Safari verification.
