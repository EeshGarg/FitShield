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

test("a category pass covers a category and nothing else", () => {
  const passes = [core.createPass({ presetId: "category30", scope: "category", target: "pizza", now: T0 })];

  assert.ok(core.findCoveringPass(passes, { domain: "dominos.com", category: "pizza" }, T0));
  assert.equal(core.findCoveringPass(passes, { domain: "dominos.com", category: "burger" }, T0), null);
  assert.equal(core.findCoveringPass(passes, { domain: "dominos.com" }, T0), null);
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

test("a one-shot pass is consumed once it is marked used", () => {
  const pass = core.createPass({ presetId: "once", target: "doordash.com", now: T0 });
  assert.equal(pass.oneShot, true);

  assert.equal(core.activePasses([pass], T0 + 1000).length, 1);
  assert.equal(core.activePasses([{ ...pass, used: true }], T0 + 1000).length, 0);
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

  const normalized = core.normalizeRepeatHistory(history);
  assert.ok(Object.keys(normalized).length <= 60, "domain count is capped");
  Object.values(normalized).forEach((times) => assert.ok(times.length <= 12, "per-domain history is capped"));
});
