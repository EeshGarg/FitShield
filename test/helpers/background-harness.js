"use strict";
/**
 * One headless background worker, shared by every suite that needs one.
 *
 * background.js is run inside a vm sandbox with a stubbed `chrome` and `fetch`,
 * so the real pipeline — JSON blocklists -> rule catalog -> declarativeNetRequest
 * rules, plus schedules, passes, and statistics — executes exactly as it does in
 * the browser, against the real engine bundle and the real datasets.
 *
 * This existed as three near-identical copies (blocking, block-page,
 * blocklist-records). They drifted in small ways that mattered — one recorded
 * the rules it was handed, one silently dropped them — which made "the rules are
 * right" mean something different depending on which file you read. One copy
 * also keeps the fault-injection seams below in a single place, so a suite that
 * wants to fail a storage read does not have to fork the whole stub again.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");

// The sandboxed worker asks for PACKAGED (zip-root-relative) paths — e.g.
// "blocklist.js", "blocklists/delivery.json" — exactly as the shipped extension
// does. In the repo those sources live in extension/ and data/; build.js
// flattens them back together and BUNDLES "FS Engine/" into blocklist.js, so
// these suites exercise the exact artifact the extension ships.
let engineBundlePath = null;
function bundledEngine() {
  if (!engineBundlePath) {
    const { bundleEngine } = require("../../build.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-engine-bundle-"));
    engineBundlePath = path.join(dir, "blocklist.js");
    fs.writeFileSync(engineBundlePath, bundleEngine());
  }
  return engineBundlePath;
}

function srcPath(rel) {
  if (rel === "blocklist.js") {
    return bundledEngine();
  }
  const candidates = [
    path.join(ROOT, "extension", rel), // browser source (js/html, _locales, icons)
    path.join(ROOT, "data", rel), // packaged blocklists/ -> repo data/blocklists/
    path.join(ROOT, rel) // packaged data/*, root files (changelog.json)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[2];
}

/**
 * Boot a background worker.
 *
 * @param {object} [initialStore] Seed contents of chrome.storage.local.
 * @param {object} [options]
 * @param {Array}  [options.openTabs] What chrome.tabs.query resolves to.
 * @param {Function} [options.onStorageGet] Called before every storage read with
 *   the requested keys. Throw from it to simulate an unreadable profile.
 * @param {Function} [options.onFetch] Called before every fetch with the packaged
 *   path. Throw to simulate a missing asset; return a string to serve corrupt
 *   bytes in place of the real file.
 */
function loadBackground(initialStore, options) {
  const opts = options || {};
  const store = { ...(initialStore || {}) };
  const listeners = {};
  let fetchCount = 0;
  let openTabs = opts.openTabs || [{ id: 1 }, { id: 2 }];

  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.55", name: "FitShield" }),
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      lastError: null
    },
    storage: {
      // Memory-only, browser-session-scoped storage. The worker keeps the
      // block-page redirect token here, so it must exist for the message
      // boundary to behave as it does in the browser.
      session: {
        _data: {},
        get: async (keys) => {
          const data = chrome.storage.session._data;
          if (keys === null || keys === undefined) return { ...data };
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in data) out[k] = data[k];
          });
          return out;
        },
        set: async (obj) => { Object.assign(chrome.storage.session._data, obj); },
        remove: async (keys) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete chrome.storage.session._data[k]);
        }
      },
      local: {
        get: async (keys) => {
          if (opts.onStorageGet) {
            opts.onStorageGet(keys);
          }
          if (keys === null || keys === undefined) {
            return { ...store };
          }
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in store) out[k] = store[k];
          });
          return out;
        },
        set: async (obj) => {
          Object.assign(store, obj);
        },
        remove: async (keys) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]);
        }
      },
      onChanged: { addListener: () => {} }
    },
    tabs: {
      query: async () => openTabs.slice(),
      create: (info) => { (listeners.created = listeners.created || []).push(info); },
      onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } }
    },
    alarms: {
      _set: {},
      clear: async (name) => { delete chrome.alarms._set[name]; },
      create: async (name, config) => { chrome.alarms._set[name] = config; },
      onAlarm: { addListener: (fn) => { listeners.alarm = fn; } }
    },
    declarativeNetRequest: {
      _rules: [],
      getDynamicRules: (cb) => cb(chrome.declarativeNetRequest._rules),
      updateDynamicRules: (config, cb) => {
        chrome.declarativeNetRequest._rules = config.addRules || [];
        cb();
      }
    }
  };

  const fetchImpl = async (url) => {
    fetchCount += 1;
    const rel = url.replace("chrome-extension://test/", "");
    const override = opts.onFetch ? opts.onFetch(rel) : undefined;
    const text = typeof override === "string" ? override : fs.readFileSync(srcPath(rel), "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };

  const sandbox = {
    chrome,
    console,
    fetch: fetchImpl,
    setTimeout,
    URL,
    URLSearchParams,
    Uint8Array,
    // The worker mints its block-page redirect token with getRandomValues.
    crypto: { getRandomValues: (array) => require("node:crypto").randomFillSync(array) },
    Math,
    Date,
    JSON,
    Promise
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  sandbox.importScripts = (file) =>
    vm.runInContext(fs.readFileSync(srcPath(file), "utf8"), context, { filename: file });

  vm.runInContext(fs.readFileSync(srcPath("background.js"), "utf8"), context, { filename: "background.js" });

  // background.js declares its module state with top-level `let`, which lives in
  // the context's lexical scope and never appears on the sandbox global — so
  // `bg.context.blocklistsLoaded` silently reads undefined. Go through the
  // context to see or set what the worker actually holds.
  const evalIn = (expression) => vm.runInContext(expression, context);

  // The URL the REAL block page runs at. The worker builds its redirect target
  // with a random token and refuses to record for a block page that does not
  // carry the current one, so a harness sender without it is not the block page
  // — it is the forgery the guard exists to stop. Every suite that drives the
  // block page therefore has to ask the worker for the same token the browser
  // would have put in the address bar.
  const blockPageUrl = async (search) =>
    `chrome-extension://test/warning.html?site=x&k=${await evalIn("ensureBlockPageToken()")}${search || ""}`;

  /**
   * Drive a message the way a page does, and resolve with what sendResponse got.
   *
   * @param {object} payload
   * @param {object} [sender] Override the sender entirely — how a suite models a
   *   web page, a framed block page, or a block page with a stale token.
   */
  const message = async (payload, sender) =>
    new Promise((resolve) => {
      const handled = listeners.message(payload, sender, resolve);
      if (!handled) {
        resolve(null);
      }
    });

  const messageFromBlockPage = async (payload) =>
    message(payload, { id: "test", url: await blockPageUrl(), frameId: 0 });

  return {
    context,
    store,
    listeners,
    // The default sender is the genuine, redirected block page: that is where
    // nearly every message in the product comes from.
    message: async (payload, sender) =>
      sender === undefined ? messageFromBlockPage(payload) : message(payload, sender),
    messageFrom: message,
    blockPageUrl,
    evalIn,
    alarms: () => chrome.alarms._set,
    createdTabs: () => listeners.created || [],
    setOpenTabs: (tabs) => { openTabs = tabs; },
    rules: () => chrome.declarativeNetRequest._rules,
    fetchCount: () => fetchCount
  };
}

module.exports = { ROOT, srcPath, bundledEngine, loadBackground };
