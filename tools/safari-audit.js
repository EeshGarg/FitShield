#!/usr/bin/env node
"use strict";
/**
 * Safari compatibility pre-flight.
 *
 * Wrapping the Safari payload needs macOS and Xcode, which this project cannot
 * run everywhere. That is a reason to make the handover exact, not a reason to
 * ship the payload unexamined: everything that would fail on a Mac because of
 * what is IN the package can be checked anywhere.
 *
 * Safari's WebExtension support is a subset of Chrome's, and the gaps are quiet
 * ones. An API Safari does not implement is `undefined`, not an error, so a
 * feature does not crash — it silently does nothing, and the first person to
 * find out is a user on a device.
 *
 *   node tools/safari-audit.js
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report.js");

const ROOT = path.join(__dirname, "..");
const STAGE = path.join(ROOT, "dist", "apple", "extension");

// Safari version floors for the APIs this extension actually calls. Only
// entries that matter here — this is not a general compatibility table.
const NEEDS_SAFARI = [
  ["background.service_worker", "16.4", "MV3 background service workers"],
  ["storage.session", "16.4", "chrome.storage.session"],
  ["declarativeNetRequest", "15.4", "declarativeNetRequest"],
  ["scripting", "15.4", "chrome.scripting"]
];

// Safari implements none of these. Using one is a silent no-op, not a throw.
const SAFARI_MISSING = [
  "chrome.declarativeNetRequestFeedback",
  "chrome.offscreen",
  "chrome.sidePanel",
  "chrome.userScripts",
  "chrome.declarativeContent",
  "chrome.enterprise",
  "chrome.gcm",
  "chrome.identity.getProfileUserInfo",
  "chrome.system"
];

const compare = (a, b) => {
  const left = String(a).split(".").map(Number);
  const right = String(b).split(".").map(Number);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
};

function shippedSources() {
  const out = [];

  (function walk(dir) {
    if (!fs.existsSync(dir)) {
      return;
    }

    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== "_locales") {
          walk(full);
        }

        return;
      }

      if (/\.(js|html)$/.test(entry.name)) {
        out.push(full);
      }
    });
  })(STAGE);

  return out;
}

function safariAudit() {
  const reporter = new Reporter("Safari — payload compatibility");
  const manifestFile = path.join(STAGE, "manifest.json");

  if (!fs.existsSync(manifestFile)) {
    reporter.warn("dist/apple/extension is not staged — run `node build.js` first");
    return reporter;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const declared = ((manifest.browser_specific_settings || {}).safari || {}).strict_min_version;

  // Without a floor the converter picks its own deployment target, and every
  // version question below becomes something a device answers.
  if (!declared) {
    reporter.fail(
      "the Safari manifest declares no browser_specific_settings.safari.strict_min_version — " +
        "the converter has no minimum to target"
    );
  }

  const sources = shippedSources();
  const blob = sources.map((file) => fs.readFileSync(file, "utf8")).join("\n");

  // Everything this package actually uses, and the Safari it needs.
  const required = [];

  if (manifest.background && manifest.background.service_worker) {
    required.push(NEEDS_SAFARI[0]);
  }

  if (/storage\s*\.\s*session/.test(blob)) {
    required.push(NEEDS_SAFARI[1]);
  }

  if ((manifest.permissions || []).includes("declarativeNetRequest")) {
    required.push(NEEDS_SAFARI[2]);
  }

  if ((manifest.permissions || []).includes("scripting")) {
    required.push(NEEDS_SAFARI[3]);
  }

  let floor = "0";

  required.forEach(([, since, what]) => {
    if (compare(since, floor) > 0) {
      floor = since;
    }

    if (declared && compare(declared, since) < 0) {
      reporter.fail(`${what} needs Safari ${since}, but the manifest declares ${declared}`);
    }
  });

  if (declared && compare(declared, floor) > 0) {
    // Not a failure — a deliberately higher floor is a decision. Saying so
    // stops the number drifting upward unnoticed and excluding users for
    // nothing.
    reporter.note(`declared minimum ${declared} is above the ${floor} this payload actually requires`);
  }

  // An API Safari lacks is undefined rather than an error, so the feature
  // quietly does nothing. Grep the shipped sources rather than trusting review.
  SAFARI_MISSING.forEach((api) => {
    if (blob.includes(api)) {
      reporter.fail(`${api} is not implemented by Safari — it would be undefined, and the feature a silent no-op`);
    }
  });

  // Safari requires the extension icon set the toolbar and preferences use.
  ["48", "128"].forEach((size) => {
    if (!(manifest.icons || {})[size]) {
      reporter.fail(`Safari needs a ${size}px icon and the manifest declares none`);
    }
  });

  // The converter reads the manifest name; a nightly build must say so, or a
  // tester cannot tell which of two installed builds they are looking at.
  if (!/nightly/i.test(manifest.name || "") && !/nightly/i.test(manifest.version_name || "")) {
    reporter.warn("the Safari payload is not marked as a nightly build");
  }

  reporter.note(`minimum Safari ${declared || "(undeclared)"} — required by: ${required.map((r) => r[2]).join(", ")}`);
  reporter.note(`${sources.length} shipped source file(s) scanned for APIs Safari does not implement`);
  reporter.note("wrapping the payload still needs macOS + Xcode; see dist/apple/BUILD.txt");

  return reporter;
}

module.exports = safariAudit;

if (require.main === module) {
  runCli(safariAudit);
}
