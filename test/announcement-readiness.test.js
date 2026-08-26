"use strict";
/**
 * The announcement audit is a BUILD GATE, and it was failing about one run in
 * three on an unchanged tree. `node build.js` aborted twice and then succeeded;
 * the audit standalone passed 1, failed 1, passed 5, failed 1. The three
 * failures were always the same, and always the popup:
 *
 *   ✗ popup: slider "Timer duration" is announced as a bare number
 *   ✗ popup: slider "Site open time" is announced as a bare number
 *   ✗ popup: the status line is not a live region and is not the master
 *     toggle's description either
 *
 * One cause, not three. The audit read the accessibility tree before the popup
 * had applied its stored state: `#status` was still the empty <div> the markup
 * ships (so `aria-describedby="status"` resolved to an empty description), and
 * neither slider had had `aria-valuetext` written yet (setTimerDisplay /
 * setPassDisplay run after the async loadState(), which has to wake the service
 * worker). The readiness probe was
 *
 *     document.readyState === 'complete' && !!document.getElementById('status')
 *
 * and `#status` is static markup, present the moment the HTML parses. The probe
 * was satisfied before any of the state it was standing in for existed. The same
 * hole sat under settings (four sliders — reproduced here on run 6 of 8),
 * diagnostics, welcome and what's-new.
 *
 * An intermittently red gate is worse than no gate: it teaches people to re-run
 * instead of read. But intermittency is exactly what a test suite cannot catch
 * by running the thing again, so this file does not run the audit. It takes the
 * audit's REAL readiness expressions and its REAL restore, and drives them
 * against a half-rendered page and a settled one directly — deterministically,
 * with no browser.
 *
 * Runs under `node --test`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const audit = require("../tools/announcement-audit.js");

const { READINESS, COMPLETE, restoreTimerSeconds, READ_TIMER_SECONDS } = audit;

// ---------------------------------------------------------------------------
// A DOM small enough to hold in your head, real enough to run the expressions
// ---------------------------------------------------------------------------
//
// The expressions under test are strings of JavaScript that the audit hands to
// Runtime.evaluate in a page. They use `document.readyState`,
// `document.querySelector(All)`, `Array.prototype.every.call`, and the element
// properties `hidden` / `textContent` / `getAttribute`. Nothing else. So a stub
// document with those four capabilities runs the SHIPPED expression rather than
// a paraphrase of it — which matters, because a paraphrase is precisely how the
// original probe came to be trusted.

function element(spec) {
  const el = {
    tag: spec.tag || "div",
    id: spec.id || "",
    classes: new Set(spec.classes || []),
    attrs: Object.assign({}, spec.attrs),
    hidden: !!spec.hidden,
    children: [],
    textContent: spec.text === undefined ? "" : spec.text,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    }
  };

  // Children arrive already built — every fixture below nests element(...) calls
  // — so they are adopted, not reconstructed.
  (spec.children || []).forEach((child) => el.children.push(child));

  // textContent of a container is its descendants' text, as in a real DOM.
  if (spec.text === undefined && el.children.length) {
    Object.defineProperty(el, "textContent", {
      get() {
        return el.children.map((c) => c.textContent).join("");
      }
    });
  }

  return el;
}

// Only the selector shapes the audit actually uses: "#id", ".class", "tag",
// "tag[attr]", "tag[attr=value]", ".class button[attr]", "#id > *", "#id .class".
function matches(el, simple) {
  const [, base, attr] = /^([^[]*)(?:\[([^\]]+)\])?$/.exec(simple) || [];

  if (attr !== undefined) {
    const eq = attr.indexOf("=");
    const name = eq === -1 ? attr : attr.slice(0, eq);
    const want = eq === -1 ? null : attr.slice(eq + 1).replace(/^["']|["']$/g, "");
    const got = el.getAttribute(name);

    if (got === null || (want !== null && got !== want)) {
      return false;
    }
  }

  if (!base) {
    return true;
  }

  if (base.startsWith("#")) {
    return el.id === base.slice(1);
  }

  if (base.startsWith(".")) {
    return el.classes.has(base.slice(1));
  }

  return base === "*" || el.tag === base;
}

function makeDocument(tree, readyState = "complete") {
  const flat = [];
  const parentOf = new Map();

  (function walk(node, parent) {
    flat.push(node);
    parentOf.set(node, parent);
    node.children.forEach((child) => walk(child, node));
  })(tree, null);

  const ancestors = (node) => {
    const chain = [];
    for (let p = parentOf.get(node); p; p = parentOf.get(p)) {
      chain.push(p);
    }
    return chain;
  };

  function queryAll(selector) {
    return selector.split(",").flatMap((part) => {
      const steps = part.trim().split(/\s+/);

      return flat.filter((node) => {
        // Right-most step matches the node; the steps to its left must match
        // ancestors (or, for ">", its direct parent).
        let index = steps.length - 1;

        if (!matches(node, steps[index])) {
          return false;
        }

        let cursor = node;
        index -= 1;

        while (index >= 0) {
          if (steps[index] === ">") {
            index -= 1;
            const parent = parentOf.get(cursor);
            if (!parent || !matches(parent, steps[index])) {
              return false;
            }
            cursor = parent;
          } else {
            const found = ancestors(cursor).find((a) => matches(a, steps[index]));
            if (!found) {
              return false;
            }
            cursor = found;
          }
          index -= 1;
        }

        return true;
      });
    });
  }

  // Elements answer querySelector too, scoped to their own descendants — the
  // welcome probe asks each `.onboard-choices` group whether it holds a button.
  flat.forEach((node) => {
    const within = (n) => n !== node && ancestors(n).includes(node);
    node.querySelector = (s) => queryAll(s).find(within) || null;
    node.querySelectorAll = (s) => queryAll(s).filter(within);
  });

  return {
    readyState,
    querySelector: (s) => queryAll(s)[0] || null,
    querySelectorAll: (s) => queryAll(s),
    getElementById: (id) => flat.find((n) => n.id === id) || null
  };
}

/** Run a readiness set exactly as openPage() does: every condition, AND-ed. */
function settled(conditions, doc) {
  return [COMPLETE, ...conditions].every(([, expression]) =>
    // eslint-disable-next-line no-new-func
    !!new Function("document", `return (${expression});`)(doc)
  );
}

/** Which conditions are unmet — the diagnosis openPage prints on timeout. */
function unmet(conditions, doc) {
  return [COMPLETE, ...conditions]
    // eslint-disable-next-line no-new-func
    .filter(([, expression]) => !new Function("document", `return (${expression});`)(doc))
    .map(([label]) => label);
}

// ---------------------------------------------------------------------------
// The two states of every one of these pages
// ---------------------------------------------------------------------------

const slider = (id, valuetext) =>
  element({ tag: "input", id, attrs: valuetext === null ? { type: "range" } : { type: "range", "aria-valuetext": valuetext } });

// popup.html as it PARSES: #status is `<div id="status" class="status"></div>`,
// and the range inputs carry no aria-valuetext.
const popupParsed = () =>
  makeDocument(
    element({
      children: [
        element({ tag: "input", id: "toggle", attrs: { type: "checkbox", "aria-describedby": "status" } }),
        element({ id: "status", classes: ["status"] }),
        slider("timerSlider", null),
        slider("passDurationSlider", null)
      ]
    })
  );

// The same page after loadState() -> updateUI() -> setTimerDisplay/setPassDisplay
// and refreshStatusOnly(). This is the only state the audit may grade.
const popupSettled = () =>
  makeDocument(
    element({
      children: [
        element({ tag: "input", id: "toggle", attrs: { type: "checkbox", "aria-describedby": "status" } }),
        element({ id: "status", classes: ["status"], text: "FitShield is on. 60-second pause." }),
        slider("timerSlider", "60 seconds"),
        slider("passDurationSlider", "5 minutes")
      ]
    })
  );

const settingsParsed = () =>
  makeDocument(
    element({
      children: [slider("timerSlider", null), slider("passDurationSlider", null), slider("popupWidth", null), slider("cornerRadius", null)]
    })
  );

const settingsSettled = () =>
  makeDocument(
    element({
      children: [
        slider("timerSlider", "60 seconds"),
        slider("passDurationSlider", "5 minutes"),
        slider("popupWidth", "380 pixels"),
        slider("cornerRadius", "14 pixels")
      ]
    })
  );

// warning.html: #brand and #reasonPanel both ship `hidden`, and a hidden element
// is not in the accessibility tree at all — so an early read reports the blocked
// site's name as ABSENT from a page that renders it perfectly well.
const blockParsed = () =>
  makeDocument(
    element({
      children: [
        element({ tag: "p", id: "brand", hidden: true }),
        element({ tag: "div", id: "timer", text: "60" }),
        element({ tag: "details", id: "reasonPanel", hidden: true, children: [element({ tag: "ul", id: "reasonBody" })] })
      ]
    })
  );

const blockSettled = () =>
  makeDocument(
    element({
      children: [
        element({ tag: "p", id: "brand", text: "Triggered by DoorDash." }),
        element({ tag: "div", id: "timer", text: "60" }),
        element({
          tag: "details",
          id: "reasonPanel",
          children: [
            element({
              tag: "ul",
              id: "reasonBody",
              children: [element({ tag: "li", classes: ["reason-row"], text: "Sitedoordash.com" })]
            })
          ]
        })
      ]
    })
  );

const diagnosticsParsed = () =>
  makeDocument(element({ children: [element({ tag: "span", id: "v-manifest", text: "…" })] }));

const diagnosticsSettled = () =>
  makeDocument(element({ children: [element({ tag: "span", id: "v-manifest", text: "FitShield v0.55" })] }));

// welcome.html ships the three `.onboard-choices` groups EMPTY; every button in
// them is created by welcome.js renderQuestions().
const welcomeParsed = () =>
  makeDocument(
    element({
      children: [
        element({ tag: "h1", text: "Welcome" }),
        element({ id: "interruptChoices", classes: ["onboard-choices"] }),
        element({ id: "whenChoices", classes: ["onboard-choices"] }),
        element({ id: "frictionChoices", classes: ["onboard-choices"] })
      ]
    })
  );

const welcomeSettled = () =>
  makeDocument(
    element({
      children: [
        element({ tag: "h1", text: "Welcome" }),
        ...["interruptChoices", "whenChoices", "frictionChoices"].map((id) =>
          element({
            id,
            classes: ["onboard-choices"],
            children: [
              element({ tag: "button", attrs: { "aria-pressed": "true" }, text: "Yes" }),
              element({ tag: "button", attrs: { "aria-pressed": "false" }, text: "No" })
            ]
          })
        )
      ]
    })
  );

const whatsNewParsed = () =>
  makeDocument(element({ children: [element({ tag: "h1", text: "What's new" }), element({ id: "releases" })] }));

const whatsNewSettled = () =>
  makeDocument(
    element({
      children: [
        element({ tag: "h1", text: "What's new" }),
        element({ id: "releases", children: [element({ tag: "section", text: "0.55" })] })
      ]
    })
  );

const SURFACES = [
  ["popup", READINESS.popup, popupParsed, popupSettled],
  ["settings", READINESS.settings, settingsParsed, settingsSettled],
  ["block page", READINESS.block, blockParsed, blockSettled],
  ["diagnostics", READINESS.diagnostics, diagnosticsParsed, diagnosticsSettled],
  ["welcome", READINESS.welcome, welcomeParsed, welcomeSettled],
  ["what's new", READINESS.whatsNew, whatsNewParsed, whatsNewSettled]
];

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

test("no surface is called ready while it is still only parsed", () => {
  const premature = SURFACES.filter(([, conditions, parsed]) => settled(conditions, parsed())).map(([label]) => label);

  assert.deepEqual(
    premature,
    [],
    `${premature.join(", ")}: the readiness probe is satisfied by the static markup, so the audit can read the ` +
      "accessibility tree before the page has applied its state and report defects that do not exist"
  );
});

test("every surface is ready once its state has been applied", () => {
  SURFACES.forEach(([label, conditions, , ready]) => {
    const doc = ready();

    assert.deepEqual(
      unmet(conditions, doc),
      [],
      `${label}: a fully rendered page is not recognised as ready — the audit would time out on a page that is fine`
    );
  });
});

test("the popup is held back by the exact three things that were flaking", () => {
  // Named individually because these are the three reported failures, and a
  // probe that happened to be strict for some other reason would not prevent
  // them coming back.
  const conditions = READINESS.popup;

  const emptyStatus = makeDocument(
    element({
      children: [
        element({ id: "status" }),
        slider("timerSlider", "60 seconds"),
        slider("passDurationSlider", "5 minutes")
      ]
    })
  );

  assert.ok(
    !settled(conditions, emptyStatus),
    "an empty #status is what made aria-describedby resolve to nothing — the audit must wait for it"
  );

  const oneBareSlider = makeDocument(
    element({
      children: [
        element({ id: "status", text: "FitShield is on." }),
        slider("timerSlider", "60 seconds"),
        slider("passDurationSlider", null)
      ]
    })
  );

  assert.ok(
    !settled(conditions, oneBareSlider),
    "one slider still without aria-valuetext is one bare-number failure — waiting for the other is not enough"
  );
});

test("a readiness failure names the condition that never came true", () => {
  // The old probe threw "popup.html never became ready (url | title | complete)",
  // which sends the next person to look at the wrong thing entirely.
  const labels = unmet(READINESS.popup, popupParsed());

  assert.ok(labels.length > 0, "the parsed popup must report at least one unmet condition");
  labels.forEach((label) => {
    assert.match(label, /\S/, "every condition carries a human-readable label");
  });
  assert.ok(
    labels.some((l) => /status/.test(l)) && labels.some((l) => /valuetext/i.test(l)),
    `the diagnosis must name #status and the sliders, got: ${labels.join("; ")}`
  );
});

// ---------------------------------------------------------------------------
// Putting back what the audit borrowed
// ---------------------------------------------------------------------------
//
// auditCountdown shortens `timerSeconds` to 12 to watch the milestones arrive in
// real time. That value lives in the profile EVERY extension page in the browser
// shares. The restore was two `try {} catch {}` blocks; its own comment said
// that leaving 12 behind "made the popup report slider and status defects that
// were artefacts of this audit", so the guard documented the damage it existed
// to prevent and then swallowed its own failure. It also wrote a hardcoded 60 —
// the default, not necessarily what was there.

// A chrome.storage.local good enough to run the real expressions against, plus
// enough of a document that openPage's own readiness check can pass — the
// recovery path opens a real page and waits for it like any other.
const recoveryDocument = () =>
  makeDocument(element({ children: [element({ tag: "div", id: "timer", text: "60" })] }));

function stubPage(store, opts = {}) {
  const chrome = {
    storage: {
      local: {
        get(key, cb) {
          cb({ [key]: store[key] });
        },
        set(obj, cb) {
          if (!opts.readOnly) {
            Object.assign(store, obj);
          }
          cb();
        },
        remove(key, cb) {
          if (!opts.readOnly) {
            delete store[key];
          }
          cb();
        }
      }
    }
  };

  const doc = recoveryDocument();

  return {
    closed: false,
    async evaluate(expression) {
      if (opts.dead) {
        throw new Error("Inspected target navigated or closed");
      }
      // eslint-disable-next-line no-new-func
      return new Function("chrome", "document", `return (${expression});`)(chrome, doc);
    },
    async send() {},
    async goto() {},
    async close() {
      this.closed = true;
    }
  };
}

function stubReporter() {
  const failures = [];
  return { failures, fail: (m) => failures.push(m), warn: () => {}, note: () => {} };
}

test("the restore puts back the value that was there, not a hardcoded default", async () => {
  const store = { timerSeconds: 45 };
  const tab = stubPage(store);
  const reporter = stubReporter();

  // What auditCountdown does: read, borrow, restore.
  const previous = JSON.parse(await tab.evaluate(READ_TIMER_SECONDS));
  assert.equal(previous, 45);

  store.timerSeconds = 12;
  await restoreTimerSeconds({}, "id", tab, previous, reporter);

  assert.equal(store.timerSeconds, 45, "a user with a 45-second pause must still have one after the audit runs");
  assert.deepEqual(reporter.failures, []);
});

test("a pause the user never set is removed again, not invented", async () => {
  const store = {};
  const tab = stubPage(store);
  const reporter = stubReporter();

  const previous = JSON.parse(await tab.evaluate(READ_TIMER_SECONDS));
  assert.equal(previous, null, "an unset key reads back as null, not as the default");

  store.timerSeconds = 12;
  await restoreTimerSeconds({}, "id", tab, previous, reporter);

  assert.ok(
    !Object.prototype.hasOwnProperty.call(store, "timerSeconds"),
    "the audit must not leave a value behind on a profile that had none — it wrote a hardcoded 60"
  );
  assert.deepEqual(reporter.failures, []);
});

test("a restore that does not land is reported, never swallowed", async () => {
  // The one case the two `try {} catch {}` blocks were written for — a tab on
  // its way out — is the case where they silently did nothing.
  const store = { timerSeconds: 12 };
  const reporter = stubReporter();
  const dead = stubPage(store, { dead: true });

  // ...and the fallback page cannot write either, so there is no way to succeed.
  const browser = { newPage: async () => stubPage(store, { readOnly: true }) };

  await restoreTimerSeconds(browser, "id", dead, 60, reporter);

  assert.equal(reporter.failures.length, 1, "an unrestorable profile must fail the audit, not pass quietly");
  assert.match(reporter.failures[0], /timerSeconds/);
});

test("a dying tab is recovered from, not given up on", async () => {
  const store = { timerSeconds: 12 };
  const reporter = stubReporter();
  const dead = stubPage(store, { dead: true });
  const fresh = stubPage(store);
  const browser = { newPage: async () => fresh };

  await restoreTimerSeconds(browser, "id", dead, 90, reporter);

  assert.equal(store.timerSeconds, 90, "the restore must be retried on a page that still works");
  assert.deepEqual(reporter.failures, []);
  assert.equal(fresh.closed, true, "the recovery page is not left open");
});
