"use strict";
/**
 * Schedule evaluation tests.
 *
 * Everything is evaluated against a fixed local Date so the suite is stable
 * wherever it runs. Dates are constructed with the local-time Date constructor
 * (not ISO strings) precisely because the feature is defined in local wall-clock
 * terms — that is what makes "evenings" mean 18:00 local on both sides of a
 * daylight-saving shift.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../extension/fitshield-core.js");

// 2026-03-04 is a Wednesday (day 3).
const at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute, 0, 0);
const WED_20_00 = at(2026, 3, 4, 20, 0);
const WED_12_00 = at(2026, 3, 4, 12, 0);
const THU_01_00 = at(2026, 3, 5, 1, 0);
const SAT_20_00 = at(2026, 3, 7, 20, 0);
const SUN_12_00 = at(2026, 3, 8, 12, 0);

const windows = (list) => ({ mode: "windows", windows: list, until: null });

test("no schedule at all means always on", () => {
  assert.equal(core.evaluateSchedule(undefined, WED_20_00).active, true);
  assert.equal(core.evaluateSchedule({}, WED_20_00).active, true);
  assert.equal(core.evaluateSchedule({ mode: "always" }, WED_20_00).reason, "always");
});

test("a normal same-day window is active inside and inactive outside", () => {
  const schedule = windows([{ days: core.ALL_DAYS, start: "18:00", end: "23:00" }]);

  assert.equal(core.evaluateSchedule(schedule, WED_20_00).active, true);
  assert.equal(core.evaluateSchedule(schedule, WED_12_00).active, false);
  assert.equal(core.evaluateSchedule(schedule, WED_12_00).reason, "outside");
});

test("a window boundary is inclusive at the start and exclusive at the end", () => {
  const schedule = windows([{ days: core.ALL_DAYS, start: "18:00", end: "23:00" }]);

  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 4, 18, 0)).active, true);
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 4, 22, 59)).active, true);
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 4, 23, 0)).active, false);
});

test("an overnight window keeps blocking past midnight and belongs to its start day", () => {
  // Wednesday 22:00 -> Thursday 02:00, Wednesdays only.
  const schedule = windows([{ days: [3], start: "22:00", end: "02:00" }]);

  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 4, 23, 30)).active, true, "Wednesday night");
  assert.equal(core.evaluateSchedule(schedule, THU_01_00).active, true, "Thursday 01:00 is still Wednesday's window");
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 5, 23, 30)).active, false, "Thursday night is NOT covered");
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 4, 21, 0)).active, false, "before it opens");
});

test("start equal to end means the whole of that day", () => {
  const schedule = windows([{ days: [3], start: "09:00", end: "09:00" }]);

  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 4, 3, 0)).active, true);
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 4, 23, 59)).active, true);
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 5, 12, 0)).active, false, "only on the listed day");
});

test("multiple windows in one day are all honoured", () => {
  const schedule = windows([
    { days: [3], start: "11:00", end: "14:00" },
    { days: [3], start: "18:00", end: "23:00" }
  ]);

  assert.equal(core.evaluateSchedule(schedule, WED_12_00).active, true, "lunch window");
  assert.equal(core.evaluateSchedule(schedule, WED_20_00).active, true, "evening window");
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 4, 16, 0)).active, false, "the gap between them");
});

test("weekday and weekend schedules can differ", () => {
  const schedule = windows([
    { days: core.WEEKDAYS, start: "18:00", end: "23:00" },
    { days: core.WEEKEND, start: "11:00", end: "23:00" }
  ]);

  assert.equal(core.evaluateSchedule(schedule, WED_12_00).active, false, "weekday lunch is free");
  assert.equal(core.evaluateSchedule(schedule, SUN_12_00).active, true, "weekend lunch is covered");
  assert.equal(core.evaluateSchedule(schedule, SAT_20_00).active, true);
  assert.equal(core.evaluateSchedule(schedule, WED_20_00).active, true);
});

test("a temporary override wins while it lasts, then expires on its own", () => {
  const schedule = {
    mode: "windows",
    windows: [{ days: core.ALL_DAYS, start: "18:00", end: "23:00" }],
    until: WED_12_00.getTime() + 60 * 60 * 1000
  };

  assert.equal(core.evaluateSchedule(schedule, WED_12_00).active, true, "override is on");
  assert.equal(core.evaluateSchedule(schedule, WED_12_00).reason, "temporary");
  // One hour later the override is gone and the normal window decides again.
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 4, 13, 30)).active, false);
});

test("invalid and legacy schedules degrade to always-on rather than blocking nothing silently", () => {
  const junk = [
    { mode: "windows", windows: [{ start: "nope", end: "??" }] },
    { mode: "windows", windows: "not an array" },
    { mode: "windows", windows: [] },
    { mode: 42 },
    null
  ];

  junk.forEach((schedule) => {
    const result = core.evaluateSchedule(schedule, WED_12_00);
    assert.equal(result.active, true, `${JSON.stringify(schedule)} should fail safe to always-on`);
  });
});

test("normalizeSchedule drops unusable windows and caps the list", () => {
  const normalized = core.normalizeSchedule({
    mode: "windows",
    windows: [
      { days: [1], start: "9:05", end: "10:00" },
      { days: [1], start: "25:00", end: "10:00" },
      { days: [1], start: "9:5", end: "10:00" },
      { days: "nope", start: "08:00", end: "09:00" },
      null
    ]
  });

  assert.equal(normalized.windows.length, 2);
  assert.equal(normalized.windows[0].start, "09:05", "single-digit hours are padded");
  assert.deepEqual(normalized.windows[1].days, core.ALL_DAYS, "an unusable day list becomes every day");
});

test("every schedule preset is well formed and evaluable", () => {
  core.SCHEDULE_PRESET_IDS.forEach((id) => {
    const preset = core.schedulePresetValues(id);
    assert.ok(preset, `${id} resolves`);
    const normalized = core.normalizeSchedule(preset);
    assert.equal(normalized.mode, preset.mode, `${id} survives normalization`);
    assert.doesNotThrow(() => core.evaluateSchedule(preset, WED_20_00));
  });

  assert.equal(core.schedulePresetValues("nonexistent"), null);
});

test("the late-night preset covers the small hours", () => {
  const lateNight = core.schedulePresetValues("lateNight");

  assert.equal(core.evaluateSchedule(lateNight, at(2026, 3, 5, 1, 0)).active, true);
  assert.equal(core.evaluateSchedule(lateNight, at(2026, 3, 4, 15, 0)).active, false);
});

test("the workday-lunch preset skips the weekend", () => {
  const lunch = core.schedulePresetValues("workdayLunch");

  assert.equal(core.evaluateSchedule(lunch, WED_12_00).active, true);
  assert.equal(core.evaluateSchedule(lunch, SUN_12_00).active, false);
});

test("copying one day's schedule to other days replaces those days", () => {
  const schedule = windows([
    { days: [1], start: "18:00", end: "22:00" },
    { days: [2], start: "09:00", end: "10:00" }
  ]);

  const copied = core.copyScheduleDay(schedule, 1, [2, 3]);

  assert.equal(core.evaluateSchedule(copied, at(2026, 3, 3, 19, 0)).active, true, "Tuesday now matches Monday");
  assert.equal(core.evaluateSchedule(copied, at(2026, 3, 3, 9, 30)).active, false, "Tuesday's old window is gone");
  assert.equal(core.evaluateSchedule(copied, at(2026, 3, 4, 19, 0)).active, true, "Wednesday got the copy too");
  assert.equal(core.evaluateSchedule(copied, at(2026, 3, 2, 19, 0)).active, true, "the source day is unchanged");
});

// ---------------------------------------------------------------------------
// Boundary scheduling (what the worker's alarm is armed on)
// ---------------------------------------------------------------------------

test("the next boundary is the next open or close, whichever comes first", () => {
  const schedule = windows([{ days: core.ALL_DAYS, start: "18:00", end: "23:00" }]);

  const fromNoon = core.nextScheduleBoundary(schedule, WED_12_00);
  assert.equal(new Date(fromNoon).getHours(), 18, "before the window opens -> the opening");

  const fromEvening = core.nextScheduleBoundary(schedule, WED_20_00);
  assert.equal(new Date(fromEvening).getHours(), 23, "inside the window -> the closing");
});

test("an always-on schedule has no boundary to wake for", () => {
  assert.equal(core.nextScheduleBoundary({ mode: "always" }, WED_12_00), null);
});

test("a boundary is always in the future, including across a day change", () => {
  const schedule = windows([{ days: [3], start: "22:00", end: "02:00" }]);
  const boundary = core.nextScheduleBoundary(schedule, at(2026, 3, 4, 23, 0));

  assert.ok(boundary > at(2026, 3, 4, 23, 0).getTime());
  assert.equal(new Date(boundary).getHours(), 2);
  assert.equal(new Date(boundary).getDate(), 5);
});

test("a pending temporary override is itself a boundary", () => {
  const until = WED_12_00.getTime() + 30 * 60 * 1000;
  const boundary = core.nextScheduleBoundary({ mode: "always", windows: [], until }, WED_12_00);

  assert.equal(boundary, until);
});

test("DST: a wall-clock window keeps its wall-clock meaning across the shift", () => {
  // US DST began 2026-03-08 at 02:00 local. An 18:00-23:00 window must mean
  // 18:00-23:00 local on both the day before and the day after.
  const schedule = windows([{ days: core.ALL_DAYS, start: "18:00", end: "23:00" }]);

  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 7, 19, 0)).active, true, "day before the shift");
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 8, 19, 0)).active, true, "day of the shift");
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 9, 19, 0)).active, true, "day after the shift");
  assert.equal(core.evaluateSchedule(schedule, at(2026, 3, 8, 17, 0)).active, false);

  // The boundary computed across the shift is still the next local 18:00 or
  // 23:00, never an hour adrift.
  const boundary = new Date(core.nextScheduleBoundary(schedule, at(2026, 3, 8, 12, 0)));
  assert.equal(boundary.getHours(), 18);
  assert.equal(boundary.getDate(), 8);
});

test("nextLocalMidnight is the coming local midnight, not a UTC one", () => {
  const midnight = new Date(core.nextLocalMidnight(WED_20_00));

  assert.equal(midnight.getHours(), 0);
  assert.equal(midnight.getMinutes(), 0);
  assert.equal(midnight.getDate(), 5);
});

// ---------------------------------------------------------------------------
// The flat mirror must never overwrite a richer schedule
//
// The worker rebuilt `schedule` from the three flat keys whenever any of them
// changed. Those three can only describe ONE window across ALL SEVEN days, and
// the advanced editor writes the structured schedule and the mirror in the same
// storage set — so saving "Workday lunch" (Mon-Fri) or "Evenings and weekends"
// (two windows) was immediately replaced by a seven-day window, and the settings
// page went on displaying the choice the user made rather than the one being
// enforced. A weekday-lunch user got interrupted on Saturday.
// ---------------------------------------------------------------------------

// Mirrors the guard in background.js syncLegacySchedule.
function expressibleByFlatKeys(schedule) {
  const current = core.normalizeSchedule(schedule);
  return current.mode !== "windows" || (current.windows.length === 1 && current.windows[0].days.length === 7);
}

test("a weekday-only schedule cannot be rebuilt from the flat keys", () => {
  const workdayLunch = core.normalizeSchedule(core.schedulePresetValues("workdayLunch"));

  assert.equal(workdayLunch.windows.length, 1);
  assert.deepEqual(workdayLunch.windows[0].days, [1, 2, 3, 4, 5], "precondition: weekdays only");
  assert.equal(expressibleByFlatKeys(workdayLunch), false, "so the worker must leave it alone");

  // What the old code would have written back.
  const lossy = core.normalizeSchedule(
    core.scheduleFromLegacy({ scheduleEnabled: true, scheduleStart: "11:00", scheduleEnd: "14:00" })
  );
  assert.deepEqual(lossy.windows[0].days, [0, 1, 2, 3, 4, 5, 6], "the mirror can only mean every day");
});

test("a multi-window schedule cannot be rebuilt from the flat keys", () => {
  const both = core.normalizeSchedule(core.schedulePresetValues("eveningsAndWeekends"));

  assert.ok(both.windows.length > 1, "precondition: more than one window");
  assert.equal(expressibleByFlatKeys(both), false);
});

test("a plain every-day window still syncs from the flat keys", () => {
  ["evenings", "lateNight", "always"].forEach((id) => {
    const preset = core.normalizeSchedule(core.schedulePresetValues(id));
    assert.equal(expressibleByFlatKeys(preset), true, `${id} is expressible, so the popup can still drive it`);
  });
});

// ---------------------------------------------------------------------------
// The UI must render the schedule that is actually enforced
//
// readSettings returned no scheduleEnabled/Start/End at all, so getBlockState
// carried none of them and both the popup and Settings fell through to their
// own destructuring defaults: a profile whose window was 19:30-02:00 was shown
// as "off, 18:00-23:00" while the worker enforced the real hours.
// ---------------------------------------------------------------------------

test("readSettings projects the flat trio from the canonical schedule", () => {
  const stored = {
    schedule: core.normalizeSchedule(
      core.scheduleFromLegacy({ scheduleEnabled: true, scheduleStart: "19:30", scheduleEnd: "02:00" })
    )
  };

  const settings = core.readSettings(stored);

  assert.equal(settings.scheduleEnabled, true, "the UI must see that a schedule is on");
  assert.equal(settings.scheduleStart, "19:30", "and the hours actually stored");
  assert.equal(settings.scheduleEnd, "02:00");
  assert.equal(settings.scheduleSimple, true);
});

test("an always-on schedule projects as off, with usable defaults", () => {
  const settings = core.readSettings({ schedule: { mode: "always", windows: [], until: null } });

  assert.equal(settings.scheduleEnabled, false);
  assert.equal(settings.scheduleSimple, true, "the simple controls can still be offered");
});

test("a schedule the two time inputs cannot hold is flagged, not misrepresented", () => {
  ["workdayLunch", "eveningsAndWeekends"].forEach((id) => {
    const settings = core.readSettings({ schedule: core.schedulePresetValues(id) });

    assert.equal(settings.scheduleEnabled, true, `${id} is a real schedule`);
    assert.equal(
      settings.scheduleSimple,
      false,
      `${id} has more shape than start+end, so the surfaces must disable those inputs`
    );
  });
});

test("the projection never invents hours for a schedule it cannot express", () => {
  // The old local mirror fell back to `settings.scheduleStart || "18:00"`, and
  // because that key did not exist the fallback always won — silently rewriting
  // a migrated 19:30 profile to 18:00 as soon as a second window was added.
  const rich = core.normalizeSchedule(core.schedulePresetValues("eveningsAndWeekends"));
  const mirror = core.scheduleToLegacy(rich);

  assert.equal(mirror.simple, false);
  assert.equal(mirror.scheduleEnabled, true, "it is still a schedule");
  // The values are the documented defaults precisely BECAUSE they are not read
  // back: scheduleIsFlatExpressible is false, so nothing rebuilds from them.
  assert.equal(core.scheduleIsFlatExpressible(rich), false);
});
