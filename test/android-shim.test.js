"use strict";
/**
 * What the Android shim actually asks the native bridge for.
 *
 * `android/web-src/android-shim.js` is the whole of the Android platform layer:
 * every `fitshield.*` call the shared web UI makes turns into some number of
 * synchronous `@JavascriptInterface` crossings here. Two things about that number
 * matter and neither is visible in a source read:
 *
 *   - How MANY. A crossing is not free, and `storageGet` used to cost one per
 *     KEY. `renderAppBlocking` asks for 9 keys and `stats.get()` for 5 — and
 *     `stats.get()` is on the dashboard's 2s status poll, so that alone was 2.5
 *     crossings a second for as long as the app was open. `A.getVersion()` is worse
 *     than a crossing: the native side answers it from
 *     `PackageManager.getPackageInfo`, a binder round-trip to system_server, and
 *     it too was on the poll.
 *   - That collapsing them changed NOTHING ELSE. A batched read that reports a
 *     missing key differently from a per-key read is not an optimisation, it is a
 *     settings bug with a benchmark attached.
 *
 * So these tests run the real shim over a fake `Android` that counts every call,
 * and assert the answers first and the call counts second. The fake is deliberately
 * faithful on the points that bite: it stores raw JSON strings (that is what
 * SharedPreferences holds), returns `null` for a key it does not have, and can be
 * built WITHOUT `storageGetMany` so the fallback path is exercised by the same
 * assertions as the fast path.
 *
 * Runs under `node --test`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Values that cross out of a vm context carry THAT context's Object.prototype, so
// deepStrictEqual rejects them as "same structure, not reference-equal". This
// re-roots them on the host's prototypes. It drops undefined-valued keys, which is
// why every "a missing key is absent" assertion also uses an explicit `in` check
// against the raw answer.
const plain = (value) => JSON.parse(JSON.stringify(value));

const ROOT = path.join(__dirname, "..");
// The AUTHORED source, not the copy bundled into assets/web/ — that one is
// generated from this file and tools/android-audit.js fails on drift between them.
const SHIM = path.join(ROOT, "android", "web-src", "android-shim.js");

/**
 * A stand-in for WebAppBridge.kt that records every crossing.
 *
 * @param store   key -> raw stored string, as SharedPreferences holds it
 * @param options `many: false` omits storageGetMany, i.e. an older APK shell
 */
function makeBridge(store, options = {}) {
  const calls = [];
  const note = (name) => calls.push(name);

  const bridge = {
    calls,
    count: (name) => calls.filter((c) => c === name).length,

    storageGet(key) {
      note("storageGet");
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    storageSet(key, value) {
      note("storageSet");
      store[key] = value;
    },
    storageRemove(key) {
      note("storageRemove");
      delete store[key];
    },
    storageClear() {
      note("storageClear");
      Object.keys(store).forEach((k) => delete store[k]);
    },
    storageKeys() {
      note("storageKeys");
      return JSON.stringify(Object.keys(store));
    },
    getVersion() {
      note("getVersion");
      return "0.57";
    },
    ruleCount() {
      note("ruleCount");
      return 2512;
    },
    getUiLanguage() {
      note("getUiLanguage");
      return "en";
    },
    vpnIsEnabled() {
      note("vpnIsEnabled");
      return true;
    },
    privateDnsActive() {
      note("privateDnsActive");
      return false;
    },
    checkHost(host) {
      note("checkHost");
      return host === "doordash.com" ? "doordash.com" : "";
    }
  };

  if (options.many !== false) {
    bridge.storageGetMany = (keysJson) => {
      note("storageGetMany");
      // The Kotlin implementation, in JS: skip a key the store does not hold, and
      // return the raw string for one it does.
      const out = {};
      JSON.parse(keysJson).forEach((key) => {
        if (!key) return;
        if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
      });
      return JSON.stringify(out);
    };
  }

  return bridge;
}

/** Load the real shim against a fake bridge and hand back `fitshield` + the bridge. */
function loadShim(values = {}, options = {}) {
  const store = {};
  Object.keys(values).forEach((key) => { store[key] = JSON.stringify(values[key]); });
  Object.keys(options.raw || {}).forEach((key) => { store[key] = options.raw[key]; });

  const bridge = makeBridge(store, options);
  const sandbox = { Android: bridge, JSON, Promise, fetch: () => Promise.reject(new Error("no network in a test")) };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SHIM, "utf8"), sandbox, { filename: "android-shim.js" });

  assert.ok(sandbox.fitshield, "the shim did not install a fitshield object");
  return { fs: sandbox.fitshield, bridge, store };
}

// ---------------------------------------------------------------------------
// The contract is unchanged, batched or not
// ---------------------------------------------------------------------------

const SETTINGS = Object.freeze({
  appBlockingEnabled: false,
  appUnlockMinutes: 30,
  appBlockDelivery: true,
  timerSeconds: 120,
  androidAllowlist: ["doordash.com"],
  themeColors: { bg: "#000", radius: 12 }
});

// Every shape chrome.storage.local.get accepts, against both bridges, asserted to
// give the same answer. The defaults-object form is the one worth having: it is how
// a caller says "use this when the key is absent", and a batched read that
// mis-reports absence breaks it silently.
for (const many of [true, false]) {
  const label = many ? "batched" : "per-key (older APK shell)";

  test(`storage.get answers identically — ${label}`, async () => {
    const { fs: shim } = loadShim(SETTINGS, { many });

    assert.deepEqual(plain(await shim.storage.get(["timerSeconds", "appUnlockMinutes"])), { timerSeconds: 120, appUnlockMinutes: 30 });
    assert.deepEqual(plain(await shim.storage.get("themeColors")), { themeColors: { bg: "#000", radius: 12 } });
    assert.deepEqual(plain(await shim.storage.get(["androidAllowlist"])), { androidAllowlist: ["doordash.com"] });

    // `false` has to survive. It is the whole state of a switch, and a batched read
    // that treated a falsy value as absent would turn every "off" back on.
    assert.deepEqual(plain(await shim.storage.get(["appBlockingEnabled"])), { appBlockingEnabled: false });
  });

  test(`a missing key is absent, not null or undefined — ${label}`, async () => {
    const { fs: shim } = loadShim(SETTINGS, { many });

    const answer = await shim.storage.get(["timerSeconds", "neverStored"]);
    assert.deepEqual(plain(answer), { timerSeconds: 120 });
    assert.ok(!("neverStored" in answer), "a key with no value must not appear at all — callers test `x === undefined`");

    assert.deepEqual(plain(await shim.storage.get(["neverStored"])), {}, "a request for only missing keys answers {}");
  });

  test(`a defaults object fills in only what is missing — ${label}`, async () => {
    const { fs: shim } = loadShim(SETTINGS, { many });

    assert.deepEqual(
      plain(await shim.storage.get({ timerSeconds: 60, neverStored: "fallback", appBlockingEnabled: true })),
      { timerSeconds: 120, neverStored: "fallback", appBlockingEnabled: false },
      "a stored value must win over its default, including when the stored value is `false`"
    );
  });

  test(`a corrupt stored value reads as absent and costs only itself — ${label}`, async () => {
    const { fs: shim } = loadShim(SETTINGS, { many, raw: { broken: "{not json", empty: "" } });

    const answer = await shim.storage.get(["broken", "empty", "timerSeconds"]);
    assert.deepEqual(
      plain(answer), { timerSeconds: 120 },
      "one unparseable preference must not take the rest of the read down with it"
    );
  });

  test(`storage.get(null) returns the whole store — ${label}`, async () => {
    const { fs: shim } = loadShim(SETTINGS, { many });
    assert.deepEqual(plain(await shim.storage.get(null)), { ...SETTINGS });
  });
}

// ---------------------------------------------------------------------------
// …and it is one crossing, not one per key
// ---------------------------------------------------------------------------

test("a nine-key read costs ONE bridge crossing, not nine", async () => {
  const keys = [
    "appBlockingEnabled", "appUnlockMinutes", "appBlockDelivery", "appBlockFastFood",
    "appBlockRestaurant", "appBlockGrocery", "appBlockCoffee", "appBlockDessert", "appBlockMealKit"
  ];
  const { fs: shim, bridge } = loadShim(SETTINGS);

  await shim.storage.get(keys);

  assert.equal(bridge.count("storageGetMany"), 1);
  assert.equal(
    bridge.count("storageGet"), 0,
    `renderAppBlocking's read still made ${bridge.count("storageGet")} per-key crossings`
  );
});

test("stats.get — which the 2s status poll calls — costs ONE crossing", async () => {
  const { fs: shim, bridge } = loadShim({ blockedVisits: 12, blockedByDomain: { "doordash.com": 3 } });

  const stats = await shim.stats.get();

  assert.deepEqual(plain(stats), { blockedVisits: 12, blockedByDomain: { "doordash.com": 3 } });
  assert.equal(bridge.count("storageGetMany") + bridge.count("storageGet"), 1,
    "stats.get reads five keys; on the poll, each extra crossing is paid twice a second forever");
});

test("the per-key fallback still answers when the native side has no batch method", async () => {
  const { fs: shim, bridge } = loadShim(SETTINGS, { many: false });

  await shim.storage.get(["timerSeconds", "appUnlockMinutes"]);

  assert.equal(bridge.count("storageGet"), 2, "the fallback must actually read every key it was asked for");
  assert.equal(bridge.count("storageGetMany"), 0);
});

test("a native batch method that answers with rubbish falls back instead of losing the settings", async () => {
  const { fs: shim, bridge } = loadShim(SETTINGS);
  bridge.storageGetMany = () => "this is not JSON";

  assert.deepEqual(
    plain(await shim.storage.get(["timerSeconds", "appUnlockMinutes"])), { timerSeconds: 120, appUnlockMinutes: 30 },
    "an unusable batch answer must degrade to the per-key path, not report every setting as unset — " +
      "unset settings are re-defaulted, which is how an optimisation silently resets someone's configuration"
  );
  assert.equal(bridge.count("storageGet"), 2);
});

// ---------------------------------------------------------------------------
// Values that cannot change are asked for once
// ---------------------------------------------------------------------------
//
// `A.getVersion()` is a PackageManager binder round-trip and `A.ruleCount()` is the
// size of a read-only packaged asset. Both were on the 2s poll, and neither can
// change without this process being replaced.

test("the app version is fetched once however often it is asked for", async () => {
  const { fs: shim, bridge } = loadShim();

  for (let i = 0; i < 5; i += 1) {
    assert.equal(await shim.blocking.rulesVersion(), "0.57");
  }
  assert.equal(shim.runtime.getManifest().version, "0.57");
  assert.equal(await shim.version.get(), "0.57");

  assert.equal(
    bridge.count("getVersion"), 1,
    `getVersion crossed to PackageManager ${bridge.count("getVersion")} times for a string fixed at process start`
  );
});

test("the blockable-host count is fetched once", async () => {
  const { fs: shim, bridge } = loadShim();

  for (let i = 0; i < 5; i += 1) {
    assert.equal(await shim.blocking.hostCount(), 2512);
  }
  assert.equal(bridge.count("ruleCount"), 1);
});

test("a bridge that is not ready yet is asked again rather than pinned to an empty answer", async () => {
  const { fs: shim, bridge } = loadShim();
  let ready = false;
  bridge.getVersion = () => { bridge.calls.push("getVersion"); return ready ? "0.57" : ""; };
  bridge.ruleCount = () => { bridge.calls.push("ruleCount"); return ready ? 2512 : 0; };

  assert.equal(await shim.blocking.rulesVersion(), "");
  assert.equal(await shim.blocking.hostCount(), 0);

  ready = true;
  assert.equal(await shim.blocking.rulesVersion(), "0.57", "an empty first answer must not be cached for the session");
  assert.equal(await shim.blocking.hostCount(), 2512);

  // …and once a real answer arrives it IS cached.
  await shim.blocking.rulesVersion();
  await shim.blocking.hostCount();
  assert.equal(bridge.count("getVersion"), 2);
  assert.equal(bridge.count("ruleCount"), 2);
});

// ---------------------------------------------------------------------------
// The rest of the contract the shared UI depends on
// ---------------------------------------------------------------------------

test("writes and removals still reach the bridge one key at a time", async () => {
  const { fs: shim, bridge, store } = loadShim();

  await shim.storage.set({ timerSeconds: 90, appBlockingEnabled: false });
  assert.equal(store.timerSeconds, "90");
  assert.equal(store.appBlockingEnabled, "false", "a boolean must be stored as JSON, not as a bare string");
  assert.equal(bridge.count("storageSet"), 2);

  await shim.storage.remove(["timerSeconds"]);
  assert.ok(!("timerSeconds" in store));
  assert.equal(bridge.count("storageRemove"), 1);
});

test("the platform identity and the domain checker are unchanged", async () => {
  const { fs: shim } = loadShim();

  assert.equal(shim.platform, "android");
  assert.deepEqual(plain(await shim.blocking.check("doordash.com")), { blocked: true, apex: "doordash.com" });
  assert.deepEqual(plain(await shim.blocking.check("example.com")), { blocked: false, apex: null });
});

// The shim must not install itself in a browser — browser-shim.js owns that, and
// two shims racing for `fitshield` is the kind of fork this project does not have.
test("with no native bridge present the shim installs nothing", () => {
  const sandbox = { JSON, Promise };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SHIM, "utf8"), sandbox, { filename: "android-shim.js" });
  assert.equal(sandbox.fitshield, undefined);
});
