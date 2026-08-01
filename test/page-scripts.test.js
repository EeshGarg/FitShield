"use strict";
/**
 * Every packaged page script must LOAD.
 *
 * `node --check` only parses; it cannot see that a declaration was deleted while
 * its usages remained, or that a page references a global no script defines.
 * These tests evaluate each page's real script chain, in the real order the HTML
 * lists it, against a stub DOM — so a ReferenceError at load surfaces here rather
 * than as a blank popup.
 *
 * This exists because a consolidation pass removed two constants from popup.js
 * and settings.js while leaving six usages behind. Syntax was valid; the pages
 * would have thrown on open.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const build = require("../build.js");

function srcPath(rel) {
  if (rel === "blocklist.js") {
    return path.join(EXT, "blocklist.js");
  }
  const candidates = [path.join(EXT, rel), path.join(ROOT, "data", rel), path.join(ROOT, rel)];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

// A DOM stub broad enough for module-level code: element lookups, listeners,
// classList, style, and the handful of window APIs the pages touch on load.
function makeElement(tag) {
  const element = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    hidden: false,
    disabled: false,
    checked: false,
    value: "",
    textContent: "",
    innerHTML: "",
    files: [],
    addEventListener() {},
    removeEventListener() {},
    appendChild(node) { element.children.push(node); return node; },
    append() {},
    replaceChildren() { element.children = []; },
    insertBefore(node) { element.children.push(node); return node; },
    remove() {},
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return name in element.attributes ? element.attributes[name] : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    click() {},
    reset() {},
    get firstChild() { return element.children[0] || null; },
    get childElementCount() { return element.children.length; }
  };
  return element;
}

function makeSandbox(page) {
  const document = {
    documentElement: makeElement("html"),
    body: makeElement("body"),
    head: makeElement("head"),
    currentScript: null,
    hidden: false,
    readyState: "complete",
    getElementById: () => makeElement("div"),
    querySelector: () => makeElement("div"),
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    createDocumentFragment: () => makeElement("fragment"),
    addEventListener() {},
    removeEventListener() {}
  };

  const storage = {};
  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.55", name: "FitShield" }),
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener() {} },
      lastError: null
    },
    storage: {
      local: {
        get: async () => ({ ...storage }),
        set: async (obj) => Object.assign(storage, obj),
        remove: async () => {},
        clear: async () => {}
      },
      onChanged: { addListener() {} }
    },
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    tabs: { create() {}, query: async () => [], onRemoved: { addListener() {} } }
  };

  const win = {
    location: { search: "", href: "", hash: "", reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} }),
    history: { back() {}, length: 1 },
    open() {},
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" })
  };

  const sandbox = {
    chrome,
    document,
    window: win,
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: async (url) => {
      const rel = String(url).replace("chrome-extension://test/", "");
      const file = srcPath(rel);
      return {
        ok: fs.existsSync(file),
        status: fs.existsSync(file) ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, "utf8"))
      };
    },
    navigator: { language: "en-US", clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
    Blob: class {},
    Math,
    Date,
    JSON,
    Promise,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Intl,
    Error,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    matchMedia: win.matchMedia,
    location: win.location,
    getComputedStyle: win.getComputedStyle,
    page
  };

  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

// The <script src> chain of a packaged page, in document order.
function scriptChain(page) {
  const html = fs.readFileSync(path.join(EXT, page), "utf8");
  return [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
}

const PAGES = build.FILES.map(([, dest]) => String(dest)).filter((dest) => dest.endsWith(".html"));

test("every packaged page declares a script chain", () => {
  assert.ok(PAGES.length >= 5, `expected the full set of pages, got ${PAGES.length}`);

  PAGES.forEach((page) => {
    assert.ok(scriptChain(page).length > 0, `${page} loads no scripts`);
  });
});

PAGES.forEach((page) => {
  test(`${page}: its whole script chain evaluates without a ReferenceError`, () => {
    const sandbox = makeSandbox(page);
    const context = vm.createContext(sandbox);

    scriptChain(page).forEach((script) => {
      const file = srcPath(script);
      assert.ok(fs.existsSync(file), `${page} references ${script}, which is not in the source tree`);

      // ambient.js is decorative and paints on a timer; it is loaded like the
      // rest, and any load-time error in it would still fail here.
      assert.doesNotThrow(
        () => vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: script }),
        `${page}: ${script} threw while loading`
      );
    });
  });
});

// Strip comments and string/template literals so identifier scanning does not
// trip over prose, CSS tokens, or locale keys that happen to be upper-case.
function stripLiterals(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');
}

test("no page script uses a SHARED constant that no script in its chain declares", () => {
  // The regression this exists for: a consolidation deleted two top-level
  // constants from popup.js and settings.js but left six usages behind. Syntax
  // was valid and the pages still LOADED, because the usages were inside
  // functions that only run on interaction — so only a static cross-file check
  // catches it.
  const HOST = new Set([
    "URL", "URLSearchParams", "JSON", "Math", "Date", "Promise", "Number", "String",
    "Array", "Object", "Set", "Map", "Intl", "Error", "RegExp", "Blob", "NaN",
    "Infinity", "MSG", "SVG", "UTF"
  ]);

  PAGES.forEach((page) => {
    const chain = scriptChain(page);
    const declared = new Set();
    const problems = [];

    chain.forEach((script) => {
      const source = stripLiterals(fs.readFileSync(srcPath(script), "utf8"));

      // Anything this file declares at any depth is visible to itself.
      const own = new Set();
      for (const match of source.matchAll(/(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})\b/g)) {
        own.add(match[1]);
      }
      for (const match of source.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*:/g)) {
        own.add(match[1]); // object keys, e.g. in a lookup table
      }

      // A bare identifier only — `core.ALL_DAYS` is a property access, not a
      // reference to a shared constant, so the preceding character must not be a
      // dot (or part of a longer identifier).
      for (const match of source.matchAll(/(^|[^.\w$])([A-Z][A-Z0-9_]{2,})\b/g)) {
        const name = match[2];
        if (HOST.has(name) || own.has(name) || declared.has(name)) {
          continue;
        }
        problems.push(`${script}: ${name}`);
      }

      // Visible to LATER scripts: top-level declarations, plus the
      // `global.NAME = …` export the shared modules use from inside an IIFE
      // (languages.js, i18n.js, backup.js, fitshield-core.js).
      for (const match of source.matchAll(/^(?:const|let|var|function)\s+([A-Z][A-Z0-9_]{2,})\b/gm)) {
        declared.add(match[1]);
      }
      for (const match of source.matchAll(/(?:global|globalThis|self|window)\.([A-Z][A-Z0-9_]{2,})\s*=/g)) {
        declared.add(match[1]);
      }
    });

    assert.deepEqual(
      [...new Set(problems)],
      [],
      `${page}: uses constants nothing in its script chain declares:\n  ${[...new Set(problems)].join("\n  ")}`
    );
  });
});

test("no page script reads a global that nothing in its chain defines", () => {
  // Catches the specific regression: a shared constant deleted from one file
  // while its usages stay behind. Each page is evaluated, then the globals its
  // scripts actually reference are checked against what the chain defined.
  const KNOWN_HOST_GLOBALS = new Set([
    "chrome", "document", "window", "console", "fetch", "navigator", "location",
    "self", "globalThis", "URL", "URLSearchParams", "Blob", "Math", "Date", "JSON",
    "Promise", "Number", "String", "Array", "Object", "Set", "Map", "Intl", "Error",
    "RegExp", "isNaN", "parseInt", "parseFloat", "setTimeout", "clearTimeout",
    "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
    "matchMedia", "getComputedStyle", "page"
  ]);

  PAGES.forEach((page) => {
    const sandbox = makeSandbox(page);
    const context = vm.createContext(sandbox);
    const chain = scriptChain(page);

    chain.forEach((script) => {
      vm.runInContext(fs.readFileSync(srcPath(script), "utf8"), context, { filename: script });
    });

    // Every SCREAMING_CASE identifier the chain reads must now exist.
    const referenced = new Set();
    chain.forEach((script) => {
      const source = fs.readFileSync(srcPath(script), "utf8");
      for (const match of source.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
        referenced.add(match[1]);
      }
    });

    const missing = [...referenced].filter((name) => {
      if (KNOWN_HOST_GLOBALS.has(name)) return false;

      // Only TOP-LEVEL declarations (column 0) are shared between the scripts of
      // a page. A declaration inside an IIFE is module-scoped on purpose.
      const declaredAtTopLevel = chain.some((script) =>
        new RegExp(`^(?:const|let|var)\\s+${name}\\s*=`, "m").test(fs.readFileSync(srcPath(script), "utf8"))
      );

      if (!declaredAtTopLevel) {
        return false;
      }

      // A top-level `const`/`let` lives in the context's lexical scope and never
      // becomes a property of the global object, so `name in sandbox` would be
      // wrong. Resolving the identifier is the only accurate check.
      try {
        vm.runInContext(name, context, { filename: "reference-check" });
        return false;
      } catch (error) {
        return error instanceof ReferenceError;
      }
    });

    assert.deepEqual(missing, [], `${page}: declared-then-missing globals: ${missing.join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// Static fallbacks: what the user sees if the scripts never run
// ---------------------------------------------------------------------------

// The block page is a declarativeNetRequest redirect target, so it is the one
// surface a user cannot avoid — and the one where a script failure strands them
// on a page with no visible way out. Every control it ships must carry its own
// label in the markup, so the page is still operable (and still readable) when
// warning.js has not run: a blocked user staring at an unlabelled button has no
// way to tell it is the way forward.
test("every block-page control is labelled in the markup, not only by script", () => {
  const html = fs.readFileSync(srcPath("warning.html"), "utf8");
  const unlabelled = [];

  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const [, attrs, inner] = match;
    const id = (/id="([^"]+)"/.exec(attrs) || [])[1] || "(no id)";
    const text = inner.replace(/<[^>]*>/g, "").trim();
    const labelled = /aria-label=|data-i18n-aria-label=/.test(attrs);

    if (!text && !labelled) {
      unlabelled.push(id);
    }
  }

  assert.deepEqual(unlabelled, [], `block-page buttons with no static label: ${unlabelled.join(", ")}`);
});

// A static fallback that disagrees with what the script writes is worse than
// none: the page would flash the wrong state. The markup must therefore quote
// the SAME message the script uses for the state the page opens in (locked).
test("the block page's static fallbacks quote the same strings the script sets", () => {
  const html = fs.readFileSync(srcPath("warning.html"), "utf8");
  const en = JSON.parse(fs.readFileSync(srcPath("_locales/en/messages.json"), "utf8"));

  [
    ["continue", "warningLockedButton"],
    ["hint", "warningLockedHint"]
  ].forEach(([id, key]) => {
    const element = new RegExp(`<[^>]*id="${id}"[^>]*>([^<]*)<`).exec(html);
    assert.ok(element, `#${id} not found in warning.html`);
    assert.ok(en[key], `${key} missing from the English catalog`);
    assert.equal(
      element[1].trim(),
      en[key].message,
      `#${id}'s static text must match ${key}, or the page flashes the wrong state`
    );
  });
});

// ARCHITECTURE.md states the rule that keeps the load-order bug from recurring:
// on every page, fitshield-core.js is listed before anything that uses
// FitShieldCore. The chain-evaluation tests above catch a missing global; this
// catches the narrower, quieter case where the tag order is wrong but the page
// still happens to evaluate — the shape the backup.js bug actually had.
test("every page loads fitshield-core.js before any script that uses it", () => {
  const pages = fs.readdirSync(EXT).filter((file) => file.endsWith(".html"));
  const violations = [];

  pages.forEach((page) => {
    const html = fs.readFileSync(path.join(EXT, page), "utf8");
    const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const coreAt = order.indexOf("fitshield-core.js");

    order.forEach((script, index) => {
      if (script === "fitshield-core.js") return;
      const file = path.join(EXT, script);
      if (!fs.existsSync(file)) return;
      if (!/\bFitShieldCore\b/.test(fs.readFileSync(file, "utf8"))) return;

      if (coreAt === -1) {
        violations.push(`${page}: ${script} uses FitShieldCore but the page never loads it`);
      } else if (index < coreAt) {
        violations.push(`${page}: ${script} is loaded before fitshield-core.js`);
      }
    });
  });

  assert.deepEqual(violations, [], violations.join("\n"));
});
