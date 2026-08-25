# Completion status

Repository-local findings: **0**

| Gate | Result |
| --- | --- |
| Findings queue | 77 recorded, 77 closed, each with a verification narrative and an anchor |
| Automated tests | 971 run, 971 pass, 0 fail |
| Validators | 15 audits, **0 errors, 0 warnings** |
| Packages | Chrome, Firefox and Safari-nightly build |
| Build reproducibility | two clean builds produce byte-identical zips (sha256 verified) |
| Commits this pass | 96 |

Closure was made expensive on purpose. `tools/policy-audit.js` rejects a queue
record with no verification narrative, one with no anchor, and one whose prose
hedges instead of reporting — it holds a list of six such phrasings, the family
that says a thing is fixed without anyone having checked. Those are not a style
preference; they are the failure mode this pass exists to correct. The list is
in the audit, and this report is held to it too: an earlier draft of this
paragraph quoted the phrases as examples and the audit refused the report until
I stopped.

---

## What the product is, as measured

- 2,535 brands (538 delivery, 1,997 fast food) across 112 countries
- 88 alternatives (46 recipes, 42 quick alternatives), schema v2
- 22 curated categories, every one with a display name in all 83 locales
- Permissions: exactly `storage`, `declarativeNetRequest`, `alarms`
- Network requests made by the shipped extension, measured in a real browser
  across a full session: **0**

---

## The defects that mattered

### The catalog was largely fabricated, and nothing could see it

804 entries — 38% of the fast-food file — carried one identical tuple:
countries `["JP"]`, specialties `["rice dishes","set meals","sides"]`, category
`fast_casual`, with names generated from the domain. 1,230 brands claimed Japan
while 118 have a `.jp` domain. Aldi Germany, Auchan France and 7-Eleven Vietnam
were all filed under Japan, and the block page printed that country list to the
user.

Classification had been done by substring, so `sTEAk`, `CHArgrill` and `jusTEAt`
matched "tea": Spur Steak Ranches, Wang Steak and Just Eat Denmark were
categorized `smoothie`, with milk-tea specialties invented to match.

This was invisible because of a second defect. `getRuleCatalog` overwrote each
brand's curated category with its blocking-rule bucket before the UI ever saw
it, so every fabricated value was masked by `fastfood` or `delivery` on screen.
Fixing the mask is what exposed the data.

Repaired: 566 countries corrected from the domain's own ccTLD, 456 unverifiable
ones cleared rather than left claiming Japan, 722 fabricated specialty tuples
cleared, 550 names repaired, 113 duplicate rows removed. 33 hosts removed with a
named reason each — 12 parcel couriers (blocking them blocked package tracking),
9 recipe sites (the thing the block page tells the user to go do), 6 parent
apexes whose food surface is separately listed and still blocked, 5 general
commerce, 1 standards body. Four entries removed on weaker grounds were restored
and their records completed instead; nothing was removed for thin data.

### The masked category had two further consequences

`recordBlockedBrand` counted the same masked field, so Settings' "Most blocked
categories" had only ever accumulated three bucket names while the category
picker beside it listed the real vocabulary — one page, two vocabularies.

And `recipes.js` reads `category` as its middle craving signal. It was reading
`"fastfood"`, which the taxonomy does not contain, so that tier was **dead for
every fast-food brand**. Craving coverage is now 2,535 of 2,535 brands.

### A website could author the user's own statistics

Direct messaging was impossible and iframes were refused, but top-level
navigation was not: any site could send the tab to
`chrome-extension://<id>/warning.html?site=delivery-doordash-com`, which passed
every provenance check because it genuinely was our origin at frame 0. Four
navigations moved lifetime interruptions from 2 to 6 and wrote `doordash.com`
into the most-interrupted list. The brand being blocked could write the user's
record of being blocked by it.

Fixed with a 128-bit token in the redirect URL, held in `chrome.storage.session`
and adopted from the persisted rules on a cold start so a browser restart cannot
lose a real interruption.

### The MV3 default CSP is not what it looks like

It constrains `script-src` and `object-src` and leaves `img-src` and
`connect-src` open to any host. Measured, not assumed: a remote `<img>` injected
into `settings.html` loaded — the exact shape of a tracking beacon in an
extension whose whole promise is that it has none. A tight `extension_pages`
policy is now declared, and the audit that used to warn about *having* a custom
CSP now fails on a policy that re-opens egress instead.

`frame-ancestors 'none'` was measured and deliberately omitted: Chrome accepts
it but does not apply it to a web-accessible resource loaded by a website, so it
would read as protection while providing none.

### Concurrent pass grants erased each other

`grantPass` did an unserialized read-modify-write of the pass list. Two brands
granted, one stored; three granted, one stored; the same brand in two tabs
granted twice, stored once. The customer sat through the pause on both tabs and
was told yes on both — then the tab whose pass was erased was interrupted again
on its next load, while "Temporary passes used" counted a pass that did not
exist. `repeatHistory` rode on the same write and was lost with it.

### 978 strings that were never translations

761 English strings stranded in non-Latin-script locales — a Bulgarian user read
`Куриерска услуга · Доставка · Бързо хранене · Bakery · Grocery · Restaurant`.
174 stray pipes in Odia, so 154 labels rendered with a vertical bar in front of
them. 43 welded suffixes (`блокироватьing`). 3,545 language names that simply
repeated the endonym printed beside them — `עברית · עברית` instead of
`Hebrew · עברית`.

The prune tool had reported clean. It was wrong: `referenced()` matched
*comments*, so the sentence in the source announcing a key's death was the
evidence it was alive.

### Accessibility

The destructive-confirmation dialog declared `aria-modal="true"` and
contradicted it three ways: it opened focus on **Confirm**, so the Enter that
opened it could confirm it on key repeat; Tab left after one press into the
130-control page behind a dimmed overlay; and dismissing dropped focus on
`<body>`. The block page's own comment claiming every control uses a 44px tap
target was false in three places. The popup was locked to a 516px floor with
`overflow-x: hidden`, so above ~155% zoom the entire right-hand column — the
master switch and all three blocklist switches — was clipped and unreachable.

### Dead controls and dead claims

`repeatWindowMinutes` was read in six places, including a newly added change
watcher, and written by nothing — retention could only ever be the default while
the key rode in every backup and was named by a reset button.
`settingsDelaySeconds` was documented, unit-tested and enforced by nothing.
Settings showed "Times you continued" and "Temporary passes used" side by side
as independent measurements when `grantPass` writes both and they cannot differ.
The wizard promised that changing a value "simply moves you to Custom" when
nothing ever wrote the custom profile.

---

## Two things I got wrong

**A broad `git add` swept four other agents' files into my commit.** Three
times. It cost nothing permanent, but it is the same class of hazard that had
already destroyed a lane's work earlier in this project. Every commit since
names explicit paths.

**I made closing a finding cost one word.** The completion guard read
`item.status !== "closed"`, so the cheapest way to empty a 77-item queue was to
write "closed" 77 times — an assertion of completion standing in for the work,
which is precisely the failure the guard exists to prevent, one file over. It
now requires a narrative and an anchor, and I proved it by trying to cheat it.

Related: the queue had never been reconciled at all. 77 findings, not one
carrying a status. Much of the work had been done, but nothing was ever verified
closed *against the finding that produced it*, so on the record all 77 were
open.

---

## Judgement calls, and why

**The 15 "orphaned" category labels were kept.** Consolidating 37 category ids
to 22 left 15 display names that no current category uses, and the audit warned
on all 15. Acting on that warning would have been wrong: `blockedByCategory` is
a lifetime map in each user's own profile, so those ids are still present for
anyone already blocked on one. Deleting the labels would not have printed a raw
id — the namer falls through to a prettifier — it would have silently downgraded
a localized name to prettified **English**, only for users with history, in the
one panel that is about their past. No fresh-profile test would ever have caught
it. The audit now records the retired ids and treats a *missing* retired label
as an error.

**`blockedByCategory` was pruned, not reset or rebuilt.** Only the two legacy
bucket keys are removed. Every genuine count stays, and the interruptions behind
the removed label remain counted per brand and per country where they were never
mislabeled. Rebuilding the map from `blockedByDomain` was possible and rejected:
it would have written counts that were never recorded.

**Validator warnings were fixed, not silenced.** The count went 93 → 0. Every
one was either a real condition that got fixed, or a check asking the wrong
question that was corrected — the ingredient matcher stemmed `"tomatoes"` to
`"tomatoe"` so it could never match a step saying "tomato". Where a check was
relaxed, a paired test pins both the case it must now accept and the case it
must still report.

---

## What this environment cannot do

Four items, each with every repository-local prerequisite complete and
everything automatable automated.

1. **Safari app** — `dist/FitShield-0.55-nightly-safari.zip` builds here;
   wrapping it requires `xcrun safari-web-extension-converter` and Xcode, which
   are macOS only. Steps are in `dist/apple/BUILD.txt`.
2. **Android APK** — assets, rules and package mapping generate and validate
   here; the final Gradle step needs a JDK and the Android SDK.
   `npm run build:android` now exits non-zero when Gradle fails rather than
   reporting success over a broken APK.
3. **Screen-reader validation** — every mechanically checkable property is
   tested (focus order, focus visibility, live-region wiring, accessible names,
   contrast ratios, reduced-motion, tap targets). Confirming how a real screen
   reader announces the block page needs assistive technology not present here.
   No claim of screen-reader testing is made anywhere in this repository.
4. **Human acceptance** — whether the friction feels right rather than
   manipulative is a judgement only a person can make.

Real-browser verification WAS performed for everything else, against the built
packages in Chromium 149 over the DevTools protocol and Firefox over the remote
debugging protocol, with zero added dependencies.
