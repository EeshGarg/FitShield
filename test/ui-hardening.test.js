"use strict";
/**
 * Behavioural guards for the interface repairs found by driving the built
 * package in real Chromium.
 *
 * Every test here failed against the code as shipped before the accompanying
 * fix, and each one drives the REAL page script — not a copy of its logic — so
 * it keeps answering the same question when the implementation moves.
 *
 *   1. THEME MODE reaches the block page and what's-new. With Theme = System
 *      the popup and the settings page re-resolve the preset against the OS at
 *      every load and neither writes the result back, so the stored `theme` is
 *      stale from the first OS light↔dark flip onwards. Those two pages read
 *      only `theme`, and rendered fully dark beside a fully light popup — same
 *      profile, same session, opposite themes.
 *   2. A FAILED "continue" is reported where it happened. The message went to
 *      #hint, in the card above; measured in Chromium it sat 830px above the
 *      viewport at the moment the chooser was open, so pressing a pass option
 *      and failing looked exactly like pressing a dead button.
 *   3. The DESTRUCTIVE CONFIRM DIALOG opens on the safe choice, keeps Tab
 *      inside itself, and gives focus back. It opened on "Confirm", let one Tab
 *      into the 130-control page behind a dimmed overlay, and dropped focus on
 *      <body> when dismissed — while claiming aria-modal="true".
 *   4. The RULE row survives both spellings of the block type. The two records
 *      this page can be handed spell fast food differently ("fast_food" from the
 *      dataset, "fastfood" from the DNR bucket) and an exact switch answered ""
 *      for one of them, so that path rendered a reason panel with no Rule in it.
 *   5. Values that come from DATA are bidi-isolated, so a right-to-left brand
 *      name cannot drag the neutral punctuation around it to the wrong end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "extension");
const read = (file) => fs.readFileSync(path.join(EXT, file), "utf8");
const core = require("../extension/fitshield-core.js");

// ---------------------------------------------------------------------------
// A DOM stub deep enough to load a page script and inspect what it built.
// ---------------------------------------------------------------------------

function makeElement(tag, doc) {
  const element = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    style: {
      _props: {},
      setProperty(name, value) { element.style._props[name] = value; },
      removeProperty(name) { delete element.style._props[name]; },
      getPropertyValue(name) { return element.style._props[name] || ""; }
    },
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((n) => element.classList._set.add(n)); },
      remove(...names) { names.forEach((n) => element.classList._set.delete(n)); },
      toggle(name, force) {
        const on = force === undefined ? !element.classList._set.has(name) : !!force;
        if (on) { element.classList._set.add(name); } else { element.classList._set.delete(name); }
        return on;
      },
      contains(name) { return element.classList._set.has(name); }
    },
    hidden: false, disabled: false, checked: false, value: "", textContent: "", dir: "",
    addEventListener(type, fn) { (element.listeners[type] = element.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      element.listeners[type] = (element.listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, event) {
      (element.listeners[type] || []).slice().forEach((fn) => fn(event || { type, target: element }));
    },
    appendChild(node) { element.children.push(node); return node; },
    append(...nodes) { element.children.push(...nodes); },
    replaceChildren(...nodes) { element.children = nodes; },
    insertBefore(node) { element.children.unshift(node); return node; },
    remove() {},
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return name in element.attributes ? element.attributes[name] : null; },
    hasAttribute(name) { return name in element.attributes; },
    removeAttribute(name) { delete element.attributes[name]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains(node) { return node === element || element.children.includes(node); },
    focus() { if (doc) { doc.activeElement = element; } },
    click() { element.dispatch("click"); },
    get firstChild() { return element.children[0] || null; },
    get childElementCount() { return element.children.length; },
    get isConnected() { return true; }
  };
  return element;
}

/** All ids referenced by `document.getElementById` in a page's markup. */
function idsIn(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

function makeDocument(html) {
  const byId = new Map();
  const doc = {
    documentElement: null,
    body: null,
    head: null,
    activeElement: null,
    currentScript: null,
    hidden: false,
    readyState: "complete",
    listeners: {},
    getElementById(id) {
      if (!byId.has(id)) { byId.set(id, makeElement("div", doc)); }
      return byId.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: (tag) => makeElement(tag, doc),
    createTextNode: (text) => ({ textContent: String(text), nodeType: 3 }),
    createDocumentFragment: () => makeElement("fragment", doc),
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      doc.listeners[type] = (doc.listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, event) { (doc.listeners[type] || []).slice().forEach((fn) => fn(event)); },
    byId
  };

  doc.documentElement = makeElement("html", doc);
  doc.body = makeElement("body", doc);
  doc.head = makeElement("head", doc);
  idsIn(html).forEach((id) => doc.getElementById(id));
  return doc;
}

// ---------------------------------------------------------------------------
// 1. Theme mode reaches every surface
// ---------------------------------------------------------------------------

/**
 * Boot warning.js or whats-new.js with a given stored theme, stored mode and OS
 * preference, and report the custom properties the page actually wrote.
 */
async function bootThemedPage(page, script, { theme, themeMode, osPrefersLight }) {
  const html = read(page);
  const doc = makeDocument(html);
  const stored = { theme, themeMode };

  const win = {
    location: { search: "?site=x", href: "" },
    matchMedia: (query) => ({
      matches: /prefers-color-scheme:\s*light/.test(query) ? !!osPrefersLight : false,
      addEventListener() {}, removeEventListener() {}
    }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    requestAnimationFrame: (fn) => { fn(); return 0; },
    history: { back() {}, length: 1 },
    close() {}
  };

  const sandbox = {
    chrome: {
      runtime: {
        getURL: (p) => `chrome-extension://test/${p}`,
        getManifest: () => ({ version: "0.55" }),
        sendMessage: async () => ({ ok: false })
      },
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
              if (stored[k] !== undefined) { out[k] = stored[k]; }
            });
            return out;
          },
          set: async (obj) => Object.assign(stored, obj)
        },
        onChanged: { addListener() {} }
      },
      i18n: { getMessage: () => "", getUILanguage: () => "en" }
    },
    document: doc, window: win,
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: async () => { throw new Error("no network in a test"); },
    navigator: { language: "en-US" },
    URL, URLSearchParams,
    Math, Date, JSON, Promise, Number, String, Array, Object, Set, Map, Intl, Error, RegExp,
    setInterval: () => 0, clearInterval() {}, setTimeout: (fn) => { void fn; return 0; },
    performance: { getEntriesByType: () => [{ type: "navigate" }] },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: win.matchMedia, location: win.location
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  // Load exactly the local scripts the page declares, in the page's own order,
  // so a test cannot pass because it supplied a dependency the page does not.
  [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).forEach((src) => {
    if (src === "ambient.js" || src === script) { return; }
    const file = path.join(EXT, src);
    if (fs.existsSync(file)) { vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: src }); }
  });
  vm.runInContext(read(script), context, { filename: script });

  // Let the page's own boot promise settle.
  await new Promise((resolve) => setTimeout(resolve, 30));

  return { sandbox, doc, props: doc.documentElement.style._props, root: doc.documentElement };
}

const DARK = core.THEME_MODE_PRESETS.dark;
const LIGHT = core.THEME_MODE_PRESETS.light;

for (const [page, script] of [["warning.html", "warning.js"], ["whats-new.html", "whats-new.js"]]) {
  test(`${page} follows Theme = System when the OS is light`, async () => {
    // Exactly the state the product leaves behind: the user chose System while
    // the OS was dark (so the DARK preset is what got persisted), then the OS
    // went light. The popup and settings re-resolve and go light; this page must
    // not be the one surface still painting the old palette.
    const { props } = await bootThemedPage(page, script, {
      theme: { ...DARK }, themeMode: "system", osPrefersLight: true
    });

    assert.equal(props["--text"], LIGHT.text, `${page} kept the stale dark text colour`);
    assert.equal(props["--bg"], LIGHT.bg, `${page} kept the stale dark background`);
    assert.equal(props["--accent"], LIGHT.accent, `${page} kept the stale dark accent`);
  });

  test(`${page} follows Theme = System when the OS is dark`, async () => {
    const { props } = await bootThemedPage(page, script, {
      theme: { ...LIGHT }, themeMode: "system", osPrefersLight: false
    });

    assert.equal(props["--text"], DARK.text, `${page} kept the stale light text colour`);
    assert.equal(props["--bg"], DARK.bg, `${page} kept the stale light background`);
  });

  test(`${page} never overwrites a hand-picked palette`, async () => {
    // shouldUseResolvedPreset is false as soon as the stored colours stop
    // matching either preset, so "System" must leave a custom theme alone.
    const custom = { ...DARK, bg: "#120018", accent: "#ff66cc" };
    const { props } = await bootThemedPage(page, script, {
      theme: custom, themeMode: "system", osPrefersLight: true
    });

    assert.equal(props["--bg"], custom.bg, `${page} discarded a custom background`);
    assert.equal(props["--accent"], custom.accent, `${page} discarded a custom accent`);
  });

  test(`${page} tells the browser which color-scheme it is painting`, async () => {
    const light = await bootThemedPage(page, script, {
      theme: { ...DARK }, themeMode: "system", osPrefersLight: true
    });
    assert.equal(light.root.style.colorScheme, "light",
      `${page} left color-scheme: dark under a light palette — the scrollbar and the pre-paint canvas come from it`);

    const dark = await bootThemedPage(page, script, {
      theme: { ...DARK }, themeMode: "dark", osPrefersLight: true
    });
    assert.equal(dark.root.style.colorScheme, "dark");
  });
}

test("the block page re-derives accentDim from the resolved accent", async () => {
  // accentDim is a function of the accent (settings.js: hexToRgba(accent, 0.22))
  // and rings every hairline on the page. Carrying the stored one across a
  // resolve would draw the dark theme's mint borders on a white panel.
  const { props } = await bootThemedPage("warning.html", "warning.js", {
    theme: { ...DARK, accentDim: core.hexToRgba(DARK.accent, 0.22) },
    themeMode: "system",
    osPrefersLight: true
  });

  assert.equal(props["--accent-dim"], core.hexToRgba(LIGHT.accent, 0.22));
});

// ---------------------------------------------------------------------------
// 2. A failed "continue" is reported where the user pressed
// ---------------------------------------------------------------------------

test("the block page reports a failed pass inside the chooser, not in another card", () => {
  const html = read("warning.html");

  const passPanel = /<section class="shell pass"[\s\S]*?<\/section>/.exec(html);
  assert.ok(passPanel, "the pass chooser section must still exist");

  const note = /<p[^>]*id="passNote"[^>]*>/.exec(passPanel[0]);
  assert.ok(note, "the pass chooser has no message element of its own");
  assert.match(note[0], /role="alert"/,
    "a failure on the one action that lets a user through has to interrupt, not queue behind other output");
  assert.match(note[0], /\bhidden\b/, "the notice must start hidden");

  // Above the option list, not below it. Six pass options are ~460px tall, and
  // measured in Chromium at a 900px viewport the notice sat at y=878 when it
  // followed them — past the fold of the very panel the user was looking at.
  assert.ok(
    passPanel[0].indexOf('id="passNote"') < passPanel[0].indexOf('id="passOptions"'),
    "the notice must precede the options, or it lands off the bottom of the panel"
  );
});

test("warning.js writes both continue failures into the chooser's own notice", () => {
  const source = read("warning.js");
  const grant = /async function grantPass\([\s\S]*?\n}/.exec(source);
  assert.ok(grant, "grantPass must still exist");

  // Both exits that leave the user on this page: a rejected pass and preview
  // mode, which grants nothing by design.
  // Matched inside a setPassNote call rather than as one exact string: the
  // rejected-pass branch now chooses between two hints, because a block page
  // left open across a browser restart holds a token the worker no longer
  // recognises and is told to ask for the site again rather than being left
  // with a generic failure. Pinning the exact call text made this fail while
  // the behaviour it guards was intact — which is the trap CLAUDE.md §6 names.
  assert.match(grant[0], /setPassNote\([^;]*"warningErrorHint"/,
    "a rejected pass must be reported beside the option that was pressed");
  assert.match(grant[0], /setPassNote\([^;]*"warningStaleHint"/,
    "an out-of-date block page must say so, not fall back to the generic failure");
  assert.match(grant[0], /setPassNote\(t\("previewPassNote"\)\)/,
    "preview mode must say so beside the option, not only in the alternative card");

  assert.doesNotMatch(grant[0], /ui\.hint\.textContent/,
    "the failure must not be written into #hint, which is off-screen while the chooser is open");
  assert.doesNotMatch(grant[0], /ui\.altAnnounce\.textContent/,
    "#altAnnounce lives in the alternative card, which is hidden on the straight-to-chooser path");
});

// ---------------------------------------------------------------------------
// 3. The destructive confirmation dialog
// ---------------------------------------------------------------------------

function settingsSandbox() {
  const html = read("settings.html");
  const doc = makeDocument(html);

  const win = {
    location: { search: "", href: "", hash: "", reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} }),
    history: { back() {}, length: 1 },
    open() {}, addEventListener() {}, removeEventListener() {},
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" })
  };

  const sandbox = {
    chrome: {
      runtime: {
        getURL: (p) => `chrome-extension://test/${p}`,
        getManifest: () => ({ version: "0.55" }),
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener() {} },
        lastError: null
      },
      storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} },
        onChanged: { addListener() {} }
      },
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      tabs: { create() {}, query: async () => [], onRemoved: { addListener() {} } }
    },
    document: doc, window: win,
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    navigator: { language: "en-US", clipboard: { writeText: async () => {} } },
    URL, URLSearchParams, Blob: class {},
    Math, Date, JSON, Promise, Number, String, Array, Object, Set, Map, Intl, Error, RegExp,
    isNaN, parseInt, parseFloat,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    matchMedia: win.matchMedia, location: win.location, getComputedStyle: win.getComputedStyle
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).forEach((src) => {
    const file = path.join(EXT, src);
    if (fs.existsSync(file)) { vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: src }); }
  });

  return { sandbox, doc };
}

function openConfirm() {
  const { sandbox, doc } = settingsSandbox();
  assert.equal(typeof sandbox.confirmAction, "function", "settings.js no longer declares confirmAction");

  const trigger = doc.getElementById("factoryReset");
  trigger.focus();

  const promise = sandbox.confirmAction("Erase everything?");
  return {
    doc,
    trigger,
    promise,
    cancel: doc.getElementById("confirmCancel"),
    ok: doc.getElementById("confirmOk"),
    overlay: doc.getElementById("confirmOverlay"),
    key: (init) => doc.dispatch("keydown", {
      key: init.key, shiftKey: !!init.shiftKey,
      preventDefault() { init.prevented = true; }
    })
  };
}

test("the destructive dialog opens on the safe choice, not on Confirm", async () => {
  const d = openConfirm();

  assert.equal(d.doc.activeElement, d.cancel,
    "focus landed on the destructive button, so key repeat from the key that opened the dialog confirms it");

  d.cancel.click();
  assert.equal(await d.promise, false);
});

test("the destructive dialog keeps Tab inside itself", async () => {
  const d = openConfirm();

  // Forward from the last stop wraps to the first.
  d.ok.focus();
  const forward = { key: "Tab" };
  d.key(forward);
  assert.ok(forward.prevented, "Tab off the last control was allowed to leave a modal dialog");
  assert.equal(d.doc.activeElement, d.cancel);

  // Backward from the first stop wraps to the last.
  const back = { key: "Tab", shiftKey: true };
  d.key(back);
  assert.ok(back.prevented, "Shift+Tab off the first control was allowed to leave a modal dialog");
  assert.equal(d.doc.activeElement, d.ok);

  d.cancel.click();
  assert.equal(await d.promise, false);
});

test("the destructive dialog pulls focus back if it is already outside", async () => {
  const d = openConfirm();

  // Whatever put focus on the page behind — a stray click, a script — the next
  // Tab must return to the dialog rather than continue through the page.
  const elsewhere = d.doc.getElementById("resetBlocking");
  elsewhere.focus();

  const event = { key: "Tab" };
  d.key(event);
  assert.ok(event.prevented);
  assert.equal(d.doc.activeElement, d.cancel);

  d.cancel.click();
  assert.equal(await d.promise, false);
});

test("the destructive dialog gives focus back to whatever opened it", async () => {
  const d = openConfirm();
  d.cancel.click();

  assert.equal(await d.promise, false);
  assert.equal(d.doc.activeElement, d.trigger,
    "focus was dropped, so a keyboard user restarts from the top of a fourteen-card page");
});

test("Escape still closes the destructive dialog, and still restores focus", async () => {
  const d = openConfirm();
  d.key({ key: "Escape" });

  assert.equal(await d.promise, false);
  assert.equal(d.doc.activeElement, d.trigger);
});

test("the destructive dialog stops listening for keys once it is closed", async () => {
  const d = openConfirm();
  d.cancel.click();
  await d.promise;

  // A trap that outlives its dialog silently eats Tab on the whole page.
  const stray = { key: "Tab" };
  d.key(stray);
  assert.ok(!stray.prevented, "the Tab trap survived the dialog and is now swallowing Tab on the settings page");
});

// ---------------------------------------------------------------------------
// 4 & 5. The reason panel: both spellings of the type, and bidi isolation
// ---------------------------------------------------------------------------

/**
 * Load the real block-page script chain. When `site` is given, the worker's
 * reply is stubbed with it so the page boots exactly as it would for that brand.
 */
function blockPageHelpers(site) {
  const html = read("warning.html");
  const doc = makeDocument(html);
  const messages = JSON.parse(read(path.join("_locales", "en", "messages.json")));

  const blockContext = site ? {
    ok: true, found: true, site,
    timerSeconds: 5, baseTimerSeconds: 5,
    repeat: { repeat: false, extraSeconds: 0, windowMinutes: 60 },
    passDurationMinutes: 5, frictionProfile: "balanced", askIntent: false,
    preferences: {
      dietPreference: "none", pantry: [], equipment: [], avoidAllergens: [],
      alternativeFavorites: [], recentAlternatives: [], dismissedAlternatives: [], customAlternatives: []
    }
  } : { ok: false };

  const win = {
    location: { search: "?site=x", href: "" },
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    requestAnimationFrame: (fn) => { fn(); return 0; },
    history: { back() {}, length: 1 }
  };

  const sandbox = {
    chrome: {
      runtime: {
        getURL: (p) => p,
        getManifest: () => ({ version: "0.55" }),
        sendMessage: async (msg) => (msg && msg.type === "getBlockContext" ? blockContext : { ok: false })
      },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      i18n: {
        getMessage: (key, subs) => {
          const entry = messages[key];
          if (!entry) { return ""; }
          return String(entry.message).replace(/\$(\d)/g, (_, i) => (subs && subs[Number(i) - 1]) || "");
        },
        getUILanguage: () => "en"
      }
    },
    document: doc, window: win,
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: async () => { throw new Error("no network in a test"); },
    navigator: { language: "en-US" },
    URL, URLSearchParams,
    Math, Date, JSON, Promise, Number, String, Array, Object, Set, Map, Intl, Error, RegExp,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    performance: { getEntriesByType: () => [{ type: "navigate" }] },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: win.matchMedia, location: win.location
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  ["browser-shim.js", "i18n.js", "fitshield-core.js", "recipes.js", "warning.js"].forEach((src) => {
    vm.runInContext(read(src), context, { filename: src });
  });

  return { sandbox, doc, messages };
}

test("the Rule row survives both spellings of the block type", () => {
  const { sandbox, messages } = blockPageHelpers();
  const label = sandbox.blockTypeLabel;
  assert.equal(typeof label, "function", "warning.js no longer declares blockTypeLabel");

  // The dataset spelling and the DNR-bucket spelling are one word, and both
  // reach this page: the branded record carries `fast_food`, the rule catalog's
  // fallback record carries `fastfood`. An exact switch answered "" for the
  // second, so that path drew a reason panel with a Site, a Category, a country
  // list — and no Rule at all.
  ["fast_food", "fastfood", "fast food", "FAST_FOOD"].forEach((spelling) => {
    assert.equal(label(spelling), messages.blockTypeFastFood.message, `"${spelling}" produced no Rule label`);
  });

  assert.equal(label("delivery"), messages.blockTypeDelivery.message);
  assert.equal(label("custom"), messages.blockTypeCustom.message);
});

test("an unknown block type prints nothing rather than a raw identifier", () => {
  const { sandbox } = blockPageHelpers();

  // Omitting is what every other row in this panel does with a missing value.
  // Printing the id would put "wholesale_marketplace" on the product's most
  // visible screen, in English, in every locale.
  ["wholesale_marketplace", "", null, undefined, "b2b"].forEach((value) => {
    assert.equal(sandbox.blockTypeLabel(value), "", `"${value}" leaked into the Rule row`);
  });
});

test("reason values and the brand name are bidi-isolated", async () => {
  // A curated label, a domain and a country list all come from data. The block
  // page renders them inside a left-to-right sentence and a left-to-right row,
  // and an unisolated right-to-left run drags the neutral characters around it
  // — the sentence's full stop, the row's separating commas, the "+7 more" —
  // to the wrong end of the line.
  const { doc } = blockPageHelpers({
    key: "x", label: "مطعم الشام", domain: "shaam.example",
    type: "delivery", category: "tea", countries: ["SA", "AE"], specialties: []
  });

  await new Promise((resolve) => setTimeout(resolve, 40));

  const strong = doc.getElementById("brand").children.find((child) => child.tagName === "STRONG");
  assert.ok(strong, "the brand line no longer emphasises the brand");
  assert.equal(strong.textContent, "مطعم الشام");
  assert.equal(strong.dir, "auto",
    "the sentence's full stop is a text node outside this element; without isolation it can be reordered into the line");

  const rows = doc.getElementById("reasonBody").children;
  assert.ok(rows.length >= 2, `the reason panel rendered ${rows.length} rows`);

  rows.forEach((row) => {
    const value = row.children.find((child) => child.className === "reason-value");
    assert.ok(value, "a reason row no longer builds a .reason-value");
    assert.equal(value.dir, "auto", `"${value.textContent}" is not isolated from the rest of its row`);
  });
});
