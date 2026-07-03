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

// Critical runtime files that must ship (mirrors build.js FILES/DIRS at a
// high level — the entrypoints whose absence would break the extension).
// Paths are repo-relative source locations; build.js flattens extension/* and
// engine/* into the packaged zip root.
const REQUIRED_FILES = [
  "extension/manifest.json", "extension/background.js", "engine/blocklist.js",
  "extension/popup.html", "extension/popup.js",
  "extension/settings.html", "extension/settings.js", "extension/warning.html", "extension/warning.js",
  "extension/welcome.html", "extension/welcome.js", "extension/whats-new.html", "extension/whats-new.js",
  "extension/i18n.js", "extension/currency.js", "extension/recipes.js", "extension/backup.js",
  "extension/browser-shim.js", "changelog.json"
];
const REQUIRED_DIRS = [
  "extension/_locales", "extension/_locales/en", "engine/blocklists", "engine/data", "extension/icons"
];
const REQUIRED_DATA = [
  "engine/blocklists/fast-food.json", "engine/blocklists/delivery.json",
  "engine/data/recipes.json", "extension/_locales/en/messages.json"
];

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
  // Manifest icon paths are package-relative (zip root); the sources live in
  // extension/, which build.js flattens into the stage root.
  iconPaths.forEach((p) => {
    if (!fs.existsSync(path.join(load.EXTENSION_DIR, p))) {
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
