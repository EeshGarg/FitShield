"use strict";
/**
 * Edge cases a real browser will eventually produce, driven against the real
 * worker: a first install, an update, a profile written by a newer FitShield, a
 * profile that is corrupt, an asset that will not load, and a locale that is
 * missing.
 *
 * The property that matters most here is the DIRECTION of failure. FitShield is
 * a blocker: when something goes wrong it must keep blocking (fail closed) and
 * never quietly unblock everything (fail open). A user who installed a blocker
 * and got no blocking has been failed in a way a crash would not have hidden.
 * Several tests below assert exactly that, and would pass just as happily if the
 * code threw — throwing is the acceptable outcome; silently clearing the rules
 * is not.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../extension/fitshield-core.js");
const { loadBackground } = require("./helpers/background-harness.js");

const SCHEMA_KEY = core.SCHEMA_KEY;
const SCHEMA_VERSION = core.SCHEMA_VERSION;

const hasRules = (bg) => bg.rules().length > 0;

// ---------------------------------------------------------------------------
// Corrupt / hostile storage
// ---------------------------------------------------------------------------

// A profile can be damaged by a half-finished write, a sync conflict, or an old
// bug. None of those may turn the blocker off.
const CORRUPT_PROFILES = [
  ["a string where the object should be", "not-an-object"],
  ["an array where the object should be", []],
  ["schedule replaced by a string", { schedule: "evenings" }],
  ["passes replaced by an object", { passes: { a: 1 } }],
  ["stats replaced by an array", { stats: [] }],
  ["every known key nulled", {
    enabled: null, timerSeconds: null, schedule: null, passes: null, stats: null,
    pantry: null, equipment: null, customSites: null, disabledDeliverySiteKeys: null
  }],
  ["nested junk inside schedule", {
    schedule: { mode: {}, windows: [{ days: {}, start: [], end: null }], until: "soon" }
  }],
  ["non-finite numbers", { timerSeconds: NaN, passDurationMinutes: Infinity, repeatExtraSeconds: -Infinity }]
];

CORRUPT_PROFILES.forEach(([label, profile]) => {
  test(`corrupt storage (${label}) still produces a usable, blocking profile`, () => {
    const settings = core.readSettings(profile);

    assert.equal(typeof settings.timerSeconds, "number");
    assert.ok(Number.isFinite(settings.timerSeconds), "timer must be a real number");
    assert.ok(settings.timerSeconds >= core.MIN_TIMER_SECONDS);
    assert.ok(Array.isArray(settings.passes));
    assert.ok(Array.isArray(settings.equipment));
    assert.equal(typeof settings.stats, "object");

    // The blocker stays on: a damaged profile must not read as "user disabled it".
    assert.equal(settings.enabled, true, "corrupt storage must not disable blocking");
    assert.equal(core.evaluateSchedule(settings.schedule).active, true, "corrupt schedule must not close the window");
    assert.deepEqual(core.activePasses(settings.passes), [], "corrupt passes must not grant access");
  });
});

test("a corrupt profile still builds real blocking rules in the worker", async () => {
  const bg = loadBackground({ schedule: "evenings", passes: { nope: true }, timerSeconds: NaN });
  await bg.context.queueRefreshBlockingState();

  assert.ok(hasRules(bg), "a damaged profile must not clear the rule set");
});

test("an unreadable profile leaves existing rules in place rather than clearing them", async () => {
  let failReads = false;
  const bg = loadBackground({}, {
    onStorageGet: () => {
      if (failReads) throw new Error("storage is unavailable");
    }
  });

  await bg.context.queueRefreshBlockingState();
  const healthy = bg.rules().length;
  assert.ok(healthy > 0);

  // Now the profile becomes unreadable and something triggers a refresh.
  failReads = true;
  await bg.context.queueRefreshBlockingState().catch(() => {});

  assert.equal(bg.rules().length, healthy, "a failed storage read must not unblock anything");
});

// ---------------------------------------------------------------------------
// Missing / corrupt assets
// ---------------------------------------------------------------------------

test("a blocklist that fails to load leaves existing rules in place", async () => {
  let failFetch = false;
  const bg = loadBackground({}, {
    onFetch: (rel) => {
      if (failFetch && rel.startsWith("blocklists/")) throw new Error(`missing asset: ${rel}`);
    }
  });

  await bg.context.queueRefreshBlockingState();
  const healthy = bg.rules().length;
  assert.ok(healthy > 0);

  // Force a genuine reload attempt: without this the lists are already cached
  // and the fetch stub would never be consulted, so the test would prove nothing.
  failFetch = true;
  bg.evalIn("blocklistsLoaded = false; blocklistLoadPromise = null;");
  await bg.context.queueRefreshBlockingState().catch(() => {});

  assert.equal(bg.rules().length, healthy, "a failed asset load must not unblock anything");
});

test("a blocklist load failure is retried rather than cached as empty", async () => {
  let failFetch = true;
  const bg = loadBackground({}, {
    onFetch: (rel) => {
      if (failFetch && rel.startsWith("blocklists/")) throw new Error("transient");
    }
  });

  await bg.context.queueRefreshBlockingState().catch(() => {});
  assert.equal(bg.rules().length, 0, "nothing could load on the first attempt");

  // The next wake-up must try again — a transient failure during a browser
  // update must not leave blocking off until the user reinstalls.
  failFetch = false;
  await bg.context.queueRefreshBlockingState();
  assert.ok(hasRules(bg), "the worker must retry a failed blocklist load");
});

test("a corrupt blocklist file is a load failure, not a silently empty list", async () => {
  const bg = loadBackground({}, {
    onFetch: (rel) => (rel.startsWith("blocklists/") ? "{ this is not json" : undefined)
  });

  await bg.context.queueRefreshBlockingState().catch(() => {});

  assert.equal(bg.rules().length, 0);
  assert.equal(bg.evalIn("blocklistsLoaded"), false, "corrupt JSON must not mark the lists as loaded");
});

// ---------------------------------------------------------------------------
// Install and update
// ---------------------------------------------------------------------------

test("a fresh install stamps the schema, opens onboarding, and blocks immediately", async () => {
  const bg = loadBackground({});
  await bg.listeners.installed({ reason: "install" });

  assert.equal(bg.store[SCHEMA_KEY], SCHEMA_VERSION, "schema stamped on install");
  assert.equal(bg.store.lastSeenVersion, "0.55", "install records the version it onboarded at");
  assert.ok(hasRules(bg), "a new user is protected before they open anything");

  const opened = bg.createdTabs().map((t) => String(t && t.url));
  assert.ok(opened.some((url) => url.includes("welcome.html")), `expected onboarding, opened: ${opened}`);
});

test("an update to an already-seen version does not reopen the what's-new page", async () => {
  const bg = loadBackground({ [SCHEMA_KEY]: SCHEMA_VERSION, lastSeenVersion: "0.55" });
  await bg.listeners.installed({ reason: "update" });

  const opened = bg.createdTabs().map((t) => String(t && t.url));
  assert.ok(!opened.some((url) => url.includes("whats-new.html")), `nothing should reopen, opened: ${opened}`);
  assert.ok(!opened.some((url) => url.includes("welcome.html")), "an update is never onboarding");
});

test("an update from an older version shows what's new exactly once", async () => {
  const bg = loadBackground({ [SCHEMA_KEY]: SCHEMA_VERSION, lastSeenVersion: "0.40" });

  await bg.listeners.installed({ reason: "update" });
  const first = bg.createdTabs().filter((t) => String(t && t.url).includes("whats-new.html")).length;
  assert.equal(first, 1, "the release note is shown after an upgrade");
  assert.equal(bg.store.lastSeenVersion, "0.55");

  // A second onInstalled (worker restart, Chrome replaying the event) must not
  // reopen it.
  await bg.listeners.installed({ reason: "update" });
  const total = bg.createdTabs().filter((t) => String(t && t.url).includes("whats-new.html")).length;
  assert.equal(total, 1, "the release note must not reappear on every worker wake-up");
});

test("an update migrates a legacy profile without losing the user's settings", async () => {
  const bg = loadBackground({ timerSeconds: 30, customSites: [{ domain: "example.com" }], blockedCount: 12 });

  await bg.listeners.installed({ reason: "update" });

  assert.equal(bg.store[SCHEMA_KEY], SCHEMA_VERSION, "an update brings the schema forward");
  assert.equal(bg.store.timerSeconds, 30, "the user's chosen timer survives the migration");
  assert.ok(hasRules(bg), "blocking resumes straight after an update");
});

test("a profile from a NEWER FitShield is left intact, not downgraded", async () => {
  const future = {
    [SCHEMA_KEY]: SCHEMA_VERSION + 5,
    timerSeconds: 45,
    somethingAddedLater: { keep: "me" }
  };
  const bg = loadBackground(future);

  await bg.listeners.installed({ reason: "update" });

  assert.equal(bg.store[SCHEMA_KEY], SCHEMA_VERSION + 5, "a newer schema must not be stamped backwards");
  assert.deepEqual(bg.store.somethingAddedLater, { keep: "me" }, "unknown future keys survive a downgrade");
  assert.equal(core.readSettings(bg.store).timerSeconds, 45, "the newer profile is still readable");
  assert.ok(hasRules(bg), "a downgraded install still blocks");
});

test("a migration that throws leaves the profile untouched and keeps blocking", async () => {
  const bg = loadBackground({ timerSeconds: 30 });

  // Break a migration step the way a genuine bug would.
  bg.context.FitShieldCore.migrateState = () => ({
    state: {}, from: 1, to: 1, changed: false, notes: [], error: "boom"
  });

  await bg.context.queueRefreshBlockingState();

  assert.equal(bg.store.timerSeconds, 30, "a failed migration must not rewrite the profile");
  assert.ok(hasRules(bg), "a failed migration must not disable blocking");
});

// ---------------------------------------------------------------------------
// Schema round-trip through export/import
// ---------------------------------------------------------------------------

test("a backup file carrying a corrupt profile imports as a clean, blocking profile", () => {
  const backup = require("../extension/backup.js");

  // Someone exported while their profile was already damaged, so the damage is
  // inside the backup file itself. Restoring it must repair, not propagate.
  const file = JSON.stringify({
    _type: backup.BACKUP_TYPE,
    schema: backup.SCHEMA_VERSION,
    settings: { schedule: "evenings", passes: "none", timerSeconds: NaN, enabled: null }
  });

  const settings = backup.normalizeImported(backup.extractSettings(backup.parseBackup(file)));

  assert.equal(settings.enabled, true, "a damaged backup must not import as 'blocking off'");
  assert.ok(Number.isFinite(settings.timerSeconds));
  assert.equal(core.evaluateSchedule(settings.schedule).active, true);
  assert.deepEqual(core.activePasses(settings.passes), []);
});

// ---------------------------------------------------------------------------
// Locale fallback
// ---------------------------------------------------------------------------

test("every locale falls back to English for a key it has not translated", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "extension", "_locales");
  const en = JSON.parse(fs.readFileSync(path.join(dir, "en", "messages.json"), "utf8"));

  fs.readdirSync(dir).forEach((locale) => {
    const messages = JSON.parse(fs.readFileSync(path.join(dir, locale, "messages.json"), "utf8"));

    // A partial translation is expected and fine. What is NOT fine is a key that
    // exists but is empty: chrome.i18n returns "" for it instead of falling back,
    // so the user sees a blank control rather than English.
    Object.entries(messages).forEach(([key, entry]) => {
      const value = entry && typeof entry.message === "string" ? entry.message : "";
      assert.notEqual(value.trim(), "", `${locale}/${key} is present but empty — it will render blank, not fall back`);
      assert.ok(en[key], `${locale}/${key} has no English original to fall back to`);
    });
  });
});
