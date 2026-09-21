#!/usr/bin/env node
"use strict";
/**
 * What a screen reader would be GIVEN — not just whether a name exists.
 *
 * tools/browser-a11y-audit.js establishes that every control has a computed
 * accessible name, a correct role and exposed state. That is necessary and it is
 * not sufficient: a page can pass it completely and still be useless to listen
 * to. "Site" and "doordash.com" both have names. Announced as two unrelated
 * strings they mean nothing, because the thing that paired them was a
 * two-column layout, and layout is not in the accessibility tree.
 *
 * So this audit reads the tree the way a screen reader consumes it — in ORDER,
 * with roles, relationships, states and live-region politeness — and checks the
 * properties that decide whether the announcement is usable:
 *
 *   1. Reading order      the block page names WHICH site before it philosophises
 *   2. Pairing            a label and its value share one node
 *   3. Countdown          milestones only, and each one says what it is counting
 *   4. State change       the pause ending is announced, not just rendered
 *   5. Units              a slider is never announced as a bare number
 *   6. Decoration         no glyph that is pure decoration is inside a name
 *   7. Politeness         the popup's status line is still NOT a live region
 *
 * Where the line falls: this settles what assistive technology RECEIVES. It
 * cannot settle what a listener understands — that needs a person with a screen
 * reader, and no assistive technology is installed in this environment. Every
 * check below is written so that its failure means "AT is handed something
 * demonstrably unusable", never "a human might dislike this".
 *
 *   node tools/announcement-audit.js
 *
 * Skips (does not fail) when no Chromium is installed. Set FS_CHROME to point at
 * a binary explicitly.
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report.js");
const { launch, unpackedExtensionId, sleep } = require("./lib/cdp.js");

const ROOT = path.join(__dirname, "..");
const PACKAGE_DIR = path.join(ROOT, "dist", "chrome");
const BLOCK_PAGE = "warning.html?site=delivery-doordash-com";

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

const value = (node, key) => (node[key] && node[key].value !== undefined ? node[key].value : undefined);
const roleOf = (node) => String(value(node, "role") || "");
const nameOf = (node) => String(value(node, "name") || "").trim();

function propertyOf(node, name) {
  const found = (node.properties || []).find((p) => p.name === name);
  return found ? found.value && found.value.value : undefined;
}

/**
 * Tree order IS the reading order: a screen reader linearises the accessibility
 * tree depth-first, and that sequence is the transcript a user hears. Flattening
 * it here means an ordering question ("is the site named before the framing
 * copy?") becomes an index comparison rather than a guess about layout.
 */
function linearise(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const order = [];
  const root = nodes.find((n) => !n.parentId) || nodes[0];

  const walk = (node) => {
    if (!node) {
      return;
    }

    if (!node.ignored) {
      order.push(node);
    }

    (node.childIds || []).forEach((id) => walk(byId.get(id)));
  };

  walk(root);
  return order;
}

// The spoken text of one node: its name, or its own text content.
const spoken = (node) => nameOf(node);

// ---------------------------------------------------------------------------
// Resolving the extension
// ---------------------------------------------------------------------------

/**
 * Ask Chromium which extension is actually loaded, and accept only an id the
 * package path could have produced.
 *
 * cdp.js resolves the id by navigating to each candidate and keeping the first
 * whose body exceeds 300 characters. Chromium's ERR_BLOCKED_BY_CLIENT page is
 * roughly 42,000 characters, so that probe answers "yes" for a candidate that is
 * not installed at all, and the resolver returns whichever id happens to sort
 * first for the path spelling in use. Observed directly while writing this
 * audit: the same package resolved to a real id from one path spelling and to a
 * dead one from another, and the dead one produced an error page with no
 * unnamed controls and no skipped headings — a clean pass over nothing.
 *
 * Target.getTargets reports what the browser actually loaded, so there is no
 * guess to get wrong; intersecting it with the derived candidates keeps a
 * component extension from being mistaken for ours.
 */
async function resolveLoadedExtensionId(browser, packageDir, timeoutMs = 20000) {
  const candidates = new Set(unpackedExtensionId(packageDir));
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { targetInfos } = await browser.cdp.send("Target.getTargets");
    const hit = targetInfos
      .map((t) => {
        try {
          return t.url.startsWith("chrome-extension://") ? new URL(t.url).host : null;
        } catch (_) {
          return null;
        }
      })
      .find((host) => host && candidates.has(host));

    if (hit) {
      return hit;
    }

    if (Date.now() > deadline) {
      return null;
    }

    await sleep(200);
  }
}

/**
 * Map a CSS selector to its node in the accessibility tree.
 *
 * Going through backendNodeId rather than matching on text keeps every check
 * below independent of the English catalog: the audit asks "where did THIS
 * element land in the reading order", not "where did this sentence land".
 */
async function axNodesFor(tab, selector, order) {
  const { root } = await tab.send("DOM.getDocument", { depth: -1, pierce: false });
  const { nodeIds } = await tab.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
  const backendIds = [];

  for (const nodeId of nodeIds) {
    const { node } = await tab.send("DOM.describeNode", { nodeId });
    backendIds.push(node.backendNodeId);
  }

  return backendIds
    .map((backendId) => {
      const index = order.findIndex((n) => n.backendDOMNodeId === backendId);
      return index === -1 ? null : { index, node: order[index] };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Readiness: "parsed" is not "rendered"
// ---------------------------------------------------------------------------
//
// Every surface here renders TWICE — static markup at parse time, then the real
// values once an async read returns (chrome.storage, or a getBlockState round
// trip that has to wake the service worker). An accessibility tree fetched
// between the two passes is a real tree of a half-rendered page, and almost
// every property this audit reads is written in the SECOND pass.
//
// The readiness probes used to check that an element EXISTED. Every one of the
// elements they named is in the static markup, so all of them were satisfied
// before any state had been applied, and the audit raced the page:
//
//   #status         static and EMPTY, filled by refreshStatusOnly() after
//                   loadState() — so the master toggle's aria-describedby
//                   resolved to an empty description and the audit reported
//                   "never told whether FitShield is on"
//   #timerSlider    aria-valuetext written by setTimerDisplay() after
//                   loadState() — so every slider on the popup AND on settings
//                   was "announced as a bare number"
//   #brand          `hidden` in markup until warning.js has the record — and a
//                   hidden element is not in the tree at all, so the block page
//                   could report "the line naming the blocked site is absent"
//   #v-manifest     static placeholder "…" until diagnostics.js fills it
//
// Measured on this machine before the fix: one run in three aborted the build,
// with three popup defects that did not exist. Nothing was wrong with the popup;
// the audit had read it too early. An intermittently red gate teaches people to
// re-run instead of read, which is worse than no gate.
//
// So a condition here must name a value only the SECOND pass can produce.

const COMPLETE = ["document readyState complete", "document.readyState === 'complete'"];

/** An element exists, is in the tree (not `hidden`), and carries real text. */
const shown = (selector) => [
  `${selector} rendered`,
  `(() => { const e = document.querySelector(${JSON.stringify(selector)});` +
    " return !!e && !e.hidden && (e.textContent || '').trim().length > 0; })()"
];

/** An element's text has moved on from a placeholder the markup ships. */
const filled = (selector, placeholder) => [
  `${selector} filled`,
  `(() => { const e = document.querySelector(${JSON.stringify(selector)});` +
    ` if (!e) { return false; } const text = (e.textContent || '').trim();` +
    ` return text.length > 0 && text !== ${JSON.stringify(placeholder)}; })()`
];

const exists = (selector) => [
  `${selector} present`,
  `!!document.querySelector(${JSON.stringify(selector)})`
];

/**
 * Every range input announces a value WITH its unit.
 *
 * Written as "all of them" rather than naming two ids on purpose: this is the
 * exact property auditSliderUnits goes on to assert, so the audit now waits for
 * the state it is about to grade, and a slider added later is covered without
 * anyone remembering to extend a list.
 *
 * It requires a NON-DIGIT in the value, not merely a non-empty string. The unit
 * comes from t(), and before the locale cache resolves t() returns "" — so the
 * first render pass can write "60 " and a length>0 probe would call that page
 * settled and hand the grader the bare number it is about to fail. The probe has
 * to be able to tell the two states apart; that is the whole reason it exists.
 */
const SLIDERS_SETTLED = [
  "every slider announces a unit, not just a number",
  "Array.prototype.every.call(document.querySelectorAll('input[type=range]')," +
    " (s) => /[^\\d\\s.,:-]/.test((s.getAttribute('aria-valuetext') || '')))"
];

/**
 * Every surface's readiness, in one table so test/announcement-readiness.test.js
 * can run these exact expressions against a half-rendered page and a settled one
 * and prove they tell the two apart. A probe that cannot is not a probe.
 */
const READINESS = {
  // #brand and #reasonPanel both ship `hidden` and are un-hidden only once
  // warning.js has resolved the record. A hidden element is absent from the
  // accessibility tree, so reading early makes this audit report the two things
  // it exists to check — the blocked site's name and the reason rows — as
  // missing from a page that renders both correctly.
  block: [
    exists("#timer"),
    shown("#brand"),
    ["#reasonPanel populated", "!!document.querySelector('#reasonPanel .reason-row')"]
  ],

  // Both conditions name a value that only loadState() can produce, and
  // loadState() has to wake the service worker to get it. `#status` is static,
  // EMPTY markup, so probing for its existence proved only that the HTML had
  // parsed — and the three defects this audit then reported (two bare-number
  // sliders and a toggle with no description) were all the same missing second
  // render pass.
  popup: [shown("#status"), SLIDERS_SETTLED],

  // The same race as the popup, on four sliders instead of two — Timer duration,
  // Site open time, Popup width and Corner radius all announced as bare numbers
  // on a run that read the page before its stored settings were applied.
  settings: [exists("#timerSlider"), SLIDERS_SETTLED],

  // "…" is the placeholder diagnostics.html ships; diagnostics.js overwrites it
  // once the report comes back. Grading the row pairing while every value still
  // reads "…" grades the markup, not the page.
  diagnostics: [filled("#v-manifest", "…")],

  // The three `.onboard-choices` groups are static and EMPTY; every button
  // inside them is built by welcome.js renderQuestions(). Probing for an <h1>
  // let this run before a single button existed — the audit's `interact` step
  // would then click nothing, and the decoration check would grade a page with
  // no onboarding controls on it and pass. A clean pass over nothing is the
  // exact failure this whole audit was written against.
  welcome: [
    [
      "onboarding choices rendered",
      "document.querySelectorAll('.onboard-choices').length > 0 && " +
        "Array.prototype.every.call(document.querySelectorAll('.onboard-choices')," +
        " (g) => !!g.querySelector('button[aria-pressed]'))"
    ]
  ],

  // #releases ships empty and is filled by whats-new.js — including the
  // "nothing yet" node, so a child always arrives and waiting for one is safe.
  // Without the wait this graded a page whose entire content was still to come.
  whatsNew: [["#releases rendered", "!!document.querySelector('#releases > *')"]],

  // The countdown section reloads the page itself, so it only needs the timer
  // and the brand line; it opens its own reason panel checks nowhere.
  countdown: [exists("#timer"), shown("#brand")]
};

/**
 * Wait for EVERY condition, and on timeout say which one never came true.
 *
 * A stricter probe is only safe if its failure is legible: "popup.html never
 * became ready" sends the next person to the wrong page entirely, where
 * "#status rendered: false" names the pass that did not run.
 */
async function openPage(browser, extensionId, file, conditions) {
  const ready = [COMPLETE, ...conditions];
  const tab = await browser.newPage();

  await tab.send("DOM.enable");
  await tab.send("Accessibility.enable");
  await tab.goto(`chrome-extension://${extensionId}/${file}`, 300);

  const combined = ready.map(([, expression]) => `(${expression})`).join(" && ");

  // 15s: a cold service worker on a cold profile is the slow case, and this
  // budget is only ever spent when something is genuinely wrong.
  for (let i = 0; i < 100; i++) {
    try {
      if (await tab.evaluate(combined)) {
        return tab;
      }
    } catch (_) {
      /* still navigating */
    }

    await sleep(150);
  }

  const unmet = [];

  for (const [label, expression] of ready) {
    try {
      if (!(await tab.evaluate(expression))) {
        unmet.push(label);
      }
    } catch (error) {
      unmet.push(`${label} (threw: ${error.message})`);
    }
  }

  let where = "";

  try {
    where = String(
      await tab.evaluate("document.location.href + ' | ' + document.title + ' | ' + document.readyState")
    );
  } catch (error) {
    where = `evaluate failed: ${error.message}`;
  }

  await tab.close();
  throw new Error(
    `${file} never became ready — unmet: ${unmet.join("; ") || "(all met on retry — a race in the probe itself)"} [${where}]`
  );
}

/**
 * Both views of the same fetch. `order` is the reading order and excludes
 * ignored nodes; `all` keeps them, because an ignored node is still a PARENT —
 * a <span> that collapses out of the tree still sits between a list item and
 * the text under it, and a walk that only knows about visible nodes stops dead
 * at it. Reading a row's text through `order` alone reported every correctly
 * grouped row as empty.
 */
async function treeOf(tab) {
  const { nodes } = await tab.send("Accessibility.getFullAXTree");
  return { all: nodes, order: linearise(nodes) };
}

// ---------------------------------------------------------------------------
// 1 + 2 + 6: the block page, read as a transcript
// ---------------------------------------------------------------------------

async function auditBlockPage(browser, extensionId, reporter) {
  const tab = await openPage(browser, extensionId, BLOCK_PAGE, READINESS.block);

  try {
    // The reason panel is a <details>: its rows are not in the tree until it is
    // open, and a check that never opens it would pass on an empty panel.
    await tab.evaluate("document.getElementById('reasonPanel').open = true; 1");
    await sleep(300);

    const tree = await treeOf(tab);
    const order = tree.order;

    // --- 1. Reading order --------------------------------------------------
    //
    // A sighted user takes the card in at once and the emphasised brand name is
    // the first thing the eye lands on. A screen reader gets one node at a time,
    // so whichever paragraph is first in the DOM is what the user hears first.
    // The concrete answer to "why am I looking at this?" has to come before the
    // general framing, or the user waits through twenty words of copy to learn
    // which site was blocked.
    const brand = await axNodesFor(tab, "#brand", order);
    const intro = await axNodesFor(tab, '[data-i18n="warningIntro"]', order);

    if (!brand.length) {
      reporter.fail("block page: the line naming the blocked site is absent from the accessibility tree");
    } else if (!intro.length) {
      reporter.fail("block page: the framing paragraph is absent from the accessibility tree");
    } else if (brand[0].index > intro[0].index) {
      reporter.fail(
        "block page: the framing copy is announced before the site that was blocked — " +
          "a screen-reader user hears the essay before they hear which site interrupted them"
      );
    } else {
      reporter.note("block page: names the blocked site before the framing copy");
    }

    // The heading has to come before the controls, or the user reaches a button
    // before they have been told what page they are on.
    const heading = order.findIndex((n) => roleOf(n) === "heading");
    const firstButton = order.findIndex((n) => roleOf(n) === "button");

    if (heading === -1) {
      reporter.fail("block page: no heading in the tree — nothing states where the user is");
    } else if (firstButton !== -1 && firstButton < heading) {
      reporter.fail("block page: a button is announced before the heading that says where the user is");
    }

    // --- 2. Pairing --------------------------------------------------------
    //
    // Every label/value row must be ONE node holding both halves. Two sibling
    // spans reach the user as two unrelated announcements; the association a
    // sighted user reads off the two columns is not in the tree at all, and it
    // breaks completely when the row wraps onto two lines at a narrow width.
    await auditRowPairing(tab, tree, ".reason-row", "block page reason panel", reporter);

    // --- 6. Decoration in names -------------------------------------------
    auditDecorativeNames(order, "block page", reporter);

    return tab;
  } catch (error) {
    await tab.close();
    throw error;
  }
}

/**
 * A row whose halves are separate top-level text nodes is the defect. A row that
 * maps to a single grouping node is the fix. Asserted through the DOM element
 * that draws the row, so the check does not depend on what the row says.
 */
async function auditRowPairing(tab, { all, order }, selector, label, reporter) {
  const rows = await axNodesFor(tab, selector, order);

  if (!rows.length) {
    reporter.fail(`${label}: no ${selector} rows reached the accessibility tree`);
    return;
  }

  // listitem is the grouping role these rows use. A generic/ignored container
  // is exactly the failure: it collapses out of the tree and leaves the label
  // and the value as siblings with nothing joining them.
  const GROUPING = new Set(["listitem", "row", "group", "term", "definition"]);
  const loose = rows.filter(({ node }) => !GROUPING.has(roleOf(node)));

  if (loose.length) {
    reporter.fail(
      `${label}: ${loose.length} of ${rows.length} label/value row(s) are not one node — ` +
        `the label and its value are announced as unrelated strings (roles seen: ${[
          ...new Set(loose.map(({ node }) => roleOf(node) || "«collapsed out of the tree»"))
        ].join(", ")})`
    );
    return;
  }

  // The grouping node has to actually CONTAIN both halves, or it groups nothing.
  const byId = new Map(all.map((n) => [n.nodeId, n]));
  const textUnder = (node) => {
    const out = [];
    const walk = (n) => {
      if (!n) {
        return;
      }
      if (roleOf(n) === "StaticText" && nameOf(n)) {
        out.push(nameOf(n));
      }
      (n.childIds || []).forEach((id) => walk(byId.get(id)));
    };
    walk(node);
    return out;
  };

  const thin = rows.filter(({ node }) => textUnder(node).length < 2);

  if (thin.length) {
    reporter.fail(
      `${label}: ${thin.length} row(s) group fewer than two pieces of text — the pair is not inside the node`
    );
    return;
  }

  reporter.note(`${label}: ${rows.length} label/value row(s) each announce as one grouped statement`);
}

/**
 * Decoration inside an accessible NAME is spoken. The block page's disclosure
 * carried a CSS-generated "▸", so the summary announced as
 * "black right-pointing small triangle, Why was this interrupted?" — and the
 * expanded/collapsed state it stood for was already exposed as a real property,
 * so the user heard it twice, once as furniture.
 *
 * Deliberately narrow: geometric shapes, arrows, dingbats and miscellaneous
 * symbols. An earlier accessibility check in this repository fired on ordinary
 * English words because it guessed at a SHAPE, and a check that cries wolf gets
 * switched off. These ranges contain no letters in any script, so a hit is
 * always furniture that leaked into a name.
 */
const DECORATIVE = /[←-⇿■-◿✀-➿⬀-⯿]/u;

function auditDecorativeNames(order, label, reporter) {
  const offenders = order
    .filter((node) => {
      // A list marker is furniture the browser generates and screen readers
      // handle themselves; it is not part of any control's name. An
      // InlineTextBox is a layout fragment of the StaticText above it, reported
      // once per rendered line — counting it turns one leak into three.
      if (roleOf(node) === "ListMarker" || roleOf(node) === "InlineTextBox") {
        return false;
      }

      return DECORATIVE.test(spoken(node));
    })
    .map((node) => `${roleOf(node)} named ${JSON.stringify(spoken(node))}`);

  offenders.forEach((what) =>
    reporter.fail(`${label}: ${what} — a decorative glyph is inside an accessible name and will be spoken`)
  );

  if (!offenders.length) {
    reporter.note(`${label}: no decorative glyph appears in any accessible name`);
  }
}

// ---------------------------------------------------------------------------
// 3 + 4: the countdown, and the moment it ends
// ---------------------------------------------------------------------------

// `undefined` and `null` are different answers — "the user never set a pause" vs
// "the pause is stored as null" — and JSON has no `undefined`, so the sentinel
// travels as null and is read back the same way on both sides.
const READ_TIMER_SECONDS =
  "new Promise((done) => chrome.storage.local.get('timerSeconds', (v) =>" +
  " done(JSON.stringify(v.timerSeconds === undefined ? null : v.timerSeconds))))";

/**
 * Put `timerSeconds` back, and PROVE it went back.
 *
 * This audit borrows the profile every other extension page shares. The restore
 * was two `try {} catch {}` blocks whose own comment said that leaving 12 behind
 * "made the popup report slider and status defects that were artefacts of this
 * audit" — a guard that documented the damage it was there to prevent and then
 * swallowed its own failure, so the one case it was written for (the tab going
 * away mid-restore) was also the case where it silently did nothing.
 *
 * Three changes: restore the value that was actually there rather than a
 * hardcoded 60; read it back and confirm; and if the borrowed tab cannot do it,
 * do it from a fresh page and, failing that, FAIL the audit. A gate that cannot
 * clean up after itself must say so, because the next thing it does is grade a
 * page using the profile it just corrupted.
 */
async function restoreTimerSeconds(browser, extensionId, tab, previous, reporter) {
  const expected = JSON.stringify(previous === undefined ? null : previous);
  const write =
    previous === undefined || previous === null
      ? "new Promise((done) => chrome.storage.local.remove('timerSeconds', done))"
      : `new Promise((done) => chrome.storage.local.set({ timerSeconds: ${JSON.stringify(previous)} }, done))`;

  const attempt = async (page) => {
    await page.evaluate(write);
    return (await page.evaluate(READ_TIMER_SECONDS)) === expected;
  };

  try {
    if (await attempt(tab)) {
      return;
    }
  } catch (_) {
    /* the borrowed tab may be on its way out — that is what the retry is for */
  }

  // A page of our own, which nothing else in this audit is about to close.
  let fresh;

  try {
    fresh = await openPage(browser, extensionId, BLOCK_PAGE, [exists("#timer")]);   // the write needs chrome.storage, nothing more

    if (await attempt(fresh)) {
      return;
    }

    reporter.fail(
      `the audit shortened timerSeconds to 12 and could not restore it to ${expected} — ` +
        "every later run of this audit, and any browser sharing this profile, sees a 12-second pause"
    );
  } catch (error) {
    reporter.fail(
      `the audit shortened timerSeconds to 12 and could not restore it to ${expected} (${error.message}) — ` +
        "the profile is left holding a value this audit invented"
    );
  } finally {
    if (fresh) {
      await fresh.close();
    }
  }
}

/**
 * The pause is the product's core moment and it has two announcement duties:
 * say how much is left without saying it sixty times, and say when it is over.
 *
 * Observed on REAL time with the pause shortened to 12 seconds — see the note
 * at the observation loop for why virtual time is the wrong instrument here.
 * Nothing is stubbed: this is the shipped timer, watched second by second.
 *
 * This is the ONE audit that writes to the profile every other page shares, so
 * it runs last and it puts what it borrowed back — provably, not hopefully.
 */
async function auditCountdown(browser, extensionId, reporter) {
  const tab = await openPage(browser, extensionId, BLOCK_PAGE, READINESS.countdown);
  let borrowed = false;
  let previousTimerSeconds;

  try {
    // Read the stored pause BEFORE shortening it. The restore used to write a
    // hardcoded 60 — which is the default, not necessarily what was there.
    previousTimerSeconds = JSON.parse(await tab.evaluate(READ_TIMER_SECONDS));

    // Shorten the pause, then reload so the page reads it at start-up. The
    // block page is an extension page, so chrome.storage is reachable from it.
    borrowed = true;
    await tab.evaluate(
      'new Promise((done) => chrome.storage.local.set({ timerSeconds: 12 }, done))'
    );
    await tab.goto(`chrome-extension://${extensionId}/${BLOCK_PAGE}`, 1500);

    for (let i = 0; i < 40; i++) {
      const ready = await tab.evaluate(
        "!!document.getElementById('timer') && Number(document.getElementById('timer').textContent) > 0"
      );

      if (ready) {
        break;
      }

      await sleep(150);
    }

    // Observed on REAL time, with the pause shortened to 12 seconds.
    //
    // This used to run on Emulation.setVirtualTimePolicy, which is a good
    // instrument for most things and the wrong one here: Chrome coalesces timer
    // callbacks inside a granted budget, so setInterval fired once for several
    // virtual seconds and `secondsLeft` skipped straight past the exact values
    // the milestones are keyed to. The audit then reported that a page which
    // announces correctly had never announced at all — confirmed by watching
    // the shipped page in real time, where 60, 30 and 10 all arrive.
    //
    // The friction presets set `timerSeconds`, so a 12-second pause reaches
    // 10, 5 and 0 in about thirteen seconds of real time. 60 and 30 are the
    // same line of code with a larger constant; what is worth guarding is that
    // renderTimer announces on milestones and stays silent between them.
    const PAUSE_SECONDS = 12;
    const EXPECTED_MILESTONES = [10, 5, 0];

    const readState =
      "JSON.stringify({" +
      "n: Number(document.getElementById('timer').textContent)," +
      "announce: document.getElementById('timerAnnounce').textContent.trim()," +
      "hint: document.getElementById('hint').textContent.trim()," +
      "locked: document.getElementById('continue').disabled" +
      "})";

    const milestoneOf = (announce) => {
      const number = /(\d+)/.exec(announce || "");
      return number ? Number(number[1]) : 0;
    };

    let previous = JSON.parse(await tab.evaluate(readState));
    const seen = [];
    let unlockStep = null;

    // Poll faster than the tick so no announcement can appear and be replaced
    // between two reads.
    for (let i = 0; i < PAUSE_SECONDS * 8 + 24; i++) {
      await sleep(250);
      const now = JSON.parse(await tab.evaluate(readState));

      if (now.announce !== previous.announce && now.announce) {
        seen.push({ at: milestoneOf(now.announce), text: now.announce });
      }

      if (previous.locked && !now.locked) {
        unlockStep = { hintChanged: now.hint !== previous.hint, announce: now.announce, hint: now.hint };
      }

      previous = now;

      if (!now.locked && now.n === 0) {
        break;
      }
    }


    // --- 3. Milestones, and what they say ---------------------------------
    const milestones = seen.map((s) => s.at);
    const unexpected = milestones.filter((n) => !EXPECTED_MILESTONES.includes(n));

    if (unexpected.length) {
      reporter.fail(
        `block page: the countdown announced at ${unexpected.join(", ")} — ` +
          "a per-second live region makes a screen reader unusable during the pause"
      );
    }

    const missing = EXPECTED_MILESTONES.filter((n) => !milestones.includes(n));

    if (missing.length) {
      reporter.fail(
        `block page: the countdown never announced at ${missing.join(", ")} — ` +
          "a screen-reader user is not told how much of the pause is left"
      );
    }

    // A bare number is not an announcement. "30" does not say thirty of what,
    // or what happens at zero; the sighted user reads that off a ring the
    // announcement has to stand in for.
    seen.forEach(({ at, text }) => {
      const withoutDigits = text.replace(/[\d\s.,:]/g, "");

      if (withoutDigits.length < 8) {
        reporter.fail(
          `block page: the countdown announced ${JSON.stringify(text)} at ${at} — ` +
            "a bare number does not say what is being counted"
        );
      }
    });

    if (!unexpected.length && !missing.length) {
      reporter.note(
        `block page: countdown announced at ${milestones.join(", ")} only, each as a sentence — ` +
          `e.g. ${JSON.stringify(seen[0].text)}`
      );
    }

    // --- 4. The state change ----------------------------------------------
    //
    // disabled -> enabled is NOT announced by any screen reader, and neither is
    // a change of accessible name. A user who is not watching the button has no
    // way to know the pause ended unless a live region says so.
    if (!unlockStep) {
      reporter.fail("block page: Continue never became operable within the pause — the block page cannot be left");
    } else {
      const announcedEnd = seen.some((s) => s.at === 0 && s.text);

      if (!announcedEnd && !unlockStep.hintChanged) {
        reporter.fail(
          "block page: Continue became operable with nothing announced — " +
            "a control silently changing state is invisible to a screen-reader user"
        );
      } else {
        reporter.note(
          "block page: the pause ending is announced, not just rendered — " +
            `${JSON.stringify(unlockStep.announce)} / ${JSON.stringify(unlockStep.hint)}`
        );
      }
    }

    // The live regions that carry all of this have to still BE live regions.
    const tree = await treeOf(tab);
    const order = tree.order;
    const announceNode = await axNodesFor(tab, "#timerAnnounce", order);
    const hintNode = await axNodesFor(tab, "#hint", order);

    [
      { found: announceNode, what: "the countdown milestone line" },
      { found: hintNode, what: "the lock/unlock hint" }
    ].forEach(({ found, what }) => {
      const live = found.length ? propertyOf(found[0].node, "live") : undefined;

      if (live !== "polite") {
        reporter.fail(
          `block page: ${what} is not a polite live region (live=${JSON.stringify(live)}) — ` +
            "what it says after load would never be heard"
        );
      }
    });

    // The ring is the same information as the milestone line. Exposed, it would
    // be read as a second, unlabelled "60" next to the sentence that explains it.
    const ringDigits = await axNodesFor(tab, "#timer", order);

    if (ringDigits.length) {
      reporter.fail(
        "block page: the countdown digits are exposed to assistive technology as well as the spoken milestone — " +
          "the same number is announced twice, once with no unit"
      );
    }
  } finally {
    if (borrowed) {
      await restoreTimerSeconds(browser, extensionId, tab, previousTimerSeconds, reporter);
    }

    await tab.close();
  }
}

// ---------------------------------------------------------------------------
// 5 + 7: the other surfaces
// ---------------------------------------------------------------------------

/**
 * A range input is announced as its name and its NUMBER. The unit almost always
 * lives in a separate element beside it, which the user never hears next to the
 * value — so "Timer duration, 60" and "Site open time, 5" were, to a listener,
 * two numbers with no units, one in seconds and one in minutes.
 *
 * READ FROM THE DOM, NOT FROM THE CDP `valuetext` PROPERTY. This check used to
 * take the AX node's `valuetext`, and as of Chrome 153 that property no longer
 * reflects `aria-valuetext` on a range input at all — it reports the raw number.
 * Reduced to a page with no FitShield code on it:
 *
 *   <input type="range" value="60" aria-valuetext="60 seconds">
 *   -> Accessibility.getFullAXTree: value=60, valuetext="60"
 *
 * and a `<div role="slider" aria-valuetext="60 seconds">` comes back with
 * valuetext="" entirely. So the old assertion failed six correct sliders on
 * every run, on a page whose DOM carried "60 seconds" from first paint. The
 * attribute is what the platform accessibility API (UIA/IA2) hands a real
 * screen reader; CDP is the thing that stopped reporting it, so the attribute
 * is what this now reads. Everything else here still comes from the AX tree,
 * which remains correct for names, roles and order.
 */
async function auditSliderUnits(tab, order, label, reporter) {
  const sliders = order.filter((n) => roleOf(n) === "slider");

  const domValues = JSON.parse(
    await tab.evaluate(
      "JSON.stringify(Array.prototype.map.call(" +
        "document.querySelectorAll('input[type=range], [role=slider]'), " +
        "(s) => (s.getAttribute('aria-valuetext') || '')))"
    )
  );

  // The AX tree lists sliders in the same order the DOM does. If those two ever
  // disagree in COUNT, pairing them by index would quietly grade the wrong
  // control, so say so instead of guessing.
  if (domValues.length !== sliders.length) {
    reporter.fail(
      `${label}: ${sliders.length} slider(s) in the accessibility tree but ${domValues.length} in the DOM — ` +
        "the two cannot be paired, so their units went ungraded"
    );
    return 0;
  }

  let checked = 0;

  sliders.forEach((node, index) => {
    checked++;
    const text = String(domValues[index] || "").trim();
    const name = nameOf(node) || "«unnamed»";

    if (!text) {
      reporter.fail(
        `${label}: slider ${JSON.stringify(name)} is announced as a bare number — ` +
          "no aria-valuetext, so the unit beside it is never spoken with the value"
      );
      return;
    }

    if (!/[^\d\s.,:-]/.test(text)) {
      reporter.fail(
        `${label}: slider ${JSON.stringify(name)} announces ${JSON.stringify(text)} — still only a number`
      );
    }
  });

  if (checked) {
    reporter.note(`${label}: ${checked} slider(s) announce a value with its unit`);
  }

  return checked;
}

async function auditPopup(browser, extensionId, reporter) {
  const tab = await openPage(browser, extensionId, "popup.html", READINESS.popup);

  try {
    const tree = await treeOf(tab);
    const order = tree.order;

    await auditSliderUnits(tab, order, "popup", reporter);
    auditDecorativeNames(order, "popup", reporter);

    // --- 7. Politeness -----------------------------------------------------
    //
    // The status line is deliberately NOT a live region. It is rewritten by a
    // one-second interval, and as a live region that meant a screen reader
    // re-read the whole sentence every second — the popup could not be used.
    const status = await axNodesFor(tab, "#status", order);

    if (!status.length) {
      reporter.fail("popup: the status line is absent from the accessibility tree");
    } else {
      const live = propertyOf(status[0].node, "live");

      if (live === "polite" || live === "assertive") {
        reporter.fail(
          "popup: the status line is a live region again — it is rewritten every second, " +
            "so a screen reader would re-read it every second and the popup becomes unusable"
        );
      } else {
        // ...and nothing was lost by that, because the same sentence is the
        // master toggle's accessible DESCRIPTION: a user landing on the switch
        // is still told what state FitShield is in, once, when it is relevant.
        const toggle = order.find((n) => roleOf(n) === "checkbox" || roleOf(n) === "switch");
        const description = toggle ? String(value(toggle, "description") || "").trim() : "";
        const statusText = await tab.evaluate("document.getElementById('status').textContent.trim()");

        if (!description) {
          reporter.fail(
            "popup: the status line is not a live region and is not the master toggle's description either — " +
              "a screen-reader user is never told whether FitShield is on"
          );
        } else if (description !== String(statusText).trim()) {
          reporter.fail(
            `popup: the master toggle describes itself as ${JSON.stringify(description)} but the status line reads ` +
              `${JSON.stringify(String(statusText).trim())} — the spoken state and the shown state disagree`
          );
        } else {
          reporter.note(
            "popup: status line is not a live region, and is the master toggle's description — " +
              `${JSON.stringify(description)}`
          );
        }
      }
    }
  } finally {
    await tab.close();
  }
}

async function auditSettings(browser, extensionId, reporter) {
  const tab = await openPage(browser, extensionId, "settings.html", READINESS.settings);

  try {
    const tree = await treeOf(tab);
    const order = tree.order;
    await auditSliderUnits(tab, order, "settings", reporter);
    auditDecorativeNames(order, "settings", reporter);
  } finally {
    await tab.close();
  }
}

async function auditDiagnostics(browser, extensionId, reporter) {
  const tab = await openPage(browser, extensionId, "diagnostics.html", READINESS.diagnostics);

  try {
    const tree = await treeOf(tab);
    const order = tree.order;

    // The same defect as the block page's reason panel, on the page someone
    // opens precisely because something is wrong: "Live redirect rules (Chrome)"
    // and "0" announced as two unrelated strings answer nothing.
    await auditRowPairing(tab, tree, ".row", "diagnostics", reporter);
    auditDecorativeNames(order, "diagnostics", reporter);
  } finally {
    await tab.close();
  }
}

/**
 * `interact` matters more than it looks. Both of the decorative glyphs this
 * audit found in settings and in onboarding are drawn by an
 * `[aria-pressed="true"]::before` rule, so they do not exist until something is
 * selected. Auditing only the untouched page proves nothing about the state the
 * user actually leaves it in.
 */
async function auditSimpleSurface(browser, extensionId, file, label, ready, reporter, interact) {
  const tab = await openPage(browser, extensionId, file, ready);

  try {
    if (interact) {
      await tab.evaluate(interact);
      await sleep(300);
    }

    auditDecorativeNames((await treeOf(tab)).order, label, reporter);
  } finally {
    await tab.close();
  }
}

// ---------------------------------------------------------------------------

async function announcementAudit() {
  const reporter = new Reporter("Accessibility — what is announced, not just what is named");

  if (!fs.existsSync(path.join(PACKAGE_DIR, "manifest.json"))) {
    reporter.warn("dist/chrome is not built — run `node build.js` first");
    return reporter;
  }

  let browser;
  let extensionId = null;

  // Chromium occasionally comes up without ever reporting an extension target
  // for a package directory that was written moments earlier — the audit now
  // reads a freshly staged dist/chrome, and on Windows a just-written tree of a
  // couple of thousand files is not always ready to be loaded. More waiting does
  // not help: if the browser did not load it at start-up it never will. A second
  // browser does.
  //
  // Two attempts, and the second failure is still a hard failure: "the extension
  // will not load" is exactly the kind of thing this gate exists to catch.
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
        reporter.warn("no Chromium found — announcement audit skipped (set FS_CHROME to a browser binary)");
        return reporter;
      }

      throw error;
    }

    extensionId = await resolveLoadedExtensionId(browser, PACKAGE_DIR);
  }

  try {
    if (!extensionId) {
      reporter.fail(
        "the extension did not load in Chromium in two attempts — no target reported an id the package path can produce"
      );
      return reporter;
    }

    const blockTab = await auditBlockPage(browser, extensionId, reporter);
    await blockTab.close();

    await auditPopup(browser, extensionId, reporter);
    await auditSettings(browser, extensionId, reporter);
    await auditDiagnostics(browser, extensionId, reporter);
    await auditSimpleSurface(
      browser,
      extensionId,
      "welcome.html",
      "welcome",
      READINESS.welcome,
      reporter,
      // Press one choice in every onboarding group: the selected state is drawn
      // with a ::before tick, so an unpressed page hides the very thing being
      // checked here.
      "document.querySelectorAll('.onboard-choices').forEach((group) => {" +
        "const first = group.querySelector('button'); if (first) { first.click(); }" +
      "}); 1"
    );
    await auditSimpleSurface(
      browser,
      extensionId,
      "whats-new.html",
      "what's new",
      READINESS.whatsNew,
      reporter
    );

    // Last on purpose: this is the only audit that WRITES to the profile (it
    // shortens timerSeconds), and one profile is shared by every extension page
    // in this browser. It restores what it borrowed and proves the restore
    // landed, so the ordering is a belt to that brace rather than the only thing
    // holding the later sections' results up.
    await auditCountdown(browser, extensionId, reporter);

    reporter.note("read from Accessibility.getFullAXTree in tree order — the sequence a screen reader linearises");
    reporter.note(
      "establishes what assistive technology is HANDED; whether a listener finds it useful still needs a person"
    );
  } finally {
    await browser.close();
  }

  return reporter;
}

module.exports = announcementAudit;
module.exports.resolveLoadedExtensionId = resolveLoadedExtensionId;
// Exported for test/announcement-readiness.test.js, which runs these exact
// expressions against a half-rendered page and a settled one, and drives the
// real restore against a stubbed chrome.storage. Both were intermittent
// build-gate failures with no test that could see them.
module.exports.READINESS = READINESS;
module.exports.COMPLETE = COMPLETE;
module.exports.restoreTimerSeconds = restoreTimerSeconds;
module.exports.READ_TIMER_SECONDS = READ_TIMER_SECONDS;

if (require.main === module) {
  runCli(announcementAudit);
}
