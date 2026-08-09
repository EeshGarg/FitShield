# FitShield 0.55 — skeptical-buyer acceptance report

Adversarial acceptance pass against the **production packages**, not the source
tree. Baseline was the completion report from the previous pass; every claim in
it was re-checked rather than carried forward.

---

## 1. Verdict

> ## NOT READY

Not a judgement on the product's design, which is strong. It is a judgement on
eight unfixed release blockers, three of which lose user data:

- Export → import **deletes every custom blocked site**, then reports success.
- Restoring a 0.54 backup **zeroes the statistics** the migration was written to
  preserve.
- The schedule controls in the popup and in Settings **render defaults rather
  than the saved schedule**, with both time inputs disabled on load.

The blocking engine, the block page, the privacy posture, and the alternatives
catalog all survived scrutiny well. The damage is concentrated in two seams:
**schedule state** (five blockers) and **backup/migration** (three). Both are
fixable without redesign, and none is architectural.

Three blockers were fixed during this pass, including the one that mattered most
for trust — see §3.

---

## 2. Buyer scorecard

| Dimension | Score | Why below 9 |
| --- | ---: | --- |
| First impression | 8 | Loads clean, no console errors on any of six pages, blocks on first navigation with no setup. Onboarding step 3 asks about delivery *and* fast food but its body describes only delivery. |
| Onboarding clarity | 5 | "Workday lunch" is silently overwritten to every day. The printed promise "doing so simply moves you to Custom" is never true — nothing writes that profile. Two separate schedule controls in two differently-named sections for one setting. |
| Blocking reliability | 9 | 2,575 rules registered in both browsers; seven brands across seven categories verified interrupted by real navigation; `example.com` untouched. Held at 9 only because scheduled blocking is unreliable (below). |
| Warning-page usability | 9 | The strongest surface in the product. One decision, three exits, no overflow at any width from 1920 to 360, both exits above the fold at 200%-equivalent zoom. |
| Alternative usefulness | 7 | 81 real entries, genuinely executable. But equipment arrays that mean OR are enforced as AND (the only oven-capable fries and the only microwave-only miso soup are invisible to the users they were written for); every drink is iced; wings need an air fryer and 26+ minutes so the "I'm hungry" path can never answer a wings craving. |
| Bypass usability | 6 | Six scoped passes work exactly as labelled and expire on time — verified end to end through the real countdown. But the "Site open time" slider is dead, no UI can end a pass early, and "Reset blocking settings" does not clear one. |
| Scheduling | 2 | Five blockers. The worker rewrote saved schedules (fixed); the UI still never renders the saved schedule; nudging a simple time destroys a multi-window schedule. |
| Statistics honesty | 8 | Vocabulary is genuinely honest and preview records nothing — both verified in a real browser. "Chose" double-counts within one interruption, a reload adds an interruption, and "continued" / "passes used" are the same event shown twice. |
| Privacy | 8 | Zero outbound requests across four surfaces; full function offline; permissions exactly as claimed in both production manifests. Was 3 before this pass — the intent answer was being persisted against an explicit on-screen promise. `repeatHistory` is still an unexpiring per-domain visit log absent from the storage table. |
| Accessibility | 6 | Full keyboard path works, Enter activates, the countdown does not flood a screen reader, RTL now correct. But light theme puts two block-page buttons at 1.21:1, switches have no accessible names, and the confirm dialog does not trap focus. |
| Chrome quality | 9 | 45/45 real-browser checks. |
| Firefox quality | 8 | Installs with **zero manifest warnings**, event page runs, 2,575 rules, engine + core boot, migration runs. Scored below Chrome only because UI-level flows were not driveable through my harness. |
| Data durability | 3 | Backup round trip loses custom blocked sites; a 0.54 backup loses statistics; a migrated pass for any hyphenated domain points at the wrong host. |
| Repository trust | 9 | 14 validators, 430 tests, drift guards that caught two of my own mistakes mid-session. Docs claimed things the code did not do in three places found this pass. |
| **Overall product confidence** | **6** | A genuinely good product with a well-defended core and a soft, under-tested periphery. |

---

## 3. Findings

**101 confirmed** (11 blocker / 19 high / 57 medium / 14 low), **73 refuted** by
an independent adversarial pass. Full machine-readable list retained at
`findings.json` in the run output.

### Fixed this pass

| Sev | Finding | Evidence it is fixed |
| --- | --- | --- |
| BLOCKER | The "what brought you here?" answer was persisted as `pass.reason`, while Settings promises "the answer is never saved" | `reason` removed from `createPass`, `normalizePass`, the migration and `grantPass`; 2 tests |
| BLOCKER | The allergen "hard filter" did nothing — `readSettings` had no `avoidAllergens` case, so the block page received `undefined` | `normalizeAllergens` added; 4 tests, one proving peanut entries actually disappear |
| BLOCKER | The worker rewrote saved schedules — "Workday lunch" (Mon–Fri) became every day | `syncLegacySchedule` returns early unless the schedule is genuinely expressible by the flat trio; 3 tests |
| HIGH | 294 mangled strings in 9 locales (`"Take one минута."`, `"блокироватьing"`, `"Использоватьful"`) | removed → clean English fallback; `tools/locale-hybrid-audit.js` now fails the build |
| HIGH | No RTL support — six RTL locales laid out left-to-right | `dir`/`lang` stamped from the active locale; verified `rtl` in ar/he/fa/ur, `ltr` in en/ja |
| HIGH | `lang` was hardcoded `"en"`, so screen readers used an English voice for every language | fixed with the above |
| MEDIUM | Settings scrolled sideways below ~412px | 412 → 347 at a 360px viewport |
| — | *(from the prior session, verified still fixed)* view-counting, pass-label corruption, single-use claim, custom-alternative pantry scoring | 430 tests |

### Release blockers still open

1. **[backup] Export → import silently deletes every custom blocked site.**
2. **[migration] A 0.54 backup restored into 0.55 zeroes the statistics** — the import stamps `schemaVersion: 2` before the counters are translated, so the migration never runs on them.
3. **[migration] Restoring a settings backup deletes every custom blocked domain, then reports success.**
4. **[dead-ends] The popup and Settings schedule controls always render defaults, never the saved schedule, and both time inputs load disabled.**
5. **[dead-ends] Nudging the simple start/end time destroys a multi-window advanced schedule.**
6. **[migration] After upgrade both surfaces show the schedule as OFF at 18:00–23:00 while blocking is actually restricted to the real 0.54 window.**
7. **[migration] Editing the advanced schedule overwrites the migrated 0.54 hours with 18:00–23:00.**
8. **[passes] The "Site open time" slider is dead** — no pass uses `passDurationMinutes`, yet onboarding, popup and Settings all state a duration from it.

4–7 are one root cause: the schedule UI has no `chrome.storage.onChanged` listener and no read-back of the stored schedule. Fixing that seam closes four blockers and four highs.

### High (19) — unfixed highlights

- `warning.html` is web-accessible to `<all_urls>` with no provenance check, so **any website can inflate the user's statistics** with a hidden iframe.
- Import writes `theme` straight to storage unvalidated; a hostile backup can make Settings and the popup **fetch a remote URL**.
- "Reset blocking settings" leaves an active pass in place and leaves the friction profile behind.
- The report "Open an email draft" button targets a mailbox with **no MX record** (see §8).
- Light theme renders two block-page buttons at **1.21:1** — an invisible label.
- Popup says "Shield up" during hours when the schedule has blocking off.

---

## 4. Real-browser evidence

Stated precisely, because the previous report could not claim any of this.

| | Chromium | Firefox |
| --- | --- | --- |
| Browser | Chrome/**149.0.7827.55** (Playwright cached build) | Firefox **153.0.1** (system install) |
| OS | Windows 11 Pro 10.0.26200 | same |
| Package under test | `dist/chrome/` (production, freshly built) | `dist/firefox/` (production) |
| Install method | `--load-extension` + `--disable-extensions-except`, **fresh profile per run** | `installTemporaryAddon` over the Remote Debugging Protocol — the same call `web-ext` makes |
| Driver | Chrome DevTools Protocol | Firefox RDP + watcher/console actors |
| Dependencies added | **none** (Node's global `WebSocket`/`fetch`/`net`) | none |
| Level achieved | **automated real-browser** | **automated real-browser** |
| Checks | **45/45 pass** | **9/12 pass** |

**Chromium flows exercised:** extension load; worker boot; production manifest
permissions; real top-level navigation to 7 blocked brands across 7 categories;
a non-food control site; block-page render; show-another; the no-cook filter;
preview records nothing; interruption counted once; choose ≠ made; the real
10-second countdown unlocking Continue; the pass chooser's 6 options; pass
granted, site reachable, other sites still blocked, expiry restoring blocking;
popup; Settings (15 sections); console-error sweep over 6 pages; overflow at
1920/1366/900/640/420/360; exits above the fold at 200%-equivalent zoom;
keyboard-only traversal; Enter activation; **network hard-disabled**; an
outbound-request sniff over 4 surfaces; a hostile custom alternative
(`<img onerror>`, `<script>`, emoji, quotes); oversized/malformed custom data;
six locales including RTL.

**Firefox flows exercised:** package installs; **zero manifest warnings**; event
page RUNNING (`persistentBackgroundScript: false`); engine + core boot with no
boot error, 2,687 brands; **2,575 DNR rules actually registered**; schema
migrated to v2 on a fresh profile; catalog loads (43 + 38); `moz-extension://`
block-page URL resolves; pass presets and stat vocabulary identical to Chromium;
engine blocks `doordash.com` and `order.kfc.com`, leaves `example.com`.

**Not achieved, stated plainly:**

- **No human manual testing.** Everything above is automated.
- **Firefox UI pages were not driven.** RDP gave me the background context, not
  page-level interaction, so Firefox's popup/Settings/block-page *rendering* is
  unverified. The three Firefox failures are harness limitations I did not
  re-run: `FS_DIAG` eval timed out, my `optional_permissions` assertion treats
  Firefox's normalized empty array as truthy, and my "no external URL" check
  flagged template literals (`https://${domain}/`) used to build the
  user-initiated navigation target.
- **No screen-reader testing** — no AT available in this environment.
- **Android not built** (no SDK/Gradle). **Safari Xcode project not generated**
  (needs macOS). Both stage and zip only.

---

## 5. Customer scenarios

| | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| A | Five-minute new customer | **FAIL** | Can preview, bypass and see data location. Cannot trust the schedule answer — "Workday lunch" was overwritten, and the schedule UI shows defaults. |
| B | "I need DoorDash right now" | **PASS** | Real countdown unlocked, 6 labelled options, `site10` granted for exactly 10 min, doordash.com reachable, kfc.com still blocked, expiry restored blocking. |
| C | "I'm hungry and impatient" | **PASS** | One alternative, four filters, `Show another` rotates. |
| D | "Your recipe is useless" | **PARTIAL** | Show-another and no-cook work; pantry ranking is honest since the prior fix. But equipment OR-vs-AND hides valid options. |
| E | "Stop judging me" | **PASS** | No shaming, no streaks, no scores found in the copy audit. |
| F | "Prove you're private" | **PASS** | Zero outbound requests; permissions exactly `storage`, `declarativeNetRequest`, `alarms` in both production manifests; intent no longer persisted. |
| G | "I use Firefox" | **PARTIAL** | Background verified equivalent; UI unverified. |
| H | "I installed an update" | **FAIL** | Statistics zeroed from a 0.54 backup; schedule displayed ≠ schedule enforced. |
| I | "I want everything gone" | **PARTIAL** | Factory reset works; "Reset blocking" leaves passes and friction profile. |
| J | "I'm offline" | **PASS** | Network hard-disabled: brand, alternatives, ingredients, steps, rotation all fine. |
| K | "I zoom to 200%" | **PASS** | No overflow 1920→360; both exits above the fold at 640px. |
| L | "Keyboard only" | **PASS** | Tab reaches every action; Enter activates. |
| M | "I don't speak English" | **PASS (now)** | Was FAIL — 33 locales shipped pidgin headlines. Now clean English fallback, and RTL lays out correctly. |

---

## 6. Recipe review

- **35 entries manually read** (20 full recipes + 15 quick alternatives) across cravings and regions.
- **Issues found: 6.** Steps calling for unlisted ingredients; `blended-mocha-frappe` says cooled coffee in the ingredient and warm coffee in step 1; `garlic-soy-noodles` labelled vegan while its noodle line offers egg noodles with egg absent from allergens; `totalMinutes` excluding preheat/boil time, which inflates the "Fastest" filter; two entries claiming a diet for a generic packaged product with no check-the-label caveat; card descriptions stating ingredient counts that contradict the list beneath them.
- **Issues fixed: 0** — all are MEDIUM and were deprioritised behind blockers.
- **Weak categories:** ice cream (2), bakery (2), wings (all 3 need an air fryer and 26+ min), drinks (every one is iced — no hot coffee, tea or chocolate anywhere), salad (7 tagged, only 2 are salads).
- **Is 81 an honest count?** **Yes as a count, no as coverage.** The entries are real and distinct. But `late-night` is tagged on 37% of the catalog and is reachable as a primary craving, so it can outrank the craving the user actually has.

---

## 7. UI review

- **Widths:** 1920, 1366, 900, 640, 420, 360 — block page clean at all six.
- **Zoom:** 200%-equivalent (640px) — no overflow, both exits above the fold, tap targets 44px.
- **Keyboard:** full block-page decision reachable; Enter activates. Focus is invisible on every `<select>`, the three theme buttons, and the Settings support link.
- **Screen reader:** not tested (no AT available). Live-region *behaviour* was read from source: the countdown correctly announces milestones only, but the popup rewrites a live region once per second while a pass runs.
- **Responsive defects:** settings overflow **fixed**; the popup is locked to a 516px minimum with `overflow-x: hidden`, so at high zoom the right-hand control column is clipped and unscrollable (unfixed).
- **Copy defects:** 10 confirmed, including three meanings for "pause", four labels for one concept, `"1 time window(s) set"`, and Title/sentence case alternating down one page.

---

## 8. Privacy audit

**Permissions** — verified in both *production* manifests and at runtime:
`storage`, `declarativeNetRequest`, `alarms`, plus `host_permissions:
<all_urls>`. No `optional_permissions`, no `externally_connectable`, **no
content scripts**. `chrome.tabs.query` is called but only maps to tab *ids* for
tab-bound passes.

**Runtime network: none.** Four surfaces sniffed at the protocol layer — zero
non-`chrome-extension://` requests. The full flow works with the network hard
disabled.

**Stored data** — aggregate counts keyed by curated brand domain / category /
country; no URL, path, query string, page title, or per-visit timestamp.

**Caveats that must not be glossed:**

- `repeatHistory` **is** a per-domain visit-timestamp log. It is bounded (60 domains × 12 entries) but has **no age expiry**, is described in-code as "short-lived", and has no row in the storage table.
- `warning.html` is web-accessible to `<all_urls>` and records statistics with no provenance check — any site can inflate counters via a hidden iframe.
- `redactReportSubject` leaks the full URL including query string whenever the host is not a dotted-alpha domain, contradicting the on-screen note.
- **`reports@fitshield.net` has no MX record.** The mail button is a dead end. Copy-to-clipboard works, so §14's "at least one functional path" holds — but the mail button should be removed or the mailbox provisioned before release.

---

## 9. Migration and durability

Exercised: fresh install → v2 (verified in **both** browsers on fresh profiles);
0.54-shaped profile → 0.55; migration idempotence.

**Failures:** backup round trip loses custom blocked sites; a 0.54 backup zeroes
statistics; a migrated pass for any hyphenated domain points at the wrong host;
"Reset blocking" removes the dead legacy `siteBypasses` key instead of the live
`passes`.

---

## 10. Chrome / Firefox parity

Verified identical: permission set, DNR rule count (2,575), engine brand count
(2,687), schema version, pass presets, stat vocabulary, catalog.

Intentional differences: Chrome uses an MV3 service worker, Firefox a
non-persistent event page (`background.scripts`); the Firefox manifest carries
`browser_specific_settings` (id `fitshield@usha.dev`, min 140, Android 142,
`data_collection_permissions: none`), which `build.js` strips for Chrome.

No silent feature degradation found. Firefox UI rendering remains unverified.

---

## 11. Localization reality

83 locale folders. **This pass removed 294 mangled strings** that were neither
translated nor English.

Recommended public wording — the accurate form:

> Available in 83 languages. Most are partially translated; anything not yet
> translated is shown in English.

Do **not** write "translated into 83 languages". Coverage after the sweep is
lower than the 59–61% previously reported, because what was removed was counted
as translated. RTL now lays out correctly in ar/fa/he/ps/ug/ur.

Still open: `learnMoreLink` is stale English ("Visit fitshield.net") in all 82
non-English locales, and the store description is verbatim English in 33.

---

## 12. Tests

| | |
| --- | --- |
| Previous | 421 |
| Added | 9 |
| **Current passing** | **430** |
| Failing | 0 |
| Validators | **14** (was 13 — `locale-hybrid-audit` added), 0 errors, 101 warnings |
| Real-browser checks | **45 Chromium + 9 Firefox** |
| Builds | Chrome 910,508 B · Firefox 910,649 B · Safari-nightly 910,534 B |

---

## 13. Performance

No regression, and nothing customer-visible. Catalog parse + index 4 ms;
`selectAlternative` 0.270 ms/call over 2,000 calls; catalog 218 KB. Six pages
loaded in a real browser with no console errors and no perceptible delay.

One real inefficiency, not user-visible: **1.5 MB of Android-only app data is
packaged into both browser store zips** and read by no browser code.

---

## 14. Known limitations

- No human manual testing; no screen-reader testing.
- Firefox UI pages not driven — background context only.
- Android APK not built; Safari Xcode project not generated.
- `reports@fitshield.net` has no MX record.
- 8 blockers, 19 highs and 57 mediums remain open.

---

## 15. Deferred non-release ideas

Recipe localization; hot-drink alternatives; per-brand block-page notes; a
human-readable export format; ending a pass early from the popup (arguably a
HIGH, not an idea — the handler already exists and nothing calls it).

---

## 16. Verified facts for later website work

2,687 curated brands · 576 delivery · 2,111 fast food · 111 countries ·
37 categories · 81 alternatives (43 recipes + 38 quick) · 83 locale folders ·
3 permissions + `<all_urls>` · 2,575 active redirect rules · zero runtime network
requests · full offline operation · Chrome MV3 + Firefox 140+ (Android 142+) ·
catalog 218 KB, parsed in 4 ms · block page usable 360–1920px and at 200% zoom ·
keyboard-complete · RTL-correct.

---

## 17. Verified facts for later store-listing work

Permissions justification: `<all_urls>` exists solely so the block-page redirect
can cover any ordering site; there are **no content scripts**, and no
`tabs`/`webRequest`/`webNavigation`/`cookies`/`history`/`notifications`
permission. Firefox declares `data_collection_permissions: none`. Chrome package
910,508 bytes.

Do not claim: prevented orders, calories avoided, money saved (without the
estimate qualifier), single-use passes, "translated into 83 languages", manual
browser testing, or Android/Safari verification.

---

## 18. Final skeptical-customer perspective

I installed this wanting to catch it lying, and the first place I looked was the
one that usually pays: the privacy promise. It lied. Right next to a toggle that
says *the answer is never saved*, FitShield was writing down which ordering site
I opened, the exact millisecond, and my own words for why I gave in. That is the
single most sensitive thing this product could keep, and it kept it by default.
It is fixed now, and I will say plainly that the fix is the right one — the
field is gone, not renamed — but I found it by reading the code, not because the
product told me. That is the thing that would make me hesitate to recommend it
to someone who could not read the code themselves.

Then I set a schedule, because that is the setting I would actually rely on. I
chose "Workday lunch". FitShield told me weekdays and stored every day, and the
settings page went on showing me the choice I made rather than the one it was
enforcing. I would have discovered this by being interrupted on a Saturday, and I
would have concluded the blocker was broken rather than the schedule — and I
would have been right. Worse, when I exported my settings as a precaution and
imported them back, my custom blocked sites were gone and the import said it
succeeded. A backup that quietly loses data is worse than no backup, because I
would have trusted it.

What is unusually good is the part most products get wrong. The block page is
genuinely calm — one decision, three ways out, no wall of recipes, no red, no
scolding. It works at 200% zoom and with only a keyboard, which almost nothing
does. The alternatives are real food with real quantities, not aspirational
nonsense. The statistics refuse to tell me I "saved" anything, which is the first
time I have seen a blocker decline to flatter itself. And the privacy claim, the
part I most expected to be marketing, is otherwise true: I disabled the network
entirely and the whole thing kept working, with not one outbound request from any
surface.

What still feels amateur is everything one layer out from that core. Two schedule
controls in two differently-named sections for one setting. A slider labelled
"Site open time" that no pass has ever used. An allergen filter that until this
week was decorative — and that one is not a papercut, that is someone with a
peanut allergy being shown peanut recipes by a control that said it would not.
A "check FitShield is working" button that opens a developer console telling me
to run `node build.js`. An email button pointing at a mailbox that does not
exist. Individually small; together they read as a product where the middle was
finished and the edges were not.

Would I keep it installed after a week? Yes — but only because I do not use the
schedule, which is the feature most people would reach for first. The core is
better than most paid alternatives. The periphery is not ready, and the gap
between them is exactly where a skeptical buyer looks. Close the schedule seam
and the backup seam and I would stop looking for reasons to uninstall; right now
I did not have to look very hard.
