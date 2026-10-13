"use strict";
/**
 * The Android WebView's copied web bundle: what is copied from where, and the
 * copier. Shared by tools/build-android.js (which copies) and
 * tools/android-audit.js (which fails on drift), so there is one list and no
 * require cycle between the builder and its audit.
 */

const fs = require("fs");
const path = require("path");
const load = require("./load");

const WEB_DIR = path.join(load.ROOT, "android", "app", "src", "main", "assets", "web");

// Canonical web files reused verbatim in the Android WebView, copied (not
// hand-maintained) so they can never fork. tools/android-audit.js fails on drift.
// Sources: extension/ (shared web UI modules), data/ (canonical data), and
// android/web-src/ (the Android-authored shim). Destinations keep the historic
// flat bundle layout inside assets/web/. index.html / app.js are
// Android-authored entry files and stay in WEB_DIR.
const WEB_COPIES = [
  [path.join("android", "web-src", "android-shim.js"), "android-shim.js"],
  [path.join("extension", "i18n.js"), "i18n.js"],
  [path.join("extension", "languages.js"), "languages.js"],
  [path.join("extension", "ambient.js"), "ambient.js"],
  [path.join("extension", "recipes.js"), "recipes.js"],
  [path.join("extension", "icons", "icon-128.png"), "icon-128.png"],
  [path.join("data", "recipes.json"), path.join("data", "recipes.json")]
];
// Whole directories copied recursively (all 83 locales for real localization).
const WEB_DIR_COPIES = [[path.join("extension", "_locales"), "_locales"]];

function bundleWeb() {
  WEB_COPIES.forEach(([src, dest]) => {
    const to = path.join(WEB_DIR, dest);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(load.ROOT, src), to);
  });
  WEB_DIR_COPIES.forEach(([src, dest]) => {
    const to = path.join(WEB_DIR, dest);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(path.join(load.ROOT, src), to, { recursive: true });
  });
  console.log(`Bundled ${WEB_COPIES.length} files + ${WEB_DIR_COPIES.length} dir(s) of canonical web assets.`);
}

module.exports = { bundleWeb, WEB_COPIES, WEB_DIR_COPIES, WEB_DIR };
