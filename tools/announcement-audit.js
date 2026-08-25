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

async function openPage(browser, extensionId, file, readyExpression) {
  const tab = await browser.newPage();

  await tab.send("DOM.enable");
  await tab.send("Accessibility.enable");
  await tab.goto(`chrome-extension://${extensionId}/${file}`, 300);

  for (let i = 0; i < 60; i++) {
    try {
      if (await tab.evaluate(readyExpression)) {
        return tab;
      }
    } catch (_) {
      /* still navigating */
    }

    await sleep(120);
  }

  let diagnosis = "";

  try {
    diagnosis = String(
      await tab.evaluate("document.location.href + ' | ' + document.title + ' | ' + document.readyState")
    );
  } catch (error) {
    diagnosis = `evaluate failed: ${error.message}`;
  }

  await tab.close();
  throw new Error(`${file} never became ready (${diagnosis})`);
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
  const tab = await openPage(
    browser,
    extensionId,
    BLOCK_PAGE,
    "document.readyState === 'complete' && !!document.getElementById('timer')"
  );

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

/**
 * The pause is the product's core moment and it has two announcement duties:
 * say how much is left without saying it sixty times, and say when it is over.
 *
 * Driven on VIRTUAL time. Emulation.setVirtualTimePolicy advances the page's
 * clock in one-second budgets, so the real countdown code runs its real
 * setInterval sixty times in a couple of seconds. Nothing is stubbed: this is
 * the shipped timer, observed second by second.
 */
async function auditCountdown(browser, extensionId, reporter) {
  const tab = await openPage(
    browser,
    extensionId,
    BLOCK_PAGE,
    "document.readyState === 'complete' && !!document.getElementById('timer')"
  );

  try {
    // Shorten the pause, then reload so the page reads it at start-up. The
    // block page is an extension page, so chrome.storage is reachable from it.
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
    // Put the pause back. This audit shortens it to observe milestones in real
    // time, and every later section shares the profile — leaving 12 behind made
    // the popup report slider and status defects that were artefacts of this
    // audit rather than anything wrong with the popup.
    try {
      await tab.evaluate(
        'new Promise((done) => chrome.storage.local.set({ timerSeconds: 60 }, done))'
      );
    } catch (_) {
      /* the tab is going away anyway */
    }

    // Virtual time is a property of the RENDERER, and every page of one
    // extension shares a renderer. Leaving the budget exhausted freezes the
    // clock for the next extension page opened in this browser — which showed
    // up as popup.html sitting in readyState "loading" forever. Handing the
    // clock back before the tab closes keeps the audits independent.
    try {
      await tab.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
    } catch (_) {
      /* the tab may already be gone; the reset is best-effort */
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
 */
function auditSliderUnits(order, label, reporter) {
  const sliders = order.filter((n) => roleOf(n) === "slider");
  let checked = 0;

  sliders.forEach((node) => {
    checked++;
    const text = String(propertyOf(node, "valuetext") || "").trim();
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
  const tab = await openPage(
    browser,
    extensionId,
    "popup.html",
    "document.readyState === 'complete' && !!document.getElementById('status')"
  );

  try {
    const tree = await treeOf(tab);
    const order = tree.order;

    auditSliderUnits(order, "popup", reporter);
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
  const tab = await openPage(
    browser,
    extensionId,
    "settings.html",
    "document.readyState === 'complete' && !!document.getElementById('timerSlider')"
  );

  try {
    const tree = await treeOf(tab);
    const order = tree.order;
    auditSliderUnits(order, "settings", reporter);
    auditDecorativeNames(order, "settings", reporter);
  } finally {
    await tab.close();
  }
}

async function auditDiagnostics(browser, extensionId, reporter) {
  const tab = await openPage(
    browser,
    extensionId,
    "diagnostics.html",
    "document.readyState === 'complete' && !!document.getElementById('v-manifest')"
  );

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

  try {
    browser = await launch({ extensionDir: PACKAGE_DIR });
  } catch (error) {
    if (error.code === "NO_BROWSER") {
      reporter.warn("no Chromium found — announcement audit skipped (set FS_CHROME to a browser binary)");
      return reporter;
    }

    throw error;
  }

  try {
    const extensionId = await resolveLoadedExtensionId(browser, PACKAGE_DIR);

    if (!extensionId) {
      reporter.fail("the extension did not load in Chromium — no target reported an id the package path can produce");
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
      "document.readyState === 'complete' && !!document.querySelector('h1')",
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
      "document.readyState === 'complete' && !!document.querySelector('h1')",
      reporter
    );

    // Last on purpose: this is the only audit that drives virtual time, and a
    // virtual clock belongs to the renderer that every extension page shares.
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

if (require.main === module) {
  runCli(announcementAudit);
}
