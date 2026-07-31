# FitShield — Block Screen Fix Verification

This checklist proves the FitShield block screen works in an unpacked Chrome /
Brave / Edge install and in a production build.

## TL;DR — the one thing that matters

**Load `extension/` directly, or `dist/chrome` from a build. Both work.**

The repo is split into three source folders — `extension/` (UI + service worker),
`FS Engine/` (the blocking engine), and `data/` (blocklists + recipes). The
service worker does `importScripts("blocklist.js")`, and the pages fetch
`blocklists/*.json`, `data/recipes.json`, and `changelog.json` at runtime. Those
runtime artifacts are **committed into `extension/`** (generated/copied from the
canonical `FS Engine/` + `data/` by `npm run sync`), so Chrome can load
`extension/` with no build step:

```
# chrome://extensions → Developer mode → Load unpacked → select extension/
```

For a store-shaped package (and Firefox), build it:

```
node build.js            # validates, then writes dist/chrome (+ dist/firefox + zips)
# chrome://extensions → Developer mode → Load unpacked → select dist/chrome
```

The committed `extension/` copies can't silently drift from canonical: after any
edit to `FS Engine/` or `data/`, run `npm run sync`. A stale copy fails
`npm run validate` (the build gate) and `npm test` with a one-line fix. If a
folder is ever loaded without the engine bundle, the service worker console
prints a loud, actionable error instead of failing silently (see “Diagnostics”).

---

## Automated proof (run these first)

```bash
npm run sync                 # regenerate extension/'s committed runtime artifacts
npm test                     # tests incl. block-page render, engine bundle, sync freshness
npm run validate             # audits: manifest, permissions, SW↔engine linkage, sync, CSP…
npm run build                # validation-gated packaging → dist/chrome + dist/firefox
npm run verify:unpacked          # DYNAMIC: build a package, load its engine, block a real domain
npm run verify:unpacked extension  # same, but against the extension/ source folder directly
```

`verify:unpacked` is the closest automated stand-in for the manual test: it
evaluates the target folder's `blocklist.js` as a worker script, fetches its
`blocklists/*.json`, and asserts a real curated brand (e.g. `order.mcdonalds.com`)
is blocked while a guaranteed-absent host is not. Pass `extension` to prove the
source folder loads unpacked; pass nothing to build a temp package and prove that.

---

## Manual browser test (the real success condition)

1. **Pick a folder to load**
   - [ ] Fastest: `npm run sync`, then load **`extension/`** directly (no build).
   - [ ] Store-shaped: `node build.js` completes with `validate-all: PASS` and
         prints `dist/chrome`; load **`dist/chrome`**.

2. **Load unpacked**
   - [ ] `chrome://extensions` → enable **Developer mode**.
   - [ ] **Load unpacked** → select **`extension/`** (or **`dist/chrome`**).
   - [ ] The FitShield card appears with **no errors** on the card.

3. **Check for load / service-worker errors**
   - [ ] The card shows no red **Errors** button.
   - [ ] Click **service worker** (the “Inspect views” link) → Console shows
         `[FitShield] service worker booted · engine loaded · v<version>` and
         `[FitShield] blocklists loaded — N delivery + M fast-food brands`.
   - [ ] No red errors in that console.

4. **Visit a known blocked domain**
   - [ ] In a normal tab, go to a curated brand, e.g. `https://www.doordash.com`
         or `https://www.mcdonalds.com`.

5. **Confirm the redirect + block screen renders**
   - [ ] The navigation is redirected to the FitShield block page
         (`chrome-extension://…/warning.html?...`).
   - [ ] The page shows the “Take a moment” card, the brand it interrupted, a
         countdown, and **one** alternative with its ingredients and steps.
   - [ ] Expanding “Why was this interrupted?” shows domain / type / category /
         countries.
   - [ ] **Show another** changes the alternative; the Closest / Fastest /
         No cooking / Microwave filters each change it too.
   - [ ] No CSP or module errors in the block page’s DevTools console.

6. **Confirm the statistics move, and only the right ones**
   - [ ] Open settings → Protection Status. “Ordering pages interrupted” went up
         by one after the block page showed.
   - [ ] Pick **I’ll make this** → “Alternatives you chose” increments and the
         page says it has recorded an intention, not a meal.
   - [ ] “Alternatives you marked as made” stays at its previous value until you
         confirm it yourself from the popup.

7. **Confirm the continue flow**
   - [ ] When the countdown reaches 0, **Continue anyway** unlocks.
   - [ ] Clicking it offers the pass options (once / 10 min / 30 min / until the
         tab closes / pause everything). Choosing one opens the brand’s site and
         does not immediately re-block.
   - [ ] Returning to the same brand soon afterwards shows a slightly longer
         pause **with an on-screen explanation of why**.

7b. **Confirm preview mode records nothing**
   - [ ] Settings → Preview and test → **Preview the block page**. The banner
         says nothing is recorded.
   - [ ] Use it fully (show another, choose one, open the pass options). None of
         the statistics in settings change, and the real site stays blocked.

8. **No console errors anywhere**
   - [ ] Service worker console: clean.
   - [ ] Block page console: clean.

---

## Diagnostics page

A live runtime view ships at **`chrome-extension://<extension-id>/diagnostics.html`**.
The exact URL is printed in the service-worker console on boot
(`[FitShield] diagnostics page: …`). It shows:

- manifest version, whether the **service worker responded**, and whether the
  **FS Engine bundle loaded**,
- **brands loaded** and the delivery / fast-food split,
- **live redirect rules** currently registered in Chrome,
- the **last blocking decision** and **last error**,
- the **block page URL**, and
- a **“test a domain”** box that runs any hostname through the engine (no
  navigation, nothing stored).

If blocking isn’t working, this page names the reason — most often “service
worker not responding”, which means a source folder was loaded instead of
`dist/chrome`.

---

## Firefox (parity)

`node build.js` also writes `dist/firefox`. Load it via
`about:debugging` → **This Firefox** → **Load Temporary Add-on** →
`dist/firefox/manifest.json`. Firefox loads the engine through
`background.scripts` (event page) instead of `importScripts`; the same block
flow applies.
