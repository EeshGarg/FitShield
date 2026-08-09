"use strict";
/**
 * Settings blocklist regression tests — the "my toggles keep resetting to
 * defaults" and "select-all should move the other three" bugs.
 *
 * Renders the REAL settings page (blocklist.js, blocklist-records.js, i18n.js,
 * currency.js, languages.js, backup.js, browser-shim.js, settings.js,
 * preferences.js) against a compact DOM, with the background worker deliberately
 * NOT answering getBlockState, and asserts:
 *
 *   1. Saved values still display — the blocklist toggles + timer reflect
 *      chrome.storage.local instead of snapping back to unchecked defaults
 *      (the local fallback path in loadBlocklist/buildLocalBlockState).
 *   2. The "All Blocklists" master toggle is indeterminate when the three groups
 *      are mixed, and toggling it moves AND persists all three.
 *
 * No jsdom: a compact DOM sufficient for the settings page lives at the bottom.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const build = require("../build.js");

function srcPath(rel) {
  const candidates = [path.join(ROOT, "extension", rel), path.join(ROOT, "data", rel), path.join(ROOT, rel)];
  return candidates.find((c) => fs.existsSync(c)) || candidates[2];
}

// Render settings.html + its scripts against a seeded storage, with a worker
// that returns `workerResponse` for getBlockState (undefined => fallback path).
function renderSettings(store, workerResponse) {
  const doc = buildDocument(srcPath("settings.html"));

  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.54" }),
      sendMessage: async () => workerResponse
    },
    storage: {
      local: {
        get: async (keys) => {
          // `get(null)` means "the whole profile" in the real API, and that is
          // how preferences.js loads settings. A mock that treated null as a key
          // name returned {} for it, so preferences.js would have rendered the
          // schedule section from defaults instead of from `store`.
          if (keys === null || keys === undefined) { return { ...store }; }
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async () => {},
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    i18n: { getMessage: () => "", getUILanguage: () => "en" }
  };
  const fetchImpl = async (url) => ({
    ok: true, status: 200,
    json: async () => JSON.parse(fs.readFileSync(srcPath(url.replace("chrome-extension://test/", "")), "utf8"))
  });
  const raf = () => 0;
  const win = {
    location: { search: "", href: "", reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    setInterval: () => 0, clearInterval() {}, history: { back() {} },
    requestAnimationFrame: raf, addEventListener() {}, removeEventListener() {}
  };
  const sandbox = {
    chrome, document: doc.document, window: win, fetch: fetchImpl, console,
    URL, URLSearchParams, Math, Date, Number, String, Array, Object, JSON, Promise, Intl,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: raf, cancelAnimationFrame: () => {},
    navigator: { language: "en-US" }, location: win.location, matchMedia: win.matchMedia
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  // The engine ships as the generated bundle; load it first (settings.html loads
  // blocklist.js), then the rest of the page scripts in order.
  vm.runInContext(build.bundleEngine(), ctx, { filename: "blocklist.js" });
  // Mirrors the <script> order in settings.html; fitshield-core.js must load
  // before the files that use it. preferences.js is last, exactly as the page
  // loads it — it owns the friction, schedule, kitchen, alternatives and recap
  // surfaces, and the schedule section is now the ONLY editor for that setting,
  // so leaving it out would render a settings page with no schedule controls.
  for (const f of ["blocklist-records.js", "languages.js", "currency.js", "fitshield-core.js", "backup.js", "browser-shim.js", "i18n.js", "settings.js", "preferences.js"]) {
    vm.runInContext(fs.readFileSync(srcPath(f), "utf8"), ctx, { filename: f });
  }
  // Top-level function declarations in these scripts land on the context's
  // global object, so tests can call the page's own helpers directly.
  doc.globals = sandbox;
  return doc;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test("saved blocklist toggles display when the worker is unavailable (no reset to defaults)", async () => {
  const store = {
    deliverySitesEnabled: false,   // user turned delivery OFF
    fastFoodSitesEnabled: true,
    customSitesEnabled: true,
    timerSeconds: 30,              // user set a 30s timer
    uiLanguage: "en"
  };
  // Worker returns undefined (asleep / not registered) — forces the local rebuild.
  const doc = renderSettings(store, undefined);

  // Wait on a positive render signal (the timer, which differs from the empty
  // default) so we don't read the controls before the async fallback finishes.
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"),
    "the settings page should render the saved timer value from storage");

  assert.equal(doc.getById("deliverySitesEnabled").checked, false,
    "delivery toggle must reflect the SAVED off state, not snap back to the default on");
  assert.equal(doc.getById("fastFoodSitesEnabled").checked, true);
  assert.equal(doc.getById("customSitesEnabled").checked, true);
});

test("the All Blocklists master toggle is indeterminate when the groups are mixed", async () => {
  const store = { deliverySitesEnabled: false, fastFoodSitesEnabled: true, customSitesEnabled: true, uiLanguage: "en" };
  const doc = renderSettings(store, undefined);

  const master = () => doc.getById("allBlocklistsEnabled");
  assert.ok(await waitFor(() => master() && master().indeterminate === true),
    "master toggle must be indeterminate when the three groups are mixed");
  assert.equal(master().checked, false);
});

test("toggling the master All Blocklists switch moves and persists all three groups", async () => {
  const store = { deliverySitesEnabled: false, fastFoodSitesEnabled: false, customSitesEnabled: false, uiLanguage: "en" };
  const doc = renderSettings(store, undefined);

  const master = doc.getById("allBlocklistsEnabled");
  assert.ok(await waitFor(() => master.indeterminate === false && master.checked === false),
    "master starts unchecked when all groups are off");

  // Flip it ON and fire the change handler, as a click would.
  master.checked = true;
  await Promise.all((master._listeners.change || []).map((fn) => fn({})));
  await waitFor(() => store.deliverySitesEnabled === true);

  assert.equal(doc.getById("deliverySitesEnabled").checked, true, "delivery moved on");
  assert.equal(doc.getById("fastFoodSitesEnabled").checked, true, "fast food moved on");
  assert.equal(doc.getById("customSitesEnabled").checked, true, "custom moved on");
  assert.deepEqual(
    [store.deliverySitesEnabled, store.fastFoodSitesEnabled, store.customSitesEnabled],
    [true, true, true],
    "all three group flags were persisted to storage"
  );
  assert.equal(master.indeterminate, false, "master is no longer indeterminate once all are on");
});

// The schedule used to be asked TWICE on this page. A simple start/end pair in
// "Blocking Options" wrote ONLY the flat scheduleEnabled / scheduleStart /
// scheduleEnd keys, while readSettings prefers the structured `schedule` object
// whenever it exists — and after the v1 -> v2 migration it always exists — so
// the flat keys were read by nobody and all three controls were visible and
// inert.
//
// RETARGETED. That duplicate pair has been deleted from settings.html
// (#scheduleEnabled / #scheduleStart / #scheduleEnd no longer exist there), so
// this drives the surface that survived and now owns the setting: the preset
// chips in #schedulePresets and the per-window editor in #scheduleWindows, both
// built by preferences.js. The end assertion is deliberately unchanged, because
// it is the whole point — after using the control,
// core.evaluateSchedule(core.readSettings(store).schedule, t) must really say
// "off" outside the chosen window and "on" inside it. Which widget carried the
// change is an implementation detail; that it reached the object the worker
// consults is not.
test("the Settings schedule controls actually change when blocking is active", async () => {
  const core = require("../extension/fitshield-core.js");

  // A migrated profile: `schedule` is present, so a control that writes only the
  // flat keys changes nothing that is enforced.
  const store = { ...core.migrateState({ timerSeconds: 30 }).state, uiLanguage: "en" };
  assert.equal(store.schedule.mode, "always", "precondition: a migrated profile blocks around the clock");

  const doc = renderSettings(store, undefined);
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"), "settings rendered");

  const presets = doc.getById("schedulePresets");
  assert.ok(await waitFor(() => presets.childElementCount > 0), "the schedule presets should render");
  assert.equal(presets.childElementCount, core.SCHEDULE_PRESET_IDS.length,
    "one chip per preset — if these drift apart the index below stops meaning anything");

  // "Evenings" is 18:00-23:00 every day. Chosen by position and then verified by
  // VALUE below, so a reordered chip list fails loudly instead of silently
  // testing a different preset.
  const evenings = presets.children[core.SCHEDULE_PRESET_IDS.indexOf("evenings")];
  (evenings._listeners.click || []).forEach((fn) => fn({}));
  await waitFor(() => store.schedule && store.schedule.mode === "windows");

  assert.equal(store.schedule.mode, "windows", "the structured schedule — the one that decides — was updated");
  // Round-tripped through JSON: the page writes these objects inside the vm
  // sandbox, so they carry that realm's Object prototype and a strict deep
  // comparison would fail on identical values.
  assert.deepEqual(
    JSON.parse(JSON.stringify(store.schedule.windows)),
    core.normalizeSchedule(core.schedulePresetValues("evenings")).windows,
    "the Evenings chip must store the Evenings window"
  );
  assert.equal(store.scheduleEnabled, true, "the flat mirror is still written, for the popup and older builds");

  // 09:00 Wednesday is outside 18:00-23:00: blocking must now be off.
  const nineAm = new Date(2026, 2, 4, 9, 0, 0);
  const eightPm = new Date(2026, 2, 4, 20, 0, 0);
  const tenPm = new Date(2026, 2, 4, 22, 0, 0);

  assert.equal(core.evaluateSchedule(core.readSettings(store).schedule, nineAm).active, false,
    "outside the chosen window blocking must be off — otherwise the control did nothing");
  assert.equal(core.evaluateSchedule(core.readSettings(store).schedule, eightPm).active, true,
    "inside the chosen window blocking must be on");

  // Now the advanced editor, which is the control the deleted pair was a lossy
  // copy of. Pull the window's end time back to 21:00 and 22:00 must stop being
  // blocked, without touching any flat key.
  const endInput = doc.getById("window-0-end");
  assert.ok(endInput, "the advanced editor should render an end-time input for the stored window");
  assert.equal(endInput.value, "23:00", "the editor shows the window that is actually stored");

  assert.equal(core.evaluateSchedule(core.readSettings(store).schedule, tenPm).active, true,
    "precondition: 22:00 is inside 18:00-23:00");

  endInput.value = "21:00";
  (endInput._listeners.change || []).forEach((fn) => fn({}));
  await waitFor(() => store.schedule.windows[0].end === "21:00");

  assert.equal(store.schedule.windows[0].end, "21:00", "the editor wrote the structured schedule");
  assert.equal(core.evaluateSchedule(core.readSettings(store).schedule, tenPm).active, false,
    "22:00 is now outside the window, so blocking must be off");
  assert.equal(core.evaluateSchedule(core.readSettings(store).schedule, eightPm).active, true,
    "20:00 is still inside it");
});

// ---------------------------------------------------------------------------
// Your Stats
//
// This panel read `blockedVisits` and `caloriesAvoided` for a whole release
// after both keys stopped being written, so it showed zeros to every new
// install while the popup's recap counted correctly. Nothing failed, because
// nothing tested it. These pin it to the live `stats` object.
// ---------------------------------------------------------------------------

test("Your Stats renders the live counters, not the retired ones", async () => {
  const core = require("../extension/fitshield-core.js");

  const store = {
    ...core.migrateState({}).state,
    uiLanguage: "en",
    stats: {
      totals: {
        interruptions: 12,
        left: 7,
        continued: 3,
        passesUsed: 3,
        alternativesViewed: 19,
        alternativesSelected: 5,
        alternativesMade: 2
      },
      history: []
    },
    // The pre-0.55 counters, deliberately set to values nothing should show.
    blockedVisits: 999,
    caloriesAvoided: 888
  };

  const doc = renderSettings(store, undefined);
  const grid = () => doc.getById("protectionStatusGrid");
  assert.ok(await waitFor(() => grid() && grid().childElementCount > 0), "the stats grid renders");

  const text = grid().textContent;

  for (const shown of ["12", "7", "3", "19", "5", "2"]) {
    assert.ok(text.includes(shown), `the grid should show the live total ${shown}`);
  }

  assert.ok(!text.includes("999"), "blockedVisits is retired and must not be displayed");
  assert.ok(!text.includes("888"), "caloriesAvoided is retired and must not be displayed");
});

test("the cost estimate is off by default, and counts only confirmed meals", async () => {
  const core = require("../extension/fitshield-core.js");

  const store = {
    ...core.migrateState({}).state,
    uiLanguage: "en",
    mealStatsCustomized: true,
    avgMealCost: 20,
    currency: "USD",
    stats: {
      totals: { interruptions: 50, left: 40, continued: 10, passesUsed: 10, alternativesViewed: 60, alternativesSelected: 9, alternativesMade: 4 },
      history: []
    }
  };

  const doc = renderSettings(store, undefined);
  const panel = () => doc.getById("estimateSettings");
  assert.ok(await waitFor(() => doc.getById("protectionStatusGrid").childElementCount > 0), "settings rendered");

  assert.equal(core.readSettings(store).showEstimates, false, "precondition: a fresh profile has estimates off");
  assert.equal(panel().hidden, true, "so the estimate is not shown unless asked for");

  const toggle = doc.getById("showEstimates");
  toggle.checked = true;
  await Promise.all((toggle._listeners.change || []).map((fn) => fn({})));
  await waitFor(() => store.showEstimates === true);

  assert.equal(panel().hidden, false, "turning it on reveals the estimate");

  // 4 meals the user CONFIRMED they made, at 20 each. Not 50 interruptions:
  // a blocked page says nothing about whether an order would have happened.
  const value = doc.getById("estimateValue").textContent;
  assert.match(value, /80/, `the estimate should be 4 x 20, got "${value}"`);
  assert.ok(!/1[,.]?000/.test(value), "it must not be derived from interruptions");
});

// Found while writing the test above. The language handler calls refreshStats,
// and on a cold load it can run before initProtectionStatus has read storage —
// at which point `customized` is still its initial false. The seeding branch
// then replaced the user's own meal cost with the locale default AND persisted
// it, so the setting was gone on the next load.
test("a saved meal cost survives the settings page loading", async () => {
  const core = require("../extension/fitshield-core.js");

  const store = {
    ...core.migrateState({}).state,
    uiLanguage: "en",
    mealStatsCustomized: true,
    avgMealCost: 20,
    currency: "USD"
  };

  const doc = renderSettings(store, undefined);
  assert.ok(await waitFor(() => doc.getById("protectionStatusGrid").childElementCount > 0), "settings rendered");

  // Give every boot path — including the language handler — a chance to run.
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(store.avgMealCost, 20, "the stored cost must not be overwritten by the locale default");
  assert.equal(Number(doc.getById("avgMealCost").value), 20, "and the field shows what was saved");
});

test("resetting statistics clears the object the panel actually reads", async () => {
  const source = fs.readFileSync(srcPath("settings.js"), "utf8");

  // PREFERENCE_KEYS named only the pre-0.55 counters, so the button cleared
  // nothing a user could see. Read the list the page really passes to remove().
  const declared = /const PREFERENCE_KEYS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(declared, "PREFERENCE_KEYS should be a literal list");
  // Comments inside the list explain each group and can quote prose, so they
  // are stripped before the entries are read.
  const keys = [...declared[1].replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  assert.ok(keys.includes("stats"), "the live statistics object must be cleared");

  for (const key of ["blockedByDomain", "blockedByCategory", "blockedByCountry"]) {
    assert.ok(keys.includes(key), `the ${key} breakdown must be cleared`);
  }

  assert.ok(keys.includes("alternativeFavorites"), "the live favourites key must be cleared");
  assert.ok(!keys.includes("customAlternatives"), "the user's own alternatives are content, and must survive");
  assert.ok(!keys.includes("pantry") && !keys.includes("equipment"), "the kitchen is a setting, and must survive");

  // Every key it clears must be one the extension actually recognises. backup.js
  // holds the full inventory of storage keys FitShield owns (durable + the ones
  // deliberately not backed up), so a typo or a key retired elsewhere shows up
  // here as "clears something that does not exist".
  const backup = fs.readFileSync(srcPath("backup.js"), "utf8");
  const listed = (name) => {
    const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(backup);
    assert.ok(block, `${name} should be a literal list in backup.js`);
    return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  };

  const known = new Set([...listed("DURABLE_KEYS"), ...listed("EXCLUDED_KEYS")]);
  const unknown = keys.filter((key) => !known.has(key));

  assert.deepEqual(unknown, [], "reset clears keys the extension does not own");
});

// ===========================================================================
// Backup & restore, from the page
//
// Three separate defects lived in this handler:
//   - every import failure was reported as "That file isn't a valid FitShield
//     backup", including a file that IS a valid backup and simply newer;
//   - a failed EXPORT reported the same thing, which is nonsense when no file
//     was chosen and none was written;
//   - import was the one destructive action in Settings with no confirmation,
//     even though it overwrites live settings AND clears an active pass and any
//     unanswered "did you make it?" prompt.
// ===========================================================================

// Drive the page's own file-picker handler with a chosen file's text, and
// answer the confirmation modal the way `answer` says.
async function importFile(doc, store, text, answer = true) {
  const input = doc.getById("importSettingsInput");
  input.files = [{ text: async () => text }];

  const done = Promise.all((input._listeners.change || []).map((fn) => fn({})));

  // The modal is shown synchronously by confirmAction; click through it once it
  // appears. If it never appears, this resolves without clicking and the test
  // that requires it will say so.
  const overlay = doc.getById("confirmOverlay");
  await waitFor(() => overlay.hidden === false, 300);

  if (overlay.hidden === false) {
    const button = doc.getById(answer ? "confirmOk" : "confirmCancel");
    (button._listeners.click || []).forEach((fn) => fn({}));
  }

  await done;
  return doc.getById("backupNotice").textContent;
}

function validBackup(settings) {
  return JSON.stringify({ _type: "fitshield-settings-backup", schema: 2, settings });
}

test("an import states the real reason it failed, not one generic message", async () => {
  const store = { uiLanguage: "en" };
  const doc = renderSettings(store, undefined);
  assert.ok(await waitFor(() => doc.getById("protectionStatusGrid").childElementCount > 0), "settings rendered");

  // A backup written by a NEWER FitShield is a perfectly valid FitShield
  // backup. Telling the user it is not invites them to delete their only copy.
  const newer = await importFile(
    doc,
    store,
    JSON.stringify({ _type: "fitshield-settings-backup", schema: 99, settings: { enabled: true } })
  );

  assert.match(newer, /newer version of FitShield/i, `got "${newer}"`);
  assert.ok(!/isn't a valid FitShield backup/i.test(newer), "a newer backup must not be called invalid");

  const notJson = await importFile(doc, store, "{not json");
  assert.match(notJson, /JSON/i, `got "${notJson}"`);

  const empty = await importFile(doc, store, "");
  assert.match(empty, /empty/i, `got "${empty}"`);

  // Each reason must be its own sentence — the whole defect was one message
  // standing in for all of them.
  assert.equal(new Set([newer, notJson, empty]).size, 3, "three different failures, three different messages");
});

test("nothing is written when a chosen file is refused", async () => {
  const store = { uiLanguage: "en", timerSeconds: 30, passes: [{ id: "keep-me" }] };
  const doc = renderSettings(store, undefined);
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"), "settings rendered");

  await importFile(doc, store, "{not json");

  assert.equal(store.timerSeconds, 30, "a rejected file must not change a setting");
  assert.deepEqual(store.passes, [{ id: "keep-me" }], "and must not clear install-local state");
});

test("an import asks before it overwrites, and says what it will clear", async () => {
  const store = {
    uiLanguage: "en",
    timerSeconds: 30,
    passes: [{ id: "active", expiresAt: Date.now() + 60000 }],
    pendingAlternatives: [{ id: "did-you-make-it" }]
  };
  const doc = renderSettings(store, undefined);
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"), "settings rendered");

  const input = doc.getById("importSettingsInput");
  input.files = [{ text: async () => validBackup({ timerSeconds: 90, enabled: true }) }];

  const done = Promise.all((input._listeners.change || []).map((fn) => fn({})));
  const overlay = doc.getById("confirmOverlay");

  assert.ok(await waitFor(() => overlay.hidden === false, 500), "import must confirm, like every reset on this page");

  const message = doc.getById("confirmMessage").textContent;
  assert.match(message, /pass/i, "the confirmation must say an active pass is cleared");
  assert.ok(/did you make it/i.test(message), "and that unanswered prompts are cleared");

  // Cancel: nothing at all may have happened.
  (doc.getById("confirmCancel")._listeners.click || []).forEach((fn) => fn({}));
  await done;

  assert.equal(store.timerSeconds, 30, "cancelling must not apply the file");
  assert.deepEqual(store.pendingAlternatives, [{ id: "did-you-make-it" }], "and must not clear anything");
  assert.match(doc.getById("backupNotice").textContent, /cancel/i);
});

test("confirming the import applies it and reports the count the FILE carried", async () => {
  const store = { uiLanguage: "en", timerSeconds: 30, passes: [{ id: "active" }] };
  const doc = renderSettings(store, undefined);
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"), "settings rendered");

  // Six settings in the file. The notice used to say seven, because the
  // importer's own schema marker was counted as one of "your settings".
  const notice = await importFile(
    doc,
    store,
    validBackup({
      enabled: true,
      timerSeconds: 90,
      deliverySitesEnabled: true,
      fastFoodSitesEnabled: false,
      theme: { accent: "#7ef0a8" },
      uiLanguage: "de"
    })
  );

  await waitFor(() => store.timerSeconds === 90);

  assert.equal(store.timerSeconds, 90, "the file was applied");
  assert.match(notice, /\b6\b/, `the notice should say six settings, got "${notice}"`);
  assert.ok(!/\b7\b/.test(notice), "and must not count the internal schema marker");
});

test("a failed export does not tell the user their file is invalid", async () => {
  const store = { uiLanguage: "en" };
  const doc = renderSettings(store, undefined);
  assert.ok(await waitFor(() => doc.getById("protectionStatusGrid").childElementCount > 0), "settings rendered");

  // downloadBackup needs Blob and URL.createObjectURL, neither of which exists
  // in this sandbox — so clicking export really does fail here, which is
  // exactly the path being asserted.
  const button = doc.getById("exportSettings");
  await Promise.all((button._listeners.click || []).map((fn) => fn({})));
  await waitFor(() => doc.getById("backupNotice").textContent !== "");

  const notice = doc.getById("backupNotice").textContent;

  assert.notEqual(notice, "", "a failed export has to say something");
  assert.ok(
    !/isn't a valid FitShield backup/i.test(notice),
    `export reported an import error — there is no file at that point. Got "${notice}"`
  );
  assert.ok(!/exportErrorNotice/.test(notice), "and the raw message key must never reach the screen");
});

// ===========================================================================
// The simple schedule summary
//
// "…every day" was appended when scheduleStart === scheduleEnd, which is the
// opposite of what it means: equal times describe a window covering the whole 24
// hours, not a set of days. The flat pair can only ever express ONE window
// across ALL SEVEN days, so whenever it can represent the schedule at all, it is
// by definition every day.
//
// RETARGETED TWICE. The element both tests read — #scheduleSummary — belonged to
// the duplicate simple pair, which finding F007 got deleted from settings.html.
// An intermediate version of these tests kept the coverage by calling
// settings.js's own `describeSimpleSchedule` directly. That function has since
// been deleted too, and rightly: with the markup gone, every DOM lookup it
// depended on returned null, so it composed a sentence that no longer reached a
// screen. A test that calls a function nothing renders passes while the surface
// it claims to protect shows whatever it likes — the exact failure mode this
// suite exists to catch — so the coverage moves off it.
//
// The guarantee is now asserted against the two things that survive and that
// make it true:
//   - core.scheduleToLegacy, the projection that decides whether a schedule can
//     be shown as one start/end pair at all. It is WHY "every day" was
//     unconditional wherever the pair was offered, and it is the rule the old
//     `start === end` condition contradicted.
//   - the day buttons rendered by the advanced editor, the surviving Settings
//     surface that states which days a window runs on. Settings now SHOWS the
//     days instead of asserting them in a sentence, which is what made the
//     sentence safe to delete.
//
// KNOWN, NOT FIXED HERE: extension/popup.js still carries the pre-fix form
// (`scheduleStart === scheduleEnd ? t("everyDaySuffix") : ""`), and its
// `scheduleIsSimple` guard is declared and read but never assigned, so its own
// start/end pair stays enabled over a schedule it cannot express. Another lane
// owns that file this session; both are reported rather than changed here, and
// no assertion below drives popup.js.
// ===========================================================================

// Was "the schedule summary says 'every day' when the window is every day".
test("a schedule that two time inputs can express always runs every day", async () => {
  const core = require("../extension/fitshield-core.js");

  const store = {
    uiLanguage: "en",
    timerSeconds: 30,
    schedule: { mode: "windows", windows: [{ days: core.ALL_DAYS.slice(), start: "18:00", end: "23:00" }], until: null }
  };

  // The rule at its source. A schedule is only offered through the flat pair
  // when it is ONE window across all seven days — and this one's two times
  // differ, which is precisely the case the old `start === end` condition
  // refused to call "every day".
  const legacy = core.scheduleToLegacy(store.schedule);
  assert.equal(legacy.simple, true, "precondition: this schedule is flat-expressible");
  assert.notEqual(legacy.scheduleStart, legacy.scheduleEnd, "…and its two times are not equal");

  core.SCHEDULE_PRESET_IDS.forEach((id) => {
    const schedule = core.normalizeSchedule(core.schedulePresetValues(id));

    if (schedule.mode === "windows" && core.scheduleToLegacy(schedule).simple) {
      assert.deepEqual(schedule.windows[0].days, core.ALL_DAYS,
        `${id} can be shown through the flat pair, so it must run on every day`);
    }
  });

  // Equal times are the other half of the same rule: they describe a window
  // covering the whole 24 hours, and that window still runs on all seven days.
  // So "every day" cannot hinge on the two times matching — it holds either way,
  // which is precisely what the old condition got backwards.
  const allDay = core.normalizeSchedule({
    mode: "windows",
    windows: [{ days: core.ALL_DAYS.slice(), start: "18:00", end: "18:00" }],
    until: null
  });
  const allDayLegacy = core.scheduleToLegacy(allDay);
  assert.equal(allDayLegacy.simple, true, "a 24-hour window is flat-expressible too");
  assert.equal(allDayLegacy.scheduleStart, allDayLegacy.scheduleEnd, "…with its two times equal");
  assert.deepEqual(allDay.windows[0].days, core.ALL_DAYS, "…and it still runs on every day");

  // The surviving Settings surface states the days rather than claiming them in
  // a sentence: seven pressed chips IS "every day", on screen.
  const doc = renderSettings(store, { ok: true, ...core.readSettings(store) });
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"), "settings rendered");

  const groups = doc.getById("scheduleWindows").querySelectorAll(".days");
  assert.equal(groups.length, 1, "one stored window, one day group in the editor");
  assert.deepEqual(pressedDays(groups[0]), core.ALL_DAYS, "the editor shows the window running on all seven days");
  assert.equal(doc.getById("window-0-start").value, "18:00", "and the hours that are stored");
  assert.equal(doc.getById("window-0-end").value, "23:00");
});

// Was "a schedule the two inputs cannot express does not claim to be every day".
test("a schedule two time inputs cannot express is shown in full, not as placeholder hours", async () => {
  const core = require("../extension/fitshield-core.js");

  // "Workday lunch" is weekdays only — the flat pair cannot hold it, so the
  // times it would show are placeholders and any "every day" would be a claim
  // about days that are not blocked.
  const schedule = core.normalizeSchedule(core.schedulePresetValues("workdayLunch"));
  const store = { uiLanguage: "en", timerSeconds: 30, schedule };
  const settings = core.readSettings(store);

  assert.equal(settings.scheduleSimple, false, "precondition: this schedule is not flat-expressible");

  // The hours the flat pair WOULD have shown are the projection's placeholders,
  // not this schedule's. Anything that renders the trio without consulting
  // `scheduleSimple` states hours the user never set — which is why Settings no
  // longer renders the trio anywhere.
  assert.equal(settings.scheduleStart, core.DEFAULT_SCHEDULE_START, "precondition: placeholder start");
  assert.equal(settings.scheduleEnd, core.DEFAULT_SCHEDULE_END, "precondition: placeholder end");
  assert.notEqual(schedule.windows[0].start, settings.scheduleStart, "…which is not the stored window");

  const doc = renderSettings(store, { ok: true, ...settings });
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"), "settings rendered");

  // The readout that DOES describe this schedule must not claim seven days.
  const status = doc.getById("scheduleStatus");
  assert.ok(await waitFor(() => status.textContent !== ""), "the schedule status should render");
  assert.ok(!/every day/i.test(status.textContent), `got "${status.textContent}"`);

  // And the editor states the real days AND the real hours, so the truth is on
  // screen — where the deleted pair could only ever have shown 18:00-23:00 on
  // all seven days, for a schedule that is none of those things.
  const groups = doc.getById("scheduleWindows").querySelectorAll(".days");
  assert.deepEqual(pressedDays(groups[0]), [1, 2, 3, 4, 5], "five weekdays selected, no weekend day");
  assert.equal(doc.getById("window-0-start").value, "11:00", "the editor shows the stored hours, not the placeholder");
  assert.equal(doc.getById("window-0-end").value, "14:00");
});

// FINDING F007's REGRESSION GUARD. The two tests above pin what the surviving
// control says; this one pins that there is only one of it. Nothing else in this
// file fails if a second editable schedule control is added back, and a second
// one is not untidiness: the simple pair wrote the flat trio, the flat trio can
// only describe ONE window across ALL SEVEN days, so a single nudge over the
// "Workday lunch" schedule above would have discarded Monday-to-Friday and
// replaced it with a seven-day window.
//
// Rendered, not grepped. test/accessibility.test.js already greps settings.html
// for these ids; this boots the real page and asks the DOM settings.js actually
// runs against, so it also fails if the ids return by script rather than markup,
// and it fails if the surviving editor is present but never renders.
test("Settings offers exactly one editable schedule control", async () => {
  const core = require("../extension/fitshield-core.js");

  const store = { ...core.migrateState({ timerSeconds: 30 }).state, uiLanguage: "en" };
  const doc = renderSettings(store, undefined);
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "30s"), "settings rendered");

  for (const id of ["scheduleEnabled", "scheduleStart", "scheduleEnd", "scheduleSummary", "simpleScheduleNote"]) {
    assert.equal(
      doc.getById(id),
      null,
      `#${id} is back on the settings page: that is a second editable control for one setting (F007)`
    );
  }

  // …and the one that survived is present AND renders, so this can never be
  // satisfied by deleting both of them.
  const presets = doc.getById("schedulePresets");
  assert.ok(await waitFor(() => presets && presets.childElementCount > 0), "the schedule presets should render");
  assert.equal(
    presets.childElementCount,
    core.SCHEDULE_PRESET_IDS.length,
    "one chip per preset — the surviving control has to be the whole editor"
  );

  for (const id of ["scheduleWindows", "scheduleAdvanced", "addScheduleWindow", "scheduleStatus"]) {
    assert.ok(doc.getById(id), `the surviving schedule editor lost #${id}`);
  }

  assert.notEqual(doc.getById("scheduleStatus").textContent, "", "and it still says what the current schedule is");
});

// Which weekday indices a rendered window's day group has switched on.
function pressedDays(group) {
  return group.children
    .map((button, index) => (button.getAttribute("aria-pressed") === "true" ? index : -1))
    .filter((index) => index >= 0);
}

// ===========================================================================
// Friction profile
//
// Both onboarding and this page print: "You can change any value afterwards —
// doing so simply moves you to Custom." Nothing wrote it.
// ===========================================================================

test("changing the timer moves the stored friction profile to Custom", async () => {
  const core = require("../extension/fitshield-core.js");

  const store = { uiLanguage: "en", ...core.frictionProfileValues("standard") };
  const doc = renderSettings(store, { ok: true, ...core.readSettings(store) });
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "60s"), "settings rendered");

  assert.equal(store.frictionProfile, "standard", "precondition: a fresh profile is Standard");

  const field = doc.getById("timerSeconds");
  field.value = "300";
  await Promise.all((field._listeners.change || []).map((fn) => fn({})));
  await waitFor(() => store.timerSeconds === 300);

  assert.equal(store.timerSeconds, 300);
  assert.equal(store.frictionProfile, "custom", "the label must follow the value, as the page promises");
});

test("setting a value back to a preset's own number restores that preset's name", async () => {
  const core = require("../extension/fitshield-core.js");

  const store = { uiLanguage: "en", ...core.frictionProfileValues("standard"), timerSeconds: 300, frictionProfile: "custom" };
  const doc = renderSettings(store, { ok: true, ...core.readSettings(store) });
  assert.ok(await waitFor(() => doc.getById("timerDisplay").textContent === "300s"), "settings rendered");

  const field = doc.getById("timerSeconds");
  field.value = String(core.FRICTION_PROFILES.standard.timerSeconds);
  await Promise.all((field._listeners.change || []).map((fn) => fn({})));
  await waitFor(() => store.frictionProfile === "standard");

  assert.equal(store.frictionProfile, "standard", "moving back onto a preset must not strand the profile on Custom");
});

// ===========================================================================
// Compact DOM + HTML parser — enough for the settings page scripts. Superset of
// the block-page test's DOM (adds querySelector, input .value, and document
// fragments, which settings.js uses).
// ===========================================================================
const VOID_TAGS = new Set(["meta", "link", "img", "br", "hr", "input"]);

function buildDocument(htmlPath) {
  const parsed = parseHTML(fs.readFileSync(htmlPath, "utf8"));
  const documentElement = new El("html");
  const body = parsed.query("body")[0] || new El("body");
  documentElement.appendChild(body);

  const findById = (id) => {
    let hit = null;
    const walk = (n) => { for (const c of n.children) { if (c instanceof El) { if (!hit && c.attributes.id === id) hit = c; walk(c); } } };
    walk(documentElement);
    return hit;
  };

  const document = {
    documentElement,
    body,
    head: new El("head"),
    currentScript: null,
    addEventListener() {},
    removeEventListener() {},
    getElementById: findById,
    createElement: (t) => new El(t),
    createTextNode: (t) => new TextNode(t),
    createDocumentFragment: () => { const f = new El("#fragment"); f._isFragment = true; return f; },
    querySelector: (sel) => documentElement.query(sel)[0] || null,
    querySelectorAll: (sel) => documentElement.query(sel)
  };
  return { document, getById: findById };
}

class TextNode {
  constructor(t) { this._text = String(t); this.children = []; this.parentNode = null; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this._text = "";
    this._value = undefined;
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.indeterminate = false;
    this._listeners = {};
    const self = this;
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.classList = {
      _get: () => (self.attributes.class || "").split(/\s+/).filter(Boolean),
      add(c) { const s = new Set(this._get()); s.add(c); self.attributes.class = [...s].join(" "); },
      remove(c) { const s = new Set(this._get()); s.delete(c); self.attributes.class = [...s].join(" "); },
      toggle(c, force) { const s = new Set(this._get()); const on = force === undefined ? !s.has(c) : force; if (on) s.add(c); else s.delete(c); self.attributes.class = [...s].join(" "); return on; },
      contains(c) { return this._get().includes(c); }
    };
  }
  get id() { return this.attributes.id || ""; }
  set id(v) { this.attributes.id = v; }
  get className() { return this.attributes.class || ""; }
  set className(v) { this.attributes.class = v; }
  get value() { return this._value !== undefined ? this._value : ""; }
  set value(v) { this._value = String(v); }
  setAttribute(n, v) {
    this.attributes[n] = String(v);
    if (n === "hidden") this.hidden = true;
    if (n.startsWith("data-")) this.dataset[n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
  appendChild(node) {
    if (node && node._isFragment) { [...node.children].forEach((c) => this.appendChild(c)); node.children = []; return node; }
    node.parentNode = this; this.children.push(node); return node;
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(typeof n === "string" ? new TextNode(n) : n)); }
  replaceChildren(...nodes) { this.children = []; this._text = ""; this.append(...nodes); }
  insertBefore(node, ref) { node.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(node); else this.children.splice(i, 0, node); return node; }
  removeAttribute(n) { delete this.attributes[n]; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  // The confirmation modal moves focus to its OK button when it opens; without
  // this every path through confirmAction threw instead of showing the dialog.
  focus() {}
  blur() {}
  get firstChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.filter((c) => c instanceof El).length; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_v) { this.children = []; this._text = ""; }
  get innerHTML() { return ""; }
  querySelector(sel) { return this.query(sel)[0] || null; }
  querySelectorAll(sel) { return this.query(sel); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  query(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    const match = (el, p) => {
      const scoped = p.replace(/^:scope\s*>?\s*/, "");
      const attr = /^\[([a-zA-Z0-9-]+)\]$/.exec(scoped);
      if (attr) return attr[1] in el.attributes;
      const cls = /^\.([a-zA-Z0-9_-]+)$/.exec(scoped);
      if (cls) return el.classList.contains(cls[1]);
      return el.tagName === scoped.toUpperCase();
    };
    const out = [];
    const walk = (node) => { for (const c of node.children) { if (c instanceof El) { if (parts.some((p) => match(c, p))) out.push(c); walk(c); } } };
    walk(this);
    return out;
  }
}

function parseHTML(html) {
  html = html.replace(/<!DOCTYPE[^>]*>/i, "");
  const root = new El("root");
  const stack = [root];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) { i = html.indexOf("-->", i) + 3; continue; }
    if (html[i] === "<") {
      const close = html.indexOf(">", i);
      if (close === -1) break;
      const raw = html.slice(i + 1, close);
      i = close + 1;
      if (raw.startsWith("/")) {
        const name = raw.slice(1).trim().toUpperCase();
        while (stack.length > 1 && stack[stack.length - 1].tagName !== name) stack.pop();
        if (stack.length > 1) stack.pop();
        continue;
      }
      const sp = raw.search(/\s/);
      const tag = (sp === -1 ? raw : raw.slice(0, sp)).replace(/\/$/, "").toLowerCase();
      const el = new El(tag);
      const attrStr = sp === -1 ? "" : raw.slice(sp);
      for (const am of attrStr.matchAll(/([a-zA-Z0-9-]+)(?:="([^"]*)")?/g)) {
        if (am[1]) el.setAttribute(am[1], am[2] === undefined ? "" : am[2]);
      }
      stack[stack.length - 1].appendChild(el);
      if (tag === "style" || tag === "script") { const end = html.indexOf(`</${tag}`, i); if (end !== -1) i = html.indexOf(">", end) + 1; continue; }
      if (!(raw.endsWith("/") || VOID_TAGS.has(tag))) stack.push(el);
    } else {
      const next = html.indexOf("<", i);
      const text = html.slice(i, next === -1 ? html.length : next);
      if (text.trim()) stack[stack.length - 1].appendChild(new TextNode(text));
      i = next === -1 ? html.length : next;
    }
  }
  return root;
}

test("resetting blocking settings clears everything that governs blocking", () => {
  const source = fs.readFileSync(srcPath("settings.js"), "utf8");
  const declared = /const BLOCKING_KEYS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(declared, "BLOCKING_KEYS should be a literal list");

  const keys = [...declared[1].replace(/\/\/[^\n]*/g, "").matchAll(/\"([^\"]+)\"/g)].map((m) => m[1]);

  // Each of these was missing, so "Reset blocking settings" left the thing it
  // named still in force: an active pass kept a site unblocked, the structured
  // schedule kept enforcing hours, and Settings showed "Strict" over freshly
  // defaulted Standard values.
  ["passes", "schedule", "frictionProfile"].forEach((key) => {
    assert.ok(keys.includes(key), `${key} governs blocking and must be cleared`);
  });

  // …and it must still not touch things it does not name.
  ["stats", "customAlternatives", "pantry", "equipment", "theme"].forEach((key) => {
    assert.ok(!keys.includes(key), `${key} is not a blocking setting and must survive`);
  });

  // Every key it clears must be one the extension actually owns. This is the
  // same drift check the statistics reset already had, and it is what catches a
  // retired key left behind: `settingsDelaySeconds` was written by the Strict
  // profile, documented, and unit-tested, while nothing read it. It has been
  // removed from the runtime, and this fails if a list still names it.
  const backupSource = fs.readFileSync(srcPath("backup.js"), "utf8");
  const listed = (name) => {
    const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(backupSource);
    assert.ok(block, `${name} should be a literal list in backup.js`);
    return [...block[1].replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  };

  const known = new Set([...listed("DURABLE_KEYS"), ...listed("EXCLUDED_KEYS")]);

  assert.deepEqual(
    keys.filter((key) => !known.has(key)),
    [],
    "reset blocking clears keys the extension does not own"
  );
  assert.ok(!known.has("settingsDelaySeconds"), "a retired key must not come back through a backup either");
});
