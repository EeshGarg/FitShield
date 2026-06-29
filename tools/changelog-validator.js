#!/usr/bin/env node
"use strict";
/**
 * Documentation & version synchronization audit.
 *
 * Errors: manifest/package version mismatch, changelog.json invalid or missing
 * the current version, missing changelog/<version>.md, missing ROADMAP.
 * Warnings: missing README/index, ROADMAP not mentioning the current version.
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");

function changelogValidator() {
  const reporter = new Reporter("Documentation & versions");

  const manifestVersion = load.manifest().version;
  const pkgVersion = load.pkg().version;
  reporter.note(`manifest ${manifestVersion}, package ${pkgVersion}`);

  // package.json uses semver (x.y.z); manifest uses x.y. They must agree on the
  // shared prefix.
  if (!String(pkgVersion).startsWith(manifestVersion)) {
    reporter.fail(`package.json version (${pkgVersion}) does not match manifest (${manifestVersion})`);
  }

  // changelog.json (in-extension What's New).
  let changelog;
  try {
    changelog = load.readJson(path.join(load.ROOT, "changelog.json"));
  } catch (error) {
    reporter.fail(`changelog.json invalid: ${error.message}`);
    return reporter;
  }

  if (!Array.isArray(changelog.entries) || changelog.entries.length === 0) {
    reporter.fail("changelog.json has no entries");
  } else {
    changelog.entries.forEach((e, i) => {
      if (typeof e.version !== "string") reporter.fail(`changelog.json[${i}]: version not a string`);
      if (typeof e.title !== "string") reporter.fail(`changelog.json[${i}]: title not a string`);
      if (!Array.isArray(e.changes) || e.changes.length === 0) reporter.fail(`changelog.json[${i}]: empty changes`);
    });
    if (!changelog.entries.some((e) => e.version === manifestVersion)) {
      reporter.fail(`changelog.json has no entry for current version ${manifestVersion}`);
    }
  }

  // changelog/ markdown record.
  const versionMd = path.join(load.CHANGELOG_DIR, `${manifestVersion}.md`);
  if (!fs.existsSync(versionMd)) {
    reporter.fail(`missing changelog/${manifestVersion}.md`);
  }

  const roadmap = path.join(load.CHANGELOG_DIR, "ROADMAP.md");
  if (!fs.existsSync(roadmap)) {
    reporter.fail("missing changelog/ROADMAP.md");
  } else if (!fs.readFileSync(roadmap, "utf8").includes(manifestVersion)) {
    reporter.warn(`ROADMAP.md does not mention the current version ${manifestVersion}`);
  }

  if (!fs.existsSync(path.join(load.CHANGELOG_DIR, "README.md"))) {
    reporter.warn("missing changelog/README.md index");
  }
  if (!load.exists("README.md")) {
    reporter.warn("missing top-level README.md");
  }

  return reporter;
}

if (require.main === module) {
  runCli(changelogValidator);
}

module.exports = changelogValidator;
