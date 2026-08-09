"use strict";
/**
 * The popup's status line must describe the state the worker is actually in.
 *
 * F006: the popup said "Shield up" during hours when the schedule had blocking
 * switched off, and `statusOutsideSchedule` — "Blocker is armed, but outside
 * scheduled hours" — was unreachable. The guard is
 * `scheduleEnabled && !scheduleActive`, and `scheduleEnabled` was destructured
 * off a getBlockState response that never carried the key, so it was always
 * false and execution always fell through to "Shield up".
 *
 * That was fixed by making the flat schedule trio a projection of the canonical
 * schedule. This pins the contract so the branch cannot go dead again: the two
 * flags the popup keys off must both be present and must disagree in exactly the
 * situation that message exists for.
 *
 * The end-to-end proof lives in the real-browser suite, which drives the actual
 * popup and reads the rendered sentence.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const core = require("../extension/fitshield-core.js");
const popupJs = fs.readFileSync(path.join(ROOT, "extension", "popup.js"), "utf8");
const messages = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "_locales", "en", "messages.json"), "utf8"));

// A window that cannot contain `now`, so the schedule is enabled but inactive.
function scheduleAwayFrom(now) {
  const pad = (n) => String(n).padStart(2, "0");
  const at = (hoursAhead) => {
    const d = new Date(now.getTime() + hoursAhead * 3600 * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return core.normalizeSchedule(
    core.scheduleFromLegacy({ scheduleEnabled: true, scheduleStart: at(2), scheduleEnd: at(3) })
  );
}

test("the popup still keys its status off both schedule flags", () => {
  // If either name disappears from popup.js the assertions below stop meaning
  // anything, so fail loudly rather than passing vacuously.
  assert.match(popupJs, /scheduleEnabled/, "popup.js must read scheduleEnabled");
  assert.match(popupJs, /scheduleActive/, "popup.js must read scheduleActive");
  assert.match(popupJs, /statusOutsideSchedule/, "popup.js must be able to show the outside-hours status");
});

test("readSettings supplies the flag whose absence made the branch dead", () => {
  const now = new Date();
  const settings = core.readSettings({ schedule: scheduleAwayFrom(now) });

  assert.equal(
    Object.prototype.hasOwnProperty.call(settings, "scheduleEnabled"),
    true,
    "getBlockState carries this to the popup; without it the guard is always false"
  );
  assert.equal(settings.scheduleEnabled, true, "a windowed schedule reads as enabled");
});

test("outside its window the two flags disagree, which is what the branch needs", () => {
  const now = new Date();
  const schedule = scheduleAwayFrom(now);

  const settings = core.readSettings({ schedule });
  const evaluated = core.evaluateSchedule(schedule, now);

  assert.equal(settings.scheduleEnabled, true, "the user has a schedule");
  assert.equal(evaluated.active, false, "but we are outside it right now");

  // This is the exact predicate in popup.js.
  assert.equal(settings.scheduleEnabled && !evaluated.active, true, "so the outside-hours status must win");
});

test("inside its window the flags agree, so the shield status wins", () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const at = (offset) => {
    const d = new Date(now.getTime() + offset * 3600 * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // A window that straddles now: one hour back to one hour forward.
  const schedule = core.normalizeSchedule(
    core.scheduleFromLegacy({ scheduleEnabled: true, scheduleStart: at(-1), scheduleEnd: at(1) })
  );

  const settings = core.readSettings({ schedule });
  const evaluated = core.evaluateSchedule(schedule, now);

  assert.equal(settings.scheduleEnabled, true);
  assert.equal(evaluated.active, true, "we are inside the window");
  assert.equal(settings.scheduleEnabled && !evaluated.active, false, "so the outside-hours status must NOT win");
});

test("an always-on schedule never claims to be outside its hours", () => {
  const settings = core.readSettings({ schedule: { mode: "always", windows: [], until: null } });
  const evaluated = core.evaluateSchedule({ mode: "always", windows: [], until: null });

  assert.equal(settings.scheduleEnabled, false, "always-on is not a windowed schedule");
  assert.equal(evaluated.active, true);
  assert.equal(settings.scheduleEnabled && !evaluated.active, false);
});

test("the outside-hours message exists and takes the time range", () => {
  const entry = messages.statusOutsideSchedule;

  assert.ok(entry, "statusOutsideSchedule must exist — it is the message the branch shows");
  assert.match(entry.message, /\$1/, "it names the window it is waiting for");
});
