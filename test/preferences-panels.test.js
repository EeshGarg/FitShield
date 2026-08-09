"use strict";
/**
 * Behavioural tests for the Settings preference panels, driven by EXECUTING
 * extension/preferences.js rather than reading it.
 *
 * Three findings are pinned here, each of which a source-text grep would have
 * declared fixed while the screen still misbehaved:
 *
 *   F038  "Add a window" accepted a click at the 24-window cap, the list did not
 *         grow, and nothing said why. `normalizeSchedule` truncates silently, so
 *         the control was dead but looked available.
 *   F032  "Your stats" re-rendered on chrome.storage.onChanged and the "This
 *         week" panel on the same page did not, so with Settings open in one
 *         window and a site interrupted in another the top card ticked up while
 *         the panel below it stayed frozen until a reload.
 *   F027  "Times you continued" and "Temporary passes used" are ONE event under
 *   F069  two names — grantPass is the only writer of either and writes both,
 *         back to back — so printing them side by side invites a conclusion
 *         drawn from an agreement that is guaranteed by construction.
 *
 * The DOM stub below is deliberately tiny and hand-written: this project ships
 * with zero dependencies and that includes its test harnesses. It implements
 * only what these panels touch, and every section whose ids it does NOT provide
 * short-circuits through preferences.js's own `has()` guard.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const core = require("../extension/fitshield-core.js");

const PREFERENCES = fs.readFileSync(path.join(__dirname, "..", "extension", "preferences.js"), "utf8");
const EN = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "extension", "_locales", "en", "messages.json"), "utf8")
);

// ---------------------------------------------------------------------------
// A DOM small enough to read and real enough to render into
// ---------------------------------------------------------------------------

function makeElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    className: "",
    id: "",
    type: "",
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    _text: "",

    get textContent() {
      return this.children.length > 0
        ? this._text + this.children.map((child) => child.textContent).join("")
        : this._text;
    },
    set textContent(value) {
      this.children = [];
      this._text = String(value);
    },

    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...nodes) {
      nodes.forEach((n) => this.children.push(typeof n === "string" ? makeText(n) : n));
    },
    replaceChildren(...nodes) {
      this.children = [];
      this._text = "";
      nodes.forEach((n) => this.children.push(typeof n === "string" ? makeText(n) : n));
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    focus() {},
    click() {
      (this.listeners.click || []).forEach((fn) => fn({ target: this }));
    },
    // Depth-first search over the rendered tree, for assertions.
    find(predicate) {
      for (const child of this.children) {
        if (predicate(child)) {
          return child;
        }
        const deeper = child.find ? child.find(predicate) : null;
        if (deeper) {
          return deeper;
        }
      }
      return null;
    },
    all(predicate, out = []) {
      this.children.forEach((child) => {
        if (predicate(child)) {
          out.push(child);
        }
        if (child.all) {
          child.all(predicate, out);
        }
      });
      return out;
    }
  };

  return node;
}

function makeText(value) {
  return { tagName: "#text", children: [], textContent: String(value), find: () => null, all: (p, out = []) => out };
}

// Only the ids the panels under test need. Everything else resolves to null, so
// preferences.js's `has()` guard skips that section entirely.
const PANEL_IDS = [
  "schedulePresets",
  "scheduleStatus",
  "clearScheduleOverride",
  "scheduleWindows",
  "addScheduleWindow",
  "blockUntilTomorrow",
  "recapBody",
  "recapEnabled"
];

function makeStorage(initial) {
  const data = { ...initial };
  const listeners = [];

  return {
    data,
    listeners,
    api: {
      local: {
        get(keys) {
          if (keys === null || keys === undefined) {
            return Promise.resolve({ ...data });
          }
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          list.forEach((key) => {
            if (key in data) {
              out[key] = data[key];
            }
          });
          return Promise.resolve(out);
        },
        set(partial) {
          const changes = {};
          Object.entries(partial).forEach(([key, value]) => {
            changes[key] = { oldValue: data[key], newValue: value };
            data[key] = value;
          });
          listeners.forEach((fn) => fn(changes, "local"));
          return Promise.resolve();
        },
        remove() {
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener(fn) {
          listeners.push(fn);
        }
      }
    }
  };
}

/** Boot preferences.js against a stub DOM and return handles for assertions. */
async function bootPreferences(initialStore = {}) {
  const elements = new Map();
  PANEL_IDS.forEach((id) => {
    const node = makeElement(id === "recapEnabled" ? "input" : "div");
    node.id = id;
    elements.set(id, node);
  });

  const storage = makeStorage(initialStore);

  const document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeElement(tag),
    createTextNode: (value) => makeText(value),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };

  const sandbox = {
    document,
    console: { error() {}, warn() {}, log() {} },
    chrome: {
      storage: storage.api,
      runtime: { getURL: (p) => `chrome-extension://test/${p}`, sendMessage: () => Promise.resolve({ ok: true }) }
    },
    FitShieldCore: core,
    FitShieldI18n: {
      // The real English strings, with the real substitution, so an assertion
      // about a LABEL is an assertion about what the customer reads.
      t(key, subs) {
        const entry = EN[key];
        if (!entry) {
          return key;
        }
        return String(entry.message).replace(/\$(\d)/g, (_, n) => String((subs || [])[Number(n) - 1] ?? ""));
      },
      ready: Promise.resolve(),
      onChange() {}
    },
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    URL,
    URLSearchParams
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(PREFERENCES, sandbox, { filename: "preferences.js" });

  // The IIFE boots off `FitShieldI18n.ready.then(initialize)`; let that settle.
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }

  return { el: (id) => elements.get(id), storage, sandbox };
}

const settled = async () => {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
};

const windowsOf = (count) =>
  Array.from({ length: count }, (_, i) => ({ days: [1], start: "18:00", end: i % 2 === 0 ? "19:00" : "20:00" }));

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

const activeStats = (overrides) => {
  const totals = {
    interruptions: 9,
    left: 4,
    continued: 5,
    passesUsed: 5,
    alternativesViewed: 7,
    alternativesSelected: 3,
    alternativesMade: 1,
    ...overrides
  };
  return { totals, history: [{ day: todayKey(), ...totals }] };
};

// ---------------------------------------------------------------------------
// F038 — the schedule window cap
// ---------------------------------------------------------------------------

test("Add a window is available below the cap", async () => {
  const { el } = await bootPreferences({
    schedule: { mode: "windows", windows: windowsOf(core.MAX_WINDOWS - 1), until: null }
  });

  const button = el("addScheduleWindow");
  assert.equal(button.disabled, false, "the control must stay usable while there is room");
  assert.equal(button.getAttribute("aria-disabled"), "false");
});

test("Add a window stops accepting clicks it cannot honour at the cap", async () => {
  const { el, storage } = await bootPreferences({
    schedule: { mode: "windows", windows: windowsOf(core.MAX_WINDOWS), until: null }
  });

  const button = el("addScheduleWindow");

  assert.equal(
    button.disabled,
    true,
    `at ${core.MAX_WINDOWS} windows the click is silently discarded by normalizeSchedule — the control must not look available`
  );
  assert.equal(button.getAttribute("aria-disabled"), "true", "and assistive technology must be told the same thing");

  // Belt and braces: even a stale render must not be able to submit a list the
  // core will truncate. Firing the handler directly is what a stale render does.
  const before = JSON.stringify(storage.data.schedule.windows);
  button.click();
  await settled();

  assert.equal(
    storage.data.schedule.windows.length,
    core.MAX_WINDOWS,
    "a click past the cap must not rewrite the schedule at all"
  );
  assert.equal(JSON.stringify(storage.data.schedule.windows), before, "and must not reorder or truncate what is there");
});

test("removing a window makes Add a window available again", async () => {
  const { el, storage } = await bootPreferences({
    schedule: { mode: "windows", windows: windowsOf(core.MAX_WINDOWS), until: null }
  });

  assert.equal(el("addScheduleWindow").disabled, true);

  const removeLabel = EN.removeButton.message;
  const remove = el("scheduleWindows").find((node) => node.textContent === removeLabel);
  assert.ok(remove, "each window row must offer a Remove control");
  remove.click();
  await settled();

  assert.equal(storage.data.schedule.windows.length, core.MAX_WINDOWS - 1);
  assert.equal(el("addScheduleWindow").disabled, false, "the control must come back once there is room");
});

// ---------------------------------------------------------------------------
// F027 / F069 — one event, one figure
// ---------------------------------------------------------------------------

test("the This week panel does not print one event under two names", async () => {
  const { el } = await bootPreferences({ recapEnabled: true, stats: activeStats() });

  const body = el("recapBody").textContent;

  assert.ok(body.includes(EN.recapContinued.message), "the continue count is the honest one to show");
  assert.ok(
    !body.includes(EN.recapPasses.message),
    `"${EN.recapContinued.message}" and "${EN.recapPasses.message}" are written back to back by grantPass and can ` +
      `never differ; showing both invites a conclusion drawn from a guaranteed agreement.\nRendered: ${body}`
  );
});

test("the This week panel prints no lifetime figure and no raw identifier", async () => {
  const { el } = await bootPreferences({
    recapEnabled: true,
    stats: activeStats(),
    // A lifetime map with an obvious winner. It belongs to Settings' all-time
    // "Most blocked categories" list, not to a panel headed "This week".
    blockedByCategory: { fast_casual: 999 }
  });

  const body = el("recapBody").textContent;

  assert.ok(!body.includes("fast_casual"), `a raw storage key reached the panel: ${body}`);
  assert.ok(!/_/.test(body), `an internal identifier leaked into the panel: ${body}`);

  // The label itself has been retired from the base locale. If it ever comes
  // back, it must not come back into THIS panel: a lifetime figure cannot be
  // reconciled with the six around it, all of which are seven-day counts.
  if (EN.recapTopCategory) {
    assert.ok(
      !body.includes(EN.recapTopCategory.message),
      `a lifetime figure is printed inside a seven-day panel: ${body}`
    );
  }
  // And the figure cannot be resurrected by the panel passing the lifetime map
  // back in: the recap takes no options and reports seven days only.
  const recap = core.weeklyRecap(activeStats(), Date.now(), { blockedByCategory: { fast_casual: 999 } });
  assert.ok(!("topCategory" in recap), "weeklyRecap still hands a lifetime figure to a seven-day panel");
  assert.deepEqual(Object.keys(recap).sort(), ["from", "hasActivity", "to", "totals"]);
});

test("the recap still reports every figure it does claim", async () => {
  const { el } = await bootPreferences({ recapEnabled: true, stats: activeStats() });

  const body = el("recapBody").textContent;

  [
    [EN.recapInterrupted.message, "9"],
    [EN.recapLeft.message, "4"],
    [EN.recapContinued.message, "5"],
    [EN.recapSelected.message, "3"],
    [EN.recapMade.message, "1"]
  ].forEach(([label, value]) => {
    assert.ok(body.includes(label), `"${label}" is missing from the recap`);
    assert.ok(body.includes(`${label}${value}`), `"${label}" does not carry its count (${value}) — got: ${body}`);
  });
});

// ---------------------------------------------------------------------------
// F032 — the two panels on one page must not disagree
// ---------------------------------------------------------------------------

test("the This week panel re-renders when stats change while the page is open", async () => {
  const { el, storage } = await bootPreferences({ recapEnabled: true, stats: { totals: {}, history: [] } });

  const before = el("recapBody").textContent;
  assert.ok(before.includes(EN.recapNoActivity.message), `expected the empty state first, got: ${before}`);

  // Exactly what the worker does when a site is interrupted in another window.
  await storage.api.local.set({ stats: activeStats() });
  await settled();

  const after = el("recapBody").textContent;
  assert.notEqual(
    after,
    before,
    "the panel stayed frozen while the stats card above it ticked up — two panels, one stats object, different numbers on one screen"
  );
  assert.ok(after.includes(EN.recapInterrupted.message), `the refreshed panel should carry the figures: ${after}`);
  assert.ok(after.includes("9"), `the refreshed panel should carry the new counts: ${after}`);
});

test("a change to an unrelated key does not churn the recap", async () => {
  const { el, storage } = await bootPreferences({ recapEnabled: true, stats: activeStats() });

  const before = el("recapBody").textContent;
  await storage.api.local.set({ theme: { bg: "#000" } });
  await settled();

  assert.equal(el("recapBody").textContent, before, "only the keys the recap is made of may re-render it");
});

test("switching the recap off is honoured live", async () => {
  const { el, storage } = await bootPreferences({ recapEnabled: true, stats: activeStats() });

  assert.ok(el("recapBody").textContent.includes(EN.recapInterrupted.message));

  await storage.api.local.set({ recapEnabled: false });
  await settled();

  assert.ok(
    el("recapBody").textContent.includes(EN.recapHidden.message),
    `hiding the recap elsewhere must take effect here too: ${el("recapBody").textContent}`
  );
});

// ---------------------------------------------------------------------------
// F004 — copying a day is additive, proved through the rendered control
// ---------------------------------------------------------------------------

test("the Copy to every day control adds the window instead of deleting the others", async () => {
  const { el, storage } = await bootPreferences({
    schedule: {
      mode: "windows",
      windows: [
        { days: [1, 2, 3, 4, 5], start: "11:00", end: "14:00" },
        { days: [0, 6], start: "22:00", end: "23:30" }
      ],
      until: null
    }
  });

  const copy = el("scheduleWindows").find((node) => node.textContent === EN.scheduleCopyToAll.message);
  assert.ok(copy, "each window row must offer the copy control");
  copy.click();
  await settled();

  const windows = storage.data.schedule.windows;
  assert.equal(windows.length, 2, `a window was destroyed: ${JSON.stringify(windows)}`);

  const weekend = windows.find((w) => w.start === "22:00");
  assert.ok(weekend, `the weekend window is gone: ${JSON.stringify(windows)}`);
  assert.deepEqual(weekend.days, [0, 6], "the weekend window must keep its own days");

  const lunch = windows.find((w) => w.start === "11:00");
  assert.deepEqual(lunch.days, [0, 1, 2, 3, 4, 5, 6], "the copied window should now cover every day");
});
