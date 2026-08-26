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
const { launchFirefox, sleep } = require("./lib/bidi.js");

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

/**
 * The block page has RENDERED — not "four seconds have passed".
 *
 * This audit waited on a stopwatch: `goto(url, 4000)`, then read the DOM. The
 * redirect is a declarativeNetRequest redirect, so `location.href` is the block
 * page from the first load event, but warning.js still has an async pass to make
 * before `#brand` is un-hidden and filled. A read landing in between reported a
 * page that renders perfectly as "rendered almost nothing in Firefox (0 bytes of
 * markup)", plus four more failures that were all the same missing pass — and it
 * failed a build roughly one run in three while nothing was wrong.
 *
 * Every element named here is one this audit goes on to assert, so it waits for
 * exactly the state it is about to grade.
 */
const BLOCK_PAGE_RENDERED = `(() => {
  const brand = document.getElementById("brand");
  return !!document.getElementById("timer")
    && !!document.getElementById("continue")
    && !!brand && !brand.hidden && (brand.textContent || "").trim().length > 0
    && !!document.body && document.body.innerHTML.length > 300;
})()`;

/**
 * Ask for a blocked site and wait until the block page is on screen and drawn.
 *
 * Two races, not one, and they need different answers:
 *
 *   RULES     the extension installs its dynamic rules from the event page
 *             AFTER Firefox reports the install complete. Measured here: a
 *             first navigation issued immediately reaches the real network
 *             about half the time, and the rules are in place within ~10s. No
 *             amount of waiting on the already-loaded tab fixes that — the
 *             request has already gone — so the probe must be re-issued.
 *   RENDER    the redirect is a DNR redirect, so `location.href` is the block
 *             page from the first load event, but warning.js still has an async
 *             pass to make before `#brand` is filled. Reading in between
 *             reported a perfectly good page as "rendered almost nothing".
 *
 * Each attempt gets its OWN TAB. That is what makes console-error attribution
 * exact: a tab that failed to be blocked is provably showing a third-party site,
 * so its errors (an aborted load logs a bare "0"; a completed one logs Cloudflare
 * Turnstile and two rejected web fonts) are not FitShield's and are dropped by
 * name below — while every error from the tab that DID reach our block page
 * still fails the audit.
 *
 * Attempts are spaced rather than hammered, so a slow start-up costs three real
 * requests, not thirty.
 */
async function reachBlockPage(firefox, options = {}) {
  // Timings are parameters so test/firefox-gate.test.js can drive the retry path
  // in milliseconds instead of half a minute. The defaults are the shipped ones.
  const deadlineMs = options.deadlineMs === undefined ? 21000 : options.deadlineMs;
  const attemptMs = options.attemptMs === undefined ? 3000 : options.attemptMs;
  const backoffMs = options.backoffMs === undefined ? 3000 : options.backoffMs;
  const started = Date.now();
  const foreignContexts = [];
  let attempt = 0;
  let tab = null;
  let url = "";

  while (Date.now() - started < deadlineMs) {
    attempt += 1;
    tab = await firefox.newPage();

    try {
      await tab.goto(BLOCKED_PROBE, 250);
    } catch (_) {
      /* a navigation that never completes is answered by the next attempt */
    }

    // Give THIS attempt a short window: if the rules are installed, the redirect
    // has already happened and only the render is outstanding.
    const attemptUntil = Date.now() + attemptMs;

    while (Date.now() < attemptUntil) {
      try {
        url = String(await tab.evaluate("location.href"));

        if (url.startsWith("moz-extension://") && (await tab.evaluate(BLOCK_PAGE_RENDERED))) {
          return { tab, foreignContexts, redirected: true, rendered: true, url, attempt, waitedMs: Date.now() - started };
        }
      } catch (_) {
        /* mid-navigation; the deadline is the arbiter */
      }

      await sleep(Math.min(200, Math.max(1, Math.floor(attemptMs / 10))));
    }

    if (url.startsWith("moz-extension://")) {
      // Reached the block page and never finished drawing it. That is a real
      // defect, not a race with rule installation — retrying would only hide it.
      return { tab, foreignContexts, redirected: true, rendered: false, url, attempt, waitedMs: Date.now() - started };
    }

    // Still on the real site. This tab is showing a third party; note it, close
    // it, and give the event page room before asking again.
    foreignContexts.push(tab.context);
    await tab.close();
    tab = null;
    await sleep(backoffMs);
  }

  // Out of time. Re-open one tab so the caller can report what the user would
  // actually have seen.
  tab = await firefox.newPage();

  try {
    await tab.goto(BLOCKED_PROBE, 1000);
    url = String(await tab.evaluate("location.href"));
  } catch (_) {
    /* report whatever the last attempt saw */
  }

  foreignContexts.push(tab.context);
  return { tab, foreignContexts, redirected: false, rendered: false, url, attempt, waitedMs: Date.now() - started };
}

/**
 * Firefox's Remote Agent occasionally never answers on a freshly spawned
 * instance, and `session.new` then times out. That threw straight out of the
 * audit, so `node build.js` died with a Node stack trace and no verdict —
 * indistinguishable, to whoever ran it, from the product being broken.
 *
 * A transient start-up failure is retried. One that survives three attempts is
 * reported as a failure with the real message, because "Firefox will not run
 * here" must not quietly become a pass.
 */
async function launchWithRetry(extensionDir, attempts = 3) {
  let last;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await launchFirefox({ extensionDir });
    } catch (error) {
      if (error.code === "NO_BROWSER") {
        throw error;
      }

      last = error;
      await sleep(1000 * attempt);
    }
  }

  throw Object.assign(new Error(`Firefox would not start after ${attempts} attempts: ${last.message}`), {
    code: "FIREFOX_UNAVAILABLE"
  });
}

async function firefoxAudit() {
  const reporter = new Reporter("Firefox — real browser, built package");

  if (!fs.existsSync(path.join(PACKAGE_DIR, "manifest.json"))) {
    reporter.warn("dist/firefox is not built — run `node build.js` first");
    return reporter;
  }

  let firefox;

  try {
    firefox = await launchWithRetry(PACKAGE_DIR);
  } catch (error) {
    if (error.code === "NO_BROWSER") {
      reporter.warn("no Firefox found — real-browser Firefox checks skipped (set FS_FIREFOX to a binary)");
      return reporter;
    }

    if (error.code === "FIREFOX_UNAVAILABLE") {
      reporter.fail(error.message);
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
    const arrival = await reachBlockPage(firefox);
    const tab = arrival.tab;

    // Tabs that ended up on a THIRD-PARTY page rather than our block page — see
    // the console-error filter below.
    const foreignContexts = new Set(arrival.foreignContexts);

    try {
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
        foreignContexts.add(tab.context);
        reporter.fail(
          `Firefox did not block ${BLOCKED_PROBE} in ${arrival.attempt} attempt(s) over ` +
            `${Math.round(arrival.waitedMs / 1000)}s — the tab ended at ${state.url.slice(0, 120)}. ` +
            "Blocking is the product; if this is wrong nothing else matters."
        );
      } else if (!arrival.rendered) {
        // Redirected but never finished drawing. Separated from "did not block"
        // on purpose: they are different defects, and reporting the second as
        // the first sends the next person to the rule engine for a UI problem.
        reporter.fail(
          `the block page was reached but never finished rendering within ${Math.round(arrival.waitedMs / 1000)}s ` +
            `(${state.html} bytes of markup, brand "${state.brand.slice(0, 40)}")`
        );
      } else {
        reporter.note(
          `blocking works: ${BLOCKED_PROBE} was redirected to the block page and rendered ` +
            `(attempt ${arrival.attempt}, ${arrival.waitedMs}ms after install)`
        );
      }

      if (redirected && state.html < 300) {
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
    // background page that threw on load as well as anything OUR pages did.
    //
    // The last clause is a correctness fix, not a relaxation. Every attempt that
    // is NOT blocked leaves a tab showing the real doordash.com, and that page's
    // own errors were reported as FitShield defects: an aborted load logs a bare
    // "0", a completed one logs a Cloudflare Turnstile failure and two rejected
    // web fonts. That is what made this gate red once in three — an audit
    // failing the product for a third party's console output.
    //
    // Errors are dropped only for a tab that provably ended on a third-party
    // site, identified by browsing context. Anything from the tab that reached
    // our block page, from the event page, or from anywhere else still fails —
    // and a probe that never got blocked has already failed above, so no
    // FitShield defect can hide behind this.
    const errors = firefox.consoleErrors.filter(
      (entry) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(entry.text) && !foreignContexts.has(entry.context)
    );

    errors.slice(0, 8).forEach((entry) => {
      reporter.fail(`console error in Firefox: ${entry.text.slice(0, 200)}`);
    });

    if (errors.length > 8) {
      reporter.fail(`… and ${errors.length - 8} further console error(s)`);
    }

    const thirdParty = firefox.consoleErrors.length - errors.length;
    reporter.note(
      `${errors.length} console error(s) from FitShield across the session` +
        (thirdParty > 0 ? ` (${thirdParty} more came from a third-party page and are not ours)` : "")
    );
    reporter.note("driven over WebDriver BiDi — Firefox 153 no longer answers the DevTools protocol");
  } finally {
    await firefox.close();
  }

  return reporter;
}

module.exports = firefoxAudit;
// Exported for test/firefox-gate.test.js, which drives the retry, the render
// wait and the third-party console-error attribution against stub tabs. Every
// one of those was an intermittent build-gate failure that no test could see.
module.exports.reachBlockPage = reachBlockPage;
module.exports.launchWithRetry = launchWithRetry;
module.exports.BLOCK_PAGE_RENDERED = BLOCK_PAGE_RENDERED;
module.exports.BLOCKED_PROBE = BLOCKED_PROBE;

if (require.main === module) {
  runCli(firefoxAudit);
}
