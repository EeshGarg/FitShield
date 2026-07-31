#!/usr/bin/env node
"use strict";
/**
 * Extension package audit. Verifies the committed manifest is a correct
 * Chromium MV3 base, that the per-browser manifest derivations in build.js
 * keep their contract, and that the PACKAGED file graph is closed — every
 * page script, runtime fetch target, engine dataset, and manifest-referenced
 * resource resolves inside the staged package layout, and no runtime source in
 * extension/ is left out of the package.
 *
 * The staged set is computed from build.js's own FILES/DIRS mapping (plus the
 * generated blocklist.js and manifest.json), so this audit can run before any
 * build and still describe exactly what build.js will ship.
 *
 * Errors: anything that would break the loaded extension (missing script,
 * unreachable fetch target, inline <script> under the MV3 CSP, manifest keys
 * that don't match the runtime, version drift). Warnings: unexpected extras
 * that load fine but deserve a look (e.g. an unused permission).
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");
const build = require("../build.js");
const engine = require("../FS Engine");

// The permissions background.js actually uses: storage (settings/stats),
// declarativeNetRequest (redirect rules), alarms (bypass + schedule timers).
const REQUIRED_PERMISSIONS = ["storage", "declarativeNetRequest", "alarms"];

// Package-relative paths the runtime fetches or importScripts at runtime
// (background.js, recipes.js, whats-new.js, i18n.js), beyond what the HTML
// pages reference via <script src>.
const RUNTIME_TARGETS = ["blocklist.js", "data/recipes.json", "changelog.json", "_locales/en/messages.json"];

const posix = (p) => p.split(path.sep).join("/");

// Every path build.js stages, as package-relative forward-slash names.
function stagedFileSet() {
  const staged = new Set(["manifest.json", "blocklist.js"]);
  for (const [, dest] of build.FILES) {
    staged.add(posix(dest));
  }
  for (const [srcDir, destDir] of build.DIRS) {
    const walk = (dir, rel) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), childRel);
        } else if (entry.isFile()) {
          staged.add(`${posix(destDir)}/${childRel}`);
        }
      }
    };
    if (fs.existsSync(srcDir)) {
      walk(srcDir, "");
    }
  }
  return staged;
}

function checkManifestShape(reporter, manifest, pkg) {
  reporter.check(manifest.manifest_version === 3, `manifest_version must be 3 (got ${manifest.manifest_version})`);
  reporter.check(manifest.default_locale === "en", `default_locale must be "en" (got "${manifest.default_locale}")`);

  // The committed manifest is the Chromium base form: service worker only.
  // build.js derives the Firefox event-page form; background.scripts committed
  // here would make Chrome warn on every load.
  const bg = manifest.background || {};
  reporter.check(bg.service_worker === "background.js", `background.service_worker must be "background.js" (got "${bg.service_worker}")`);
  reporter.check(!bg.scripts, "committed manifest must not contain background.scripts (Firefox form is derived by build.js)");

  // __MSG_*__ names used by the manifest must exist in the default locale.
  const en = load.loadLocale("en");
  if (reporter.check(!en.error, `_locales/en/messages.json unreadable: ${en.error}`)) {
    for (const value of [manifest.name, manifest.description, (manifest.action || {}).default_title]) {
      const msg = /^__MSG_(\w+)__$/.exec(String(value || ""));
      if (msg && !(msg[1] in en.data)) {
        reporter.fail(`manifest references missing locale message "${msg[1]}"`);
      }
    }
  }

  // Permissions: the exact set the runtime needs — a missing one breaks
  // blocking/timers silently, an extra one hurts store review for nothing.
  const permissions = manifest.permissions || [];
  for (const permission of REQUIRED_PERMISSIONS) {
    reporter.check(permissions.includes(permission), `missing required permission "${permission}"`);
  }
  for (const permission of permissions) {
    if (!REQUIRED_PERMISSIONS.includes(permission)) {
      reporter.warn(`permission "${permission}" is not used by the runtime — drop it or document why`);
    }
  }
  reporter.check(
    (manifest.host_permissions || []).includes("<all_urls>"),
    'host_permissions must include "<all_urls>" (declarativeNetRequest redirects cover every ordering site)'
  );

  // The DNR redirect target must be web-accessible or Chrome blocks the
  // redirect at match time.
  const war = manifest.web_accessible_resources || [];
  const warningEntry = war.find((e) => (e.resources || []).includes("warning.html"));
  if (reporter.check(!!warningEntry, "web_accessible_resources must expose warning.html (the DNR redirect target)")) {
    reporter.check(
      (warningEntry.matches || []).includes("<all_urls>"),
      'warning.html web_accessible_resources entry must match "<all_urls>"'
    );
  }

  // MV3 extensions must not carry a custom CSP unless deliberately relaxed —
  // the default (script-src 'self') is the privacy story the docs promise.
  if (manifest.content_security_policy) {
    reporter.warn("manifest sets a custom content_security_policy — the MV3 default is expected");
  }

  // Firefox packaging metadata (AMO requires the id + data collection keys).
  const gecko = (manifest.browser_specific_settings || {}).gecko || {};
  reporter.check(!!gecko.id, "browser_specific_settings.gecko.id is required for AMO signing");
  reporter.check(!!gecko.strict_min_version, "browser_specific_settings.gecko.strict_min_version is required (declarativeNetRequest baseline)");

  // Version must agree across manifest, package.json, and the changelog head.
  const pkgOk = pkg.version === manifest.version || pkg.version.startsWith(`${manifest.version}.`);
  reporter.check(pkgOk, `package.json version ${pkg.version} does not match manifest version ${manifest.version}`);
  try {
    const changelog = load.readJson(path.join(load.ROOT, "changelog.json"));
    const latest = ((changelog.entries || [])[0] || {}).version;
    reporter.check(latest === manifest.version, `changelog.json latest entry ${latest} does not match manifest version ${manifest.version}`);
  } catch (error) {
    reporter.fail(`changelog.json unreadable: ${error.message}`);
  }
}

function checkDerivedManifests(reporter, manifest) {
  const chrome = build.chromeManifest(manifest);
  reporter.check(!("browser_specific_settings" in chrome), "chrome manifest derivation must strip browser_specific_settings");

  const firefox = build.firefoxManifest(manifest);
  const scripts = (firefox.background || {}).scripts || [];
  const expected = build.BACKGROUND_SCRIPTS;
  reporter.check(
    scripts.length === expected.length && scripts.every((script, index) => script === expected[index]),
    `firefox manifest derivation must load ${JSON.stringify(expected)} (got ${JSON.stringify(scripts)})`
  );
  // background.js is last on purpose: it references the globals the earlier
  // files define, so a reordering here would break Firefox at load time.
  reporter.check(
    scripts[scripts.length - 1] === "background.js",
    "background.js must be the LAST firefox background script (it depends on the others)"
  );

  // Safari (nightly): Chromium form (gecko stripped, service worker path) plus
  // the two nightly markers so the wrapped app is unmistakably a nightly build.
  const safari = build.safariManifest(manifest);
  reporter.check(!("browser_specific_settings" in safari), "safari manifest derivation must strip browser_specific_settings");
  reporter.check(
    safari.name === build.SAFARI_NIGHTLY_NAME,
    `safari manifest derivation must set a nightly name "${build.SAFARI_NIGHTLY_NAME}" (got ${JSON.stringify(safari.name)})`
  );
  reporter.check(
    safari.version_name === `${manifest.version}-nightly`,
    `safari manifest derivation must set version_name "${manifest.version}-nightly" (got ${JSON.stringify(safari.version_name)})`
  );
  reporter.check(
    (safari.background || {}).service_worker === "background.js" && !(safari.background || {}).scripts,
    "safari manifest derivation must use the service-worker background (no background.scripts)"
  );
}

// Every resource the manifest points at must exist in the staged package.
function checkManifestResources(reporter, manifest, staged) {
  const refs = new Set();
  Object.values(manifest.icons || {}).forEach((p) => refs.add(p));
  Object.values((manifest.action || {}).default_icon || {}).forEach((p) => refs.add(p));
  if ((manifest.action || {}).default_popup) refs.add(manifest.action.default_popup);
  if ((manifest.options_ui || {}).page) refs.add(manifest.options_ui.page);
  if ((manifest.background || {}).service_worker) refs.add(manifest.background.service_worker);
  (manifest.web_accessible_resources || []).forEach((e) => (e.resources || []).forEach((r) => refs.add(r)));

  refs.forEach((ref) => {
    reporter.check(staged.has(posix(ref)), `manifest references "${ref}" but build.js does not stage it`);
  });
  return refs.size;
}

// Page graph: every <script src>/<link href>/<img src> in the packaged HTML
// resolves inside the package, and no page carries an inline <script> (the
// MV3 default CSP silently refuses to run it).
function checkPageGraph(reporter, staged) {
  const htmlFiles = build.FILES.map(([, dest]) => posix(dest)).filter((dest) => dest.endsWith(".html"));
  let checkedRefs = 0;

  for (const page of htmlFiles) {
    const html = fs.readFileSync(path.join(load.EXTENSION_DIR, page), "utf8");

    for (const tag of html.match(/<script\b[^>]*>/g) || []) {
      const src = /\ssrc="([^"]+)"/.exec(tag);
      if (!src) {
        reporter.fail(`${page}: inline <script> is blocked by the MV3 default CSP`);
        continue;
      }
      checkedRefs++;
      reporter.check(staged.has(posix(src[1])), `${page}: <script src="${src[1]}"> is not in the staged package`);
    }

    for (const tag of html.match(/<(?:link|img)\b[^>]*>/g) || []) {
      const ref = /\s(?:href|src)="([^"]+)"/.exec(tag);
      if (!ref || /^(https?:|data:|#|mailto:)/.test(ref[1])) {
        continue;
      }
      checkedRefs++;
      reporter.check(staged.has(posix(ref[1])), `${page}: references "${ref[1]}" which is not in the staged package`);
    }
  }
  return checkedRefs;
}

// Runtime fetch()/importScripts targets and the engine's dataset contract.
function checkRuntimeTargets(reporter, staged) {
  for (const target of RUNTIME_TARGETS) {
    reporter.check(staged.has(target), `runtime fetch target "${target}" is not in the staged package`);
  }
  for (const dataset of engine.BLOCKLIST_FILES) {
    reporter.check(staged.has(posix(dataset)), `engine dataset "${dataset}" is not in the staged package`);
  }
}

// Generated/synced artifacts that live in extension/ but are NOT hand-authored
// sources build.js copies verbatim: blocklist.js is the engine bundle written by
// bundleEngine (build.js) and mirrored into extension/ by `npm run sync` so the
// source folder loads unpacked. It is exempt from the orphan check; its presence
// and freshness are owned by tools/sync-audit.js.
const GENERATED_SOURCES = new Set(["blocklist.js"]);

// No orphaned runtime sources: every js/html file in extension/ must be staged
// by build.js — a file that exists but never ships is dead code or a packaging
// bug waiting to be found in production.
function checkNoOrphans(reporter) {
  const shipped = new Set(build.FILES.map(([src]) => posix(path.relative(load.EXTENSION_DIR, src))));
  const sources = fs
    .readdirSync(load.EXTENSION_DIR)
    .filter((name) => (name.endsWith(".js") || name.endsWith(".html")) && !GENERATED_SOURCES.has(name));
  for (const name of sources) {
    reporter.check(shipped.has(name), `extension/${name} is not staged by build.js — ship it or delete it`);
  }
  return sources.length;
}

function extensionAudit() {
  const reporter = new Reporter("Extension package");

  let manifest;
  let pkg;
  try {
    manifest = load.manifest();
    pkg = load.pkg();
  } catch (error) {
    reporter.fail(`manifest/package.json invalid: ${error.message}`);
    return reporter;
  }

  const staged = stagedFileSet();

  checkManifestShape(reporter, manifest, pkg);
  checkDerivedManifests(reporter, manifest);
  const manifestRefs = checkManifestResources(reporter, manifest, staged);
  const pageRefs = checkPageGraph(reporter, staged);
  checkRuntimeTargets(reporter, staged);
  const sources = checkNoOrphans(reporter);

  reporter.note(
    `${staged.size} staged files · ${manifestRefs} manifest refs · ${pageRefs} page refs · ` +
    `${RUNTIME_TARGETS.length + engine.BLOCKLIST_FILES.length} runtime targets · ${sources} extension sources`
  );
  return reporter;
}

if (require.main === module) {
  runCli(extensionAudit);
}

module.exports = extensionAudit;
