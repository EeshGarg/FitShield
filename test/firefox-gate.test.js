"use strict";
/**
 * The Firefox gate must fail for FitShield's defects and nothing else.
 *
 * `tools/firefox-audit.js` aborted `node build.js` roughly one run in three on a
 * tree where Firefox blocking worked perfectly. Three separate causes, all of
 * them the audit's, all of them invisible to the test suite because the audit
 * needs a real browser and nothing could drive its internals:
 *
 *   1. RENDER RACE. It navigated with `goto(url, 4000)` and read the DOM. The
 *      redirect is a declarativeNetRequest redirect, so the block page's URL is
 *      correct from the first load event — but warning.js still has an async
 *      pass to make before `#brand` is un-hidden and filled. A read landing in
 *      between reported "the block page rendered almost nothing in Firefox
 *      (0 bytes of markup)" plus four more failures, all the same missing pass.
 *
 *   2. NO RETRY. The extension installs its dynamic rules from the event page
 *      after Firefox reports the install complete. Measured here: the very first
 *      navigation misses the rules about half the time, and they are in place
 *      within ~11s. Waiting longer on the tab that already loaded cannot help —
 *      the request has gone. The probe has to be re-issued.
 *
 *   3. THIRD-PARTY CONSOLE ERRORS. Every unblocked attempt leaves a tab showing
 *      the real doordash.com, and the audit failed the build for that page's
 *      console output: an aborted load logs a bare "0", a completed one logs a
 *      Cloudflare Turnstile failure and two rejected web fonts. FitShield was
 *      being failed for a third party's errors.
 *
 * ...plus a fourth: a Firefox that would not start threw `BiDi timeout:
 * session.new` straight out of the audit, so the build died with a Node stack
 * trace and no verdict at all.
 *
 * These tests drive the real functions against stub tabs, with the timings
 * passed in, so the retry path runs in milliseconds and no browser is launched.
 *
 * Runs under `node --test`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const audit = require("../tools/firefox-audit.js");

const { reachBlockPage, launchWithRetry, BLOCK_PAGE_RENDERED } = audit;

const FAST = { deadlineMs: 900, attemptMs: 120, backoffMs: 20 };
const BLOCK_URL = "moz-extension://abc-123/warning.html?site=delivery-doordash-com";
const REAL_URL = "https://www.doordash.com/";

// ---------------------------------------------------------------------------
// A document just big enough to run the shipped readiness expression
// ---------------------------------------------------------------------------

function documentWhere({ brandText = "", brandHidden = false, bodyHtml = 0, hasTimer = true, hasContinue = true } = {}) {
  const byId = {
    timer: hasTimer ? { id: "timer" } : null,
    continue: hasContinue ? { id: "continue" } : null,
    brand: { id: "brand", hidden: brandHidden, textContent: brandText }
  };

  return {
    getElementById: (id) => byId[id] || null,
    body: { innerHTML: { length: bodyHtml } }
  };
}

const rendered = (doc) =>
  // eslint-disable-next-line no-new-func
  !!new Function("document", `return ${BLOCK_PAGE_RENDERED};`)(doc);

// ---------------------------------------------------------------------------
// A Firefox whose tabs behave to a script
// ---------------------------------------------------------------------------

/**
 * `script` is one entry per attempt: the url that attempt lands on, and the
 * document it renders. `newPage` hands out a fresh tab each time, exactly as the
 * real audit now does — which is what makes the console-error attribution below
 * a statement about tabs rather than a guess.
 */
function stubFirefox(script) {
  let issued = 0;
  const opened = [];

  return {
    opened,
    async newPage() {
      const step = script[Math.min(issued, script.length - 1)];
      issued += 1;

      const tab = {
        context: `ctx-${issued}`,
        url: step.url,
        closed: false,
        async goto() {},
        async evaluate(expression) {
          if (expression === "location.href") {
            return tab.url;
          }

          if (expression === BLOCK_PAGE_RENDERED) {
            return rendered(step.doc || documentWhere());
          }

          throw new Error(`unexpected evaluate: ${expression.slice(0, 40)}`);
        },
        async close() {
          tab.closed = true;
        }
      };

      opened.push(tab);
      return tab;
    }
  };
}

const GOOD_BLOCK_PAGE = { url: BLOCK_URL, doc: documentWhere({ brandText: "Triggered by DoorDash.", bodyHtml: 4000 }) };
const NOT_BLOCKED = { url: REAL_URL, doc: documentWhere() };

// ---------------------------------------------------------------------------
// 1. The render wait
// ---------------------------------------------------------------------------

test("a block page mid-render is not mistaken for a finished one", () => {
  assert.equal(
    rendered(documentWhere({ brandText: "", brandHidden: true, bodyHtml: 0 })),
    false,
    "the state warning.js leaves behind before its async pass — reading here produced five failures on a good page"
  );

  assert.equal(
    rendered(documentWhere({ brandText: "Triggered by DoorDash.", bodyHtml: 4000 })),
    true,
    "a fully rendered block page must be recognised, or the audit times out on a page that is fine"
  );
});

test("the render wait names every element the audit goes on to assert", () => {
  const full = { brandText: "Triggered by DoorDash.", bodyHtml: 4000 };

  assert.equal(rendered(documentWhere({ ...full, hasTimer: false })), false, "no countdown must not read as ready");
  assert.equal(rendered(documentWhere({ ...full, hasContinue: false })), false, "no continue must not read as ready");
  assert.equal(rendered(documentWhere({ ...full, brandHidden: true })), false, "a hidden brand line must not read as ready");
  assert.equal(rendered(documentWhere({ ...full, bodyHtml: 12 })), false, "an empty body must not read as ready");
});

// ---------------------------------------------------------------------------
// 2. The retry
// ---------------------------------------------------------------------------

test("a first navigation that beat the rules is retried, not reported as broken", async () => {
  const firefox = stubFirefox([NOT_BLOCKED, GOOD_BLOCK_PAGE]);
  const arrival = await reachBlockPage(firefox, FAST);

  assert.equal(arrival.redirected, true, "the second attempt reached the block page and must be believed");
  assert.equal(arrival.rendered, true);
  assert.equal(arrival.attempt, 2, "the probe must be re-issued, not merely re-read");
});

test("each attempt gets its own tab, and a tab left on the real site is closed", async () => {
  const firefox = stubFirefox([NOT_BLOCKED, GOOD_BLOCK_PAGE]);
  const arrival = await reachBlockPage(firefox, FAST);

  assert.equal(firefox.opened.length, 2, "reusing one tab makes it impossible to say whose console errors are whose");
  assert.equal(firefox.opened[0].closed, true, "the tab showing doordash.com must not be left open");
  assert.equal(arrival.tab, firefox.opened[1], "the caller must be handed the tab that reached the block page");
});

test("a site that is never blocked still fails, after a bounded wait", async () => {
  const firefox = stubFirefox([NOT_BLOCKED]);
  const arrival = await reachBlockPage(firefox, FAST);

  assert.equal(arrival.redirected, false, "retrying must not turn a genuinely unblocked site into a pass");
  assert.ok(arrival.attempt >= 2, "the audit must have tried more than once before saying so");
  assert.equal(arrival.url, REAL_URL);
});

test("a block page that never finishes rendering is a defect, not something to retry", async () => {
  // Retrying here would eventually mask a real rendering failure behind a
  // timeout, and report it as "did not block" — sending the next person to the
  // rule engine for a UI problem.
  const stuck = { url: BLOCK_URL, doc: documentWhere({ brandText: "", brandHidden: true, bodyHtml: 0 }) };
  const firefox = stubFirefox([stuck, GOOD_BLOCK_PAGE]);
  const arrival = await reachBlockPage(firefox, FAST);

  assert.equal(arrival.redirected, true, "it did reach the block page");
  assert.equal(arrival.rendered, false, "and it must be reported as not rendering");
  assert.equal(arrival.attempt, 1, "a render failure must not be retried away");
});

// ---------------------------------------------------------------------------
// 3. Whose console errors are these
// ---------------------------------------------------------------------------

test("only tabs left on a third-party site are marked foreign", async () => {
  const firefox = stubFirefox([NOT_BLOCKED, GOOD_BLOCK_PAGE]);
  const arrival = await reachBlockPage(firefox, FAST);

  assert.deepEqual(
    arrival.foreignContexts,
    ["ctx-1"],
    "the unblocked attempt's tab is the one whose console output belongs to doordash.com"
  );

  const foreign = new Set(arrival.foreignContexts);

  // The exact entries that failed builds here.
  const session = [
    { text: "0", context: "ctx-1" },
    { text: "TurnstileError: [Cloudflare Turnstile] Error: 600010.", context: "ctx-1" },
    { text: "downloadable font: rejected by sanitizer", context: "ctx-1" },
    { text: "TypeError: state.info is undefined", context: "ctx-2" },
    { text: "background page threw on load", context: "" }
  ];

  const kept = session.filter((entry) => !foreign.has(entry.context)).map((entry) => entry.text);

  assert.deepEqual(
    kept,
    ["TypeError: state.info is undefined", "background page threw on load"],
    "an error from our block page, and one from the event page, must both still fail the audit"
  );
});

test("a clean run marks nothing foreign", async () => {
  const firefox = stubFirefox([GOOD_BLOCK_PAGE]);
  const arrival = await reachBlockPage(firefox, FAST);

  assert.deepEqual(arrival.foreignContexts, [], "nothing was ever on a third-party page, so nothing may be excused");
  assert.equal(arrival.attempt, 1);
});

// ---------------------------------------------------------------------------
// 4. A browser that will not start
// ---------------------------------------------------------------------------

test("a transient Firefox start-up failure is retried", async () => {
  let calls = 0;
  const realLaunch = require("../tools/lib/bidi.js").launchFirefox;

  require("../tools/lib/bidi.js").launchFirefox = async () => {
    calls += 1;

    if (calls < 2) {
      throw new Error("BiDi timeout: session.new");
    }

    return { geckoId: "fitshield@usha.dev" };
  };

  try {
    // The module captured `launchFirefox` at require time, so re-require it with
    // the stub in place.
    delete require.cache[require.resolve("../tools/firefox-audit.js")];
    const fresh = require("../tools/firefox-audit.js");
    const firefox = await fresh.launchWithRetry("dist/firefox", 3);

    assert.equal(firefox.geckoId, "fitshield@usha.dev");
    assert.equal(calls, 2, "the first attempt failed and must have been retried");
  } finally {
    require("../tools/lib/bidi.js").launchFirefox = realLaunch;
    delete require.cache[require.resolve("../tools/firefox-audit.js")];
  }
});

test("a Firefox that never starts is reported, not thrown as a stack trace", async () => {
  const realLaunch = require("../tools/lib/bidi.js").launchFirefox;

  require("../tools/lib/bidi.js").launchFirefox = async () => {
    throw new Error("BiDi timeout: session.new");
  };

  try {
    delete require.cache[require.resolve("../tools/firefox-audit.js")];
    const fresh = require("../tools/firefox-audit.js");
    let thrown = null;

    try {
      await fresh.launchWithRetry("dist/firefox", 2);
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown, "a browser that never starts must not be silently treated as success");
    assert.equal(
      thrown.code,
      "FIREFOX_UNAVAILABLE",
      "the audit needs a code it can turn into a reported failure — an untagged error reaches the user as a Node stack"
    );
    assert.match(thrown.message, /session\.new/, "the real reason must survive into the message");
  } finally {
    require("../tools/lib/bidi.js").launchFirefox = realLaunch;
    delete require.cache[require.resolve("../tools/firefox-audit.js")];
  }
});
