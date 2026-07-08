#!/usr/bin/env node
/**
 * FitShield packager — builds the store-ready zips from the split source tree:
 *   FS Engine/  the blocking engine, code only (see its README for the API)
 *   data/       canonical datasets (blocklists/, recipes.json, android/, generated/)
 *   extension/  browser-extension source (manifest, UI, shims, page scripts)
 *   changelog.json (repo root)
 * The staged package is FLAT — identical to the historical zip layout
 * (manifest.json, all js/html, blocklists/, data/, _locales/, icons/ at the zip
 * root) — because runtime code fetches those relative paths and the store
 * listings expect them. The engine modules are bundled into the packaged
 * blocklist.js (see bundleEngine below). Only the repo layout changed over the
 * releases; the artifact did not.
 *
 * Why a build step at all: Manifest V3 background handling differs by engine.
 *   - Chrome / Brave / Edge (Chromium) only support `background.service_worker`
 *     and emit "'background.scripts' requires manifest version of 2 or lower."
 *     if `scripts` is present.
 *   - Firefox only supports `background.scripts` (an event page); it has no
 *     background service worker in release.
 * So the committed extension/manifest.json is the clean Chromium form
 * (service_worker only). This script derives the Firefox manifest by adding
 * `background.scripts` — letting the same code run on both with no console
 * warning on either.
 *
 *   node build.js            -> dist/ staging + the packaged zips in dist/:
 *                               dist/FitShield-<version>-firefox.zip (Firefox/AMO)
 *                               dist/FitShield-<version>-chrome.zip  (Chrome Web Store)
 *
 * No dependencies. Zipping is done with a tiny built-in writer (Node's zlib) so
 * archive paths always use forward slashes — Windows' Compress-Archive stores
 * backslashes, which breaks extension resource loading and AMO validation.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const EXTENSION_DIR = path.join(ROOT, "extension");
const ENGINE_DIR = path.join(ROOT, "FS Engine");
const DATA_DIR = path.join(ROOT, "data");
const DIST = path.join(ROOT, "dist");

// Extension runtime files only — dev/build/docs assets are deliberately
// excluded. Each entry is [absolute source, stage-relative destination];
// the destinations preserve the flat packaged layout the runtime expects.
const FILES = [
  [path.join(EXTENSION_DIR, "ambient.js"), "ambient.js"],
  [path.join(EXTENSION_DIR, "background.js"), "background.js"],
  [path.join(EXTENSION_DIR, "backup.js"), "backup.js"],
  [path.join(EXTENSION_DIR, "browser-shim.js"), "browser-shim.js"],
  [path.join(EXTENSION_DIR, "currency.js"), "currency.js"],
  [path.join(EXTENSION_DIR, "i18n.js"), "i18n.js"],
  [path.join(EXTENSION_DIR, "languages.js"), "languages.js"],
  [path.join(EXTENSION_DIR, "popup.js"), "popup.js"],
  [path.join(EXTENSION_DIR, "recipes.js"), "recipes.js"],
  [path.join(EXTENSION_DIR, "settings.js"), "settings.js"],
  [path.join(EXTENSION_DIR, "warning.js"), "warning.js"],
  [path.join(EXTENSION_DIR, "welcome.js"), "welcome.js"],
  [path.join(EXTENSION_DIR, "whats-new.js"), "whats-new.js"],
  [path.join(EXTENSION_DIR, "popup.html"), "popup.html"],
  [path.join(EXTENSION_DIR, "settings.html"), "settings.html"],
  [path.join(EXTENSION_DIR, "warning.html"), "warning.html"],
  [path.join(EXTENSION_DIR, "welcome.html"), "welcome.html"],
  [path.join(EXTENSION_DIR, "whats-new.html"), "whats-new.html"],
  [path.join(ROOT, "changelog.json"), "changelog.json"],
  [path.join(DATA_DIR, "recipes.json"), path.join("data", "recipes.json")]
];

// [absolute source dir, stage-relative destination]. data/blocklists is
// remapped to the package root's blocklists/ (the runtime fetch path); the
// rest of data/ keeps its data/ prefix.
const DIRS = [
  [path.join(EXTENSION_DIR, "_locales"), "_locales"],
  [path.join(DATA_DIR, "blocklists"), "blocklists"],
  [path.join(DATA_DIR, "android"), path.join("data", "android")],
  [path.join(DATA_DIR, "generated"), path.join("data", "generated")],
  [path.join(EXTENSION_DIR, "icons"), "icons"]
];

// ---- FS Engine bundler --------------------------------------------------------
// The engine is authored as CommonJS modules in "FS Engine/" (see its README),
// but the extension loads ONE classic script: importScripts("blocklist.js") in
// the Chromium service worker, background.scripts in Firefox. This wraps each
// module in a registry entry and emits a deterministic single file. index.js
// sets the FitShieldBlocklist global itself, so the footer only requires it.
const ENGINE_MODULES = ["hostnames.js", "entries.js", "metadata.js", "loader.js", "index.js"];

function bundleEngine() {
  const parts = [
    '/* GENERATED single-file browser bundle of "FS Engine/" — built by build.js.',
    " * Do not edit: change the engine sources and rebuild (node build.js).",
    ' * API reference: "FS Engine/README.md". */',
    "(function () {",
    '"use strict";',
    "var __modules = Object.create(null), __cache = Object.create(null);",
    "function __require(id) {",
    "  if (__cache[id]) return __cache[id].exports;",
    '  if (!__modules[id]) throw new Error("FS Engine bundle: module not bundled: " + id);',
    "  var m = { exports: {} };",
    "  __cache[id] = m;",
    "  __modules[id].call(m.exports, m, m.exports, __require);",
    "  return m.exports;",
    "}"
  ];

  for (const name of ENGINE_MODULES) {
    const src = fs.readFileSync(path.join(ENGINE_DIR, name), "utf8");
    parts.push(`__modules["./${name}"] = function (module, exports, require) {`);
    parts.push(src.replace(/\r\n/g, "\n").replace(/\n+$/, ""));
    parts.push("};");
  }

  parts.push('__require("./index.js");');
  parts.push("})();");
  return parts.join("\n") + "\n";
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyInto(stageDir) {
  fs.mkdirSync(stageDir, { recursive: true });

  for (const [src, dest] of FILES) {
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required file: ${path.relative(ROOT, src)}`);
    }
    const target = path.join(stageDir, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
  }

  for (const [src, dest] of DIRS) {
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required directory: ${path.relative(ROOT, src)}`);
    }
    fs.cpSync(src, path.join(stageDir, dest), { recursive: true });
  }

  // The engine ships as one generated classic script (see bundleEngine above).
  fs.writeFileSync(path.join(stageDir, "blocklist.js"), bundleEngine());

  verifyStage(stageDir);
}

// Fail the build LOUDLY if the packaged output is missing anything the block
// page (warning.html) needs to render. copyInto already throws when a *source*
// FILE/DIR is absent; this instead re-reads the STAGED package and proves the
// block page's own dependency graph is closed inside it — the exact failure
// mode ("block page broke after the engine moved") this guards against:
//   1. warning.html itself, plus every local asset it <script>/<link>/<img>s
//      (ambient.js, browser-shim.js, i18n.js, recipes.js, warning.js, …),
//   2. the generated engine runtime bundle (blocklist.js) and the datasets it
//      fetches at runtime (blocklists/*.json), and the recipe catalog the
//      block page's alternative columns load (data/recipes.json).
// The page's asset list is derived FROM warning.html, so adding a <script> to
// the block page without staging it fails here rather than in production.
// test/block-page.test.js exercises the same graph plus a full render.
function verifyStage(stageDir) {
  const has = (rel) => fs.existsSync(path.join(stageDir, rel));
  const missing = [];

  // (1) The block page and each same-origin asset it loads.
  const warningHtmlPath = path.join(stageDir, "warning.html");
  if (!fs.existsSync(warningHtmlPath)) {
    throw new Error("Block page dependency check failed: warning.html was not staged.");
  }
  const warningHtml = fs.readFileSync(warningHtmlPath, "utf8");
  for (const tag of warningHtml.match(/<(?:script|link|img)\b[^>]*>/g) || []) {
    const ref = /\s(?:src|href)="([^"]+)"/.exec(tag);
    if (ref && !/^(https?:|data:|#|mailto:)/.test(ref[1]) && !has(ref[1])) {
      missing.push(`warning.html references "${ref[1]}"`);
    }
  }

  // (2) The engine runtime bundle, its datasets, and the recipe catalog.
  const engineDatasets = require("./FS Engine").BLOCKLIST_FILES;
  for (const rel of ["blocklist.js", "data/recipes.json", ...engineDatasets]) {
    if (!has(rel)) {
      missing.push(rel);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      "Block page dependency check failed — the staged package is missing:\n  " +
        missing.join("\n  ") +
        "\nThe block page would render blank. Fix build.js FILES/DIRS or the FS Engine bundle."
    );
  }
}

// Firefox needs an event page (background.scripts). blocklist.js must load
// before background.js, which references FitShieldBlocklist.
function firefoxManifest(base) {
  const manifest = JSON.parse(JSON.stringify(base));
  manifest.background = {
    service_worker: "background.js",
    scripts: ["blocklist.js", "background.js"]
  };
  return manifest;
}

// Chromium (Chrome/Brave/Edge) ignores Firefox-only keys but emits an
// "Unrecognized manifest key 'browser_specific_settings'" warning on load. The
// committed manifest keeps those keys as the shared base for the Firefox build;
// strip them here so the Chrome package loads cleanly with no warnings.
function chromeManifest(base) {
  const manifest = JSON.parse(JSON.stringify(base));
  delete manifest.browser_specific_settings;
  return manifest;
}

// ---- Minimal ZIP writer (deflate) --------------------------------------------
// Browser extensions require forward-slash paths and manifest.json at the root.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Recursively collect files as { name (forward-slash, relative), fullPath }.
function walkFiles(baseDir, dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(baseDir, full, out);
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, full).split(path.sep).join("/");
      out.push({ name: rel, fullPath: full });
    }
  }
  return out;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time: time & 0xffff, day: day & 0xffff };
}

function zipDir(stageDir, outputZip) {
  rmrf(outputZip);

  const files = walkFiles(stageDir, stageDir, []).sort((a, b) => a.name.localeCompare(b.name));
  const { time, day } = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const data = fs.readFileSync(file.fullPath);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data);
    // Fall back to STORE if deflate didn't help (e.g. tiny/already-compressed).
    const useStore = deflated.length >= data.length;
    const method = useStore ? 0 : 8;
    const body = useStore ? data : deflated;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(outputZip, Buffer.concat([...localParts, centralBuf, end]));
}

async function main() {
  // Gate the build on the validators: never package broken datasets, locales,
  // documentation, missing assets, or an Android ruleset that has drifted from
  // the canonical engine. Warnings are allowed; errors abort.
  const { validateAll } = require("./tools/validate-all");
  console.log("Validating before packaging…");
  const validation = await validateAll();
  if (!validation.ok) {
    console.error(`\nBuild aborted: ${validation.errors} validation error(s). Fix them and re-run.`);
    process.exit(1);
  }

  const base = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
  const version = base.version;

  // Clean only the browser stages/zips — leave any dist/android (built by the
  // separate Android step) untouched.
  fs.mkdirSync(DIST, { recursive: true });
  rmrf(path.join(DIST, "chrome"));
  rmrf(path.join(DIST, "firefox"));

  // --- Chrome / Chromium: same files, Firefox-only manifest keys removed. -----
  const chromeStage = path.join(DIST, "chrome");
  copyInto(chromeStage);
  fs.writeFileSync(
    path.join(chromeStage, "manifest.json"),
    JSON.stringify(chromeManifest(base), null, 2) + "\n"
  );
  const chromeZip = path.join(DIST, `FitShield-${version}-chrome.zip`);
  zipDir(chromeStage, chromeZip);

  // --- Firefox / AMO: same files, manifest gains background.scripts. ----------
  const firefoxStage = path.join(DIST, "firefox");
  copyInto(firefoxStage);
  fs.writeFileSync(
    path.join(firefoxStage, "manifest.json"),
    JSON.stringify(firefoxManifest(base), null, 2) + "\n"
  );
  const firefoxZip = path.join(DIST, `FitShield-${version}-firefox.zip`);
  zipDir(firefoxStage, firefoxZip);

  console.log(`\nBuilt FitShield ${version}:`);
  console.log(`  Firefox / AMO : ${path.relative(ROOT, firefoxZip).split(path.sep).join("/")}`);
  console.log(`  Chrome / CWS  : ${path.relative(ROOT, chromeZip).split(path.sep).join("/")}`);
  console.log(`  Android APK   : run \`npm run build:android\` (requires the Android SDK/Gradle)`);
}

// Exported for the test suite and tools/extension-audit.js: bundleEngine so
// test/engine-bundle.test.js can prove the bundled browser artifact exposes the
// exact same API as require("./FS Engine"); FILES/DIRS so the audit can verify
// package-graph closure without building; the manifest derivations so the
// per-browser forms stay a checked contract. Assigned BEFORE main() may run —
// the audit is reached from main() via validate-all, and a later assignment
// would hand that circular require an empty exports object.
module.exports = { bundleEngine, ENGINE_MODULES, FILES, DIRS, copyInto, verifyStage, chromeManifest, firefoxManifest };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
