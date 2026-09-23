"use strict";
/**
 * Temporary-pass and repeat-access-friction tests.
 *
 * The properties that matter here are all about expiry being trustworthy: a pass
 * must not survive a browser restart, a suspended service worker, a long system
 * sleep, a clock change, or an extension update beyond the time it was granted
 * for. Every one of those reduces to the same thing in code — expiry is an
 * absolute timestamp re-checked on every read — so each is tested by reading the
 * same stored records at a later `now`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../extension/fitshield-core.js");

const T0 = new Date(2026, 2, 4, 20, 0, 0, 0).getTime();
const minutes = (n) => n * 60 * 1000;

test("every pass preset produces a valid, absolutely-timed record", () => {
  core.PASS_PRESET_IDS.forEach((presetId) => {
    const pass = core.createPass({ presetId, target: "doordash.com", tabId: 7, now: T0 });

    assert.ok(core.PASS_SCOPES.includes(pass.scope), `${presetId} has a known scope`);
    assert.ok(pass.expiresAt > T0, `${presetId} expires in the future`);
    assert.equal(pass.createdAt, T0);
    assert.ok(pass.maxDurationMs >= 60 * 1000);
  });
});

test("a site pass covers only its own domain and its subdomains", () => {
  const pass = core.createPass({ presetId: "site30", target: "doordash.com", now: T0 });
  const passes = [pass];

  assert.ok(core.findCoveringPass(passes, { domain: "doordash.com" }, T0));
  assert.ok(core.findCoveringPass(passes, { domain: "www.doordash.com" }, T0), "subdomains are covered");
  assert.equal(core.findCoveringPass(passes, { domain: "ubereats.com" }, T0), null);
  assert.equal(
    core.findCoveringPass(passes, { domain: "notdoordash.com" }, T0),
    null,
    "a look-alike suffix must not match"
  );
});

// ---------------------------------------------------------------------------
// There is no category preset, because no screen could ever select one
//
// `category30` was defined in PASS_PRESETS, exported through PASS_PRESET_IDS,
// published in docs/STORAGE.md as a state a profile could hold, and pinned by a
// passing test called "a category pass covers a category and nothing else" —
// while the block page's chooser offered six options, none of them this one. A
// buyer reading the docs or the suite would believe FitShield supports "open all
// pizza sites for 30 minutes". It does not, and a test passing for a feature is
// exactly the case where tests do not make it real.
// ---------------------------------------------------------------------------

test("no pass preset creates a scope no screen can offer", () => {
  assert.ok(!core.PASS_PRESET_IDS.includes("category30"));
  assert.equal(core.PASS_PRESETS.category30, undefined);

  const reachableScopes = new Set(core.PASS_PRESET_IDS.map((id) => core.PASS_PRESETS[id].scope));
  assert.ok(!reachableScopes.has("category"), "nothing the UI can press grants a category pass");
});

test("a category pass already granted by an older build still covers what it said", () => {
  // The scope stays supported precisely so a pass someone is currently holding
  // is neither widened nor dropped out from under them mid-flight.
  const stored = [
    {
      id: "p-old",
      preset: "category30",
      scope: "category",
      target: "pizza",
      createdAt: T0,
      expiresAt: T0 + minutes(30),
      maxDurationMs: minutes(30)
    }
  ];

  assert.ok(core.findCoveringPass(stored, { domain: "dominos.com", category: "pizza" }, T0 + minutes(5)));
  assert.equal(core.findCoveringPass(stored, { domain: "dominos.com", category: "burger" }, T0 + minutes(5)), null);
  assert.equal(core.findCoveringPass(stored, { domain: "dominos.com" }, T0 + minutes(5)), null);
  assert.equal(core.activePasses(stored, T0 + minutes(31)).length, 0, "and it still expires on time");
});

test("an all-scope pause covers everything", () => {
  const passes = [core.createPass({ presetId: "all30", now: T0 })];

  assert.ok(core.findCoveringPass(passes, { domain: "anything.example", category: "pizza" }, T0));
  assert.ok(core.findCoveringPass(passes, {}, T0));
});

test("pause until tomorrow ends at the coming local midnight, not 24 hours later", () => {
  const pass = core.createPass({ presetId: "allTomorrow", now: T0 });
  const expiry = new Date(pass.expiresAt);

  assert.equal(expiry.getHours(), 0);
  assert.equal(expiry.getMinutes(), 0);
  assert.equal(expiry.getDate(), 5);
});

// ---------------------------------------------------------------------------
// Expiry across the four hostile lifecycle events
// ---------------------------------------------------------------------------

test("a pass expires exactly at its timestamp and never after", () => {
  const passes = [core.createPass({ presetId: "site10", target: "doordash.com", now: T0 })];

  assert.equal(core.activePasses(passes, T0 + minutes(9)).length, 1, "still valid at 9 minutes");
  assert.equal(core.activePasses(passes, T0 + minutes(10)).length, 0, "gone at exactly 10 minutes");
  assert.equal(core.activePasses(passes, T0 + minutes(11)).length, 0);
});

test("browser restart / worker suspension: the same stored records re-read later are expired", () => {
  // Nothing is held in memory — this IS the restart case, because a restart just
  // means the next read happens at a later `now` from the same storage.
  const stored = JSON.parse(
    JSON.stringify([
      core.createPass({ presetId: "site30", target: "doordash.com", now: T0 }),
      core.createPass({ presetId: "all30", now: T0 })
    ])
  );

  assert.equal(core.activePasses(stored, T0 + minutes(5)).length, 2);
  assert.equal(core.activePasses(stored, T0 + minutes(31)).length, 0, "after a restart 31 minutes later, both are gone");
});

test("system sleep: a long jump forward expires everything it should", () => {
  const stored = [core.createPass({ presetId: "tab", target: "doordash.com", tabId: 4, now: T0 })];

  assert.equal(core.activePasses(stored, T0 + minutes(60), { openTabIds: [4] }).length, 1);
  assert.equal(core.activePasses(stored, T0 + minutes(60 * 13), { openTabIds: [4] }).length, 0, "the 12h guard holds");
});

test("a clock moved backwards cannot extend a pass", () => {
  const stored = [core.createPass({ presetId: "site10", target: "doordash.com", now: T0 })];

  // The clock jumps back an hour; the pass must not become valid for longer.
  assert.equal(core.activePasses(stored, T0 - minutes(60)).length, 0, "a now far before the grant is not trusted");
  assert.equal(core.activePasses(stored, T0 + 1000).length, 1, "a sane now still works");
});

test("a pass whose apparent age exceeds its own maximum is treated as expired", () => {
  // A tampered or clock-skewed record whose expiresAt is far in the future but
  // whose granted duration was short.
  const tampered = [
    {
      id: "x",
      scope: "site",
      target: "doordash.com",
      createdAt: T0,
      expiresAt: T0 + minutes(60 * 24 * 365),
      maxDurationMs: minutes(10),
      used: false
    }
  ];

  assert.equal(core.activePasses(tampered, T0 + minutes(5)).length, 1);
  assert.equal(core.activePasses(tampered, T0 + minutes(11)).length, 0, "the granted duration is the real ceiling");
});

test("a tab-bound pass dies with its tab", () => {
  const stored = [core.createPass({ presetId: "tab", target: "doordash.com", tabId: 12, now: T0 })];

  assert.equal(core.activePasses(stored, T0 + minutes(1), { openTabIds: [12, 13] }).length, 1);
  assert.equal(core.activePasses(stored, T0 + minutes(1), { openTabIds: [13] }).length, 0, "tab closed");
  assert.equal(core.activePasses(stored, T0 + minutes(1)).length, 1, "no tab list available -> time still governs");
});

// Replaces "a one-shot pass is consumed once it is marked used", which set
// `used: true` on the record by hand. No code path in the extension ever wrote
// that flag — declarativeNetRequest gives the worker no signal when a request
// matches, so a single visit cannot be observed and a pass cannot stand down
// after it. The old test pinned a filter for a state the product could not
// reach, while the UI promised "Just this once". The behaviour that actually
// ships is pinned instead: the shortest pass is a five-minute site pass.
test("the site pass honours the user's own Site open time setting", () => {
  const pass = core.createPass({ presetId: "siteDefault", target: "doordash.com", minutes: 5, now: T0 });

  assert.equal(pass.scope, "site");
  assert.equal(pass.expiresAt, T0 + minutes(5));
  assert.equal(core.activePasses([pass], T0 + minutes(4)).length, 1);
  assert.equal(core.activePasses([pass], T0 + minutes(5)).length, 0, "gone the moment it expires");

  // The whole point of siteDefault: it carries no fixed duration, so the
  // "Site open time" slider in the popup and Settings actually governs it.
  // Every other preset hard-codes its minutes, which is why that slider was
  // unreachable and did nothing while three surfaces quoted a number from it.
  assert.equal(core.PASS_PRESETS.siteDefault.minutes, undefined, "no baked-in duration");

  const longer = core.createPass({ presetId: "siteDefault", target: "doordash.com", minutes: 25, now: T0 });
  assert.equal(longer.expiresAt, T0 + minutes(25), "a different setting gives a different pass");
});

test("no pass record carries state nothing can ever set", () => {
  const pass = core.createPass({ presetId: "siteDefault", target: "doordash.com", minutes: 5, now: T0 });

  assert.ok(!("oneShot" in pass), "oneShot was never read by anything");
  assert.ok(!("used" in pass), "used was never written by anything");
});

// The named shim for 0.55's development-only "once" / "site5" presets was removed
// in 0.57: neither ever shipped, and a pass lives minutes to hours, so no profile
// can hold one. What has to keep holding is the property that made that shim
// unnecessary — an unrecognised preset must never cost the user the pass they were
// granted. That is what this asserts, for any unknown label.
test("a pass carrying an unrecognised preset keeps running, it is not dropped", () => {
  const stranger = {
    id: "p1",
    preset: "someLabelThisBuildDoesNotKnow",
    scope: "site",
    target: "doordash.com",
    createdAt: T0,
    expiresAt: T0 + minutes(5),
    maxDurationMs: minutes(5)
  };

  const [active] = core.activePasses([stranger], T0 + minutes(1));

  assert.ok(active, "the pass was dropped out from under whoever granted it");
  assert.equal(active.preset, "custom", "an unknown label reads as a custom pass");
  assert.equal(active.scope, "site", "its scope is untouched");
  assert.equal(active.target, "doordash.com");
  assert.equal(active.expiresAt, T0 + minutes(5), "its expiry is untouched");
});

test("malformed and hostile pass records are discarded, not trusted", () => {
  const junk = [
    null,
    "pass",
    {},
    { expiresAt: "soon" },
    { createdAt: T0 },
    { createdAt: T0, expiresAt: T0 + 1000, scope: "everything", target: "x" },
    JSON.parse('{"__proto__":{"polluted":true},"createdAt":' + T0 + ',"expiresAt":' + (T0 + 60000) + "}")
  ];

  const active = core.activePasses(junk, T0 + 1000);

  assert.equal({}.polluted, undefined, "no prototype pollution");
  active.forEach((pass) => assert.ok(core.PASS_SCOPES.includes(pass.scope), "an unknown scope is normalized, not kept"));
  assert.equal(active.filter((pass) => pass.scope === "all").length, 0, 'a junk scope must not become "all"');
});

test("an unrecognised scope falls back to the narrowest one", () => {
  const pass = core.createPass({ scope: "everything", target: "doordash.com", now: T0 });
  assert.equal(pass.scope, "site");
});

// ---------------------------------------------------------------------------
// Repeat-access friction
// ---------------------------------------------------------------------------

const frictionOn = { repeatFrictionEnabled: true, repeatExtraSeconds: 20, repeatWindowMinutes: 60 };

test("a first visit earns no extra friction", () => {
  const result = core.repeatFrictionFor({}, "doordash.com", frictionOn, T0);

  assert.equal(result.repeat, false);
  assert.equal(result.extraSeconds, 0);
});

test("returning inside the window earns one explained step of extra pause", () => {
  const history = core.recordContinue({}, "doordash.com", T0);
  const result = core.repeatFrictionFor(history, "doordash.com", frictionOn, T0 + minutes(20));

  assert.equal(result.repeat, true);
  assert.equal(result.recentCount, 1);
  assert.equal(result.extraSeconds, 20);
  assert.equal(result.windowMinutes, 60, "the reason is reportable to the user");
});

test("friction does not escalate — two visits and twenty cost the same", () => {
  let history = {};
  for (let i = 0; i < 20; i += 1) {
    history = core.recordContinue(history, "doordash.com", T0 + i * 1000);
  }

  const many = core.repeatFrictionFor(history, "doordash.com", frictionOn, T0 + minutes(30));
  const two = core.repeatFrictionFor(core.recordContinue({}, "doordash.com", T0), "doordash.com", frictionOn, T0 + minutes(30));

  assert.equal(many.extraSeconds, two.extraSeconds, "no exponential lockout");
  assert.ok(many.extraSeconds <= 120, "and it is capped");
});

test("friction lapses once the window passes", () => {
  const history = core.recordContinue({}, "doordash.com", T0);
  const later = core.repeatFrictionFor(history, "doordash.com", frictionOn, T0 + minutes(61));

  assert.equal(later.repeat, false);
});

test("friction is per-domain", () => {
  const history = core.recordContinue({}, "doordash.com", T0);

  assert.equal(core.repeatFrictionFor(history, "ubereats.com", frictionOn, T0 + minutes(5)).repeat, false);
});

test("repeat friction can be switched off completely", () => {
  const history = core.recordContinue({}, "doordash.com", T0);
  const off = core.repeatFrictionFor(history, "doordash.com", { repeatFrictionEnabled: false }, T0 + minutes(5));

  assert.equal(off.repeat, false);
  assert.equal(off.extraSeconds, 0);
});

test("repeat history is bounded so it cannot grow without limit", () => {
  let history = {};
  for (let i = 0; i < 400; i += 1) {
    history = core.recordContinue(history, `site${i % 90}.example`, T0 + i * 1000);
  }

  const normalized = core.normalizeRepeatHistory(history, { now: T0 + 400 * 1000 });
  assert.ok(Object.keys(normalized).length <= 60, "domain count is capped");
  Object.values(normalized).forEach((times) => assert.ok(times.length <= 12, "per-domain history is capped"));
});

// ---------------------------------------------------------------------------
// repeatHistory must actually be the "short-lived window" the product calls it
//
// The caps were on COUNT only — 60 domains x 12 entries — and nothing anywhere
// applied an age. `repeatFrictionFor` computed a cutoff but used it for READING
// only and never wrote the pruned list back, so a map of
// {"ubereats.com": [12 exact millisecond timestamps]} survived every read,
// forever. That is a durable per-brand record of the moments a user gave in, on
// a product that promises it stores no browsing history, readable by anyone with
// a moment at an unlocked machine. Age is now enforced where it is decided:
// every read, and every write.
// ---------------------------------------------------------------------------

const RETENTION = () => core.repeatHistoryRetentionMs(60);

test("a continue older than the retention window is dropped on read", () => {
  const history = {
    "ubereats.com": [T0 - RETENTION() - minutes(1), T0 - minutes(5)],
    "dominos.com": [T0 - 3 * 365 * 24 * 60 * 60 * 1000]
  };

  const pruned = core.normalizeRepeatHistory(history, { now: T0, windowMinutes: 60 });

  assert.deepEqual(pruned["ubereats.com"], [T0 - minutes(5)], "only the recent visit survives");
  assert.ok(!("dominos.com" in pruned), "a domain with nothing recent leaves no row at all");
});

test("retention is a bounded multiple of the user's own repeat window", () => {
  assert.equal(core.repeatHistoryRetentionMs(60), 60 * core.REPEAT_HISTORY_RETENTION_MULTIPLE * 60 * 1000);
  // Clamped to the same 5-720 minute range the window itself uses, so no
  // setting can turn this back into an unbounded log.
  assert.equal(core.repeatHistoryRetentionMs(999999), core.repeatHistoryRetentionMs(720));
  assert.equal(core.repeatHistoryRetentionMs("nonsense"), core.repeatHistoryRetentionMs(60));
  assert.ok(core.repeatHistoryRetentionMs(720) <= 36 * 60 * 60 * 1000, "nothing survives beyond 36 hours");
});

test("recording a continue prunes what it is written into", () => {
  const stale = { "ubereats.com": [T0 - RETENTION() - 1] };
  const next = core.recordContinue(stale, "doordash.com", T0, { windowMinutes: 60 });

  assert.deepEqual(next, { "doordash.com": [T0] }, "the write carried nothing expired forward");
});

test("a timestamp from a wrong clock cannot outlive every cutoff", () => {
  const tampered = { "ubereats.com": [T0 + 10 * 365 * 24 * 60 * 60 * 1000] };

  assert.deepEqual(core.normalizeRepeatHistory(tampered, { now: T0, windowMinutes: 60 }), {});
});

test("readSettings expires repeat history, so a profile left alone cannot keep it", () => {
  const settings = core.readSettings(
    {
      repeatWindowMinutes: 60,
      repeatHistory: { "ubereats.com": [T0 - RETENTION() - 1, T0 - minutes(2)] }
    },
    { now: T0 }
  );

  assert.deepEqual(settings.repeatHistory, { "ubereats.com": [T0 - minutes(2)] });
});

test("friction still works exactly as before within the window", () => {
  // Retention must never shorten the behaviour it exists to serve: an entry
  // inside the repeat window has to survive both the read and the write.
  const history = core.recordContinue({}, "doordash.com", T0, { windowMinutes: 60 });
  const result = core.repeatFrictionFor(history, "doordash.com", frictionOn, T0 + minutes(59));

  assert.equal(result.repeat, true);
  assert.equal(result.recentCount, 1);
});

// ---------------------------------------------------------------------------
// The block page's "what brought you here?" answer
//
// Settings promises, next to the toggle, that "the answer is never saved". It
// was being written onto the pass record as `reason`, leaving a
// {domain, exact timestamp, why I gave in} triple on disk — the most sensitive
// thing this product could keep, about the moment a user gave in. Nothing ever
// read it back.
// ---------------------------------------------------------------------------

test("a pass never records why the user continued", () => {
  const pass = core.createPass({
    presetId: "site10",
    target: "doordash.com",
    now: T0,
    reason: "someone-else"
  });

  assert.ok(!("reason" in pass), "the intent answer must not be stored on the pass");
  assert.equal(
    JSON.stringify(pass).includes("someone-else"),
    false,
    "no part of the record may carry the answer"
  );
});

test("a pass stored by an older build has its reason dropped on the next read", () => {
  const legacy = {
    id: "p1",
    preset: "site10",
    scope: "site",
    target: "doordash.com",
    createdAt: T0,
    expiresAt: T0 + minutes(10),
    maxDurationMs: minutes(10),
    reason: "someone-else"
  };

  const [active] = core.activePasses([legacy], T0 + minutes(1));

  assert.ok(active, "the pass itself still works");
  assert.ok(!("reason" in active), "but the stored answer is not carried forward");
});
