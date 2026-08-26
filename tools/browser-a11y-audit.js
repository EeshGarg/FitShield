#!/usr/bin/env node
"use strict";
/**
 * Accessibility audit against the REAL accessibility tree, in a real browser.
 *
 * Every other accessibility check in this repository reads the DOM: it asks
 * whether an aria-label attribute is present, whether a rule exists in a
 * stylesheet. That is a proxy. A screen reader does not read the DOM — it reads
 * the platform accessibility tree the browser computes from it, after ARIA,
 * label association, alt text, content, and the accessible-name algorithm have
 * all been applied.
 *
 * The two disagree in exactly the cases that matter. An aria-label on an element
 * whose role forbids naming is dropped. A <label> that points at a missing id
 * contributes nothing. A control inside aria-hidden vanishes entirely while
 * remaining focusable. None of that is visible from the markup.
 *
 * So this drives the built package in Chromium and pulls the computed tree with
 * Accessibility.getFullAXTree — the same data an assistive technology consumes.
 * It is not a substitute for a person listening to a screen reader, and it makes
 * no claim to be: it cannot judge whether an announcement is USEFUL. It does
 * establish that every control has a name, a correct role, and exposed state,
 * which is the part a machine can settle.
 *
 *   node tools/browser-a11y-audit.js
 *
 * Skips (does not fail) when no Chromium is installed, so a checkout without one
 * still validates. Set FS_CHROME to point at a binary explicitly.
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report.js");
const { launch, sleep } = require("./lib/cdp.js");

const ROOT = path.join(__dirname, "..");
const PACKAGE_DIR = path.join(ROOT, "dist", "chrome");

// The surfaces a user can actually reach. The block page needs a site key or it
// renders its "unknown site" state, which has no controls to audit.
const PAGES = [
  { file: "popup.html", label: "popup" },
  { file: "settings.html", label: "settings" },
  { file: "welcome.html", label: "welcome" },
  { file: "warning.html?site=delivery-doordash-com", label: "block page" },
  { file: "whats-new.html", label: "what's new" },
  { file: "diagnostics.html", label: "diagnostics" }
];

// Roles that must carry an accessible name to be operable by a screen reader.
// A user hearing "button" with no name has no way to know what it does.
const MUST_BE_NAMED = new Set([
  "button",
  "link",
  "checkbox",
  "switch",
  "radio",
  "textbox",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "menuitem",
  "tab",
  "searchbox"
]);

const value = (node, key) => (node[key] && node[key].value !== undefined ? node[key].value : undefined);
const roleOf = (node) => String(value(node, "role") || "");
const nameOf = (node) => String(value(node, "name") || "").trim();

function propertyOf(node, name) {
  const found = (node.properties || []).find((p) => p.name === name);
  return found ? found.value && found.value.value : undefined;
}

// A name that is literally an i18n key is a failure this project has hit
// before: FitShieldI18n.t() returns the key itself when nothing resolves, so an
// unresolved lookup reaches the user as "warningContinueButton".
//
// Matched against the actual English catalog rather than a shape heuristic. An
// earlier draft used /^[a-z][a-zA-Z0-9]{6,}$/ and reported "chicken",
// "potatoes", "microwave" and twelve more — every one a real pantry item, named
// exactly as intended. A guess about what a key looks like cannot tell a key
// from an ordinary English word, and a check that cries wolf gets switched off.
const MESSAGE_KEYS = new Set(
  Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "_locales", "en", "messages.json"), "utf8")))
);

async function auditPage(browser, extensionId, page, reporter) {
  const tab = await browser.newPage();

  try {
    await tab.goto(`chrome-extension://${extensionId}/${page.file}`, 2200);

    const { nodes } = await tab.send("Accessibility.getFullAXTree");
    const live = nodes.filter((n) => !n.ignored && ["assertive", "polite"].includes(propertyOf(n, "live")));

    let checked = 0;
    const unnamed = [];
    const keyNamed = [];
    const hiddenFocusable = [];

    nodes.forEach((node) => {
      const role = roleOf(node);

      if (node.ignored) {
        // A control that is focusable but absent from the tree is unreachable by
        // a screen reader while still reachable by Tab — the worst combination,
        // because keyboard focus lands somewhere the user is never told about.
        if (propertyOf(node, "focusable") === true && MUST_BE_NAMED.has(role)) {
          hiddenFocusable.push(role);
        }

        return;
      }

      if (!MUST_BE_NAMED.has(role)) {
        return;
      }

      checked++;
      const name = nameOf(node);

      if (!name) {
        unnamed.push(`${role} (no accessible name)`);
        return;
      }

      if (MESSAGE_KEYS.has(name)) {
        keyNamed.push(`${role} named "${name}"`);
      }
    });

    unnamed.forEach((what) => reporter.fail(`${page.label}: ${what}`));
    keyNamed.forEach((what) => reporter.fail(`${page.label}: ${what} — an unresolved i18n key reached the user`));
    hiddenFocusable.forEach((role) =>
      reporter.fail(`${page.label}: a focusable ${role} is hidden from assistive technology but still in the tab order`)
    );

    // Heading outline: a level may not be skipped on the way down (h2 -> h4),
    // because a screen reader's heading navigation is how a user builds a mental
    // model of a long settings page.
    const headings = nodes
      .filter((n) => !n.ignored && roleOf(n) === "heading")
      .map((n) => Number(propertyOf(n, "level")) || 0)
      .filter(Boolean);

    let previous = 0;
    const skips = [];

    headings.forEach((level) => {
      if (previous && level > previous + 1) {
        skips.push(`h${previous} -> h${level}`);
      }

      previous = level;
    });

    skips.forEach((skip) => reporter.fail(`${page.label}: heading level skipped (${skip})`));

    reporter.note(
      `${page.label}: ${checked} named control(s), ${headings.length} heading(s), ${live.length} live region(s)`
    );

    return { checked, live: live.length };
  } finally {
    await tab.close();
  }
}

async function browserA11yAudit() {
  const reporter = new Reporter("Accessibility — computed tree, real browser");

  if (!fs.existsSync(path.join(PACKAGE_DIR, "manifest.json"))) {
    reporter.warn("dist/chrome is not built — run `node build.js` first");
    return reporter;
  }

  let browser;
  let extensionId = null;

  // Same two-attempt launch as tools/announcement-audit.js, for the same reason:
  // Chromium sometimes comes up without loading a package directory that was
  // written moments earlier, and this audit now reads a freshly staged
  // dist/chrome. Waiting longer never helps — a browser that did not load the
  // extension at start-up never will — so the second attempt is a new browser.
  // Two failures in a row is still a hard failure.
  for (let attempt = 1; attempt <= 2 && !extensionId; attempt++) {
    if (browser) {
      await browser.close();
      browser = null;
      await sleep(1000);
    }

    try {
      browser = await launch({ extensionDir: PACKAGE_DIR });
    } catch (error) {
      if (error.code === "NO_BROWSER") {
        // Not a failure: a checkout without Chromium still validates everything
        // else. Saying so plainly beats a green tick that hides a skipped audit.
        reporter.warn("no Chromium found — computed-tree audit skipped (set FS_CHROME to a browser binary)");
        return reporter;
      }

      throw error;
    }

    extensionId = await browser.resolveExtensionId(PACKAGE_DIR);
  }

  try {
    if (!extensionId) {
      reporter.fail("the extension did not load in Chromium in two attempts — no page answered on any derived id");
      return reporter;
    }

    let totalControls = 0;
    let totalLive = 0;

    for (const page of PAGES) {
      const result = await auditPage(browser, extensionId, page, reporter);
      totalControls += result.checked;
      totalLive += result.live;
    }

    // The countdown and the failure hint are the two moments the block page has
    // something to say after load. With no live region a screen-reader user is
    // told nothing and the button simply becomes clickable.
    if (totalLive === 0) {
      reporter.fail("no page exposes a live region — nothing the pages announce after load would ever be heard");
    }

    reporter.note(`${totalControls} control(s) across ${PAGES.length} surfaces carry a computed accessible name`);
    reporter.note("computed via Accessibility.getFullAXTree — the tree assistive technology reads, not the DOM");
  } finally {
    await browser.close();
  }

  return reporter;
}

module.exports = browserA11yAudit;

if (require.main === module) {
  runCli(browserA11yAudit);
}
