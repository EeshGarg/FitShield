#!/usr/bin/env node
"use strict";
/**
 * Unpacked-readiness proof — DYNAMIC end-to-end check of a built package.
 *
 * The other audits (extension-audit, service-worker-audit) prove the SOURCE tree
 * would stage correctly. This one goes further: it actually BUILDS the package
 * into a temp folder and then exercises it the way Chrome would when you Load
 * unpacked from dist/chrome —
 *
 *   1. The staged manifest is a loadable MV3 extension: service worker file
 *      present, the exact permissions blocking needs, and warning.html exposed
 *      as a web-accessible resource (the declarativeNetRequest redirect target).
 *   2. The generated blocklist.js loads as a classic worker script and defines
 *      FitShieldBlocklist — evaluated with NO require/module (the faithful shape
 *      of an MV3 worker global), the exact failure a source-folder load hits.
 *   3. loadBlocklists() fetches the PACKAGED blocklists/*.json (via a fetch stub
 *      that reads the staged files) and returns a non-empty catalog.
 *   4. A real curated brand (and a subdomain of it) is reported blocked, while a
 *      guaranteed-absent host is not — proving detection against packaged bytes.
 *   5. warning.html and every local asset it loads exist in the package.
 *
 * This is the closest automated stand-in for "load dist/chrome and block a real
 * site" short of driving a browser. It writes to a temp dir and cleans up.
 *
 *   node tools/verify-unpacked.js            # build a temp stage and verify it
 *   node tools/verify-unpacked.js dist/chrome  # verify an already-built folder
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { Reporter } = require("./lib/report");
const build = require("../build.js");

const REQUIRED_PERMISSIONS = ["storage", "declarativeNetRequest", "alarms"];
const HOST_GUARANTEED_ABSENT = "definitely-not-a-food-brand-zzq.example";

// Evaluate the staged blocklist.js as a classic worker script whose only I/O is
// fetch(chrome.runtime.getURL(...)) against the staged files on disk. Returns the
// FitShieldBlocklist API the extension's background.js would see.
function loadStagedEngine(stageDir) {
  const bundlePath = path.join(stageDir, "blocklist.js");
  const source = fs.readFileSync(bundlePath, "utf8");

  const sandbox = { console };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.URL = URL;
  sandbox.chrome = {
    runtime: {
      // Mirror the extension root: getURL(rel) -> rel, fetched from the stage.
      getURL: (rel) => rel
    }
  };
  sandbox.fetch = (rel) => {
    const target = path.join(stageDir, rel);
    if (!fs.existsSync(target)) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("404")) });
    }
    const data = fs.readFileSync(target, "utf8");
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(data)) });
  };

  vm.runInContext(source, vm.createContext(sandbox), { filename: "blocklist.js" });
  return sandbox.FitShieldBlocklist;
}

async function verifyUnpacked(providedStageDir) {
  const reporter = new Reporter("Unpacked-readiness (dynamic)");

  // Stage a fresh build unless the caller pointed us at an existing folder.
  let stageDir = providedStageDir;
  let temp = null;
  if (!stageDir) {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "fitshield-unpacked-"));
    stageDir = temp;
    build.copyInto(stageDir);
    // copyInto stages every file EXCEPT the per-browser manifest (main() writes
    // that); derive the same Chrome manifest here so the stage is complete.
    const base = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
    fs.writeFileSync(
      path.join(stageDir, "manifest.json"),
      JSON.stringify(build.chromeManifest(base), null, 2) + "\n"
    );
  }

  try {
    const has = (rel) => fs.existsSync(path.join(stageDir, rel));

    // (1) Manifest is a loadable MV3 extension with the right blocking contract.
    const manifestPath = path.join(stageDir, "manifest.json");
    if (!reporter.check(fs.existsSync(manifestPath), "manifest.json is missing from the package")) {
      return reporter;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    reporter.check(manifest.manifest_version === 3, `manifest_version must be 3 (got ${manifest.manifest_version})`);

    const sw = (manifest.background || {}).service_worker;
    reporter.check(!!sw && has(sw), `background.service_worker "${sw}" is missing from the package`);

    for (const permission of REQUIRED_PERMISSIONS) {
      reporter.check((manifest.permissions || []).includes(permission), `missing required permission "${permission}"`);
    }
    reporter.check((manifest.host_permissions || []).includes("<all_urls>"), 'host_permissions must include "<all_urls>"');

    const warEntry = (manifest.web_accessible_resources || []).find((e) => (e.resources || []).includes("warning.html"));
    if (reporter.check(!!warEntry, "warning.html must be a web_accessible_resource (the DNR redirect target)")) {
      reporter.check((warEntry.matches || []).includes("<all_urls>"), 'warning.html must be web-accessible to "<all_urls>"');
    }
    reporter.check(has("warning.html"), "warning.html is missing from the package");

    // (2) The engine bundle loads as a worker script and defines the API.
    reporter.check(has("blocklist.js"), "blocklist.js (the engine bundle) is missing from the package");
    let engine = null;
    try {
      engine = loadStagedEngine(stageDir);
    } catch (error) {
      reporter.fail(`blocklist.js threw when evaluated as a classic worker script: ${error.message}`);
    }
    const apiOk = reporter.check(
      engine && typeof engine.loadBlocklists === "function" && typeof engine.isBlockedHost === "function",
      "blocklist.js did not define FitShieldBlocklist with loadBlocklists()/isBlockedHost()"
    );

    // (3) + (4) Load packaged datasets and prove detection against real bytes.
    if (apiOk) {
      let entries = [];
      try {
        entries = await engine.loadBlocklists();
      } catch (error) {
        reporter.fail(`loadBlocklists() failed against the packaged datasets: ${error.message}`);
      }

      if (reporter.check(Array.isArray(entries) && entries.length > 0, "loadBlocklists() returned no entries from the packaged blocklists")) {
        const sample = entries.find((e) => e && e.domain && /^[a-z0-9.-]+$/i.test(String(e.domain)));
        if (reporter.check(!!sample, "no usable apex domain found in the packaged blocklists")) {
          const apex = engine.normalizeHostname(sample.domain);
          reporter.check(engine.isBlockedHost(apex), `packaged brand "${apex}" is not detected as blocked`);
          reporter.check(engine.isBlockedHost(`order.${apex}`), `subdomain "order.${apex}" is not detected as blocked`);
          reporter.check(!engine.isBlockedHost(HOST_GUARANTEED_ABSENT), `"${HOST_GUARANTEED_ABSENT}" must NOT be blocked (over-blocking)`);
          reporter.note(`blocked sample: ${apex} (+ order.${apex}) · ${entries.length} entries loaded from packaged data`);
        }
      }
    }

    // (5) warning.html asset closure inside the package.
    const warningHtml = has("warning.html") ? fs.readFileSync(path.join(stageDir, "warning.html"), "utf8") : "";
    for (const tag of warningHtml.match(/<(?:script|link|img)\b[^>]*>/g) || []) {
      const ref = /\s(?:src|href)="([^"]+)"/.exec(tag);
      if (ref && !/^(https?:|data:|#|mailto:)/.test(ref[1])) {
        reporter.check(has(ref[1]), `warning.html references "${ref[1]}" which is missing from the package`);
      }
    }

    reporter.note(`verified package: ${providedStageDir ? path.relative(path.join(__dirname, ".."), stageDir) : "fresh temp build"}`);
    return reporter;
  } finally {
    if (temp) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

module.exports = verifyUnpacked;

if (require.main === module) {
  const arg = process.argv[2];
  verifyUnpacked(arg ? path.resolve(arg) : undefined)
    .then((reporter) => {
      reporter.print();
      process.exit(reporter.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
