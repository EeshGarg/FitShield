#!/usr/bin/env node
"use strict";
/**
 * Firefox real-browser gate for the built package.
 *
 * CLAUDE.md §5 requires real-browser checks for Chrome AND Firefox. Chrome's
 * live in tools/browser-a11y-audit.js. Firefox's existed only as a scratch
 * harness in a temp directory, which the OS deleted between sessions — so the
 * guarantee was real when it ran and unrepeatable afterwards, which is the same
 * as not having it. This is that check, in the repository.
 *
 * Firefox is not Chrome with a different logo, and the differences here are
 * load-bearing: it uses the event-page background form rather than a service
 * worker, it assigns extension pages a per-profile UUID instead of a stable id,
 * and it enforces `browser_specific_settings.gecko`. A package that loads in
 * Chrome can fail in Firefox for any of those and nothing else would notice.
 *
 *   node tools/firefox-audit.js
 *
 * Skips (does not fail) when Firefox is absent. Set FS_FIREFOX to a binary.
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report.js");
const { launchFirefox } = require("./lib/bidi.js");

const ROOT = path.join(__dirname, "..");
const PACKAGE_DIR = path.join(ROOT, "dist", "firefox");

// Firefox refuses top-level navigation to an extension page that is not a
// web-accessible resource — a real difference from Chrome, and a security one.
// Only the block page is web-accessible here, because it is the DNR redirect
// target. That turns out to be the right thing to test anyway: reaching it by
// being BLOCKED exercises the whole product in Firefox — rules installed from
// the event page, matched by the browser, redirected, rendered — rather than
// just proving a file can be opened.
const BLOCKED_PROBE = "https://www.doordash.com/";

// The i18n runtime returns the KEY when a lookup fails, so an unresolved string
// reaches the user as "warningContinueButton". Firefox resolves messages
// through its own implementation, so this can differ from Chrome.
function messageKeys() {
  const file = path.join(ROOT, "extension", "_locales", "en", "messages.json");
  return new Set(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))));
}

async function firefoxAudit() {
  const reporter = new Reporter("Firefox — real browser, built package");

  if (!fs.existsSync(path.join(PACKAGE_DIR, "manifest.json"))) {
    reporter.warn("dist/firefox is not built — run `node build.js` first");
    return reporter;
  }

  let firefox;

  try {
    firefox = await launchFirefox({ extensionDir: PACKAGE_DIR });
  } catch (error) {
    if (error.code === "NO_BROWSER") {
      reporter.warn("no Firefox found — real-browser Firefox checks skipped (set FS_FIREFOX to a binary)");
      return reporter;
    }

    throw error;
  }

  try {
    // Installing at all proves the manifest is valid for Firefox: a bad gecko
    // block, an unsupported key or the Chrome service-worker form would be
    // refused here rather than at review time.
    if (!firefox.geckoId) {
      reporter.fail("Firefox refused to install the built package");
      return reporter;
    }

    reporter.note(`installed as ${firefox.geckoId}`);

    if (!firefox.uuid) {
      reporter.fail("the extension installed but Firefox never assigned it a UUID — its pages are unreachable");
      return reporter;
    }

    const keys = messageKeys();

    // The real test: ask for a blocked site and see whether Firefox redirects.
    // This exercises everything at once — the event page booting, the dynamic
    // rules being installed, Firefox matching one, and the block page rendering
    // what it was handed.
    const tab = await firefox.newPage();

    try {
      await tab.goto(BLOCKED_PROBE, 4000);

      const landed = await tab.evaluate(`(() => {
        const body = document.body;
        return JSON.stringify({
          url: location.href,
          html: body ? body.innerHTML.length : 0,
          text: body ? body.innerText.slice(0, 4000) : "",
          brand: (document.getElementById("brand") || {}).textContent || "",
          hasTimer: !!document.getElementById("timer"),
          hasContinue: !!document.getElementById("continue"),
          lang: document.documentElement.lang || ""
        });
      })()`);

      const state = JSON.parse(landed);
      const redirected = state.url.startsWith(`moz-extension://${firefox.uuid}/warning.html`);

      if (!redirected) {
        reporter.fail(
          `Firefox did not block ${BLOCKED_PROBE} — the tab ended at ${state.url.slice(0, 120)}. ` +
            "Blocking is the product; if this is wrong nothing else matters."
        );
      } else {
        reporter.note(`blocking works: ${BLOCKED_PROBE} was redirected to the block page`);
      }

      if (state.html < 300) {
        reporter.fail(`the block page rendered almost nothing in Firefox (${state.html} bytes of markup)`);
      }

      if (redirected && !state.hasTimer) {
        reporter.fail("the block page has no countdown element in Firefox — the pause cannot happen");
      }

      if (redirected && !state.hasContinue) {
        reporter.fail("the block page has no continue control in Firefox — the user would be trapped");
      }

      if (redirected && !/doordash/i.test(state.brand)) {
        reporter.fail(`the block page did not name the brand it interrupted (rendered "${state.brand.slice(0, 80)}")`);
      }

      if (redirected && !state.lang) {
        reporter.fail("the block page carries no lang attribute in Firefox");
      }

      // A raw key on screen means the page rendered but said nothing. Firefox
      // resolves messages through its own i18n implementation, so this can
      // differ from Chrome even with an identical catalog.
      const leaked = [...keys].filter((key) => new RegExp(`(^|\s)${key}(\s|$)`).test(state.text));

      if (leaked.length > 0) {
        reporter.fail(`unresolved i18n key(s) reached the block page: ${leaked.slice(0, 3).join(", ")}`);
      }
    } finally {
      await tab.close();
    }

    // Console errors are collected for the whole session, so this catches a
    // background page that threw on load as well as anything a page did.
    const errors = firefox.consoleErrors.filter(
      (entry) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(entry.text)
    );

    errors.slice(0, 8).forEach((entry) => {
      reporter.fail(`console error in Firefox: ${entry.text.slice(0, 200)}`);
    });

    if (errors.length > 8) {
      reporter.fail(`… and ${errors.length - 8} further console error(s)`);
    }

    reporter.note(`${firefox.consoleErrors.length} console error(s) observed across the session`);
    reporter.note("driven over WebDriver BiDi — Firefox 153 no longer answers the DevTools protocol");
  } finally {
    await firefox.close();
  }

  return reporter;
}

module.exports = firefoxAudit;

if (require.main === module) {
  runCli(firefoxAudit);
}
