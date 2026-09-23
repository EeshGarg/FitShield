#!/usr/bin/env node
"use strict";
/**
 * Service worker <-> engine linkage audit.
 *
 * Guards the exact failure mode behind "the MV3 service worker won't register
 * after the FS Engine was separated": background.js loads the engine with
 * `importScripts("blocklist.js")`, and `blocklist.js` is the SINGLE generated
 * classic-script bundle build.js emits from the "FS Engine/" CommonJS modules.
 *
 * The engine sources use `require` / `module.exports`, so importScripts-ing them
 * raw in a service worker throws `ReferenceError: require is not defined` and the
 * worker never registers. This audit fails if anyone rewires background.js to do
 * that (or points it at the spaced "FS Engine/" path), if a hand-authored
 * blocklist.js is committed to shadow the bundle, or if the bundle stops
 * defining the FitShieldBlocklist API that background.js calls.
 *
 * It proves the contract WITHOUT a browser: it materializes the real bundle
 * (build.bundleEngine) and evaluates it in a classic-script context with NO
 * require/module/importScripts — the faithful shape of an MV3 worker global.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");
const build = require("../build.js");

// The engine's public functions the block/background flow depends on. Any of
// these missing from the bundle means a silently broken worker.
const REQUIRED_ENGINE_API = [
  "loadBlocklists",
  "getEntryDomains",
  "normalizeHostname",
  "shouldBlockByCountry",
  "shouldBlockByCategory"
];

// Raw engine module basenames — importScripts-ing any of these is the broken
// pattern (they are CommonJS and throw "require is not defined").
const RAW_ENGINE_MODULES = build.ENGINE_MODULES; // hostnames.js, entries.js, …

// The classic scripts background.js is allowed to pull in, and the global each
// one must define afterwards. Anything else is a packaging mistake.
const ALLOWED_IMPORTS = {
  "blocklist.js": "FitShieldBlocklist",
  "fitshield-core.js": "FitShieldCore",
  // The site-record helpers the settings page also uses. The worker used to carry
  // its own byte-identical copy of this logic; sharing the one module is what
  // stops the site keys the page writes drifting from the ones the worker reads.
  "blocklist-records.js": "FitShieldBlocklistRecords"
};

// Extract the string arguments of every importScripts(...) call in `source`,
// ignoring // line comments and /* */ block comments (the header comment in
// background.js talks about importScripts without calling it).
function importScriptsTargets(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const targets = [];
  for (const call of code.matchAll(/importScripts\s*\(([^)]*)\)/g)) {
    for (const str of call[1].matchAll(/["']([^"']+)["']/g)) {
      targets.push(str[1]);
    }
  }
  return targets;
}

function serviceWorkerAudit() {
  const reporter = new Reporter("Service worker ↔ engine linkage");

  // ---- background.js importScripts contract --------------------------------
  const backgroundPath = path.join(load.EXTENSION_DIR, "background.js");
  if (!reporter.check(fs.existsSync(backgroundPath), "extension/background.js is missing")) {
    return reporter;
  }
  const background = fs.readFileSync(backgroundPath, "utf8");
  const targets = importScriptsTargets(background);

  reporter.check(
    targets.includes("blocklist.js"),
    'background.js must load the engine with importScripts("blocklist.js") (the generated bundle)'
  );
  reporter.check(
    targets.includes("fitshield-core.js"),
    'background.js must load the shared decision layer with importScripts("fitshield-core.js")'
  );

  for (const target of targets) {
    if (Object.prototype.hasOwnProperty.call(ALLOWED_IMPORTS, target)) {
      continue;
    }
    // The specific mistake: importScripts of a raw engine module or the spaced
    // engine folder. Call it out precisely so the fix is obvious.
    const isRawModule =
      RAW_ENGINE_MODULES.some((m) => target.endsWith(m)) ||
      /FS[ _-]?Engine|fs-engine/i.test(target) ||
      /\s/.test(target);
    if (isRawModule) {
      reporter.fail(
        `background.js importScripts("${target}") — raw FS Engine modules are CommonJS and throw ` +
          `"require is not defined" as classic worker scripts. Import the generated "blocklist.js" bundle instead.`
      );
    } else {
      reporter.fail(
        `background.js importScripts an unexpected target "${target}" ` +
          `(only ${Object.keys(ALLOWED_IMPORTS).map((name) => `"${name}"`).join(" and ")} are packaged)`
      );
    }
  }

  // Each imported script must actually define the global background.js expects,
  // evaluated the way an MV3 worker would evaluate it (see below for the engine;
  // the shared core is checked the same way).
  const corePath = path.join(load.EXTENSION_DIR, "fitshield-core.js");
  if (reporter.check(fs.existsSync(corePath), "extension/fitshield-core.js is missing")) {
    const coreGlobal = { console };
    coreGlobal.self = coreGlobal;
    coreGlobal.globalThis = coreGlobal;

    try {
      vm.runInContext(fs.readFileSync(corePath, "utf8"), vm.createContext(coreGlobal), {
        filename: "fitshield-core.js"
      });
      reporter.check(
        coreGlobal.FitShieldCore && typeof coreGlobal.FitShieldCore.migrateState === "function",
        "fitshield-core.js must define FitShieldCore with the storage/schedule/pass API"
      );
    } catch (error) {
      reporter.fail(
        `fitshield-core.js threw when evaluated as a classic worker script ` +
          `(no require/module/importScripts): ${error.message}`
      );
    }
  }

  // ---- blocklist.js is a SYNCED artifact (committed so extension/ loads raw) --
  // It is generated from "FS Engine/" by `npm run sync` (build.bundleEngine) and
  // committed so `Load unpacked → extension/` works with no build. Its FRESHNESS
  // (byte-parity with the generated bundle) is owned by tools/sync-audit.js; here
  // we only prove the generated bundle itself is a valid classic worker script.
  // A hand-authored copy that drifts from FS Engine/ fails the sync audit.

  // ---- The bundle loads as a classic script and defines the API ------------
  // Faithful MV3 worker global: `self` is the global; NO require/module/
  // importScripts. If the bundle needed any of those, this throws — exactly the
  // failure the worker would hit at registration time.
  const workerGlobal = { console };
  workerGlobal.self = workerGlobal;
  workerGlobal.globalThis = workerGlobal;
  let bundleLoaded = false;
  try {
    vm.runInContext(build.bundleEngine(), vm.createContext(workerGlobal), { filename: "blocklist.js" });
    bundleLoaded = true;
  } catch (error) {
    reporter.fail(
      `the generated blocklist.js threw when evaluated as a classic worker script ` +
        `(no require/module/importScripts): ${error.message}`
    );
  }

  const api = workerGlobal.FitShieldBlocklist;
  reporter.check(
    bundleLoaded && api && typeof api === "object",
    "blocklist.js must define the global FitShieldBlocklist after loading (background.js depends on it)"
  );

  // Every engine function background.js actually calls must be present — derived
  // from the source so the check stays honest as background.js evolves.
  if (api && typeof api === "object") {
    const used = new Set([...background.matchAll(/FitShieldBlocklist\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    REQUIRED_ENGINE_API.forEach((fn) => used.add(fn));
    for (const fn of used) {
      reporter.check(
        typeof api[fn] === "function",
        `FitShieldBlocklist.${fn}() is called by background.js but missing from the engine bundle`
      );
    }
    reporter.note(
      `importScripts target: ${[...new Set(targets)].join(", ")} · ` +
        `${used.size} engine function(s) verified present in the bundle`
    );
  }

  return reporter;
}

if (require.main === module) {
  runCli(serviceWorkerAudit);
}

module.exports = serviceWorkerAudit;
