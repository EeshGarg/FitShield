#!/usr/bin/env node
/**
 * FitShield packager — builds the store-ready zips from this single source tree.
 *
 * Why a build step at all: Manifest V3 background handling differs by engine.
 *   - Chrome / Brave / Edge (Chromium) only support `background.service_worker`
 *     and emit "'background.scripts' requires manifest version of 2 or lower."
 *     if `scripts` is present.
 *   - Firefox only supports `background.scripts` (an event page); it has no
 *     background service worker in release.
 * So the committed manifest.json is the clean Chromium form (service_worker
 * only). This script derives the Firefox manifest by adding `background.scripts`
 * — letting the same code run on both with no console warning on either.
 *
 *   node build.js            -> dist/ staging + the packaged zips in dist/:
 *                               dist/FitShield-<version>.zip        (Firefox/AMO)
 *                               dist/FitShield-<version>-chrome.zip (Chrome Web Store)
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
const DIST = path.join(ROOT, "dist");

// Extension runtime files only — dev/build/docs assets are deliberately excluded.
const ROOT_FILES = [
  "ambient.js",
  "background.js",
  "backup.js",
  "blocklist.js",
  "currency.js",
  "i18n.js",
  "languages.js",
  "popup.js",
  "recipes.js",
  "settings.js",
  "warning.js",
  "welcome.js",
  "whats-new.js",
  "popup.html",
  "settings.html",
  "warning.html",
  "welcome.html",
  "whats-new.html",
  "changelog.json"
];

const DIRS = ["_locales", "blocklists", "data", "icons"];

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyInto(stageDir) {
  fs.mkdirSync(stageDir, { recursive: true });

  for (const file of ROOT_FILES) {
    const src = path.join(ROOT, file);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required file: ${file}`);
    }
    fs.copyFileSync(src, path.join(stageDir, file));
  }

  for (const dir of DIRS) {
    const src = path.join(ROOT, dir);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required directory: ${dir}`);
    }
    fs.cpSync(src, path.join(stageDir, dir), { recursive: true });
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

function main() {
  // Gate the build on the validators: never package broken datasets, locales,
  // documentation, or missing assets. Warnings are allowed; errors abort.
  const { validateAll } = require("./tools/validate-all");
  console.log("Validating before packaging…");
  const validation = validateAll();
  if (!validation.ok) {
    console.error(`\nBuild aborted: ${validation.errors} validation error(s). Fix them and re-run.`);
    process.exit(1);
  }

  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const version = base.version;

  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

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
  const firefoxZip = path.join(DIST, `FitShield-${version}.zip`);
  zipDir(firefoxStage, firefoxZip);

  console.log(`\nBuilt FitShield ${version}:`);
  console.log(`  Firefox / AMO : ${path.relative(ROOT, firefoxZip).split(path.sep).join("/")}`);
  console.log(`  Chrome / CWS  : ${path.relative(ROOT, chromeZip).split(path.sep).join("/")}`);
}

main();
