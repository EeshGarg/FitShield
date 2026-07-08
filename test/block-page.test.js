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
let engineBundlePath = null;
function bundledEnginePath() {
  if (!engineBundlePath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-engine-bundle-"));
    engineBundlePath = path.join(dir, "blocklist.js");
    fs.writeFileSync(engineBundlePath, build.bundleEngine());
  }
  return engineBundlePath;
}

function srcPath(rel) {
  if (rel === "blocklist.js") {
    return bundledEnginePath();
  }
  const candidates = [
    path.join(ROOT, "extension", rel),
    path.join(ROOT, "data", rel),
    path.join(ROOT, rel)
  ];
  return candidates.find((c) => fs.existsSync(c)) || candidates[2];
}

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

  // Firefox: the engine bundle must load BEFORE background.js (which references
  // the FitShieldBlocklist global) — the exact ordering the split depends on.
  assert.deepEqual(firefox.background.scripts, ["blocklist.js", "background.js"]);
  for (const script of firefox.background.scripts) {
    assert.ok(staged(script), `firefox background script "${script}" must be packaged`);
  }
});

// ===========================================================================
// Part B — render smoke test (engine -> background -> block page)
// ===========================================================================

// Load the REAL background.js in an isolated sandbox with a stubbed chrome +
// fetch, backed by the real engine bundle and the real JSON datasets.
function loadBackground() {
  const store = {};
  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      getManifest: () => ({ version: "0.54" }),
      lastError: null
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); }
      },
      onChanged: { addListener: () => {} }
    },
    alarms: { clear: async () => {}, create: async () => {}, onAlarm: { addListener: () => {} } },
    tabs: { create: () => {} },
    declarativeNetRequest: {
      _rules: [],
      getDynamicRules: (cb) => cb(chrome.declarativeNetRequest._rules),
      updateDynamicRules: (opts, cb) => { chrome.declarativeNetRequest._rules = opts.addRules || []; cb(); }
    }
  };
  const fetchImpl = async (url) => {
    const rel = url.replace("chrome-extension://test/", "");
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(srcPath(rel), "utf8")) };
  };
  const sandbox = { chrome, console, fetch: fetchImpl, setTimeout, URL, Math, Date };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (f) => vm.runInContext(fs.readFileSync(srcPath(f), "utf8"), context, { filename: f });
  vm.runInContext(fs.readFileSync(srcPath("background.js"), "utf8"), context, { filename: "background.js" });
  return { context, store };
}

// The message contract the block page speaks to the worker (mirrors the real
// chrome.runtime.onMessage dispatch in background.js).
function dispatchToBackground(bg, msg) {
  switch (msg.type) {
    case "getBlockedSiteInfo": return bg.context.getBlockedSiteInfo(msg.site);
    case "getBlockState": return bg.context.getBlockState();
    case "recordBlockedVisit": return bg.context.recordBlockedVisit().then((v) => ({ ok: true, blockedVisits: v }));
    case "recordBlockedBrand": return bg.context.recordBlockedBrand(msg.meta);
    case "recordRecipeChoice": return bg.context.recordRecipeChoice(msg.recipeCalories).then((r) => ({ ok: true, ...r }));
    case "startTemporaryBypass": return bg.context.startTemporaryBypass(msg.site).then((r) => ({ ok: true, ...r }));
    default: return Promise.resolve({ ok: false });
  }
}

// Render the block page (browser-shim.js, i18n.js, recipes.js, warning.js) for
// `siteKey` against a compact DOM, routing runtime.sendMessage to `bg`. ambient.js
// is intentionally excluded — it is purely decorative, self-guards on the DOM,
// and Part A already proves it ships. Returns { getById, messages }.
function renderBlockPage(bg, siteKey) {
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
  const win = {
    location: { search: `?site=${siteKey}`, href: "" },
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0, clearInterval: () => {},
    history: { back: () => {} }
  };
  const sandbox = {
    chrome, document: doc.document, window: win, fetch: fetchImpl, console,
    URL, URLSearchParams, Math, Date, Number, String, Array, Object, JSON, Promise,
    setInterval: () => 0, clearInterval: () => {}, setTimeout,
    location: win.location, matchMedia: win.matchMedia
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ["browser-shim.js", "i18n.js", "recipes.js", "warning.js"]) {
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

test("render smoke: the block page renders the trigger brand and block reason", async () => {
  const bg = loadBackground();
  bg.store.uiLanguage = "en";                      // force the _locales override path
  bg.store.theme = { accent: "#7ef0a8" };          // the block page reads `theme`
  await bg.context.queueRefreshBlockingState();

  const doc = renderBlockPage(bg, "delivery-doordash-com");
  const brand = () => doc.getById("brand");
  assert.ok(await waitFor(() => brand() && brand().hidden === false && brand().textContent.length > 0),
    "the brand line should resolve and become visible");

  assert.match(brand().textContent, /DoorDash/, "brand line names the interrupted site");

  const reason = doc.getById("blockReason");
  assert.equal(reason.hidden, false, "the block reason panel should be shown");
  assert.match(reason.textContent, /doordash\.com/, "block reason includes the domain");
  assert.ok(reason.textContent.length > "doordash.com".length, "block reason has more than just the domain");

  // Timer + continue button are present and locked at first paint.
  assert.equal(doc.getById("timer").textContent, "60");
  assert.ok(doc.getById("continue"), "continue button exists");
});

test("render smoke: recipe alternatives load (one vegetarian, one meat)", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  const veg = () => doc.getById("recipeVeg");
  const meat = () => doc.getById("recipeMeat");
  assert.ok(await waitFor(() => veg() && veg().hidden === false && meat() && meat().hidden === false),
    "both recipe columns should populate");
  assert.ok(veg().textContent.length > 0 && meat().textContent.length > 0, "recipe cards have content");
});

test("render smoke: stats update through the worker without throwing", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "delivery-doordash-com");

  // recordBlockedVisit + recordBlockedBrand fire from initializeTimer.
  assert.ok(await waitFor(() => bg.store.blockedVisits === 1), "a single blocked visit is counted");
  assert.ok(await waitFor(() => bg.store.blockedByDomain && bg.store.blockedByDomain["doordash.com"] === 1),
    "the trigger brand is aggregated by domain");
  assert.ok(doc.messages.includes("getBlockState"), "the page asked the worker for block state");
  assert.ok(doc.messages.includes("getBlockedSiteInfo"), "the page asked the worker to resolve the brand");
});

test("render smoke: an unresolved site key degrades gracefully (no throw, no brand)", async () => {
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  const doc = renderBlockPage(bg, "does-not-exist");

  // Timer still renders; brand + reason stay hidden; nothing throws.
  assert.ok(await waitFor(() => doc.getById("timer").textContent === "60"));
  assert.equal(doc.getById("brand").hidden, true, "no brand line for an unknown key");
  assert.equal(doc.getById("blockReason").hidden, true, "no block reason for an unknown key");
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
