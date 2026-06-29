#!/usr/bin/env node
"use strict";
/**
 * Build-readiness asset check. Verifies the files the packaged extension needs
 * are present before build.js zips anything.
 *
 * Errors: missing manifest keys, missing referenced icon, missing required
 * runtime file/dir. Warnings: missing branding assets.
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");

// Critical runtime files that must ship (mirrors build.js ROOT_FILES/DIRS at a
// high level — the entrypoints whose absence would break the extension).
const REQUIRED_FILES = [
  "manifest.json", "background.js", "blocklist.js", "popup.html", "popup.js",
  "settings.html", "settings.js", "warning.html", "warning.js",
  "welcome.html", "welcome.js", "whats-new.html", "whats-new.js",
  "i18n.js", "currency.js", "recipes.js", "backup.js", "changelog.json"
];
const REQUIRED_DIRS = ["_locales", "_locales/en", "blocklists", "data", "icons"];
const REQUIRED_DATA = ["blocklists/fast-food.json", "blocklists/delivery.json", "data/recipes.json", "_locales/en/messages.json"];

function assetsCheck() {
  const reporter = new Reporter("Build assets");

  let manifest;
  try {
    manifest = load.manifest();
  } catch (error) {
    reporter.fail(`manifest.json invalid: ${error.message}`);
    return reporter;
  }

  ["manifest_version", "name", "version", "background", "action", "icons", "default_locale"].forEach((k) => {
    if (!(k in manifest)) {
      reporter.fail(`manifest.json missing "${k}"`);
    }
  });

  // Icons referenced by the manifest must exist on disk.
  const iconPaths = new Set();
  if (manifest.icons) Object.values(manifest.icons).forEach((p) => iconPaths.add(p));
  if (manifest.action && manifest.action.default_icon) {
    Object.values(manifest.action.default_icon).forEach((p) => iconPaths.add(p));
  }
  iconPaths.forEach((p) => {
    if (!load.exists(p)) {
      reporter.fail(`manifest references missing icon "${p}"`);
    }
  });

  REQUIRED_FILES.forEach((f) => {
    if (!load.exists(f)) reporter.fail(`missing required file "${f}"`);
  });
  REQUIRED_DIRS.forEach((d) => {
    if (!load.exists(d)) reporter.fail(`missing required directory "${d}"`);
  });
  REQUIRED_DATA.forEach((f) => {
    if (!load.exists(f)) reporter.fail(`missing required data file "${f}"`);
  });

  // Documentation that should ship alongside the repo (not bundled, but
  // required to exist for a clean release).
  if (!fs.existsSync(path.join(load.CHANGELOG_DIR, "ROADMAP.md"))) {
    reporter.fail("missing changelog/ROADMAP.md");
  }

  // Branding (warning only — not bundled into the package).
  if (!load.exists("Branding") || fs.readdirSync(load.BRANDING_DIR).length === 0) {
    reporter.warn("Branding/ is missing or empty");
  }

  reporter.note(`${REQUIRED_FILES.length} files, ${REQUIRED_DIRS.length} dirs, ${iconPaths.size} icon(s) checked`);
  return reporter;
}

if (require.main === module) {
  runCli(assetsCheck);
}

module.exports = assetsCheck;
