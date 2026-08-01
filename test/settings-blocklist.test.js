"use strict";
/**
 * Settings blocklist regression tests — the "my toggles keep resetting to
 * defaults" and "select-all should move the other three" bugs.
 *
 * Renders the REAL settings page (blocklist.js, blocklist-records.js, i18n.js,
 * currency.js, languages.js, backup.js, browser-shim.js, settings.js) against a
 * compact DOM, with the background worker deliberately NOT answering
 * getBlockState, and asserts:
 *
 *   1. Saved values still display — the blocklist toggles + timer reflect
 *      chrome.storage.local instead of snapping back to unchecked defaults
 *      (the local fallback path in loadBlocklist/buildLocalBlockState).
 *   2. The "All Blocklists" master toggle is indeterminate when the three groups
 *      are mixed, and toggling it moves AND persists all three.
 *
 * No jsdom: a compact DOM sufficient for the settings page lives at the bottom.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const build = require("../build.js");

function srcPath(rel) {
  const candidates = [path.join(ROOT, "extension", rel), path.join(ROOT, "data", rel), path.join(ROOT, rel)];
  return candidates.find((c) => fs.existsSync(c)) || candidates[2];
}

// Render settings.html + its scripts against a seeded storage, with a worker
// that returns `workerResponse` for getBlockState (undefined => fallback path).
function renderSettings(store, workerResponse) {
  const doc = buildDocument(srcPath("settings.html"));

  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.54" }),
      sendMessage: async () => workerResponse
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async () => {},
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    i18n: { getMessage: () => "", getUILanguage: () => "en" }
  };
  const fetchImpl = async (url) => ({
    ok: true, status: 200,
    json: async () => JSON.parse(fs.readFileSync(srcPath(url.replace("chrome-extension://test/", "")), "utf8"))
  });
  const raf = () => 0;
  const win = {
    location: { search: "", href: "", reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    setInterval: () => 0, clearInterval() {}, history: { back() {} },
    requestAnimationFrame: raf, addEventListener() {}, removeEventListener() {}
  };
  const sandbox = {
    chrome, document: doc.document, window: win, fetch: fetchImpl, console,
    URL, URLSearchParams, Math, Date, Number, String, Array, Object, JSON, Promise, Intl,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: raf, cancelAnimationFrame: () => {},
    navigator: { language: "en-US" }, location: win.location, matchMedia: win.matchMedia
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  // The engine ships as the generated bundle; load it first (settings.html loads
  // blocklist.js), then the rest of the page scripts in order.
  vm.runInContext(build.bundleEngine(), ctx, { filename: "blocklist.js" });
  // Mirrors the <script> order in settings.html; fitshield-core.js must load
  // before the files that use it.
  for (const f of ["blocklist-records.js", "languages.js", "currency.js", "fitshield-core.js", "backup.js", "browser-shim.js", "i18n.js", "settings.js"]) {
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

test("saved blocklist toggles display when the worker is unavailable (no reset to defaults)", async () => {
  const store = {
    deliverySitesEnabled: false,   // user turned delivery OFF
    fastFoodSitesEnabled: true,
    customSitesEnabled: true,
    timerSeconds: 30,              // user set a 30s timer
    uiLanguage: "en"
  };
  // Worker returns undefined (asleep / not registered) — forces the local rebuild.
  const doc = renderSettings(store, undefined);

  // Wait on a positive render signal (the timer, which differs from the empty
  // default) so we don't read the controls before the async fallback finishes.
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"),
    "the settings page should render the saved timer value from storage");

  assert.equal(doc.getById("deliverySitesEnabled").checked, false,
    "delivery toggle must reflect the SAVED off state, not snap back to the default on");
  assert.equal(doc.getById("fastFoodSitesEnabled").checked, true);
  assert.equal(doc.getById("customSitesEnabled").checked, true);
});

test("the All Blocklists master toggle is indeterminate when the groups are mixed", async () => {
  const store = { deliverySitesEnabled: false, fastFoodSitesEnabled: true, customSitesEnabled: true, uiLanguage: "en" };
  const doc = renderSettings(store, undefined);

  const master = () => doc.getById("allBlocklistsEnabled");
  assert.ok(await waitFor(() => master() && master().indeterminate === true),
    "master toggle must be indeterminate when the three groups are mixed");
  assert.equal(master().checked, false);
});

test("toggling the master All Blocklists switch moves and persists all three groups", async () => {
  const store = { deliverySitesEnabled: false, fastFoodSitesEnabled: false, customSitesEnabled: false, uiLanguage: "en" };
  const doc = renderSettings(store, undefined);

  const master = doc.getById("allBlocklistsEnabled");
  assert.ok(await waitFor(() => master.indeterminate === false && master.checked === false),
    "master starts unchecked when all groups are off");

  // Flip it ON and fire the change handler, as a click would.
  master.checked = true;
  await Promise.all((master._listeners.change || []).map((fn) => fn({})));
  await waitFor(() => store.deliverySitesEnabled === true);

  assert.equal(doc.getById("deliverySitesEnabled").checked, true, "delivery moved on");
  assert.equal(doc.getById("fastFoodSitesEnabled").checked, true, "fast food moved on");
  assert.equal(doc.getById("customSitesEnabled").checked, true, "custom moved on");
  assert.deepEqual(
    [store.deliverySitesEnabled, store.fastFoodSitesEnabled, store.customSitesEnabled],
    [true, true, true],
    "all three group flags were persisted to storage"
  );
  assert.equal(master.indeterminate, false, "master is no longer indeterminate once all are on");
});

// The three simple schedule inputs used to write ONLY the flat scheduleEnabled /
// scheduleStart / scheduleEnd keys. readSettings prefers the structured
// `schedule` object whenever it exists — and after the v1 -> v2 migration it
// always exists — so the flat keys were read by nobody and all three controls
// were visible and inert. Assert the effect, not the key: what matters is that
// setting a window actually stops blocking outside it.
test("the simple schedule controls actually change when blocking is active", async () => {
  const core = require("../extension/fitshield-core.js");

  // A migrated profile: `schedule` is present, so the flat keys alone are dead.
  const store = { ...core.migrateState({ timerSeconds: 30 }).state, uiLanguage: "en" };
  assert.equal(store.schedule.mode, "always", "precondition: a migrated profile blocks around the clock");

  const doc = renderSettings(store, undefined);
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"), "settings rendered");

  const enabled = doc.getById("scheduleEnabled");
  const start = doc.getById("scheduleStart");
  const end = doc.getById("scheduleEnd");

  start.value = "18:00";
  end.value = "23:00";
  enabled.checked = true;
  await Promise.all((enabled._listeners.change || []).map((fn) => fn({})));
  await waitFor(() => store.scheduleEnabled === true);

  assert.equal(store.scheduleEnabled, true, "the flat mirror is still written, for Android and older builds");
  assert.equal(store.schedule.mode, "windows", "the structured schedule — the one that decides — was updated");

  // 09:00 Wednesday is outside 18:00-23:00: blocking must now be off.
  const settings = core.readSettings(store);
  const nineAm = new Date(2026, 2, 4, 9, 0, 0);
  const eightPm = new Date(2026, 2, 4, 20, 0, 0);

  assert.equal(core.evaluateSchedule(settings.schedule, nineAm).active, false,
    "outside the chosen window blocking must be off — otherwise the control did nothing");
  assert.equal(core.evaluateSchedule(settings.schedule, eightPm).active, true,
    "inside the chosen window blocking must be on");
});

// ===========================================================================
// Compact DOM + HTML parser — enough for the settings page scripts. Superset of
// the block-page test's DOM (adds querySelector, input .value, and document
// fragments, which settings.js uses).
// ===========================================================================
const VOID_TAGS = new Set(["meta", "link", "img", "br", "hr", "input"]);

function buildDocument(htmlPath) {
  const parsed = parseHTML(fs.readFileSync(htmlPath, "utf8"));
  const documentElement = new El("html");
  const body = parsed.query("body")[0] || new El("body");
  documentElement.appendChild(body);

  const findById = (id) => {
    let hit = null;
    const walk = (n) => { for (const c of n.children) { if (c instanceof El) { if (!hit && c.attributes.id === id) hit = c; walk(c); } } };
    walk(documentElement);
    return hit;
  };

  const document = {
    documentElement,
    body,
    head: new El("head"),
    currentScript: null,
    addEventListener() {},
    removeEventListener() {},
    getElementById: findById,
    createElement: (t) => new El(t),
    createTextNode: (t) => new TextNode(t),
    createDocumentFragment: () => { const f = new El("#fragment"); f._isFragment = true; return f; },
    querySelector: (sel) => documentElement.query(sel)[0] || null,
    querySelectorAll: (sel) => documentElement.query(sel)
  };
  return { document, getById: findById };
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
    this._value = undefined;
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.indeterminate = false;
    this._listeners = {};
    const self = this;
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.classList = {
      _get: () => (self.attributes.class || "").split(/\s+/).filter(Boolean),
      add(c) { const s = new Set(this._get()); s.add(c); self.attributes.class = [...s].join(" "); },
      remove(c) { const s = new Set(this._get()); s.delete(c); self.attributes.class = [...s].join(" "); },
      toggle(c, force) { const s = new Set(this._get()); const on = force === undefined ? !s.has(c) : force; if (on) s.add(c); else s.delete(c); self.attributes.class = [...s].join(" "); return on; },
      contains(c) { return this._get().includes(c); }
    };
  }
  get id() { return this.attributes.id || ""; }
  set id(v) { this.attributes.id = v; }
  get className() { return this.attributes.class || ""; }
  set className(v) { this.attributes.class = v; }
  get value() { return this._value !== undefined ? this._value : ""; }
  set value(v) { this._value = String(v); }
  setAttribute(n, v) {
    this.attributes[n] = String(v);
    if (n === "hidden") this.hidden = true;
    if (n.startsWith("data-")) this.dataset[n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
  appendChild(node) {
    if (node && node._isFragment) { [...node.children].forEach((c) => this.appendChild(c)); node.children = []; return node; }
    node.parentNode = this; this.children.push(node); return node;
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(typeof n === "string" ? new TextNode(n) : n)); }
  replaceChildren(...nodes) { this.children = []; this._text = ""; this.append(...nodes); }
  insertBefore(node, ref) { node.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(node); else this.children.splice(i, 0, node); return node; }
  removeAttribute(n) { delete this.attributes[n]; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  get firstChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.filter((c) => c instanceof El).length; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_v) { this.children = []; this._text = ""; }
  get innerHTML() { return ""; }
  querySelector(sel) { return this.query(sel)[0] || null; }
  querySelectorAll(sel) { return this.query(sel); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  query(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    const match = (el, p) => {
      const scoped = p.replace(/^:scope\s*>?\s*/, "");
      const attr = /^\[([a-zA-Z0-9-]+)\]$/.exec(scoped);
      if (attr) return attr[1] in el.attributes;
      const cls = /^\.([a-zA-Z0-9_-]+)$/.exec(scoped);
      if (cls) return el.classList.contains(cls[1]);
      return el.tagName === scoped.toUpperCase();
    };
    const out = [];
    const walk = (node) => { for (const c of node.children) { if (c instanceof El) { if (parts.some((p) => match(c, p))) out.push(c); walk(c); } } };
    walk(this);
    return out;
  }
}

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
      if (tag === "style" || tag === "script") { const end = html.indexOf(`</${tag}`, i); if (end !== -1) i = html.indexOf(">", end) + 1; continue; }
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
