"use strict";
/**
 * The diagnostics page is customer copy, not a developer console.
 *
 * Settings' "Check FitShield is working" opens diagnostics.html, so the reader
 * is whoever installed FitShield — from a store, with no repository, no Node and
 * no dist/ folder. It shipped telling that person:
 *
 *   "The service worker did not respond — blocking is NOT running."
 *   "Most likely a source folder was loaded. Fix: run `node build.js`, then Load
 *    unpacked from dist/chrome (not the repo root or extension/)."
 *
 * and rendering the block-page row as the link text "open warning.html". Three
 * separate things a customer cannot act on: a build command, a repository path,
 * and a source filename.
 *
 * What is pinned here:
 *
 *   1. THE COPY CONTRACT, data-driven over diagnostics.js itself. Every
 *      `tOr("key", "English")` pair in the file is extracted and checked — both
 *      the English fallback and the message the key resolves to — so a string
 *      added later is covered without touching this file.
 *   2. NOTHING SENTENCE-SHAPED IS HARDCODED. A new user-facing string that
 *      skips `tOr` is caught by the same scan.
 *   3. THE RENDERED PAGE, in every failure state, with the real locale AND with
 *      no messages at all. The second run is the one that proves the fallback:
 *      `t` returns the KEY when a message is missing, so without it a customer
 *      reads "diagWorkerDown" at the moment they are trying to find out why
 *      blocking stopped.
 *   4. THE LIVE REGION IS VISIBLE BEFORE IT IS WRITTEN. #banner is role="status"
 *      and was written while still `hidden`, which screen readers announce
 *      inconsistently — some never see the change, some announce the old text.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

const read = (file) => fs.readFileSync(path.join(EXT, file), "utf8");
const source = read("diagnostics.js");
const en = JSON.parse(read(path.join("_locales", "en", "messages.json")));

// ---------------------------------------------------------------------------
// What may never appear in something a customer reads
// ---------------------------------------------------------------------------

// Each entry is a shape, not a phrase, so the rule keeps meaning when the copy
// is rewritten. `$1` values are excluded from this scan where they carry text
// the browser or the engine reported — that is quotable evidence, not copy, and
// the fixtures below use realistic browser wording rather than paths.
const FORBIDDEN = [
  { what: "a build command", pattern: /\bnode\s+[\w./-]*\.js\b|\bnpm\s+(?:run\s+)?[\w:-]+/i },
  { what: "a repository or package path", pattern: /\b(?:dist|extension|src|tools|data|node_modules|engine)\/|\brepo(?:sitory)?\b/i },
  { what: "a source filename", pattern: /\b[\w-]+\.(?:js|mjs|html|json|zip|crx|xpi)\b/i },
  { what: "a load-unpacked instruction", pattern: /\bload\s+unpacked\b/i },
  { what: "an internal module or platform name", pattern: /\bFS Engine\b|\bservice worker\b|\bMV3\b|\bmanifest\b|\bdeclarativeNetRequest\b|\bbundle\b/i },
  { what: "a command in backticks", pattern: /`[^`]+`/ }
];

function offences(text) {
  return FORBIDDEN.filter((rule) => rule.pattern.test(String(text))).map((rule) => rule.what);
}

function assertReadable(text, where) {
  const found = offences(text);
  assert.deepEqual(found, [], `${where} names ${found.join(", ")}: ${JSON.stringify(String(text))}`);
}

// ---------------------------------------------------------------------------
// 1 + 2. The copy contract, read out of the file
// ---------------------------------------------------------------------------

/** Every `tOr("key", "English fallback")` pair in diagnostics.js. */
function copyPairs() {
  const pairs = [];
  const call = /\btOr\(\s*"([A-Za-z0-9_]+)"\s*,\s*("(?:[^"\\]|\\.)*")/g;

  for (const match of source.matchAll(call)) {
    pairs.push({ key: match[1], fallback: JSON.parse(match[2]) });
  }

  return pairs;
}

// Comments quote the copy this page used to ship, so they are not part of what
// it ships now.
const CODE = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every double-quoted literal in the executable source, in order. */
function stringLiterals() {
  return [...CODE.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((match) => JSON.parse(match[0]));
}

/**
 * Messages the page throws at itself.
 *
 * These are not copy: the page marks its own failures as carrying nothing to
 * show, and "our own timeout adds no untranslated line under the banner" below
 * proves that by rendering it. Only what the BROWSER reports is quoted on
 * screen.
 */
function internalErrorMessages() {
  return new Set(
    [...CODE.matchAll(/new Error\(\s*("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]))
  );
}

const highestPlaceholder = (text) =>
  (String(text).match(/\$[1-9]/g) || []).reduce((max, token) => Math.max(max, Number(token.slice(1))), 0);

const PAIRS = copyPairs();

test("the diagnostics copy is localized, and every key it names really exists", () => {
  // A floor, so a refactor that breaks the extraction fails loudly instead of
  // passing with nothing to check.
  assert.ok(PAIRS.length >= 15, `expected the page to name many strings, found ${PAIRS.length}`);

  const missing = PAIRS.map((pair) => pair.key).filter((key) => !en[key]);
  assert.deepEqual(missing, [], `these render as their own key name in every locale: ${missing.join(", ")}`);
});

test("no diagnostics string tells a customer to run a build, open a repository path, or name a source file", () => {
  // Data-driven: both halves of every pair, so the page is correct whether the
  // message resolves or falls back.
  PAIRS.forEach(({ key, fallback }) => {
    assertReadable(fallback, `the English fallback for ${key}`);
    assertReadable(en[key].message, `the English message ${key}`);
  });
});

test("a missing message cannot change what a parameterized sentence says", () => {
  PAIRS.forEach(({ key, fallback }) => {
    assert.ok(fallback.trim().length > 0, `${key} has an empty fallback`);
    assert.equal(
      highestPlaceholder(fallback),
      highestPlaceholder(en[key].message),
      `${key}: the fallback and the message disagree about how many values they take`
    );
  });
});

test("no user-facing sentence is hardcoded past the localization helper", () => {
  const localized = new Set(PAIRS.map((pair) => pair.fallback));
  const internal = internalErrorMessages();

  // Element ids and class names are lowercase tokens; a sentence written for a
  // person has a capital letter in it. Anything of that shape has to have gone
  // through `tOr`.
  const looksLikeCopy = (value) => /\s/.test(value) && /[A-Z]/.test(value);

  const loose = stringLiterals()
    .filter((value) => looksLikeCopy(value))
    .filter((value) => !localized.has(value) && !internal.has(value));

  assert.deepEqual(loose, [], `these would ship in English in every locale: ${loose.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// 3 + 4. The page, actually rendered
// ---------------------------------------------------------------------------

function makeElement(tag) {
  const element = {
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    children: [],
    attributes: {},
    dataset: {},
    className: "",
    hidden: false,
    value: "",
    href: "",
    target: "",
    rel: "",
    writes: [],
    addEventListener() {},
    removeEventListener() {},
    appendChild(node) { element.children.push(node); return node; },
    append(...nodes) { element.children.push(...nodes); },
    replaceChildren() { element.children = []; },
    remove() {},
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return name in element.attributes ? element.attributes[name] : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {}, click() {}
  };

  // textContent is a real property with a record of every write, because the
  // ORDER of writes relative to `hidden` is itself part of the contract.
  let text = "";
  Object.defineProperty(element, "textContent", {
    get: () => text,
    set: (value) => {
      text = String(value);
      element.children = [];
      element.writes.push({ what: "text", value: text });
    }
  });

  let isHidden = false;
  Object.defineProperty(element, "hidden", {
    get: () => isHidden,
    set: (value) => {
      isHidden = Boolean(value);
      element.writes.push({ what: "hidden", value: isHidden });
    }
  });

  return element;
}

/** Everything this element and its children put on screen. */
function shownText(element) {
  const own = element.textContent || "";
  const kids = (element.children || []).map(shownText).join(" ");
  return `${own} ${kids}`.trim();
}

/**
 * Load the real page chain (browser-shim.js, i18n.js, diagnostics.js) against a
 * stub DOM built from the ids diagnostics.html actually contains.
 *
 * `messages: "en"` pins the stored language so i18n.js fetches the real English
 * file; `messages: "none"` gives the page a host that resolves nothing, which is
 * what a missing or not-yet-translated message looks like at runtime.
 */
function diagnosticsPage({ messages = "en", answer } = {}) {
  const ids = [...read("diagnostics.html").matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const byId = new Map();
  const body = makeElement("body");

  ids.forEach((id) => {
    const element = makeElement(id === "domain" ? "input" : "div");
    element.id = id;
    body.appendChild(element);
    byId.set(id, element);
  });

  const document = {
    documentElement: makeElement("html"),
    body,
    head: makeElement("head"),
    hidden: false,
    readyState: "complete",
    getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(tag),
    createTextNode: (value) => ({ textContent: String(value) }),
    addEventListener() {},
    removeEventListener() {}
  };

  const store = { uiLanguage: messages === "en" ? "en" : "" };
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.55", name: "FitShield" }),
      // The page uses the CALLBACK form, and reads chrome.runtime.lastError.
      // `answer` returning undefined models a worker that never calls back.
      sendMessage: (message, callback) => {
        const result = typeof answer === "function" ? answer(message) : answer;
        if (result === undefined) { return; }
        setTimeout(() => {
          chrome.runtime.lastError = result && result.lastError ? { message: result.lastError } : null;
          callback(result && result.lastError ? undefined : result);
          chrome.runtime.lastError = null;
        }, 0);
      },
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
            if (key in store) { out[key] = store[key]; }
          });
          return out;
        },
        set: async (object) => { Object.assign(store, object); }
      },
      onChanged: { addListener() {} }
    },
    i18n: {
      // "none": a host that knows no messages, so `t` falls through to the key.
      getMessage: () => "",
      getUILanguage: () => "en"
    },
    tabs: { create() {} }
  };

  const fetchImpl = async (url) => {
    const rel = String(url).replace("chrome-extension://test/", "");
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(path.join(EXT, rel), "utf8")) };
  };

  const sandbox = {
    chrome,
    document,
    window: { addEventListener() {}, removeEventListener() {} },
    fetch: fetchImpl,
    console: { log() {}, warn() {}, error() {}, info() {} },
    URL, URLSearchParams,
    Math, Date, JSON, Promise, Number, String, Array, Object, Set, Map, Error, RegExp, Boolean,
    isNaN, parseInt, parseFloat,
    // The page waits 4s for a worker that never answers. The wait is the
    // behaviour under test, not its duration.
    setTimeout: (fn, ms) => setTimeout(fn, ms >= 1000 ? 5 : ms),
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {}
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  ["browser-shim.js", "i18n.js", "diagnostics.js"].forEach((file) => {
    vm.runInContext(read(file), context, { filename: file });
  });

  return { sandbox, byId, shown: () => [...byId.values()].map(shownText).join("\n") };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

// A healthy snapshot, and the shapes of the three failures the page exists for.
const HEALTHY = {
  ok: true,
  manifestVersion: "0.55",
  manifestName: "FitShield",
  engineLoaded: true,
  blocklistCount: 1400,
  deliveryCount: 300,
  fastFoodCount: 1100,
  dynamicRuleCount: 12,
  dynamicRuleError: null,
  lastDecision: "active — 12 redirect rule(s)",
  lastError: null,
  blockPageUrl: "chrome-extension://test/warning.html"
};

const STATES = [
  { what: "everything is working", response: HEALTHY },
  { what: "the engine did not load", response: { ...HEALTHY, engineLoaded: false, bootError: "Unexpected end of input" } },
  { what: "the rule count could not be read", response: { ...HEALTHY, dynamicRuleCount: null, dynamicRuleError: "quota exceeded" } },
  { what: "the worker answered with a failure", response: { ok: false, error: "storage unavailable" } },
  { what: "the worker reported a browser error", response: { lastError: "Could not establish connection. Receiving end does not exist." } },
  { what: "the worker never answered at all", response: undefined }
];

["en", "none"].forEach((messages) => {
  STATES.forEach(({ what, response }) => {
    test(`(${messages} messages) nothing developer-facing reaches the screen when ${what}`, async () => {
      const page = diagnosticsPage({ messages, answer: response });
      await settle();

      const text = page.shown();

      assert.ok(text.trim().length > 0, "the page rendered nothing at all");
      assertReadable(text.replace(/Details:[\s\S]*/g, ""), `the page with ${what}`);
    });

    test(`(${messages} messages) no raw message key is shown when ${what}`, async () => {
      const page = diagnosticsPage({ messages, answer: response });
      await settle();

      const text = page.shown();
      const leaked = PAIRS.map((pair) => pair.key).filter((key) => text.includes(key));

      assert.deepEqual(leaked, [], `the fallback did not fire; the user reads a key name: ${leaked.join(", ")}`);
    });
  });
});

// ---------------------------------------------------------------------------
// The page answers its own question, in both directions
// ---------------------------------------------------------------------------
//
// "Is FitShield working?" is the only question this page exists to answer, and
// it only ever answered when the answer was NO. A healthy install produced eight
// value rows and a hidden banner, so a reader had to assemble the verdict
// themselves and "no banner" was indistinguishable from "the banner failed to
// render". #banner is the page's role="status", so a screen-reader user heard a
// verdict on every failure path and nothing at all on the healthy one.

test("a healthy install is told, in the same place a broken one is", async () => {
  const page = diagnosticsPage({ answer: HEALTHY });
  await settle();

  const banner = page.byId.get("banner");

  assert.equal(banner.hidden, false, "a healthy install gets silence where a broken one gets a verdict");
  assert.match(banner.className, /\bgood\b/, "the success state must not be styled as an error");
  assert.ok(shownText(banner).trim().length > 0, "the banner is visible but says nothing");
});

test("a cold service worker does not read as a broken install", async () => {
  // `blocklistCount` is populated as a side effect of the worker loading its
  // datasets, and an MV3 worker is torn down when idle — so opening this page is
  // often the thing that wakes it, and the row legitimately reads 0 on a healthy
  // install while thousands of redirect rules are live. Observed in Chromium:
  // "Brands loaded: 0" beside "Live redirect rules: 2538". A verdict that
  // depended on that number would flicker with worker lifecycle.
  const page = diagnosticsPage({ answer: { ...HEALTHY, blocklistCount: 0, deliveryCount: 0, fastFoodCount: 0 } });
  await settle();

  const banner = page.byId.get("banner");
  assert.equal(banner.hidden, false, "a cold worker made the page withhold its verdict");
  assert.match(banner.className, /\bgood\b/);
  assert.equal(page.byId.get("v-brands").textContent, "0", "the row still reports what the worker actually said");
});

test("the healthy verdict does not claim protection the user may have paused", async () => {
  // Zero live redirect rules is the CORRECT state with blocking switched off or
  // outside a schedule window. The banner may say the extension is running; it
  // may not say the user is currently being protected.
  const page = diagnosticsPage({
    answer: { ...HEALTHY, dynamicRuleCount: 0, lastDecision: "paused — blocking is off" }
  });
  await settle();

  const banner = page.byId.get("banner");
  assert.equal(banner.hidden, false, "switching blocking off is not a fault and must not silence the verdict");

  const text = shownText(banner);
  assert.doesNotMatch(text, /\bprotected\b|\bblocking (?:is )?(?:active|on)\b/i,
    `the verdict overclaims with blocking paused: "${text}"`);
  assert.equal(page.byId.get("v-rules").textContent, "0", "the row still reports the real rule count");
});

// Every state where something is genuinely wrong must NOT be told "all good".
// Silence is allowed there (the failure banners and the per-row markers already
// speak); a false all-clear never is.
[
  ["the engine did not load", { ...HEALTHY, engineLoaded: false, bootError: "Unexpected end of input" }],
  ["the rule count could not be read", { ...HEALTHY, dynamicRuleCount: null, dynamicRuleError: "quota exceeded" }],
  ["the worker recorded an error", { ...HEALTHY, lastError: { message: "rule update rejected" } }]
].forEach(([what, response]) => {
  test(`the page never says all-clear when ${what}`, async () => {
    const page = diagnosticsPage({ answer: response });
    await settle();

    const banner = page.byId.get("banner");
    assert.ok(
      banner.hidden || !/\bgood\b/.test(banner.className),
      `a success banner was shown while ${what}`
    );
  });
});

test("the banner names what is wrong and what the customer can do about it", async () => {
  const page = diagnosticsPage({ answer: undefined });
  await settle();

  const banner = page.byId.get("banner");

  assert.equal(banner.hidden, false, "the failure banner has to be visible");
  assert.match(shownText(banner), /not responding/i, "it must say what is wrong");
  assert.match(
    shownText(banner),
    /turn FitShield off and back on|restart your browser/i,
    "and offer something a store customer can actually do"
  );
  assert.equal(page.byId.get("v-sw").textContent, "Not responding");
});

test("the block page row is a link a person can read, not a filename", async () => {
  const page = diagnosticsPage({ answer: HEALTHY });
  await settle();

  const link = page.byId.get("v-blockurl").children[0];

  assert.ok(link, "the block page row built no link");
  assert.equal(link.tagName, "A");
  assert.equal(link.href, HEALTHY.blockPageUrl, "the address is still the real one");
  assertReadable(link.textContent, "the block page link text");
  assert.match(link.textContent, /block page/i);
});

test("our own timeout adds no untranslated line under the banner", async () => {
  const page = diagnosticsPage({ answer: undefined });
  await settle();

  const banner = page.byId.get("banner");

  // The browser reported nothing here — the deadline was ours. An English
  // "timed out" underneath a translated banner would be the only untranslated
  // line on the page, so there is no Details block at all.
  assert.doesNotMatch(shownText(banner), /Details:/, "nothing was reported, so there is nothing to quote");
  assert.doesNotMatch(shownText(banner), /timed out/i);
});

test("what the browser DID report is still quoted, so it can be pasted into a support message", async () => {
  const reported = "Could not establish connection. Receiving end does not exist.";
  const page = diagnosticsPage({ answer: { lastError: reported } });
  await settle();

  assert.match(shownText(page.byId.get("banner")), new RegExp(reported.replace(/[.]/g, "\\.")));
});

test("the banner is visible before it is written, so a screen reader announces it", async () => {
  const page = diagnosticsPage({ answer: undefined });
  await settle();

  const writes = page.byId.get("banner").writes;
  const firstText = writes.findIndex((entry) => entry.what === "text" && entry.value.length > 0);
  const shownAt = writes.findIndex((entry) => entry.what === "hidden" && entry.value === false);

  assert.ok(firstText !== -1, "the banner was never written");
  assert.ok(shownAt !== -1, "the banner was never shown");
  assert.ok(
    shownAt < firstText,
    "a live region mutated while hidden is announced inconsistently: unhide it, then write it"
  );
});

test("the domain check reports in the user's language, whichever answer comes back", async () => {
  const cases = [
    { test: { input: "doordash.com", host: "doordash.com", blocked: true }, expect: /would be interrupted/i },
    { test: { input: "example.com", host: "example.com", blocked: false }, expect: /would open normally/i },
    { test: { input: "??", error: "engine not loaded" }, expect: /could not check/i }
  ];

  for (const entry of cases) {
    const page = diagnosticsPage({
      answer: (message) => (message.domain ? { ...HEALTHY, test: entry.test } : HEALTHY)
    });
    await settle();

    page.byId.get("domain").value = entry.test.input;
    await page.sandbox.testDomain();

    const result = page.byId.get("test-result").textContent;

    assert.match(result, entry.expect);
    assertReadable(result, "the domain check result");
  }
});
