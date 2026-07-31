"use strict";
/**
 * Statistics semantics tests.
 *
 * These exist to keep FitShield honest. Every counter must name something the
 * extension actually observed. The specific claims this file forbids are:
 *   - "an order was prevented" inferred from a page being interrupted,
 *   - "calories were avoided" inferred from a recipe being displayed,
 *   - "selected" and "made" being the same event.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../extension/fitshield-core.js");

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 2, 4, 20, 0, 0, 0).getTime();

const apply = (stats, event, now) => core.applyStatEvent(stats, event, now);

test("the event vocabulary describes observations, not outcomes", () => {
  assert.deepEqual(core.STAT_EVENTS, [
    "interruptions",
    "left",
    "continued",
    "passesUsed",
    "alternativesViewed",
    "alternativesSelected",
    "alternativesMade"
  ]);

  // Nothing in the vocabulary asserts a prevented order, avoided calories, money
  // saved, or a success/failure judgement.
  const forbidden = /prevent|avoid|saved|calorie|fail|streak|score|cheat|relapse/i;
  core.STAT_EVENTS.forEach((event) => {
    assert.doesNotMatch(event, forbidden, `"${event}" claims more than FitShield can observe`);
  });
});

test("an interruption is only an interruption — it moves no other counter", () => {
  const stats = apply({ totals: core.emptyStatTotals(), history: [] }, "interruptions", T0);

  assert.equal(stats.totals.interruptions, 1);
  assert.equal(stats.totals.left, 0);
  assert.equal(stats.totals.continued, 0);
  assert.equal(stats.totals.alternativesSelected, 0);
  assert.equal(stats.totals.alternativesMade, 0);
});

test("viewing an alternative does not count as choosing one", () => {
  let stats = { totals: core.emptyStatTotals(), history: [] };
  stats = apply(stats, "alternativesViewed", T0);
  stats = apply(stats, "alternativesViewed", T0);

  assert.equal(stats.totals.alternativesViewed, 2);
  assert.equal(stats.totals.alternativesSelected, 0, "a display is not a decision");
});

test("selected and made are distinct events and made never happens on its own", () => {
  let stats = { totals: core.emptyStatTotals(), history: [] };

  stats = apply(stats, "alternativesSelected", T0);
  assert.equal(stats.totals.alternativesSelected, 1);
  assert.equal(stats.totals.alternativesMade, 0, "choosing is intent, not completion");

  stats = apply(stats, "alternativesMade", T0 + 60 * 60 * 1000);
  assert.equal(stats.totals.alternativesSelected, 1);
  assert.equal(stats.totals.alternativesMade, 1, "made is a separate, later, voluntary confirmation");
});

test("leaving and continuing are recorded separately and neither is judged", () => {
  let stats = { totals: core.emptyStatTotals(), history: [] };
  stats = apply(stats, "left", T0);
  stats = apply(stats, "continued", T0);

  assert.equal(stats.totals.left, 1);
  assert.equal(stats.totals.continued, 1);
});

test("an unknown event is ignored rather than creating a counter", () => {
  const stats = apply({ totals: core.emptyStatTotals(), history: [] }, "caloriesAvoided", T0);

  assert.equal(stats.totals.caloriesAvoided, undefined);
  assert.deepEqual(Object.keys(stats.totals).sort(), core.STAT_EVENTS.slice().sort());
});

test("events accumulate per local day", () => {
  let stats = { totals: core.emptyStatTotals(), history: [] };
  stats = apply(stats, "interruptions", T0);
  stats = apply(stats, "interruptions", T0 + 60 * 1000);
  stats = apply(stats, "interruptions", T0 + DAY);

  assert.equal(stats.totals.interruptions, 3);
  assert.equal(stats.history.length, 2);
  assert.equal(stats.history[0].interruptions, 2);
  assert.equal(stats.history[1].interruptions, 1);
});

test("history is bounded and stays sorted", () => {
  let stats = { totals: core.emptyStatTotals(), history: [] };

  for (let day = 0; day < 100; day += 1) {
    stats = apply(stats, "interruptions", T0 + day * DAY);
  }

  assert.ok(stats.history.length <= 70, "history is capped");
  for (let i = 1; i < stats.history.length; i += 1) {
    assert.ok(stats.history[i - 1].day < stats.history[i].day, "history stays chronological");
  }
  assert.equal(stats.totals.interruptions, 100, "totals are not truncated with the history");
});

test("malformed stored stats normalize to zeros instead of throwing", () => {
  const stats = apply({ totals: "nope", history: { not: "an array" } }, "left", T0);

  assert.equal(stats.totals.left, 1);
  assert.equal(stats.totals.interruptions, 0);
  assert.ok(Array.isArray(stats.history));
});

test("negative and fractional stored counts are cleaned", () => {
  const totals = core.normalizeStatTotals({ interruptions: -5, left: 2.7, continued: "9" });

  assert.equal(totals.interruptions, 0);
  assert.equal(totals.left, 2);
  assert.equal(totals.continued, 9);
});

// ---------------------------------------------------------------------------
// Weekly recap
// ---------------------------------------------------------------------------

test("the recap covers the last seven local days and nothing older", () => {
  let stats = { totals: core.emptyStatTotals(), history: [] };
  stats = apply(stats, "interruptions", T0 - 10 * DAY);
  stats = apply(stats, "interruptions", T0 - 3 * DAY);
  stats = apply(stats, "left", T0);

  const recap = core.weeklyRecap(stats, T0);

  assert.equal(recap.totals.interruptions, 1, "the 10-day-old event is outside the window");
  assert.equal(recap.totals.left, 1);
  assert.equal(recap.hasActivity, true);
});

test("the recap of an unused week reports no activity rather than a zero score", () => {
  const recap = core.weeklyRecap({ totals: core.emptyStatTotals(), history: [] }, T0);

  assert.equal(recap.hasActivity, false);
  assert.equal(recap.topCategory, null);
  core.STAT_EVENTS.forEach((event) => assert.equal(recap.totals[event], 0));
});

test("the recap reports a most-common category but never ranks the user", () => {
  const recap = core.weeklyRecap({ totals: core.emptyStatTotals(), history: [] }, T0, {
    blockedByCategory: { pizza: 9, burger: 3 }
  });

  assert.deepEqual(recap.topCategory, { name: "pizza", count: 9 });

  // The recap payload carries counts only — no score, streak, grade or projection.
  const keys = Object.keys(recap);
  ["score", "streak", "grade", "failures", "projection", "goal"].forEach((banned) => {
    assert.ok(!keys.includes(banned), `recap must not expose "${banned}"`);
  });
});

test("the recap window is inclusive of today and seven days wide", () => {
  const recap = core.weeklyRecap({ totals: core.emptyStatTotals(), history: [] }, T0);

  assert.equal(recap.to, core.localDayKey(T0));
  assert.equal(recap.from, core.localDayKey(T0 - 6 * DAY));
});

test("localDayKey is local, so an evening event is not pushed into tomorrow", () => {
  const lateEvening = new Date(2026, 2, 4, 23, 30);
  assert.equal(core.localDayKey(lateEvening), "2026-03-04");
});
