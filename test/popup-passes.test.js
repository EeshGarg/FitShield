"use strict";
/**
 * Popup regressions: what the status line CLAIMS, what the user can DO about a
 * running pass, and what the popup WRITES to storage.
 *
 * Six defects, all in extension/popup.js, all invisible to a source grep and
 * all visible the moment the page is actually driven:
 *
 *   F039  the status announced a global pause ("Blocking resumes in 4m 12s")
 *         for a pass that had unblocked exactly ONE site — the opposite of what
 *         the pass chooser had just promised. The first correction named the
 *         site but did it in fragments ("doordash.com · This site only · 4m
 *         12s"), which still never said that everything else was blocked; the
 *         status line is now a sentence in every branch.
 *   F040  the worker has implemented and registered `revokeAllPasses` since
 *         passes existed and NOTHING called it: a pass could not be ended early
 *         except by turning FitShield off.
 *   F041  the countdown had no hours unit, so "Pause everything until tomorrow"
 *         rendered as "Blocking resumes in 1439m 59s".
 *   F029  the "did you make it?" prompt named nothing, for a choice that can be
 *         up to 48 hours old.
 *   F061  the popup wrote `timerSeconds` / `passDurationMinutes` without
 *         updating `frictionProfile`, leaving storage — and any exported backup
 *         — describing values it no longer matched.
 *   F050  the status text was rewritten once a second whether or not it had
 *         changed.
 *
 * No jsdom: a compact DOM sufficient for the popup lives at the bottom. Only
 * ids that really exist in popup.html resolve, so a control the page creates at
 * runtime (the end-pass button) has to be found in the tree — which is what
 * makes the F040 assertions mean something.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const core = require("../extension/fitshield-core.js");

const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function srcPath(rel) {
  const candidates = [path.join(EXT, rel), path.join(ROOT, "data", rel), path.join(ROOT, rel)];
  return candidates.find((c) => fs.existsSync(c)) || candidates[2];
}

/**
 * Render the real popup (browser-shim.js, i18n.js, fitshield-core.js, popup.js)
 * against `store`, with the worker answering getBlockState with `blockState`.
 * ambient.js is excluded: it is the decorative background and needs a canvas.
 */
function renderPopup(store, blockState) {
  const dom = buildDocument(path.join(EXT, "popup.html"));
  const sent = [];

  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.55" }),
      sendMessage: async (message) => {
        sent.push(message);
        if (message.type === "getBlockState") {
          return { ok: true, ...blockState };
        }
        if (message.type === "revokeAllPasses") {
          store.passes = [];
          return { ok: true };
        }
        return { ok: true };
      }
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in store) out[k] = store[k];
          });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); }
      },
      onChanged: { addListener: () => {} }
    },
    i18n: { getMessage: () => "", getUILanguage: () => "en" }
  };

  const fetchImpl = async (url) => {
    const rel = url.replace("chrome-extension://test/", "");
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(srcPath(rel), "utf8")) };
  };

  const win = {
    location: { search: "", href: "" },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    open() {},
    history: { back() {}, length: 1 },
    setInterval: () => 0, clearInterval() {}
  };

  const sandbox = {
    chrome, document: dom.document, window: win, fetch: fetchImpl,
    console: { log() {}, warn() {}, error() {}, info() {} },
    URL, URLSearchParams, Intl,
    Math, Date, Number, String, Array, Object, JSON, Promise, Set, Map, Error, RegExp,
    isNaN, parseInt, parseFloat,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    location: win.location, matchMedia: win.matchMedia
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const file of ["browser-shim.js", "i18n.js", "fitshield-core.js", "popup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), ctx, { filename: file });
  }

  return { ...dom, sandbox, sent, store };
}

async function settle(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

// A getBlockState response with everything the status line reads.
function blockStateWith(overrides) {
  return {
    enabled: true,
    timerSeconds: 60,
    passDurationMinutes: 5,
    scheduleEnabled: false,
    scheduleActive: true,
    scheduleSimple: true,
    deliverySitesEnabled: true,
    fastFoodSitesEnabled: true,
    customSitesEnabled: true,
    deliverySites: [{ key: "delivery-doordash-com", label: "DoorDash", domain: "doordash.com", enabled: true }],
    fastFoodSites: [],
    customSites: [],
    passes: [],
    bypassUntil: 0,
    recap: null,
    ...overrides
  };
}

function sitePass(target, minutes) {
  const now = Date.now();
  return { id: `p${target}`, preset: "site30", scope: "site", target, createdAt: now, expiresAt: now + minutes * 60000 };
}

function allPass(minutes) {
  const now = Date.now();
  return { id: "pall", preset: "all30", scope: "all", target: "", createdAt: now, expiresAt: now + minutes * 60000 };
}

// ===========================================================================
// F041 — the countdown needs an hours unit
// ===========================================================================

test("the pass countdown carries hours, so a day-long pause is readable", async () => {
  const { sandbox } = renderPopup({ uiLanguage: "en" }, blockStateWith({}));
  await settle();
  const format = sandbox.formatTimeRemaining;

  assert.equal(typeof format, "function", "popup.js no longer declares formatTimeRemaining");

  // "Pause everything until tomorrow" is up to 24 hours. This is the exact
  // string the finding quotes, and the exact one that can no longer be produced.
  assert.equal(format(86399000), "23h 59m 59s");
  assert.doesNotMatch(format(86399000), /^\d{3,}m/, "no more four-digit minute counts");

  assert.equal(format(3600000), "1h 0m 0s", "exactly an hour rolls over");
  assert.equal(format(3661000), "1h 1m 1s");

  // …and nothing below an hour changed.
  assert.equal(format(90000), "1m 30s");
  assert.equal(format(30000), "30s");
  assert.equal(format(0), "0s");
  assert.equal(format(-5000), "0s", "an expired pass never counts upwards");
});

// ===========================================================================
// F039 — say what is actually paused
// ===========================================================================

test("a site-scoped pass does not claim that all blocking is paused", async () => {
  const { sandbox } = renderPopup({ uiLanguage: "en" }, blockStateWith({}));
  await settle();
  const pass = sitePass("doordash.com", 5);
  const state = blockStateWith({ passes: [pass], bypassUntil: pass.expiresAt });

  const message = sandbox.getStatusMessage(state);

  assert.match(message, /doordash\.com/, "the one site that IS open must be named");
  assert.doesNotMatch(
    message,
    /Blocking resumes/i,
    "blocking never stopped for anything but that site — saying so was the defect"
  );

  // The guarantee is now made in words instead of being implied by a "This site
  // only" tag wedged between two separators. A caption made the reader infer
  // it; a sentence states it.
  assert.match(message, /doordash\.com is open for/i, "a sentence about that site, not a caption");
  assert.match(
    message,
    /Everything else is still blocked\./i,
    "the fix is only complete when the popup SAYS what is still blocked"
  );
  assert.doesNotMatch(message, /·/, "no interpunct fragments — screen readers read this as one sentence");
  assert.doesNotMatch(message, /statusPassSite/, "the key resolved: t() renders the key name when it does not");
});

test("a pass that really did pause everything still says so", async () => {
  const { sandbox } = renderPopup({ uiLanguage: "en" }, blockStateWith({}));
  await settle();
  const pass = allPass(30);
  const state = blockStateWith({ passes: [pass], bypassUntil: pass.expiresAt });

  const message = sandbox.getStatusMessage(state);

  assert.match(message, /Blocking resumes in/i, '"Pause everything" is global, and that sentence is true of it');
});

test("several site passes name every site that is open", async () => {
  const { sandbox } = renderPopup({ uiLanguage: "en" }, blockStateWith({}));
  await settle();
  const passes = [sitePass("doordash.com", 5), sitePass("ubereats.com", 12)];
  const state = blockStateWith({ passes, bypassUntil: Math.max(...passes.map((p) => p.expiresAt)) });

  const message = sandbox.getStatusMessage(state);

  assert.match(message, /doordash\.com/);
  assert.match(message, /ubereats\.com/);
  assert.doesNotMatch(message, /Blocking resumes/i);

  // A count is not a substitute for the names here. "2 sites are open" tells a
  // user that something is unblocked without telling them WHICH — which is the
  // exact information F039 was raised to restore, so the short-list branch has
  // to name them rather than count them.
  assert.match(
    message,
    /doordash\.com, ubereats\.com are open for up to/i,
    "both names, in one sentence, joined readably"
  );
  assert.doesNotMatch(message, /^\s*2 sites/i, "the count-only sentence must not be used while the list is nameable");
  assert.match(message, /Everything else is still blocked\./i);
  assert.doesNotMatch(message, /·/, "one sentence, not three fragments");
  assert.doesNotMatch(message, /statusPassSitesNamed/, "the key resolved");
});

test("three site passes are still all named — that is the threshold, not two", async () => {
  const { sandbox } = renderPopup({ uiLanguage: "en" }, blockStateWith({}));
  await settle();
  const passes = [sitePass("doordash.com", 5), sitePass("ubereats.com", 12), sitePass("grubhub.com", 3)];
  const state = blockStateWith({ passes, bypassUntil: Math.max(...passes.map((p) => p.expiresAt)) });

  const message = sandbox.getStatusMessage(state);

  for (const site of ["doordash.com", "ubereats.com", "grubhub.com"]) {
    assert.match(message, new RegExp(site.replace(".", "\\.")), `${site} has a pass and must be named`);
  }

  assert.doesNotMatch(message, /3 sites/i, "three still fits the status line, so it is named rather than counted");
  assert.match(message, /Everything else is still blocked\./i);
  assert.doesNotMatch(message, /Blocking resumes/i);
});

test("past the threshold the count takes over, and keeps the promise with it", async () => {
  const { sandbox } = renderPopup({ uiLanguage: "en" }, blockStateWith({}));
  await settle();
  const names = ["doordash.com", "ubereats.com", "grubhub.com", "postmates.com"];
  const passes = names.map((name, index) => sitePass(name, index + 2));
  const state = blockStateWith({ passes, bypassUntil: Math.max(...passes.map((p) => p.expiresAt)) });

  const message = sandbox.getStatusMessage(state);

  // Four names would push the status box onto a third line and resize the popup
  // every time a pass starts or ends, so the list gives way to a count.
  assert.match(message, /4 sites are open for up to/i, "the count, once the list stops being readable");
  names.forEach((name) => {
    assert.doesNotMatch(message, new RegExp(name.replace(".", "\\.")), `${name} is counted, not listed, past the threshold`);
  });

  // Whatever the length, the sentence never degrades into the global claim.
  assert.doesNotMatch(message, /Blocking resumes/i, "these are site passes at any count");
  assert.match(
    message,
    /Everything else is still blocked\./i,
    "the promise F039 restored has to survive the fallback, not just the short list"
  );
});

test("a mixed set is described by the pass with the widest scope", async () => {
  const { sandbox } = renderPopup({ uiLanguage: "en" }, blockStateWith({}));
  await settle();
  const passes = [sitePass("doordash.com", 5), allPass(30)];
  const state = blockStateWith({ passes, bypassUntil: Math.max(...passes.map((p) => p.expiresAt)) });

  // Everything IS paused, so the global sentence is the honest one.
  assert.match(sandbox.getStatusMessage(state), /Blocking resumes in/i);
});

test("a pass that expired while the popup sat open stops describing itself", async () => {
  const { sandbox } = renderPopup({ uiLanguage: "en" }, blockStateWith({}));
  await settle();
  const now = Date.now();
  const expired = { id: "p1", preset: "site30", scope: "site", target: "doordash.com", createdAt: now - 60000, expiresAt: now - 1000 };

  // getBlockState filtered on the response it sent; the popup re-reads that same
  // response every second, so it has to re-filter too.
  const state = blockStateWith({ passes: [expired], bypassUntil: expired.expiresAt });

  assert.deepEqual(sandbox.activePassesOf(state, now), [], "an expired pass is not active");
  assert.doesNotMatch(sandbox.getStatusMessage(state), /doordash\.com/, "and must not still be named");
});

// ===========================================================================
// F040 — a way to end a pass early
// ===========================================================================

test("a running pass offers a control that ends it, and it calls the worker", async () => {
  const pass = sitePass("doordash.com", 30);
  const store = { uiLanguage: "en", passes: [pass] };
  const page = renderPopup(store, blockStateWith({ passes: [pass], bypassUntil: pass.expiresAt }));

  assert.ok(await waitFor(() => page.find("endPass")), "no control to end a running pass");

  const button = page.find("endPass");
  assert.equal(button.hidden, false, "it must be visible while a pass is running");
  assert.equal(button.tagName, "BUTTON");
  assert.ok(button.textContent.length > 0, "and it must be labelled");
  assert.equal(button.getAttribute("aria-describedby"), "status", "named by the sentence saying what it ends");

  button.click();

  assert.ok(
    await waitFor(() => page.sent.some((m) => m.type === "revokeAllPasses")),
    "the handler the worker has always registered must finally be called"
  );
  assert.deepEqual(store.passes, [], "and the passes are gone");
});

test("with no pass running there is nothing to cancel", async () => {
  const page = renderPopup({ uiLanguage: "en", passes: [] }, blockStateWith({ passes: [], bypassUntil: 0 }));

  await settle();

  const button = page.find("endPass");
  // Either never created or created hidden — both are "not offered". What must
  // never happen is a live control for a pass that does not exist.
  assert.ok(!button || button.hidden === true, "a dead control must not be shown");
});

test("the control disappears once the pass has been ended", async () => {
  const pass = sitePass("doordash.com", 30);
  const store = { uiLanguage: "en", passes: [pass] };
  const page = renderPopup(store, blockStateWith({ passes: [pass], bypassUntil: pass.expiresAt }));

  assert.ok(await waitFor(() => page.find("endPass") && page.find("endPass").hidden === false));

  // The worker now answers with no passes, as it would after revoking.
  page.sandbox.updateUI({ ok: true, ...blockStateWith({ passes: [], bypassUntil: 0 }) });

  assert.equal(page.find("endPass").hidden, true, "no pass, no control");
});

// ===========================================================================
// F050 — do not rewrite an unchanged sentence once a second
// ===========================================================================

test("the ticking status writes only when the sentence actually changes", async () => {
  const page = renderPopup({ uiLanguage: "en" }, blockStateWith({ passes: [], bypassUntil: 0 }));

  assert.ok(await waitFor(() => page.find("status") && page.find("status").textContent.length > 0));

  const status = page.find("status");
  const before = status.writes;

  // Ten ticks of the 1s interval with nothing about the state changing.
  for (let tick = 0; tick < 10; tick += 1) {
    page.sandbox.refreshStatusOnly();
  }

  assert.equal(status.writes, before, "an unchanged sentence must not be reassigned every second");

  // …but a real change still lands. A pass counts down, so its text differs on
  // every tick and must keep being written.
  const pass = sitePass("doordash.com", 30);
  page.sandbox.updateUI({ ok: true, ...blockStateWith({ passes: [pass], bypassUntil: pass.expiresAt }) });

  assert.ok(status.writes > before, "a changed sentence is still written");
  assert.match(status.textContent, /doordash\.com/);
});

// ===========================================================================
// F061 — the stored friction label must follow the values the popup writes
// ===========================================================================

test("dragging the popup's timer off a preset moves the stored profile to Custom", async () => {
  const store = { uiLanguage: "en", ...core.frictionProfileValues("standard") };
  const page = renderPopup(store, blockStateWith({}));

  await settle();
  assert.equal(store.frictionProfile, "standard", "precondition: a fresh profile is Standard");

  const slider = page.find("timerSlider");
  slider.value = "300";
  await Promise.all((slider._listeners.change || []).map((fn) => fn({})));
  await waitFor(() => store.frictionProfile === "custom");

  assert.equal(store.timerSeconds, 300, "the value the user chose is stored");
  assert.equal(
    store.frictionProfile,
    "custom",
    "the label has to follow it — a backup exported now carried the contradiction to the next device"
  );
});

test("the popup's site-open-time control moves the profile too", async () => {
  const store = { uiLanguage: "en", ...core.frictionProfileValues("standard") };
  const page = renderPopup(store, blockStateWith({}));

  await settle();

  const field = page.find("passDurationMinutes");
  field.value = "90";
  await Promise.all((field._listeners.change || []).map((fn) => fn({})));
  await waitFor(() => store.frictionProfile === "custom");

  assert.equal(store.passDurationMinutes, 90);
  assert.equal(store.frictionProfile, "custom");
});

test("moving back onto a preset's own numbers restores that preset's name", async () => {
  const store = {
    uiLanguage: "en",
    ...core.frictionProfileValues("standard"),
    timerSeconds: 300,
    frictionProfile: "custom"
  };
  const page = renderPopup(store, blockStateWith({ timerSeconds: 300 }));

  await settle();

  const slider = page.find("timerSlider");
  slider.value = String(core.FRICTION_PROFILES.standard.timerSeconds);
  await Promise.all((slider._listeners.change || []).map((fn) => fn({})));
  await waitFor(() => store.frictionProfile === "standard");

  assert.equal(store.frictionProfile, "standard", "the popup must not strand the profile on Custom either");
});

test("the popup derives the profile the same way the settings page does", () => {
  // Both pages own a copy of this logic because they are separate scripts; what
  // must not differ is the ANSWER. Derived from frictionProfileValues in both,
  // so a new field added to a profile is picked up by both at once.
  const popupSource = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
  const settingsSource = fs.readFileSync(path.join(EXT, "settings.js"), "utf8");

  for (const [name, source] of [["popup.js", popupSource], ["settings.js", settingsSource]]) {
    assert.match(source, /frictionProfileValues\("standard"\)/, `${name} must derive the field list, not hand-write it`);
    assert.match(source, /frictionProfile: frictionProfileFor\(next\)/, `${name} must persist the derived label`);
  }
});

// ===========================================================================
// F029 — the follow-up prompt has to say what it is asking about
// ===========================================================================

test("the did-you-make-it prompt names the alternative and roughly when it was chosen", async () => {
  const store = {
    uiLanguage: "en",
    pendingAlternatives: [{ id: "naan-pizza", at: Date.now() - 3 * HOUR }]
  };
  const page = renderPopup(store, blockStateWith({}));

  const text = () => (page.find("madePromptText") || {}).textContent || "";
  assert.ok(await waitFor(() => /Naan Pizza/i.test(text())), `the prompt never named the entry: "${text()}"`);

  assert.match(text(), /Naan Pizza/i, "the title the user actually saw, from the packaged catalog");
  assert.match(text(), /3 hours ago/i, "and roughly when — the entry can be up to 48 hours old");
  assert.match(text(), /Did you make it\?/i, "the question itself is unchanged");
  assert.equal(page.find("madePrompt").hidden, false);
  assert.equal(page.find("madePrompt").dataset.alternativeId, "naan-pizza");
});

test("the prompt names an alternative the user wrote themselves", async () => {
  const store = {
    uiLanguage: "en",
    customAlternatives: [{ id: "custom-abc-0", kind: "custom", title: "Dad's omelette", steps: ["beat", "fry"] }],
    pendingAlternatives: [{ id: "custom-abc-0", at: Date.now() - 20 * 60 * 1000 }]
  };
  const page = renderPopup(store, blockStateWith({}));

  const text = () => (page.find("madePromptText") || {}).textContent || "";
  assert.ok(await waitFor(() => /Dad's omelette/.test(text())), `own alternatives must be named too: "${text()}"`);
  assert.match(text(), /20 minutes ago/i, "and a recent one is described in minutes, not hours");
});

test("an alternative whose title has since vanished still asks the plain question", async () => {
  const store = {
    uiLanguage: "en",
    // A custom alternative the user has since deleted: the id survives in the
    // pending list, the title does not.
    pendingAlternatives: [{ id: "custom-deleted-9", at: Date.now() - HOUR }]
  };
  const page = renderPopup(store, blockStateWith({}));

  await waitFor(() => /Did you make it/i.test(page.find("madePromptText").textContent));

  assert.equal(page.find("madePrompt").hidden, false, "the prompt still works");
  assert.match(page.find("madePromptText").textContent, /Did you make it\?/i, "it just cannot name it");
});

test("nothing pending means no prompt at all", async () => {
  const page = renderPopup({ uiLanguage: "en" }, blockStateWith({}));

  await settle();

  assert.equal(page.find("madePrompt").hidden, true, "FitShield never chases an answer it has not earned");
});

// ===========================================================================
// Compact DOM
// ===========================================================================

function makeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    _listeners: {},
    _text: "",
    writes: 0,
    parentNode: null,
    id: "",
    className: "",
    hidden: false,
    disabled: false,
    checked: false,
    indeterminate: false,
    value: "",
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    addEventListener(type, fn) {
      (element._listeners[type] = element._listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    appendChild(node) {
      if (node && typeof node === "object") node.parentNode = element;
      element.children.push(node);
      return node;
    },
    append(...nodes) {
      nodes.forEach((node) => element.appendChild(node));
    },
    replaceChildren(...nodes) {
      element.children = [];
      element._text = "";
      nodes.forEach((node) => element.appendChild(node));
    },
    insertBefore(node, reference) {
      if (node && typeof node === "object") node.parentNode = element;
      const at = reference ? element.children.indexOf(reference) : -1;
      if (at < 0) element.children.push(node);
      else element.children.splice(at, 0, node);
      return node;
    },
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return name in element.attributes ? element.attributes[name] : null; },
    removeAttribute(name) { delete element.attributes[name]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    remove() {},
    click() { (element._listeners.click || []).forEach((fn) => fn({})); },
    get childElementCount() { return element.children.length; },
    get nextSibling() {
      if (!element.parentNode) return null;
      const at = element.parentNode.children.indexOf(element);
      return at < 0 ? null : element.parentNode.children[at + 1] || null;
    }
  };

  // textContent behaves like the real thing: setting it replaces all children,
  // reading it concatenates them. `writes` counts assignments, which is how the
  // F050 test sees whether the ticker touched the DOM.
  Object.defineProperty(element, "textContent", {
    get() {
      return element._text + element.children.map((child) => (child && child.textContent) || "").join("");
    },
    set(value) {
      element.children = [];
      element._text = String(value);
      element.writes += 1;
    }
  });

  return element;
}

// Only ids that genuinely exist in popup.html resolve through getElementById,
// so a control the page creates at RUNTIME has to be found by walking the tree.
function buildDocument(popupHtmlPath) {
  const html = fs.readFileSync(popupHtmlPath, "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

  const byId = new Map();
  const documentElement = makeElement("html");
  const body = makeElement("body");

  documentElement.lang = "en";
  documentElement.dir = "ltr";

  ids.forEach((id) => {
    const element = makeElement(id.toLowerCase().includes("slider") || id.toLowerCase().includes("input") ? "input" : "div");
    element.id = id;
    body.appendChild(element);
    byId.set(id, element);
  });

  const card = makeElement("main");
  card.className = "card";
  body.appendChild(card);

  const document = {
    documentElement,
    body,
    head: makeElement("head"),
    hidden: false,
    readyState: "complete",
    getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
    querySelector: (selector) => (selector === ".card" ? card : null),
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), parentNode: null }),
    createDocumentFragment: () => makeElement("fragment"),
    addEventListener() {},
    removeEventListener() {}
  };

  // Depth-first lookup over everything actually in the tree, including nodes the
  // page inserted after load.
  function find(id) {
    const seen = new Set();
    const walk = (node) => {
      if (!node || typeof node !== "object" || seen.has(node)) return null;
      seen.add(node);
      if (node.id === id) return node;
      for (const child of node.children || []) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(body);
  }

  return { document, find, byId };
}
