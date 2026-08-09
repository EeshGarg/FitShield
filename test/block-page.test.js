"use strict";
/**
 * Block page (warning.html) regression + smoke tests.
 *
 * This is the test that catches "the block page broke after the FS Engine was
 * separated from the extension." It has two halves:
 *
 *   Part A — PACKAGE CLOSURE: stage a REAL package with build.js's own copyInto,
 *     then prove the block page's whole dependency graph resolves INSIDE that
 *     staged output — the page itself, every <script>/<link>/<img> it loads, the
 *     generated engine runtime bundle (blocklist.js) and the datasets it fetches,
 *     the recipe catalog, and that no page reference escapes the package. Both
 *     the Chrome and Firefox manifests are checked against the same real stage.
 *     (tools/extension-audit.js checks the *computed* stage; this checks the
 *     bytes build.js actually writes.)
 *
 *   Part B — RENDER SMOKE: drive the REAL engine-backed background.js and the
 *     REAL block-page scripts (browser-shim.js, i18n.js, recipes.js, warning.js)
 *     against a compact DOM, simulating a blocked DoorDash URL. Proves the page
 *     renders: brand resolves, the block reason is produced, recipes load, stats
 *     update without throwing, and locale + theme load without throwing.
 *
 * No dependencies (no jsdom): a small DOM + HTML parser sufficient for the block
 * page lives at the bottom of this file.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const build = require("../build.js");
const engine = require("../FS Engine");

// ---------------------------------------------------------------------------
// Shared: resolve a PACKAGE-relative path (as the shipped extension requests
// it) to its repo source. blocklist.js is materialized from the real bundle so
// the tests exercise the exact artifact the extension ships.
// ---------------------------------------------------------------------------
const { srcPath, loadBackground } = require("./helpers/background-harness.js");

// ===========================================================================
// Part A — packaged block-page dependency graph is closed
// ===========================================================================

// Stage a real package once (build.copyInto is what the shipped build runs),
// then add both derived manifests so manifest references can be checked too.
let stageDir = null;
function stagedPackage() {
  if (!stageDir) {
    stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-blockpage-stage-"));
    build.copyInto(stageDir); // stages FILES/DIRS + writes blocklist.js + verifyStage
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
    fs.writeFileSync(path.join(stageDir, "manifest.chrome.json"), JSON.stringify(build.chromeManifest(base)));
    fs.writeFileSync(path.join(stageDir, "manifest.firefox.json"), JSON.stringify(build.firefoxManifest(base)));
  }
  return stageDir;
}

const staged = (rel) => fs.existsSync(path.join(stagedPackage(), rel));

// Pull the local (non-http/data) <script src>/<link href>/<img src> refs out of
// a staged HTML page.
function pageAssetRefs(stage, page) {
  const html = fs.readFileSync(path.join(stage, page), "utf8");
  const refs = [];
  for (const tag of html.match(/<(?:script|link|img)\b[^>]*>/g) || []) {
    const ref = /\s(?:src|href)="([^"]+)"/.exec(tag);
    if (ref && !/^(https?:|data:|#|mailto:)/.test(ref[1])) {
      refs.push(ref[1]);
    }
  }
  return refs;
}

test("packaged block page: warning.html and every asset it loads are in the package", () => {
  const stage = stagedPackage();
  assert.ok(staged("warning.html"), "warning.html must be staged (it is the DNR redirect target)");

  const refs = pageAssetRefs(stage, "warning.html");
  assert.ok(refs.length >= 4, `expected the block page to load its scripts (got ${refs.length})`);
  for (const ref of refs) {
    assert.ok(staged(ref), `warning.html references "${ref}" which is not in the staged package`);
  }
});

test("packaged block page: no block-page reference escapes the package", () => {
  const stage = stagedPackage();
  for (const ref of pageAssetRefs(stage, "warning.html")) {
    assert.doesNotMatch(ref, /^(\/|[a-zA-Z]:|\\\\)/, `absolute path escapes the package: "${ref}"`);
    assert.doesNotMatch(ref, /\.\.\//, `parent-relative path escapes the package: "${ref}"`);
    assert.doesNotMatch(ref, /FS Engine|engine\//i, `reference points at engine source, not the packaged bundle: "${ref}"`);
  }
});

test("packaged block page: the engine RUNTIME ships as blocklist.js and loads", () => {
  const stage = stagedPackage();
  assert.ok(staged("blocklist.js"), "engine runtime bundle blocklist.js must be packaged");

  // The bundle must evaluate as a classic script and define the global the
  // background worker (which the block page messages) depends on.
  const sandbox = { self: {}, console };
  sandbox.self.self = sandbox.self;
  const context = vm.createContext(sandbox.self);
  vm.runInContext(fs.readFileSync(path.join(stage, "blocklist.js"), "utf8"), context, { filename: "blocklist.js" });
  assert.equal(typeof context.FitShieldBlocklist, "object", "blocklist.js must define FitShieldBlocklist");
  assert.equal(typeof context.FitShieldBlocklist.loadBlocklists, "function", "engine API must be present in the bundle");
});

test("packaged block page: engine datasets and the recipe catalog are in the package", () => {
  for (const dataset of engine.BLOCKLIST_FILES) {
    assert.ok(staged(dataset), `engine dataset "${dataset}" (fetched at runtime) is not in the package`);
  }
  assert.ok(staged("data/recipes.json"), "recipe catalog data/recipes.json is not in the package");
  assert.ok(staged("_locales/en/messages.json"), "default locale is not in the package");
});

// ---------------------------------------------------------------------------
// …and nothing the browser cannot use.
//
// data/android/ and data/generated/ are the Android AccessibilityService's
// app-package datasets — ~1.5 MB of `com.dd.doordash`-style ANDROID package
// names. No browser can act on an Android package name, and no file under
// extension/ reads them: the only data/ path the browser runtime ever fetches
// is data/recipes.json. They were nevertheless copied into the Chrome, Firefox
// and Safari packages on every build and shipped to every user and both store
// reviews. The exclusion is asserted against the staged BYTES, not against the
// DIRS table, so re-adding them by any route fails here.
// ---------------------------------------------------------------------------

test("packaged: no Android-only dataset is shipped to a browser", () => {
  const stage = stagedPackage();

  const strays = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel);
      } else if (build.ANDROID_ONLY_PREFIXES.some((prefix) => childRel.startsWith(prefix))) {
        strays.push(childRel);
      }
    }
  };
  walk(stage, "");

  assert.deepEqual(strays, [], `Android-only payload in a browser package:\n  ${strays.join("\n  ")}`);

  // The datasets still exist canonically — this is an exclusion from the browser
  // package, not a deletion. The Android build reads them from data/ directly.
  assert.ok(fs.existsSync(path.join(ROOT, "data", "android")), "data/android must still exist for the Android build");
  assert.ok(
    fs.existsSync(path.join(ROOT, "data", "generated", "android-packages.json")),
    "the generated Android package asset must still exist for the Android build"
  );
});

test("packaged: staging an Android dataset into a browser package fails the build", () => {
  // Prove the guard, rather than trusting that the DIRS table stays correct:
  // plant the exact file the old build shipped into a stage and assert
  // verifyStage's check rejects it.
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "fs-android-stray-"));
  const planted = path.join(probe, "data", "generated", "android-packages.json");

  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, "{}");

  assert.throws(
    () => build.assertNoAndroidPayload(probe),
    /Android-only data was staged/,
    "an Android dataset in a browser stage must abort the build"
  );

  // A stage without it passes.
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "fs-android-clean-"));
  fs.writeFileSync(path.join(clean, "manifest.json"), "{}");
  assert.doesNotThrow(() => build.assertNoAndroidPayload(clean));

  fs.rmSync(probe, { recursive: true, force: true });
  fs.rmSync(clean, { recursive: true, force: true });
});

// The block page and the settings page must still find everything they load —
// this is the check that the exclusion took only dead weight. copyInto runs
// verifyStage itself, so stagedPackage() reaching this point is already part of
// the proof; these pin the two pages' own data dependency explicitly.
test("packaged: the data the browser DOES read is still there", () => {
  assert.ok(staged("data/recipes.json"), "the block page's alternative columns load this");
  assert.ok(staged("blocklists/delivery.json"), "settings renders its pickers from the live dataset");
  assert.ok(staged("blocklists/fast-food.json"));
  assert.ok(staged("blocklist.js"), "and the engine bundle both pages depend on");
});

test("packaged block page: both browser manifests are valid and point at packaged files", () => {
  const stage = stagedPackage();
  const chrome = JSON.parse(fs.readFileSync(path.join(stage, "manifest.chrome.json"), "utf8"));
  const firefox = JSON.parse(fs.readFileSync(path.join(stage, "manifest.firefox.json"), "utf8"));

  // warning.html must be web-accessible in BOTH (it is the DNR redirect target).
  for (const [name, manifest] of [["chrome", chrome], ["firefox", firefox]]) {
    const war = (manifest.web_accessible_resources || []).some((e) => (e.resources || []).includes("warning.html"));
    assert.ok(war, `${name} manifest must expose warning.html as web_accessible_resources`);
    assert.ok(staged(manifest.background.service_worker), `${name} background.service_worker must be packaged`);
  }

  // Chrome: service-worker only, no Firefox-only keys.
  assert.equal(chrome.background.service_worker, "background.js");
  assert.ok(!("browser_specific_settings" in chrome), "chrome manifest must strip browser_specific_settings");

  // Firefox: the shared runtime files must load BEFORE background.js (which
  // references the FitShieldBlocklist and FitShieldCore globals) — the exact
  // ordering the compartment split depends on.
  assert.deepEqual(firefox.background.scripts, build.BACKGROUND_SCRIPTS);
  assert.equal(
    firefox.background.scripts[firefox.background.scripts.length - 1],
    "background.js",
    "background.js must load last"
  );
  for (const script of firefox.background.scripts) {
    assert.ok(staged(script), `firefox background script "${script}" must be packaged`);
  }
});

// ===========================================================================
// Part B — render smoke test (engine -> background -> block page)
// ===========================================================================

// Load the REAL background.js in an isolated sandbox with a stubbed chrome +
// fetch, backed by the real engine bundle and the real JSON datasets.
// Route through the worker's REAL onMessage listener, so the page and the worker
// are tested against the same message contract the browser would use — not a
// hand-maintained copy of it that can drift.
function dispatchToBackground(bg, msg) {
  return new Promise((resolve) => {
    const handled = bg.listeners.message(msg, { id: "test", url: "chrome-extension://test/warning.html" }, resolve);
    if (!handled) resolve({ ok: false });
  });
}

// Render the block page (browser-shim.js, i18n.js, recipes.js, warning.js) for
// `siteKey` against a compact DOM, routing runtime.sendMessage to `bg`. ambient.js
// is intentionally excluded — it is purely decorative, self-guards on the DOM,
// and Part A already proves it ships. Returns { getById, messages }.
function renderBlockPage(bg, siteKey, options) {
  const opts = options || {};
  const doc = buildDocument(srcPath("warning.html"));

  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.54" }),
      sendMessage: async (msg) => { doc.messages.push(msg.type); return dispatchToBackground(bg, msg); }
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in bg.store) out[k] = bg.store[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(bg.store, obj); }
      },
      onChanged: { addListener: () => {} }
    },
    i18n: { getMessage: () => "", getUILanguage: () => "en" }
  };
  const fetchImpl = async (url) => {
    const rel = url.replace("chrome-extension://test/", "");
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(srcPath(rel), "utf8")) };
  };
  const search = `?site=${siteKey}${opts.preview ? "&preview=1" : ""}`;
  const win = {
    location: { search, href: "" },
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0,
    history: { back: () => {}, length: 1 }
  };

  // A tab's sessionStorage. Passing the SAME `opts.tabSession` object into two
  // renders is what makes the second one a reload of the first rather than a
  // load in a fresh tab — that is exactly the distinction sessionStorage draws
  // in a real browser, and the one the block page relies on.
  const session = opts.tabSession || new Map();
  const sessionStorage = {
    getItem: (key) => (session.has(key) ? session.get(key) : null),
    setItem: (key, value) => { session.set(key, String(value)); },
    removeItem: (key) => { session.delete(key); }
  };

  // PerformanceNavigationTiming.type: "navigate" for a new arrival, "reload"
  // when the user pressed reload, "back_forward" for a history restore.
  const performance = {
    getEntriesByType: (type) =>
      type === "navigation" ? [{ type: opts.navigationType || "navigate" }] : []
  };

  const sandbox = {
    chrome, document: Object.assign(doc.document, { hidden: false }), window: win, fetch: fetchImpl, console,
    URL, URLSearchParams, Math, Date, Number, String, Array, Object, JSON, Promise,
    setInterval: () => 0, clearInterval: () => {}, setTimeout,
    location: win.location, matchMedia: win.matchMedia,
    sessionStorage, performance
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ["browser-shim.js", "i18n.js", "fitshield-core.js", "recipes.js", "warning.js"]) {
    vm.runInContext(fs.readFileSync(srcPath(f), "utf8"), ctx, { filename: f });
  }
  return doc;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test("render smoke: the block page names the interrupted brand and explains why", async () => {
  const bg = loadBackground();
  bg.store.uiLanguage = "en";                      // force the _locales override path
  bg.store.theme = { accent: "#7ef0a8" };          // the block page reads `theme`
  bg.store.askIntent = false;                      // go straight to the alternative
  await bg.context.queueRefreshBlockingState();

  const doc = renderBlockPage(bg, "delivery-doordash-com");
  const brand = () => doc.getById("brand");
  assert.ok(
    await waitFor(() => brand() && brand().hidden === false && brand().textContent.length > 0),
    "the brand line should resolve and become visible"
  );

  assert.match(brand().textContent, /DoorDash/, "the brand line names the interrupted site");

  const reason = doc.getById("reasonPanel");
  assert.equal(reason.hidden, false, "the why-panel should be shown");
  assert.match(doc.getById("reasonBody").textContent, /doordash\.com/, "the reason includes the domain");

  // The pause and both exits exist at first paint.
  assert.ok(Number(doc.getById("timer").textContent) > 0, "the countdown renders a number");
  assert.ok(doc.getById("back"), "Go back exists");
  assert.ok(doc.getById("continue").disabled, "Continue is locked while the pause runs");
});

test("render smoke: one alternative is shown, with ingredients and steps", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  const panel = () => doc.getById("altPanel");
  assert.ok(await waitFor(() => panel() && panel().hidden === false), "the alternative panel should populate");

  assert.ok(doc.getById("altTitle").textContent.length > 0, "it has a title");
  assert.ok(doc.getById("altIngredients").childElementCount > 0, "it lists ingredients");
  assert.ok(doc.getById("altSteps").childElementCount > 0, "it lists steps");
  assert.ok(doc.getById("altMeta").childElementCount > 0, "it shows time and effort");
  assert.ok(doc.getById("filters").childElementCount >= 4, "the fastest / no-cook filters are offered");
});

test("render smoke: ONE alternative at a time, not a wall of them", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  await waitFor(() => doc.getById("altPanel") && doc.getById("altPanel").hidden === false);

  // The decision must stay legible: exactly one titled alternative on screen.
  assert.equal(doc.getById("altTitle").children.length, 0, "the title is a single string, not a list");
  assert.ok(doc.getById("chooseAlt"), "there is one way to choose it");
  assert.ok(doc.getById("anotherAlt"), "and one way to see another");
});

test("render smoke: show another moves to a different alternative", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  await waitFor(() => doc.getById("altPanel") && doc.getById("altPanel").hidden === false);
  const first = doc.getById("altTitle").textContent;

  doc.getById("anotherAlt").click();
  assert.ok(await waitFor(() => doc.getById("altTitle").textContent !== first), "a different alternative is shown");
});

test("render smoke: statistics move through the worker with the new event names", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  assert.ok(
    await waitFor(() => bg.store.stats && bg.store.stats.totals.interruptions === 1),
    "the interruption is counted exactly once"
  );
  assert.ok(
    await waitFor(() => bg.store.blockedByDomain && bg.store.blockedByDomain["doordash.com"] === 1),
    "the trigger brand is aggregated by domain"
  );
  assert.ok(doc.messages.includes("getBlockContext"), "the page asked the worker for its context");

  // Nothing claims a meal happened just because the page rendered.
  assert.equal(bg.store.stats.totals.alternativesSelected, 0);
  assert.equal(bg.store.stats.totals.alternativesMade, 0);
});

// ---------------------------------------------------------------------------
// An interruption is counted once per interruption — not once per page load.
//
// `interruptions` and the per-brand breakdown are published to the user as
// OBSERVED events. The worker cannot tell a reload of the block page from a new
// interruption (same tab, same sender.url, and a reload mints a new documentId),
// so holding F5 ran both counters up as fast as the page could load. The page
// itself is the only party that knows, and it needs BOTH a tab-scoped marker and
// the navigation type to know it correctly — each of the four tests below fails
// if either half is dropped.
// ---------------------------------------------------------------------------

async function countedInterruptions(bg) {
  await waitFor(() => bg.store.stats && bg.store.stats.totals.interruptions >= 1);
  return bg.store.stats.totals.interruptions;
}

test("reloading the block page does not record a second interruption", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();

  // One tab: the same sessionStorage carries across the reload, as in a browser.
  const tabSession = new Map();

  renderBlockPage(bg, "delivery-doordash-com", { tabSession, navigationType: "navigate" });
  assert.equal(await countedInterruptions(bg), 1, "the first arrival is a real interruption");

  // Now reload it, three times, exactly as holding F5 would.
  for (let reload = 0; reload < 3; reload += 1) {
    renderBlockPage(bg, "delivery-doordash-com", { tabSession, navigationType: "reload" });
  }

  // Give the (fire-and-forget) recording calls every chance to land.
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(bg.store.stats.totals.interruptions, 1, "a reload is the same interruption, not a new one");
  assert.equal(
    bg.store.blockedByDomain["doordash.com"],
    1,
    "and the brand breakdown must not climb either — it is the same event seen from the other side"
  );
});

test("a back/forward restore of the block page is not a new interruption either", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();

  const tabSession = new Map();

  renderBlockPage(bg, "delivery-doordash-com", { tabSession, navigationType: "navigate" });
  assert.equal(await countedInterruptions(bg), 1);

  renderBlockPage(bg, "delivery-doordash-com", { tabSession, navigationType: "back_forward" });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(bg.store.stats.totals.interruptions, 1, "pressing Back onto the block page re-shows one interruption");
});

// The half that is easy to get wrong in the other direction. A marker keyed on
// the site alone would suppress this, and it is a genuine, separate interruption
// the user really did experience.
test("a GENUINE second interruption of the same site in the same tab is still counted", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();

  // Same tab (the marker is still sitting in sessionStorage), but the user went
  // away and came back: a real navigation, not a reload.
  const tabSession = new Map();

  renderBlockPage(bg, "delivery-doordash-com", { tabSession, navigationType: "navigate" });
  assert.equal(await countedInterruptions(bg), 1);

  renderBlockPage(bg, "delivery-doordash-com", { tabSession, navigationType: "navigate" });

  assert.ok(
    await waitFor(() => bg.store.stats.totals.interruptions === 2),
    "returning to a blocked site later is a second interruption and must be counted"
  );
  assert.equal(bg.store.blockedByDomain["doordash.com"], 2, "and it is a second visit to that brand");
});

// The other direction again, and the reason the navigation type cannot be used
// on its own: turning blocking on while a delivery site is already open and
// hitting reload is an extremely ordinary way to meet the block page for the
// FIRST time. There is no marker yet, so it counts.
test("a reload that produces the FIRST block page in a tab is counted", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();

  renderBlockPage(bg, "delivery-doordash-com", { tabSession: new Map(), navigationType: "reload" });

  assert.ok(
    await waitFor(() => bg.store.stats.totals.interruptions === 1),
    "a reload with nothing counted yet in this tab is a real first interruption"
  );
});

test("a reload in a DIFFERENT tab is its own interruption", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();

  renderBlockPage(bg, "delivery-doordash-com", { tabSession: new Map(), navigationType: "navigate" });
  assert.equal(await countedInterruptions(bg), 1);

  // A second tab has its own sessionStorage, so nothing carries over.
  renderBlockPage(bg, "delivery-doordash-com", { tabSession: new Map(), navigationType: "reload" });

  assert.ok(
    await waitFor(() => bg.store.stats.totals.interruptions === 2),
    "sessionStorage is per tab — another tab's block page is another interruption"
  );
});

test("render smoke: choosing an alternative records intent, not a meal", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  await waitFor(() => doc.getById("altPanel") && doc.getById("altPanel").hidden === false);
  doc.getById("chooseAlt").click();

  assert.ok(
    await waitFor(() => bg.store.stats && bg.store.stats.totals.alternativesSelected === 1),
    "the choice is recorded"
  );
  assert.equal(bg.store.stats.totals.alternativesMade, 0, "but nothing says it was made");
  assert.equal(doc.getById("chosenNote").hidden, false, "and the page says so explicitly");
});

test("render smoke: going back records leaving", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  await waitFor(() => doc.getById("altPanel") && doc.getById("altPanel").hidden === false);
  doc.getById("back").click();

  assert.ok(await waitFor(() => bg.store.stats && bg.store.stats.totals.left === 1), "leaving is its own event");
});

test("render smoke: the intent prompt is offered and is skippable", async () => {
  const bg = loadBackground();
  bg.store.askIntent = true;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  const panel = () => doc.getById("intentPanel");
  assert.ok(await waitFor(() => panel() && panel().hidden === false), "the prompt appears");
  assert.ok(doc.getById("intentOptions").childElementCount >= 5, "every intent is offered");

  doc.getById("intentSkip").click();
  assert.equal(panel().hidden, true, "it can be dismissed without answering");
});

// `alternativesViewed` is published to the user as an observed event, and the
// same recording call seeds the recently-shown rotation. Counting a card that
// is sitting behind the intent prompt would inflate the statistic AND penalise
// an entry that was never suggested, so nothing may be recorded until the card
// is actually uncovered.
test("an alternative prepared behind the intent prompt is not counted as seen", async () => {
  const bg = loadBackground();
  bg.store.askIntent = true;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  await waitFor(() => doc.getById("intentPanel") && doc.getById("intentPanel").hidden === false);
  // The interruption itself is recorded, so waiting on it proves the worker has
  // caught up and an unrecorded view is a real absence, not a race.
  await waitFor(() => bg.store.stats && bg.store.stats.totals.interruptions === 1);

  assert.equal(doc.getById("altPanel").hidden, true, "the card is prepared but covered");
  assert.equal(bg.store.stats.totals.alternativesViewed, 0, "nothing has been shown yet");
  assert.equal(bg.store.recentAlternatives, undefined, "and nothing entered the rotation");

  doc.getById("intentSkip").click();

  assert.ok(
    await waitFor(() => bg.store.stats.totals.alternativesViewed === 1),
    "uncovering it counts exactly one view"
  );
  assert.equal(doc.getById("altPanel").hidden, false, "and the prepared card is on screen");
  assert.equal(bg.store.recentAlternatives.length, 1, "the rotation records the one that was seen");
});

test("answering 'bored or browsing' shows no food and counts no view", async () => {
  const bg = loadBackground();
  bg.store.askIntent = true;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  await waitFor(() => doc.getById("intentPanel") && doc.getById("intentPanel").hidden === false);
  await waitFor(() => bg.store.stats && bg.store.stats.totals.interruptions === 1);

  // hungry · something specific · bored or browsing · legitimate · someone else
  doc.getById("intentOptions").children[2].click();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(doc.getById("altPanel").hidden, true, "the alternative stays out of sight");
  assert.equal(bg.store.stats.totals.alternativesViewed, 0, "and is not counted as viewed");
  assert.equal(bg.store.recentAlternatives, undefined, "nor pushed into the rotation");
});

test("answering 'ordering for someone else' opens the pass chooser, counting no view", async () => {
  const bg = loadBackground();
  bg.store.uiLanguage = "en";
  bg.store.askIntent = true;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  await waitFor(() => doc.getById("intentPanel") && doc.getById("intentPanel").hidden === false);
  await waitFor(() => bg.store.stats && bg.store.stats.totals.interruptions === 1);

  doc.getById("intentOptions").children[4].click();

  assert.ok(
    await waitFor(() => doc.getById("passPanel") && doc.getById("passPanel").hidden === false),
    "ordering for someone else goes straight to a scoped pass"
  );
  assert.equal(bg.store.stats.totals.alternativesViewed, 0, "no alternative was ever shown");
});

// Each pass option is a two-part button: the option and, beneath it, the scope
// it applies to. Writing a transient label onto the BUTTON collapses both into
// one string, so restoring it fused them ("For 5 minutesThis site only"). The
// preview path hits this on every click.
test("a pass option keeps its label and scope after a preview click", async () => {
  const bg = loadBackground();
  bg.store.uiLanguage = "en";
  bg.store.askIntent = true;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com", { preview: true });

  await waitFor(() => doc.getById("intentPanel") && doc.getById("intentPanel").hidden === false);
  doc.getById("intentOptions").children[3].click();
  await waitFor(() => doc.getById("passPanel") && doc.getById("passPanel").hidden === false);

  const option = doc.getById("passOptions").children[0];
  assert.equal(option.childElementCount, 2, "an option and its scope line");

  const label = option.children[0].textContent;
  const scope = option.children[1].textContent;
  assert.ok(label.length > 0 && scope.length > 0, "both are localized");

  option.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(option.childElementCount, 2, "the two parts survive the click");
  assert.equal(option.children[0].textContent, label, "the option reads the same as before");
  assert.equal(option.children[1].textContent, scope, "and still says what it applies to");
  assert.equal(option.disabled, false, "and it can be pressed again");
});

test("render smoke: an unresolved site key degrades gracefully (no throw, no brand)", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "does-not-exist");

  assert.ok(await waitFor(() => Number(doc.getById("timer").textContent) > 0), "the pause still renders");
  assert.equal(doc.getById("brand").hidden, true, "no brand line for an unknown key");
  assert.equal(doc.getById("reasonPanel").hidden, true, "no reason panel for an unknown key");
});

test("render smoke: preview mode records nothing", async () => {
  const bg = loadBackground();
  bg.store.askIntent = false;
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com", { preview: true });

  await waitFor(() => doc.getById("altPanel") && doc.getById("altPanel").hidden === false);
  doc.getById("chooseAlt").click();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const totals = bg.store.stats ? bg.store.stats.totals : {};
  assert.equal(totals.interruptions || 0, 0, "preview must not count an interruption");
  assert.equal(totals.alternativesSelected || 0, 0, "preview must not count a choice");
  assert.equal(bg.store.recentAlternatives, undefined, "preview must not write rotation history");
  assert.equal(doc.getById("previewBanner").hidden, false, "and it says so on screen");
});

test("the block page never assigns user or catalog text to innerHTML", () => {
  const source = fs.readFileSync(srcPath("warning.js"), "utf8");

  assert.ok(!/\.innerHTML\s*=/.test(source), "warning.js must not assign innerHTML");
  assert.ok(!/insertAdjacentHTML/.test(source), "warning.js must not use insertAdjacentHTML");
  assert.ok(!/document\.write/.test(source), "warning.js must not use document.write");
});

// ===========================================================================
// Compact DOM + HTML parser — only what the block page scripts touch.
// ===========================================================================
const VOID_TAGS = new Set(["meta", "link", "img", "br", "hr", "input"]);

function buildDocument(warningHtmlPath) {
  const html = fs.readFileSync(warningHtmlPath, "utf8");
  const parsed = parseHTML(html);
  const documentElement = new El("html");
  const body = parsed.query("body")[0] || new El("body");
  documentElement.appendChild(body);

  const findById = (id) => {
    let hit = null;
    const walk = (n) => {
      for (const c of n.children) {
        if (c instanceof El) {
          if (!hit && c.attributes.id === id) hit = c;
          walk(c);
        }
      }
    };
    walk(documentElement);
    return hit;
  };

  const document = {
    documentElement,
    body,
    head: new El("head"),
    currentScript: null,
    getElementById: findById,
    createElement: (t) => new El(t),
    createTextNode: (t) => new TextNode(t),
    querySelectorAll: (sel) => documentElement.query(sel)
  };
  return { document, getById: findById, messages: [] };
}

class TextNode {
  constructor(t) { this._text = String(t); this.children = []; this.parentNode = null; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this._text = "";
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this._listeners = {};
    const self = this;
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.classList = {
      _get: () => (self.attributes.class || "").split(/\s+/).filter(Boolean),
      add(c) { const s = new Set(this._get()); s.add(c); self.attributes.class = [...s].join(" "); },
      remove(c) { const s = new Set(this._get()); s.delete(c); self.attributes.class = [...s].join(" "); },
      toggle(c, force) {
        const s = new Set(this._get());
        const on = force === undefined ? !s.has(c) : force;
        if (on) s.add(c); else s.delete(c);
        self.attributes.class = [...s].join(" ");
        return on;
      },
      contains(c) { return this._get().includes(c); }
    };
  }
  get id() { return this.attributes.id || ""; }
  set id(v) { this.attributes.id = v; }
  get className() { return this.attributes.class || ""; }
  set className(v) { this.attributes.class = v; }
  setAttribute(n, v) {
    this.attributes[n] = String(v);
    if (n === "hidden") this.hidden = true;
    if (n === "disabled") this.disabled = true;
    if (n.startsWith("data-")) {
      const key = n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(v);
    }
  }
  getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  append(...nodes) { nodes.forEach((n) => this.appendChild(typeof n === "string" ? new TextNode(n) : n)); }
  replaceChildren(...nodes) { this.children = []; this._text = ""; this.append(...nodes); }
  insertBefore(node, ref) {
    node.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
    return node;
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  // Dispatch a click the way a user would, so the tests exercise the page's real
  // handlers rather than reaching into its internals.
  click() { (this._listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); }
  focus() { this.ownerDocumentFocus = true; }
  querySelector(sel) { return this.query(sel)[0] || null; }
  get firstChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.filter((c) => c instanceof El).length; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() {
    return this.children.length === 0 ? this._text : this.children.map((c) => c.textContent).join("");
  }
  set innerHTML(_v) { this.children = []; this._text = ""; }
  get innerHTML() { return ""; }
  query(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    const match = (el, p) => {
      const m = /^\[([a-zA-Z0-9-]+)\]$/.exec(p);
      return m ? m[1] in el.attributes : el.tagName === p.toUpperCase();
    };
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c instanceof El) {
          if (parts.some((p) => match(c, p))) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

// Minimal HTML parser: elements, double-quoted attributes, void + self-closing
// tags, comments, and opaque <style>/<script> bodies. Sufficient for the clean,
// hand-authored warning.html — not a general HTML5 parser.
function parseHTML(html) {
  html = html.replace(/<!DOCTYPE[^>]*>/i, "");
  const root = new El("root");
  const stack = [root];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) { i = html.indexOf("-->", i) + 3; continue; }
    if (html[i] === "<") {
      const close = html.indexOf(">", i);
      if (close === -1) break;
      const raw = html.slice(i + 1, close);
      i = close + 1;
      if (raw.startsWith("/")) {
        const name = raw.slice(1).trim().toUpperCase();
        while (stack.length > 1 && stack[stack.length - 1].tagName !== name) stack.pop();
        if (stack.length > 1) stack.pop();
        continue;
      }
      const sp = raw.search(/\s/);
      const tag = (sp === -1 ? raw : raw.slice(0, sp)).replace(/\/$/, "").toLowerCase();
      const el = new El(tag);
      const attrStr = sp === -1 ? "" : raw.slice(sp);
      for (const am of attrStr.matchAll(/([a-zA-Z0-9-]+)(?:="([^"]*)")?/g)) {
        if (am[1]) el.setAttribute(am[1], am[2] === undefined ? "" : am[2]);
      }
      stack[stack.length - 1].appendChild(el);
      if (tag === "style" || tag === "script") {
        const end = html.indexOf(`</${tag}`, i);
        if (end !== -1) i = html.indexOf(">", end) + 1;
        continue;
      }
      if (!(raw.endsWith("/") || VOID_TAGS.has(tag))) stack.push(el);
    } else {
      const next = html.indexOf("<", i);
      const text = html.slice(i, next === -1 ? html.length : next);
      if (text.trim()) stack[stack.length - 1].appendChild(new TextNode(text));
      i = next === -1 ? html.length : next;
    }
  }
  return root;
}
