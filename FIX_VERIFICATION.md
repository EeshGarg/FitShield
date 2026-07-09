# FitShield — Block Screen Fix Verification

This checklist proves the FitShield block screen works in an unpacked Chrome /
Brave / Edge install and in a production build.

## TL;DR — the one thing that matters

**Load `dist/chrome`, not `extension/` and not the repo root.**

The repo is split into three source folders — `extension/` (UI + service worker),
`FS Engine/` (the blocking engine), and `data/` (blocklists + recipes). Chrome
cannot load any of them directly: the service worker does
`importScripts("blocklist.js")`, and `blocklist.js` is *generated* by the build
from `FS Engine/`, alongside the `blocklists/` and `data/` the runtime fetches.
Loading a source folder means the service worker never registers and **nothing
blocks** — previously with no visible error.

```
node build.js            # validates, then writes dist/chrome (+ dist/firefox + zips)
# chrome://extensions → Developer mode → Load unpacked → select dist/chrome
```

If a source folder is ever loaded now, the service worker console prints a loud,
actionable error instead of failing silently (see “Diagnostics” below).

---

## Automated proof (run these first)

```bash
npm test                 # 92 tests incl. block-page render + engine bundle
npm run validate         # 11 audits: manifest, permissions, SW↔engine linkage, CSP…
npm run build            # validation-gated packaging → dist/chrome + dist/firefox
npm run verify:unpacked  # DYNAMIC: build a package, load its engine, block a real domain
```

`verify:unpacked` is the closest automated stand-in for the manual test: it
builds the package, evaluates the packaged `blocklist.js` as a worker script,
fetches the packaged `blocklists/*.json`, and asserts a real curated brand
(e.g. `order.mcdonalds.com`) is blocked while a guaranteed-absent host is not.

---

## Manual browser test (the real success condition)

1. **Build**
   - [ ] `node build.js` completes with `validate-all: PASS` and prints
         `dist/chrome`.

2. **Load unpacked**
   - [ ] `chrome://extensions` → enable **Developer mode**.
   - [ ] **Load unpacked** → select the **`dist/chrome`** folder.
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
   - [ ] The page shows the “Take one minute” card, the brand it interrupted,
         the “Why you’re seeing this” panel (domain / type / category / country),
         a countdown timer, and two recipe alternative columns.
   - [ ] No CSP or module errors in the block page’s DevTools console.

6. **Confirm stats increment**
   - [ ] Open the popup (or settings → stats). The blocked-visits count went up
         by one after the block page showed.
   - [ ] Pick “I’ll make this instead” on a recipe → the calories-avoided /
         recipes-chosen stats increment.

7. **Confirm the continue flow**
   - [ ] When the timer reaches 0, **Continue** unlocks; clicking it opens the
         brand’s site and does not immediately re-block (temporary pass works).

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
