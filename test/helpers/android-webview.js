"use strict";
/**
 * A small, faithful stand-in for the Android WebView, so the Android UI can be
 * asserted on BEHAVIOUR rather than on the shape of its source text.
 *
 * Why this exists: every previous guard over the Android web assets read the
 * files as strings. A string grep cannot see that a label renders the literal
 * text "statusBlockedVisits" on a phone, because the key is spelled correctly
 * in the markup — it is simply not a key any locale defines, and
 * FitShieldI18n.t() deliberately returns the raw key when it cannot resolve one
 * ("so a gap stays visible rather than rendering blank"). The gap was visible
 * only on a device, where nobody was looking.
 *
 * So this harness runs the REAL files — extension/i18n.js, extension/currency.js
 * and the Android-authored app.js / block.js — inside one vm context over a DOM
 * built from the REAL index.html / block.html, and lets a test read back what
 * the screen would say.
 *
 * Two decisions make it able to fail honestly:
 *
 *   - getElementById returns NULL for an id the shipped markup does not carry.
 *     An auto-vivifying stub would silently absorb a render into a tile that no
 *     longer exists, which is the exact drift this is here to catch.
 *   - the locale messages are fetched off disk from extension/_locales, the same
 *     files tools/build-android.js copies into the APK — so a key that resolves
 *     here resolves on the phone.
 *
 * Zero dependencies: node:vm plus a DOM small enough to read in one sitting.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const WEB_DIR = path.join(ROOT, "android", "app", "src", "main", "assets", "web");
const LOCALES_DIR = path.join(ROOT, "extension", "_locales");

const readWeb = (name) => fs.readFileSync(path.join(WEB_DIR, name), "utf8");

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.dataset = {};
    this.attributes = {};

    // Enough CSSStyleDeclaration for theme.js, which writes custom properties.
    const properties = new Map();
    this.style = {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
      getPropertyValue: (name) => properties.get(name) || "",
      properties
    };

    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.className = "";
    this.listeners = new Map();
    this.ownText = "";

    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !classes.has(n) : !!force;
        if (on) classes.add(n);
        else classes.delete(n);
        return on;
      }
    };
  }

  /** Own text plus every descendant's, which is what a reader actually sees. */
  get textContent() {
    return this.ownText + this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(value) {
    this.ownText = value == null ? "" : String(value);
    this.childNodes.forEach((c) => {
      c.parentNode = null;
    });
    this.childNodes = [];
  }

  set innerHTML(value) {
    // Only ever used for a small status line; the tags are irrelevant to what
    // the tests read, the text between them is not.
    this.textContent = String(value == null ? "" : value).replace(/<[^>]*>/g, "");
  }

  get innerHTML() {
    return this.textContent;
  }

  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n));
  }

  replaceChildren(...nodes) {
    this.childNodes.forEach((c) => {
      c.parentNode = null;
    });
    this.childNodes = [];
    this.ownText = "";
    nodes.forEach((n) => this.appendChild(n));
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    if (child) child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((h) => h !== handler));
  }

  /** Fire every handler registered for `type`, awaiting async ones. */
  async dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      await handler(event);
    }
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, width: 100, height: 100 };
  }

  querySelectorAll() {
    return [];
  }

  querySelector() {
    return null;
  }
}

class TextNode {
  constructor(text) {
    this.ownText = String(text == null ? "" : text);
    this.childNodes = [];
    this.parentNode = null;
  }

  get textContent() {
    return this.ownText;
  }
}

/**
 * Every element the shipped markup declares, flattened.
 *
 * Nesting is not modelled: nothing in the Android UI walks upward or sideways
 * through the tree, and a flat table is enough to answer the two questions the
 * code and the tests actually ask — "is there an element with this id" and
 * "which elements carry a data-i18n attribute".
 */
function parseMarkup(html) {
  const elements = [];
  const byId = new Map();
  const tagPattern = /<([a-z][\w-]*)\b([^>]*?)(\/?)>([^<]*)/gi;
  let match;

  while ((match = tagPattern.exec(html)) !== null) {
    const [, tag, rawAttributes, , trailingText] = match;

    if (/^(script|style|meta|link|br|hr|img|input|!)/i.test(tag) && !/\bid=/.test(rawAttributes)) {
      // Still parsed below when it carries an id or a data-i18n; otherwise skip.
      if (!/data-i18n/.test(rawAttributes)) continue;
    }

    const element = new El(tag);
    const attributePattern = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g;
    let attribute;

    while ((attribute = attributePattern.exec(rawAttributes)) !== null) {
      const [, name, value] = attribute;
      element.attributes[name] = value;

      if (name === "id") {
        element.id = value;
      } else if (name === "class") {
        element.className = value;
      } else if (name.startsWith("data-")) {
        // "data-i18n-aria-label" -> dataset.i18nAriaLabel, matching the DOM.
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        element.dataset[key] = value;
      }
    }

    // The inline copy between the tags is the English fallback the page ships.
    element.ownText = trailingText.trim();
    elements.push(element);

    if (element.id && !byId.has(element.id)) {
      byId.set(element.id, element);
    }
  }

  return { elements, byId };
}

function makeDocument(html) {
  const { elements, byId } = parseMarkup(html);
  const documentElement = new El("html");

  const matchesSelector = (element, selector) =>
    selector
      .split(",")
      .map((part) => part.trim())
      .some((part) => {
        const attribute = /^\[([^\]=]+)\]$/.exec(part);
        if (attribute) return Object.prototype.hasOwnProperty.call(element.attributes, attribute[1]);
        if (part.startsWith(".")) return element.className.split(/\s+/).includes(part.slice(1));
        if (part.startsWith("#")) return element.id === part.slice(1);
        return element.tagName === part.toUpperCase();
      });

  return {
    documentElement,
    // NULL for an id the markup does not declare — see the header note.
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new El(tag),
    createTextNode: (text) => new TextNode(text),
    querySelectorAll: (selector) => elements.filter((el) => matchesSelector(el, selector)),
    querySelector: (selector) => elements.find((el) => matchesSelector(el, selector)) || null,
    addEventListener: () => {},
    removeEventListener: () => {},
    get activeElement() {
      return null;
    },
    readyState: "complete",
    elements,
    byId
  };
}

// ---------------------------------------------------------------------------
// Host platform (what android-shim.js provides on a device)
// ---------------------------------------------------------------------------

let recipeDocumentCache = null;

/** The canonical catalog the APK bundles, parsed once. */
function recipeDocument() {
  if (!recipeDocumentCache) {
    recipeDocumentCache = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "recipes.json"), "utf8"));
  }
  return recipeDocumentCache;
}

function makeShim(store) {
  const pick = (keys) => {
    const out = {};
    keys.forEach((key) => {
      if (store[key] !== undefined) out[key] = store[key];
    });
    return out;
  };

  return {
    runtime: { getURL: (p) => p },
    storage: {
      get: (keys) => Promise.resolve(pick(Array.isArray(keys) ? keys : [keys])),
      set: (patch) => {
        Object.assign(store, patch);
        return Promise.resolve();
      },
      remove: (keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete store[key]);
        return Promise.resolve();
      },
      clear: () => {
        Object.keys(store).forEach((key) => delete store[key]);
        return Promise.resolve();
      }
    },
    // No getMessage, exactly like the device: i18n.js then resolves strings from
    // the bundled _locales files. This is the property that makes an unresolved
    // key render as its own name here as well as on a phone.
    i18n: { getUILanguage: () => "en" },
    blocking: {
      isEnabled: () => Promise.resolve(true),
      enable: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      rulesVersion: () => Promise.resolve("0.55"),
      hostCount: () => Promise.resolve(1234),
      privateDnsActive: () => Promise.resolve(false),
      check: () => Promise.resolve({ blocked: false, apex: null })
    },
    stats: {
      get: () =>
        Promise.resolve(
          pick([
            "blockedVisits",
            "blockedByDomain",
            "blockedByCategory",
            "blockedByCountry",
            "blockedByApp",
            "caloriesAvoided",
            "avgMealCost",
            "avgMealCalories",
            "mealStatsCustomized",
            "currency"
          ])
        )
    },
    filters: {
      metadata: () => Promise.resolve({}),
      getSelected: () => Promise.resolve(pick(["enabledCountries", "enabledCategories"])),
      setSelected: () => Promise.resolve()
    },
    appBlocking: { list: () => Promise.resolve([]) },
    // Exactly what android-shim.js resolves: `load` hands back the WHOLE
    // document (the selector needs the taxonomy), `loadEntries` the flat array.
    // Faithfulness matters here — a harness that returned an array from `load`
    // would hide a caller that treats the document as one.
    recipes: {
      load: () => Promise.resolve(recipeDocument()),
      loadEntries: () =>
        Promise.resolve([...(recipeDocument().recipes || []), ...(recipeDocument().quickAlternatives || [])])
    },
    importExport: { export: () => Promise.resolve(), import: () => Promise.resolve({ supported: true }) },
    theme: { getMode: () => Promise.resolve("system"), setMode: () => Promise.resolve() },
    tabs: { create: () => Promise.resolve() },
    version: { name: () => Promise.resolve("0.55") }
  };
}

/** Serve the real locale files the APK bundles. */
function makeFetch() {
  return (url) => {
    const locale = /_locales\/([^/]+)\/messages\.json/.exec(String(url));

    if (!locale) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("no such asset")) });
    }

    const file = path.join(LOCALES_DIR, locale[1], "messages.json");

    if (!fs.existsSync(file)) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("no such locale")) });
    }

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(fs.readFileSync(file, "utf8"))) });
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Let queued promise callbacks run; the pages render across several awaits. */
async function settle(ticks = 60) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Load one Android page the way the WebView does: the shim, then i18n, then
 * currency, then the page script, over the page's own markup.
 *
 * @param {object} options
 *   page     "index.html" or "block.html"
 *   script   the page script to run ("app.js" / "block.js")
 *   store    initial device storage
 *   bridge   optional AndroidBlock stand-in for the pause screen
 * @returns {{ document, store, context, text(id), allText() }}
 */
async function loadPage({ page, script, store = {}, bridge = null, language = "en" }) {
  const document = makeDocument(readWeb(page));
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    setImmediate,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    Promise,
    Intl,
    Date,
    Math,
    JSON,
    URL,
    document,
    navigator: { language },
    location: { reload: () => {}, href: "https://appassets.androidplatform.net/assets/web/" + page },
    performance: { now: () => Date.now() },
    matchMedia: () => ({ matches: true, addEventListener: () => {}, addListener: () => {} }),
    fetch: makeFetch(),
    fitshield: makeShim(store)
  };

  if (bridge) sandbox.AndroidBlock = bridge;

  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);

  const run = (file, source) => {
    vm.runInContext(source, context, { filename: file });
  };

  run("i18n.js", fs.readFileSync(path.join(ROOT, "extension", "i18n.js"), "utf8"));
  run("currency.js", fs.readFileSync(path.join(ROOT, "extension", "currency.js"), "utf8"));
  run("theme.js", readWeb("theme.js"));

  // The pause screen builds its suggestion from the shared selector module.
  if (page === "block.html") {
    run("recipes.js", fs.readFileSync(path.join(ROOT, "extension", "recipes.js"), "utf8"));
  }

  await sandbox.FitShieldI18n.ready;
  run(script, readWeb(script));
  await settle();

  return {
    document,
    store,
    context: sandbox,
    /** What the element with this id says, descendants included. */
    text: (id) => {
      const element = document.getElementById(id);
      return element ? element.textContent : null;
    },
    /** Everything the screen says, as one string. */
    allText: () => document.elements.map((el) => el.textContent).join(" ␟ ")
  };
}

module.exports = { ROOT, WEB_DIR, LOCALES_DIR, readWeb, makeDocument, parseMarkup, loadPage, settle, El };
