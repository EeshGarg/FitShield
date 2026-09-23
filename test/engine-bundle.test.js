"use strict";

// The extension ships the FS Engine as ONE generated classic script
// (blocklist.js, emitted by build.js's bundleEngine). These tests prove the
// bundle is a faithful stand-in for require("../FS Engine"): same API surface,
// same matching semantics, and a working global for the service worker.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { bundleEngine, ENGINE_MODULES } = require("../build.js");
const nodeEngine = require("../FS Engine");

function loadBundle() {
  // A bare sandbox: no chrome, no module/require — exactly what a classic
  // script sees. index.js must fall back to the global assignment path.
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.URL = URL; // hostnames.js uses URL for full-URL normalization
  vm.createContext(sandbox);
  vm.runInContext(bundleEngine(), sandbox, { filename: "blocklist.js" });
  return sandbox.FitShieldBlocklist;
}

test("bundle evaluates as a classic script and defines FitShieldBlocklist", () => {
  const api = loadBundle();
  assert.ok(api && typeof api === "object", "global FitShieldBlocklist missing");
});

test("bundle exposes the exact same API surface as require('FS Engine')", () => {
  const api = loadBundle();
  const bundleKeys = Object.keys(api).sort();
  const nodeKeys = Object.keys(nodeEngine).sort();
  assert.deepEqual(bundleKeys, nodeKeys);
  for (const key of nodeKeys) {
    assert.equal(typeof api[key], typeof nodeEngine[key], `type mismatch for ${key}`);
  }
});

test("bundle matching semantics agree with the Node engine", () => {
  const api = loadBundle();
  const entries = [
    { domain: "doordash.com", aliases: ["doordash.ca"], countries: ["US"], category: "delivery" },
    { domain: "mcdonalds.com", enabled: false }
  ];

  const cases = [
    ["order.doordash.com", {}],
    ["doordash.ca", {}],
    ["fake-doordash.com", {}],
    ["mcdonalds.com", {}],
    ["mcdonalds.com", { onlyEnabled: false }],
    ["doordash.com", { country: "US" }],
    ["doordash.com", { country: "DE" }]
  ];

  for (const [host, opts] of cases) {
    assert.equal(
      api.isBlockedHost(host, { ...opts, entries }),
      nodeEngine.isBlockedHost(host, { ...opts, entries }),
      `divergence for ${host} ${JSON.stringify(opts)}`
    );
  }

  assert.equal(api.domainMatches("https://www.doordash.com/cart", "doordash.com"), true);
  assert.equal(api.domainMatches("fake-mcdonalds.com", "mcdonalds.com"), false);
  // Spread into a host-realm array: the sandbox's Array prototype differs.
  assert.deepEqual([...api.getEntryDomains(entries[0])], nodeEngine.getEntryDomains(entries[0]));
});

test("bundle is deterministic and bundles index.js last", () => {
  assert.equal(bundleEngine(), bundleEngine(), "two bundles differ");
  assert.equal(ENGINE_MODULES[ENGINE_MODULES.length - 1], "index.js");
});

// The engine is versioned separately (it is published as @fitshield/engine and is
// meant to be consumable on its own), but it is released FROM this repo, and its
// package version had been left at 0.54.0 while the product shipped 0.56 — two
// releases stale, with nothing checking it. A version that lies about which
// engine you have is worse than no version at all.
test("the engine's package version tracks the product it ships in", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const ROOT = path.join(__dirname, "..");

  const enginePkg = JSON.parse(fs.readFileSync(path.join(ROOT, "FS Engine", "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));

  // The manifest carries x.y; the engine carries semver x.y.z. They must agree on
  // the release, not on the patch field.
  assert.equal(
    enginePkg.version.split(".").slice(0, 2).join("."),
    manifest.version,
    `FS Engine/package.json says ${enginePkg.version} but this release is ${manifest.version}`
  );
});
