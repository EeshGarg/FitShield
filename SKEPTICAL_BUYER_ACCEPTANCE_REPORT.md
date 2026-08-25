# Completion status

Repository-local findings: **0**

| Gate | Result |
| --- | --- |
| Findings queue | 77 recorded, 77 closed, each with a verification narrative and an anchor |
| Automated tests | `npm test` — 44 test files |
| Validators | `npm run validate` — **19 audits**, gating the build |
| Packages | Chrome, Firefox, Safari-nightly and **Android APK** all build |
| Build reproducibility | two clean builds produce byte-identical zips (sha256 verified) |

> **On the counts.** This table used to freeze a run — "971 tests, 0 fail; 17
> audits, 0 warnings; 102 commits". Every one of those decayed within days, and
> a stale green light is worse than none: it invites a reader to trust a number
> instead of running the command beside it. The suite and the audit list are
> named here so they can be *run*; the audit count is pinned by a test, because
> an audit silently dropping out of `validate-all` is a real regression and a
> countable one.

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

- 2,505 brands (514 delivery, 1,991 fast food) across 111 countries
- 88 alternatives (46 recipes, 42 quick alternatives), schema v2
- 21 curated categories, every one with an English display name; a locale with no
  translation for one falls back to English, never to a raw id
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
every fast-food brand**. Craving coverage is now 2,505 of 2,505 brands.

### The two blocklists are the two switches, and brands straddled them

The popup offers Delivery and Fast food sites, and those switches *are* the two
blocklist files. 26 brands had their country domains split across both — two
McDonald's domains in delivery against fourteen in fast food, three Wolt domains
in delivery against ten in fast food — so turning **Fast food sites** off
unblocked delivery platforms and turning **Delivery** off left McDonald's Korea
blocking. 191 records were involved, and no brand is split now — a property
`test/docs-claims.test.js` asserts directly against the two files rather than
by quoting a count that a later data pass would move.

The same pass removed 30 hosts that are not places you can order food from:
fifteen same-city courier and errand platforms, the LINE messenger, a fitness
app, four general Jumia storefronts, a discount department store and eight
corporate or franchisor pages. The rule had been applied unevenly — `pickndrop.co.ke`
was blocked while `sendyit.com`, the same class in the same country, was not.
Coverage was checked rather than assumed: LINE MAN, EatFit, Jumia Food and BHC
Chicken all still block. The `courier` category retired with them and keeps its
display name for anyone whose lifetime stats carry it.

An earlier draft of this paragraph cited `minorfood.com` in that list too. A
later data pass removed it, and the sentence went on claiming a site still
blocks that the catalog no longer carries — the same decay this report was
rewritten to stop. Every brand named as still-blocked is now pinned by a test,
so citing one is a commitment rather than a flourish.

Both are user-visible changes in blocking behaviour, so both are written into
`changelog/0.55.md` in plain language rather than left for a user to discover.

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

**The 16 "orphaned" category labels were kept.** Consolidating 37 category ids
to 22 left 15 display names that no current category uses, and retiring `courier`
with the courier removals made it 16. The audit warned on all of them. Acting on
that warning would have been wrong: `blockedByCategory` is
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

## The four "impossible" items

An earlier draft of this report listed four things as physically impossible in
this environment. Two of them were not impossible; they were unattempted, and
calling them external was the same mistake in a different costume. Both are now
done.

### Android APK — built

There was no JDK and no Android SDK on this machine, and no attempt had been
made to get either. `npm run toolchain:android` now fetches JDK 17 and the
Android SDK (platform 35, build-tools 35) into `~/.fitshield-toolchain` —
outside the repository, with no PATH edit, no registry key and no `JAVA_HOME`
export, so nothing system-wide changes.

From a clean build, 82 tasks executed: debug and release APKs both build,
`lintVitalRelease` passes, and the packaged `fitshield-rules.json` and
`android-packages.json` hash-match the repository's canonical assets.
`npm run build:android` runs to completion and stages
`dist/android/FitShield-0.55-debug.apk`.

No project dependency was added. FitShield still ships zero, and its tests and
validators still add none.

### Screen-reader validation — mostly closed

Claiming this needed assistive technology conflated two things. A screen reader
does not read the DOM; it reads the platform accessibility tree the browser
computes after ARIA, label association and the accessible-name algorithm have
been applied. That tree is readable from here.

`npm run validate:a11y` drives the built package in Chromium and pulls
`Accessibility.getFullAXTree`. Across the six surfaces: **272 controls with a
computed accessible name, no unnamed control, no unresolved i18n key reaching a
label, nothing focusable hidden from assistive technology, and no skipped
heading level.** Both checks are proven to fire — an icon-only button injected
into the popup is reported unnamed, and an `h5` injected after settings' `h1` is
reported as `h1 -> h5`.

What remains is genuinely narrower than "screen-reader validation": whether
hearing it is *useful*. A machine can establish that the block page exposes a
name, a role and a state for everything; it cannot judge whether the
announcements land in a helpful order.

### Safari — reduced to one command

Wrapping the payload still needs macOS and Xcode. That is real. But shipping the
payload unexamined was not required by it, and the manifest declared no minimum
Safari version, so the converter would have picked its own deployment target.

Two things here need Safari 16.4 and neither fails loudly below it: the MV3
background service worker, and `chrome.storage.session`, which holds the
block-page redirect token and is deliberately written to degrade quietly. On an
older Safari it would have kept working while re-minting the token per worker
generation — exactly the kind of thing a device finds out first.

`npm run validate:safari` derives the floor the payload actually requires from
what it uses, fails when the declared minimum is below it, and greps the shipped
sources for APIs Safari does not implement (those are `undefined` there, so the
feature silently does nothing rather than failing). The remaining step is the
single converter command in `dist/apple/BUILD.txt`.

### Human acceptance — reduced to four questions

Still a person's call, and it should be. What changed is everything around it.

`npm run capture` screenshots all ten surfaces in both palettes at the sizes
where layouts break. `docs/ACCEPTANCE.md` names the four judgements that
actually need a human — is the pause the right length, does the page respect a
decision to continue, is the recipe credible, do the statistics feel honest —
and lists what is already verified so none of it gets re-checked by hand.

Two bugs in that capture tool were found by looking at its output rather than
trusting it. Emulating `prefers-color-scheme` alone produced two identical DARK
sets labelled "dark" and "light", because `themeMode` is a stored setting whose
default is dark. Setting `themeMode: "light"` did not fix it either: with an
explicit choice the pages paint the stored palette, which Settings writes at the
moment the user picks. Both palettes are now captured through Theme = System,
the path that genuinely resolves against the OS.

A mislabelled screenshot is worse than no screenshot — it shows the reviewer the
wrong thing under the right name.

---

## Still external

Two, both honestly so:

1. **The macOS/Xcode wrap.** `xcrun safari-web-extension-converter` does not
   exist off macOS. Every prerequisite is complete, the payload is audited
   against Safari's actual constraints, and the exact command is in
   `dist/apple/BUILD.txt`.
2. **Four judgement calls**, in `docs/ACCEPTANCE.md`, plus listening to a screen
   reader read the block page. A machine can prove the announcements exist; only
   a person can say whether they help.
