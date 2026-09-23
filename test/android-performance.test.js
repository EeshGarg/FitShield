"use strict";
/**
 * The recurring work the Android UI does, asserted by doing it.
 *
 * Everything here is about cost, and cost is the one property a source read is
 * worst at. "Does this poll stop while the app is backgrounded", "does a tick that
 * found no new data still discard sixty DOM nodes", "does the search box re-derive
 * its haystack per keystroke" — each of those is answered by running the page and
 * looking at what moved, and each of them was answered wrongly by code that read
 * perfectly well.
 *
 * The dashboard's 2s status poll is the largest single piece of it. Per tick it
 * made roughly fourteen synchronous bridge crossings, about six of them real binder
 * IPCs (PackageManager via `blocking.rulesVersion`, Settings.Global for Private
 * DNS, Settings.Secure for the accessibility service, canDrawOverlays,
 * NotificationManagerCompat, PowerManager), plus five storage hops for
 * `stats.get()`. MainActivity has no `onPause` override, so `webView.onPause()` /
 * `pauseTimers()` are never called and all of that kept happening with the user in
 * another app entirely.
 *
 * None of these tests lengthen the poll or remove it. ARCHITECTURE.md records that
 * the permission rows are POLLED rather than latched because Android publishes no
 * change event for them, and the period is a user-visible latency decision that
 * wants a device to judge. The period is pinned here precisely so it does not drift
 * on this machine.
 *
 * Runs under `node --test`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const { loadPage, readWeb, settle, ROOT } = require("./helpers/android-webview.js");
const core = require("../extension/fitshield-core.js");

// A device that has been used for a while. Types matter: the harness's shim hands
// back exactly what the store holds, so these are the parsed shapes the real shim
// produces from SharedPreferences, not the raw JSON strings it parses.
const SEEDED = Object.freeze({
  androidWelcomed: true,
  blockedVisits: 137,
  blockedByDomain: { "doordash.com": 9, "mcdonalds.com": 4 }
});

/** The minimum `AndroidBlock` the pause screen needs to render. */
const blockBridge = () => ({
  getInfo: () =>
    JSON.stringify({
      brandId: "mcdonalds.com",
      displayName: "McDonald's",
      category: "fast_food",
      foodCategory: "burger",
      foodType: "fast_food",
      specialties: ["burgers"],
      packageId: "com.mcdonalds.app",
      unlockMinutes: 5,
      timerSeconds: 60
    }),
  unlock: () => {},
  leave: () => {},
  openFitShield: () => {}
});

// ---------------------------------------------------------------------------
// The status poll: what it costs, and when it runs at all
// ---------------------------------------------------------------------------
//
// These drive the real interval callback rather than grepping for
// `document.hidden`, because the thing that matters is the combination: skipping
// ticks while hidden is only correct if coming back refreshes EVERYTHING the
// skipped ticks would have. The `visibilitychange` listener that used to exist
// refreshed the permission rows alone — and it was registered inside
// renderAppBlocking, behind an early return, so on any build without the
// appBlocking bridge there was no resume refresh at all.

test("the dashboard registers exactly one repeating poll, at the documented 2s period", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  assert.equal(page.intervals.length, 1, "the dashboard should have one poll, not several competing ones");
  assert.equal(
    page.intervals[0].ms, 2000,
    "the poll period is a user-visible latency decision that needs a device to judge; it must not drift here"
  );
});

test("a tick with the app off-screen changes nothing on the dashboard", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });
  const before = page.text("visits");
  assert.equal(before, "137", "the seeded interruption count should be on screen before anything else is asserted");

  // The user switches to another app, and the number behind their back moves.
  page.document.hidden = true;
  page.store.blockedVisits = 424;
  await page.tick();

  assert.equal(
    page.text("visits"), before,
    "a tick fired while the app was hidden did its work anyway — that is ~7 bridge crossings a second, several of " +
      "them binder IPCs, paid forever for a screen nobody can see"
  );
});

test("coming back to the app refreshes the statistics, not only the permission rows", async () => {
  const page = await loadPage({
    page: "index.html",
    script: "app.js",
    store: { ...SEEDED, appBlockingEnabled: true }
  });

  page.document.hidden = true;
  page.store.blockedVisits = 424;
  page.store.blockedByDomain = { "ubereats.com": 41 };
  await page.tick();

  // …and the user comes back.
  page.document.hidden = false;
  await page.dispatch("visibilitychange");

  assert.equal(
    page.text("visits"), "424",
    "the statistics were stale on resume. With the poll paused while hidden, a resume handler that covers only the " +
      "permission rows leaves most of the screen showing whatever it showed when the user left."
  );
  assert.match(page.text("mostBlocked"), /ubereats\.com/, "the ranked list was stale on resume");
});

test("a tick while visible does pick new statistics up", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  page.store.blockedVisits = 424;
  await page.tick();

  assert.equal(
    page.text("visits"), "424",
    "guarding the poll on document.hidden must not stop it polling when the app IS on screen — that is the half " +
      "ARCHITECTURE.md says has to keep working, because there is no event to replace it"
  );
});

// ---------------------------------------------------------------------------
// Write-if-changed
// ---------------------------------------------------------------------------
//
// extension/popup.js states the rule where it implements it: "assigning
// textContent unconditionally destroys and rebuilds the text node… Write only when
// there is something different to write." On Android that rule was not followed on
// the one surface that repaints twice a second forever: `renderStatus` rewrote four
// textContents and a hidden flag per tick, and `renderStats` -> `renderMostBlocked`
// unconditionally `replaceChildren()`-ed FOUR lists and rebuilt up to sixty nodes,
// whether or not a single count had moved.
//
// Asserted by IDENTITY: the row objects are the same after a tick that found
// nothing new, and different after one that did. A grep for a signature variable
// would pass over an implementation that computed one and then wrote anyway.

test("a tick that finds nothing new does not rebuild the ranked lists", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  const list = page.document.getElementById("mostBlocked");
  const rowsBefore = list.childNodes.slice();
  assert.ok(rowsBefore.length > 0, "the ranked list needs rows before this can assert anything about rebuilding them");

  await page.tick();

  assert.deepEqual(
    list.childNodes, rowsBefore,
    "the rows were discarded and rebuilt although every count was identical — up to sixty nodes every two seconds, " +
      "for the life of the app"
  );
});

test("a tick that finds new counts DOES rebuild them", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  const list = page.document.getElementById("mostBlocked");
  const rowsBefore = list.childNodes.slice();

  page.store.blockedByDomain = { "ubereats.com": 41 };
  await page.tick();

  assert.notDeepEqual(list.childNodes, rowsBefore, "write-if-changed must still write when there is something to write");
  assert.match(page.text("mostBlocked"), /ubereats\.com/);
});

test("a tick that finds nothing new does not rewrite the headline either", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  const statusText = page.document.getElementById("statusText");
  const before = statusText.textContent;
  assert.ok(before, "the headline should say something before this asserts it is left alone");

  // A sentinel no renderer would ever write. If renderStatus rewrites
  // unconditionally it is gone; if it compares first, it survives.
  statusText.textContent = "SENTINEL";
  await page.tick();

  assert.equal(
    statusText.textContent, "SENTINEL",
    "renderStatus rewrote the headline although neither the enabled state nor Private DNS had changed"
  );
});

// The version/host line is built from two values that cannot change while the
// process lives — the APK's own versionName and the size of a packaged asset — so
// it is derived once. It still has to be RIGHT, which is the half a memo can break.
test("the version and blocked-domain line is rendered, and survives the poll", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  const meta = page.text("meta");
  assert.match(meta, /blocked domains/, "the headline should say how many domains are blockable");
  assert.match(meta, /rules v/, "…and which rules version is on the device");

  await page.tick();
  assert.equal(page.text("meta"), meta, "memoising the immutable values must not blank the line they build");
  assert.match(page.text("footerVersion"), /FitShield \d/, "the footer version survives too");
});

// ---------------------------------------------------------------------------
// The pause screen loads nothing it does not use
// ---------------------------------------------------------------------------
//
// block.html loaded languages.js — an 85-entry display-language metadata array —
// on the most latency-sensitive surface in the product: a screen that appears over
// an app the user has just opened and starts a countdown immediately. The only
// consumer of FITSHIELD_LANGUAGE_OPTIONS is the dashboard's language picker.
//
// Stated as an invariant over both pages rather than "block.html must not name this
// one file", so it also catches the reverse — dropping the script from index.html,
// which is the failure build.js warns about: "dropping any of them from FILES
// shipped a dead options page with a green build."
test("languages.js is loaded by exactly the pages whose script reads it", () => {
  const scriptsOf = (page) => [...readWeb(page).matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

  Object.entries({ "index.html": "app.js", "block.html": "block.js" }).forEach(([page, script]) => {
    const loads = scriptsOf(page).includes("languages.js");
    const uses = /FITSHIELD_LANGUAGE_OPTIONS/.test(readWeb(script));

    assert.equal(
      loads, uses,
      uses
        ? `${page} does not load languages.js, but ${script} reads FITSHIELD_LANGUAGE_OPTIONS — the picker would be empty`
        : `${page} loads languages.js and ${script} never reads it: ~7 KB of parse and 85 object allocations for ` +
            "nothing, on the screen where a countdown starts immediately"
    );
    assert.ok(scriptsOf(page).includes(script), `${page} no longer loads ${script}`);
  });
});

// …and removing the tag must not have broken the screen that no longer loads it.
test("the pause screen still renders with languages.js gone", async () => {
  const page = await loadPage({
    page: "block.html",
    script: "block.js",
    store: { ...SEEDED },
    bridge: blockBridge()
  });

  assert.equal(page.text("visits"), "137", "the interruption count is still drawn from storage");
  assert.match(page.allText(), /McDonald|Pause|pause/, "the pause screen rendered nothing recognisable");
});

// ---------------------------------------------------------------------------
// Recipe search: the haystack is built once, not per keystroke
// ---------------------------------------------------------------------------
//
// `draw()` is bound to the search box's `input` event, so it runs on every
// character typed — and it used to call `matchText(r)` inside its filter for all 88
// catalog entries. `matchText` joins the title, the description and EVERY ingredient
// run through `formatIngredient`, then lower-cases the result. That is 88 joins plus
// 88 lowercase passes over several hundred ingredient objects per keypress, on the
// same main thread the synchronous storage bridge blocks.
//
// The catalog is fetched once and never mutated, so the text it is searched by
// cannot change either.

const ALL_RECIPES = 88;

async function typeSearch(page, query) {
  const box = page.document.getElementById("recipeSearch");
  box.value = query;
  await box.dispatch("input");
  await settle();
  return page.document.getElementById("recipeList");
}

test("the alternatives panel renders the whole catalog and says how many", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  assert.match(
    page.text("recipeCount"), new RegExp(`${ALL_RECIPES} alternatives`),
    "the panel must state how many alternatives there are, not silently show a slice"
  );
  assert.equal(
    page.document.getElementById("recipeList").childNodes.length, ALL_RECIPES,
    "every catalog entry should be on the page before any filtering"
  );
});

test("search still matches on the title, the description and an ingredient", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  assert.match((await typeSearch(page, "naan pizza")).textContent, /Naan Pizza/, "a title search stopped finding its entry");

  // The ingredient field is the one a precomputed haystack has to keep carrying,
  // and the one a careless "index the title only" rewrite would quietly drop. The
  // ingredients are OBJECTS, so this can only match if they went through
  // formatIngredient on the way in.
  assert.match(
    (await typeSearch(page, "naan breads")).textContent, /Naan Pizza/,
    "an ingredient search found nothing — the haystack is no longer built from formatted ingredients"
  );

  assert.match(
    (await typeSearch(page, "properly crisp base")).textContent, /Naan Pizza/,
    "a description search stopped working"
  );
});

test("a query that matches nothing says so, and clearing it restores the catalog", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  assert.equal((await typeSearch(page, "zzzzzznotafood")).childNodes.length, 0);
  assert.match(page.text("recipeCount"), /0 of 88 alternatives match/, "the count has to be honest about an empty result");

  assert.equal(
    (await typeSearch(page, "")).childNodes.length, ALL_RECIPES,
    "clearing the box must bring the whole catalog back"
  );
});

// The cost itself, measured. Every entry's `ingredients` is a counting getter, so
// the number of reads after the first render is the number of times the haystack was
// re-derived. Typing must not add any.
test("typing in the search box does not re-derive the ingredient text", async () => {
  const document = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "recipes.json"), "utf8"));
  const flat = [...(document.recipes || []), ...(document.quickAlternatives || [])];

  let reads = 0;
  const counted = flat.map((entry) => {
    const ingredients = entry.ingredients;
    return Object.defineProperty({ ...entry }, "ingredients", {
      get() { reads += 1; return ingredients; },
      enumerable: true
    });
  });

  const page = await loadPage({
    page: "index.html",
    script: "app.js",
    store: { ...SEEDED },
    recipeEntries: counted
  });

  const afterRender = reads;
  assert.ok(afterRender >= flat.length, "the first render must read every entry's ingredients at least once");

  await typeSearch(page, "n");
  await typeSearch(page, "na");
  await typeSearch(page, "naa");
  await typeSearch(page, "naan");

  const perKeystroke = (reads - afterRender) / 4;
  assert.ok(
    perKeystroke < flat.length,
    `each keystroke re-read the ingredients of ${perKeystroke} of ${flat.length} entries — the search haystack is ` +
      "being rebuilt per character instead of derived once"
  );
});

// ---------------------------------------------------------------------------
// The press tilt: one layout read per press, one write per frame
// ---------------------------------------------------------------------------
//
// `move` called `tile.getBoundingClientRect()` and then wrote `tile.style.transform`
// directly in the `pointermove` handler, with no rAF coalescing. `pointermove` is
// delivered at the touch digitiser's rate — 120-240 Hz on current phones — so every
// sample forced a synchronous layout flush and then dirtied the layout again, on the
// same main thread the synchronous storage bridge blocks. extension/settings.js
// already rAF-coalesces its equivalent, so this was a platform-local regression from
// the shared design.
//
// A tile cannot move or resize while a finger is held down on it, so one measurement
// covers the whole gesture; and the display can only show one transform per frame,
// so the extra writes produced no pixel. The rendered result is identical — the
// transform is still computed from the newest pointer position.

/** The tilt handlers are only wired when reduced-motion is off. */
async function pressedTile() {
  const page = await loadPage({
    page: "index.html",
    script: "app.js",
    store: { ...SEEDED },
    reduceMotion: false
  });

  const tile = page.document.querySelectorAll(".stat")[0];
  assert.ok(tile, "index.html declares no .stat tile for the tilt handler to bind to");

  let rectReads = 0;
  tile.getBoundingClientRect = () => {
    rectReads += 1;
    return { top: 0, left: 0, width: 100, height: 100 };
  };

  const writes = [];
  Object.defineProperty(tile.style, "transform", {
    get() { return writes.length ? writes[writes.length - 1] : ""; },
    set(value) { writes.push(value); },
    configurable: true
  });

  return { page, tile, writes, reads: () => rectReads };
}

/** Let the queued rAF (a setTimeout in this harness) run. */
const frame = () => new Promise((resolve) => setTimeout(resolve, 1));

test("a whole press gesture reads the tile's geometry once", async () => {
  const { tile, reads } = await pressedTile();

  await tile.dispatch("pointerdown", { clientX: 10, clientY: 10 });
  for (let i = 0; i < 40; i += 1) {
    await tile.dispatch("pointermove", { clientX: 10 + i, clientY: 20 + i });
  }
  await frame();

  assert.equal(
    reads(), 1,
    `getBoundingClientRect ran ${reads()} times for one press. Each call forces a synchronous layout flush, and the ` +
      "handler writes a transform straight afterwards — so at 120-240 Hz that is a read against a layout the previous " +
      "sample just dirtied, on the thread the storage bridge blocks."
  );
});

test("forty pointer samples produce one transform write per frame, not forty", async () => {
  const { tile, writes } = await pressedTile();

  await tile.dispatch("pointerdown", { clientX: 10, clientY: 10 });
  for (let i = 0; i < 40; i += 1) {
    await tile.dispatch("pointermove", { clientX: 10 + i, clientY: 20 + i });
  }
  await frame();

  assert.ok(
    writes.length <= 2,
    `the tile's transform was written ${writes.length} times for 40 samples within one frame — the display can show ` +
      "one of them, so the rest is layout work with no pixel to account for it"
  );
  assert.ok(writes.length >= 1, "the tilt must still happen; coalescing is not the same as dropping it");
});

test("the transform still follows the newest pointer position, and is cleared on release", async () => {
  const { tile, writes } = await pressedTile();

  await tile.dispatch("pointerdown", { clientX: 50, clientY: 50 });
  await tile.dispatch("pointermove", { clientX: 10, clientY: 10 });
  await tile.dispatch("pointermove", { clientX: 90, clientY: 90 });
  await frame();

  const last = writes[writes.length - 1];
  assert.match(last, /^perspective\(760px\) rotateX\(-?[\d.]+deg\) rotateY\(-?[\d.]+deg\) scale\(\.985\)$/,
    `the transform is no longer the shape the stylesheet expects: ${last}`);

  // 90,90 on a 100x100 tile is bottom-right: px and py are both positive, so
  // rotateX is negative and rotateY positive. Coalescing must keep the LAST sample,
  // not the first — dropping to the first would make the tile lag the finger.
  const [, rx, ry] = /rotateX\((-?[\d.]+)deg\) rotateY\((-?[\d.]+)deg\)/.exec(last);
  assert.ok(Number(rx) < 0 && Number(ry) > 0,
    `the coalesced frame used a stale sample: rotateX ${rx}, rotateY ${ry} do not correspond to the last pointer position`);

  await tile.dispatch("pointerup", {});
  assert.equal(writes[writes.length - 1], "", "releasing the tile must reset its transform");
});

test("a pointermove with no press does nothing at all", async () => {
  const { tile, writes, reads } = await pressedTile();

  await tile.dispatch("pointermove", { clientX: 30, clientY: 30 });
  await frame();

  assert.deepEqual(writes, [], "a hover-style move outside a press must not tilt anything");
  assert.equal(reads(), 0, "…and must not measure anything either");
});

// ---------------------------------------------------------------------------
// What the Alternatives panel actually renders
// ---------------------------------------------------------------------------
//
// docs/STORE_LISTING_DRAFT.md holds a paragraph withdrawing the browse bullet from
// the Play listing because this panel "renders only the first 24 of the 88 entries"
// and its ingredient line is `(r.ingredients || []).join(", ")` over objects, "so a
// real device prints `[object Object], [object Object], …`". Both were true once and
// neither is true now.
//
// `test/play-release.test.js` could not tell, because it greps app.js as raw text
// and app.js CONTAINS BOTH STRINGS — inside the comments that explain the fixes. It
// matched `.slice(0, 24)` in a comment reading "This drew `.slice(0, 24)` of 88
// entries and said nothing about the other 64", and `(r.ingredients || []).join(",
// ")` in a comment reading "This panel did `(r.ingredients || []).join(", ")` over a
// list of {quantity, unit, item} objects". So it certified the listing's caveat
// against the description of the bug rather than against the bug.
//
// Both halves are already pinned by RENDERING the panel, which is the only thing
// that can answer either:
//
//   the 24-of-88 half   "the alternatives panel renders the whole catalog and says
//                        how many", above — all 88 entries are on the page.
//   the ingredient half  test/android-alternatives.test.js, "no alternative renders
//                        [object Object] where its ingredients belong", plus "every
//                        ingredient reads exactly as the extension would phrase it",
//                        which drives BOTH formatters over every ingredient in the
//                        shipped catalog.
//
// So no assertion is added here. The listing paragraph and the grep in
// test/play-release.test.js are what need changing, and neither belongs to this lane.

// ---------------------------------------------------------------------------
// The clamps, driven through the inputs
// ---------------------------------------------------------------------------
//
// test/android-controls.test.js holds the three layers' RANGES to the constants
// extension/fitshield-core.js exports. This drives the actual `change` handlers,
// because the range being written down correctly and the value being clamped are
// two different facts — and the bug was a `Math.max` that had the right floor and
// no ceiling at all.
async function setNumber(page, id, value) {
  const input = page.document.getElementById(id);
  input.value = String(value);
  await input.dispatch("change");
  await settle();
  return page.store;
}

test("a pause length above the product's range is clamped before it is stored", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  // The value from the bug report: the dashboard accepted 600, stored 600, showed
  // 600 back, and the pause screen counted down for 300.
  assert.equal(
    (await setNumber(page, "timerSeconds", 600)).timerSeconds, 600,
    "600 is inside the product's 10..900, so it must be stored as typed"
  );
  assert.equal(
    (await setNumber(page, "timerSeconds", 4000)).timerSeconds, 900,
    "a value above the range must be clamped to the maximum the pause screen will honour, not stored whole"
  );
  assert.equal((await setNumber(page, "timerSeconds", 1)).timerSeconds, 10, "…and below it, to the minimum");
});

test("the pass duration is clamped at both ends too", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  assert.equal((await setNumber(page, "passMinutes", 999)).passDurationMinutes, 240);
  assert.equal((await setNumber(page, "passMinutes", 120)).passDurationMinutes, 120);
});

// The same numbers core would store, for the same input, including the two edges
// where "clamp" and "fall back to the default" give different answers. Android used
// `Number(value) || fallback`, so a typed 0 — falsy — became the DEFAULT while core
// clamps it to the MINIMUM: 5 minutes against 1, and 60 seconds against 10. Neither
// is wrong on its own; the two platforms answering differently is the bug this row
// of §2e exists for.
test("the dashboard stores exactly what fitshield-core would store, edges included", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });

  for (const typed of [0, 1, 9, 10, 11, 60, 600, 900, 901, 4000, "", "abc", "45.7"]) {
    assert.equal(
      (await setNumber(page, "timerSeconds", typed)).timerSeconds,
      core.normalizeTimerSeconds(typed === "" || typed === "abc" ? undefined : typed),
      `the dashboard and fitshield-core disagree about what to store for a typed timer value of ${JSON.stringify(typed)}`
    );
  }

  for (const typed of [0, 1, 5, 240, 241, 999, "abc"]) {
    assert.equal(
      (await setNumber(page, "passMinutes", typed)).passDurationMinutes,
      core.normalizePassDurationMinutes(typed === "abc" ? undefined : typed),
      `the dashboard and fitshield-core disagree about what to store for a typed pass duration of ${JSON.stringify(typed)}`
    );
  }
});

// ---------------------------------------------------------------------------
// A dataset that will not load has to SAY so
// ---------------------------------------------------------------------------
//
// `PackageBlocklist.fromAssets` catches everything and returns an empty matcher.
// That direction is deliberate and stays: it is loaded by
// `FitShieldAccessibilityService.onServiceConnected`, so throwing — the way
// `RuleEngine.fromAssets` does — would crash-loop the accessibility service every
// time the system reconnected it, which the user cannot diagnose and which is worse
// for them than app blocking being off.
//
// What was wrong is that it was SILENT: every category pill still read "on" above a
// feature that could not match a single app, and nothing anywhere said why. The
// dashboard's own app-blocking readiness line was `if (n)`, so a count of zero left
// it blank.
/** A native app-blocking bridge whose matcher holds `count` packages. */
const appBlockingWith = (count) => ({
  available: true,
  list: () => Promise.resolve([]),
  packageCount: () => Promise.resolve(count),
  accessibilityEnabled: () => Promise.resolve(true),
  vpnEnabled: () => Promise.resolve(true),
  overlayEnabled: () => Promise.resolve(true),
  notificationsEnabled: () => Promise.resolve(true),
  batteryUnrestricted: () => Promise.resolve(true),
  keepAliveEnabled: () => Promise.resolve(false),
  setKeepAlive: () => Promise.resolve(),
  consentGiven: () => Promise.resolve(true),
  recordConsent: () => Promise.resolve(),
  openSettings: () => Promise.resolve(),
  openOverlaySettings: () => Promise.resolve(),
  openNotificationSettings: () => Promise.resolve(),
  openBatterySettings: () => Promise.resolve()
});

test("zero blockable apps is reported, not left blank", async () => {
  // A matcher holding nothing is exactly what PackageBlocklist returns when the
  // dataset will not parse, and `appPackageCount()` now reports the matcher's size.
  const page = await loadPage({
    page: "index.html",
    script: "app.js",
    store: { ...SEEDED },
    appBlocking: appBlockingWith(0)
  });

  const line = page.text("appBlockCount");
  assert.ok(
    line && line.trim().length > 0,
    "the app-blocking readiness line is blank when no app can be blocked — which is precisely the state that needs " +
      "explaining, because the pills above it still show as on"
  );
  assert.match(
    line, /app blocking is inactive/i,
    `the line says "${line}", which does not tell the user app blocking cannot work`
  );
  assert.match(
    line, /[Ss]ite blocking is unaffected/,
    "it must also say what still works, or the user reads it as FitShield being broken outright"
  );
});

test("a matcher that loaded reports the count, not the failure message", async () => {
  const page = await loadPage({
    page: "index.html",
    script: "app.js",
    store: { ...SEEDED },
    appBlocking: appBlockingWith(1511)
  });

  const line = page.text("appBlockCount");
  assert.match(line, /1,?511 apps can be blocked/, `the normal case must still read normally; it said "${line}"`);
  assert.ok(
    !/inactive/i.test(line),
    "the failure message is showing on a healthy build, so the zero branch is being taken unconditionally"
  );
});

// …and the honest count comes from the matcher, not from a number written beside it.
// `appPackageCount()` used to read the asset's own `counts.packages` field in a
// separate parse, so a malformed asset could have the dashboard announcing "1511
// apps can be blocked" while the matcher held zero.
test("the dashboard's app count is read from the matcher the service uses", () => {
  const bridge = fs.readFileSync(
    path.join(ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield", "WebAppBridge.kt"),
    "utf8"
  );

  assert.match(
    bridge, /fun appPackageCount\(\): Int = packages\.size/,
    "appPackageCount must report the size of the PackageBlocklist the AccessibilityService loads; reading a " +
      "`counts` field out of the asset lets the number on screen disagree with the number in effect"
  );
  assert.ok(
    !/fun appPackageCount[\s\S]{0,400}?counts/.test(bridge),
    "appPackageCount still reads the asset's counts field"
  );

  const kt = fs.readFileSync(
    path.join(ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield", "PackageBlocklist.kt"),
    "utf8"
  );
  assert.match(
    kt, /Log\.e\(/,
    "a dataset that will not parse must be logged at error level; absorbing it silently is what hid this"
  );
  assert.match(
    kt, /app blocking is inactive/,
    "the log line should name the CONSEQUENCE, not just the exception — that is the fact someone reading logcat needs"
  );
  assert.match(kt, /PackageBlocklist\(emptyMap\(\)\)/, "and it must still fail open, not throw into the service");
});
