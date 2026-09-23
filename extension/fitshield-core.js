/**
 * FitShield core — the shared, pure decision layer.
 *
 * Everything here is a plain function over plain data: no DOM, no chrome.*, no
 * network, no clock reads other than the `now` you pass in. That is deliberate,
 * because the same code has to run in four places:
 *
 *   - the Chromium MV3 service worker      (importScripts("fitshield-core.js"))
 *   - the Firefox event page               (manifest background.scripts)
 *   - every extension page                 (<script src="fitshield-core.js">)
 *   - Node, under `node --test`            (module.exports)
 *
 * It owns the parts of FitShield that must agree everywhere and must never drift:
 * the storage schema and its migrations, friction profiles, schedule evaluation,
 * temporary-pass scopes and expiry, repeat-access friction, the statistics event
 * vocabulary, and validation of anything the user typed.
 *
 * Public global: FitShieldCore.
 */
(function (global) {
  "use strict";

  // ===========================================================================
  // Storage schema
  // ===========================================================================

  // Bump when the SHAPE of local storage changes, and add a step to MIGRATIONS.
  // 1 is the implicit version of every pre-0.55 profile (no marker key).
  const SCHEMA_VERSION = 2;
  const SCHEMA_KEY = "schemaVersion";

  // Keys whose absence must never be read as "user turned this off".
  const DEFAULT_TIMER_SECONDS = 60;
  const MIN_TIMER_SECONDS = 10;
  const MAX_TIMER_SECONDS = 900;
  const DEFAULT_PASS_DURATION_MINUTES = 5;
  const MIN_PASS_DURATION_MINUTES = 1;
  const MAX_PASS_DURATION_MINUTES = 240;

  const DEFAULT_SCHEDULE_START = "18:00";
  const DEFAULT_SCHEDULE_END = "23:00";

  // ---------------------------------------------------------------------------
  // Small shared helpers
  // ---------------------------------------------------------------------------

  // Keys that can poison Object.prototype if copied blindly out of imported or
  // user-supplied JSON. Every object we build from untrusted input skips these.
  const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  // A prototype-less copy of `value`'s own, safe, enumerable keys.
  function safeObject(value) {
    const out = {};

    if (!isPlainObject(value)) {
      return out;
    }

    Object.keys(value).forEach((key) => {
      if (!FORBIDDEN_KEYS.has(key)) {
        out[key] = value[key];
      }
    });

    return out;
  }

  function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
  }

  function toStringList(value, limit) {
    if (!Array.isArray(value)) {
      return [];
    }

    const seen = new Set();
    const out = [];

    value.forEach((item) => {
      const text = String(item == null ? "" : item).trim();

      if (text && !seen.has(text) && (!limit || out.length < limit)) {
        seen.add(text);
        out.push(text);
      }
    });

    return out;
  }

  function normalizeTimerSeconds(value) {
    return clampInt(value, MIN_TIMER_SECONDS, MAX_TIMER_SECONDS, DEFAULT_TIMER_SECONDS);
  }

  function normalizePassDurationMinutes(value) {
    return clampInt(value, MIN_PASS_DURATION_MINUTES, MAX_PASS_DURATION_MINUTES, DEFAULT_PASS_DURATION_MINUTES);
  }

  // ===========================================================================
  // Friction profiles
  // ===========================================================================
  //
  // A preset is a starting point, not a cage: choosing one writes its values into
  // the same timerSeconds / passDurationMinutes / … keys the user can then edit.
  // Editing any value moves the profile to "custom" rather than silently
  // disagreeing with the label. No profile is irreversible and every profile
  // keeps the block page's override reachable.

  // A profile carries ONLY values something in the runtime actually enforces.
  // `settingsDelaySeconds` used to live here: strict wrote 60, the storage doc
  // described it as "a cooling-off delay before weakening protection", a unit
  // test asserted it was greater than zero — and no code anywhere read it. A
  // setting that does nothing is a false claim about the product, and a tested
  // one is worse, because the test reads as proof it works. It is gone rather
  // than left inert; adding it back means implementing the delay first.
  const FRICTION_PROFILES = {
    light: {
      id: "light",
      timerSeconds: 20,
      passDurationMinutes: 15,
      askIntent: false,
      repeatFrictionEnabled: false,
      repeatExtraSeconds: 0
    },
    standard: {
      id: "standard",
      timerSeconds: 60,
      passDurationMinutes: 5,
      askIntent: true,
      repeatFrictionEnabled: true,
      repeatExtraSeconds: 20
    },
    strict: {
      id: "strict",
      timerSeconds: 120,
      passDurationMinutes: 3,
      askIntent: true,
      repeatFrictionEnabled: true,
      repeatExtraSeconds: 45
    }
  };

  const FRICTION_PROFILE_IDS = Object.keys(FRICTION_PROFILES);

  // Which stored profile id best describes these values, or "custom".
  /**
   * Which named profile, if any, describes these values.
   *
   * Compares EVERY field a preset writes, derived from `frictionProfileValues`
   * rather than a hand-written list so it cannot drift from what a preset
   * actually sets. It used to compare only `timerSeconds` and
   * `passDurationMinutes`, which meant turning "Ask what brought me here" off
   * left the label still reading "Standard" — a label that did not describe the
   * numbers under it.
   *
   * Three pages had each written their own stricter copy of this to work around
   * that, with a comment in each naming this function as the durable home. This
   * is that home; the copies are gone.
   */
  function detectFrictionProfile(state) {
    const source = safeObject(state);
    const keys = Object.keys(frictionProfileValues(FRICTION_PROFILE_IDS[0])).filter(
      (key) => key !== "frictionProfile"
    );

    // Each key is resolved EXACTLY as readSettings resolves it, so an absent key
    // means here what it means everywhere else. Comparing raw storage instead
    // would call a profile "custom" merely because it had never written
    // `askIntent`, which is the default rather than a deviation.
    const normalizers = {
      timerSeconds: (value) => normalizeTimerSeconds(value),
      passDurationMinutes: (value) => normalizePassDurationMinutes(value),
      askIntent: (value) => value !== false,
      repeatFrictionEnabled: (value) => value !== false,
      repeatExtraSeconds: (value) => clampInt(value, 0, 120, FRICTION_PROFILES.standard.repeatExtraSeconds)
    };
    const valueOf = (key) => (normalizers[key] ? normalizers[key](source[key]) : source[key]);

    return (
      FRICTION_PROFILE_IDS.find((id) => {
        const preset = frictionProfileValues(id);
        return keys.every((key) => preset[key] === valueOf(key));
      }) || "custom"
    );
  }

  // The values a profile writes. Callers merge this into storage themselves so
  // this stays a pure description.
  function frictionProfileValues(id) {
    const profile = FRICTION_PROFILES[id];

    if (!profile) {
      return null;
    }

    return {
      frictionProfile: profile.id,
      timerSeconds: profile.timerSeconds,
      passDurationMinutes: profile.passDurationMinutes,
      askIntent: profile.askIntent,
      repeatFrictionEnabled: profile.repeatFrictionEnabled,
      repeatExtraSeconds: profile.repeatExtraSeconds
    };
  }

  // ===========================================================================
  // Schedules
  // ===========================================================================
  //
  // schedule = {
  //   mode: "always" | "windows",
  //   windows: [ { days: [0..6], start: "HH:MM", end: "HH:MM" } ],
  //   until: null | epochMs        // temporary override ("block until tomorrow")
  // }
  //
  // `days` uses JavaScript's getDay() numbering (0 = Sunday). A window whose end
  // is <= its start crosses midnight and is anchored to its START day, so
  // { days: [5], start: "22:00", end: "02:00" } means Friday 22:00 -> Saturday
  // 02:00. start === end means the whole of that day.
  //
  // Everything is evaluated against the LOCAL wall clock of the device. That is
  // what makes daylight-saving transitions behave the way a person expects: an
  // "evenings" window is 18:00-23:00 local before and after the shift, with no
  // remote time service and no stored offsets to go stale.

  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const WEEKDAYS = [1, 2, 3, 4, 5];
  const WEEKEND = [0, 6];
  const MAX_WINDOWS = 24;

  const SCHEDULE_PRESETS = {
    always: { id: "always", mode: "always", windows: [] },
    evenings: {
      id: "evenings",
      mode: "windows",
      windows: [{ days: ALL_DAYS.slice(), start: "18:00", end: "23:00" }]
    },
    lateNight: {
      id: "lateNight",
      mode: "windows",
      windows: [{ days: ALL_DAYS.slice(), start: "21:00", end: "03:00" }]
    },
    workdayLunch: {
      id: "workdayLunch",
      mode: "windows",
      windows: [{ days: WEEKDAYS.slice(), start: "11:00", end: "14:00" }]
    },
    eveningsAndWeekends: {
      id: "eveningsAndWeekends",
      mode: "windows",
      windows: [
        { days: WEEKDAYS.slice(), start: "18:00", end: "23:00" },
        { days: WEEKEND.slice(), start: "11:00", end: "23:59" }
      ]
    }
  };

  const SCHEDULE_PRESET_IDS = Object.keys(SCHEDULE_PRESETS);

  const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

  function normalizeTime(value, fallback) {
    const text = String(value == null ? "" : value).trim();
    const match = TIME_PATTERN.exec(text);

    if (!match) {
      return fallback;
    }

    return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
  }

  function timeToMinutes(value) {
    const normalized = normalizeTime(value, null);

    if (normalized === null) {
      return null;
    }

    const [hour, minute] = normalized.split(":").map(Number);
    return hour * 60 + minute;
  }

  function normalizeDays(value) {
    if (!Array.isArray(value)) {
      return ALL_DAYS.slice();
    }

    const days = [
      ...new Set(
        value
          .map((day) => Number.parseInt(day, 10))
          .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      )
    ].sort((a, b) => a - b);

    return days.length > 0 ? days : ALL_DAYS.slice();
  }

  function normalizeWindow(value) {
    if (!isPlainObject(value)) {
      return null;
    }

    const start = normalizeTime(value.start, null);
    const end = normalizeTime(value.end, null);

    if (start === null || end === null) {
      return null;
    }

    return { days: normalizeDays(value.days), start, end };
  }

  // Accepts anything (missing, malformed, legacy) and always returns a usable
  // schedule. Unparseable windows are dropped rather than crashing evaluation.
  function normalizeSchedule(value) {
    const source = safeObject(value);
    const windows = (Array.isArray(source.windows) ? source.windows : [])
      .map(normalizeWindow)
      .filter(Boolean)
      .slice(0, MAX_WINDOWS);

    const mode = source.mode === "windows" && windows.length > 0 ? "windows" : "always";
    const until = Number.isFinite(Number(source.until)) && Number(source.until) > 0 ? Number(source.until) : null;

    return { mode, windows, until };
  }

  // Build the schedule a pre-0.55 profile described with the three flat keys.
  // scheduleEnabled:false is preserved as mode "always" WITH the window intact,
  // so switching the schedule back on restores the user's original hours.
  function scheduleFromLegacy(state) {
    const source = safeObject(state);
    const start = normalizeTime(source.scheduleStart, DEFAULT_SCHEDULE_START);
    const end = normalizeTime(source.scheduleEnd, DEFAULT_SCHEDULE_END);

    return {
      mode: source.scheduleEnabled === true ? "windows" : "always",
      windows: [{ days: ALL_DAYS.slice(), start, end }],
      until: null
    };
  }

  /**
   * The flat trio (`scheduleEnabled` / `scheduleStart` / `scheduleEnd`) derived
   * FROM the canonical `schedule`.
   *
   * `schedule` is the single source of truth. The trio is a one-way projection
   * of it, kept because the popup, older builds, and the Android app all still
   * speak it. It is never read back to rebuild `schedule` unless it can express
   * it exactly (see `scheduleIsFlatExpressible`).
   *
   * `simple` says whether the simple start/end controls can honestly represent
   * this schedule at all. When it is false the schedule has more shape than two
   * time inputs can hold, and a surface that offers them anyway would silently
   * destroy the other windows the moment the user nudged one.
   */
  function scheduleToLegacy(schedule) {
    const normalized = normalizeSchedule(schedule);
    const single =
      normalized.mode === "windows" &&
      normalized.windows.length === 1 &&
      normalized.windows[0].days.length === ALL_DAYS.length
        ? normalized.windows[0]
        : null;

    return {
      scheduleEnabled: normalized.mode === "windows",
      scheduleStart: single ? single.start : DEFAULT_SCHEDULE_START,
      scheduleEnd: single ? single.end : DEFAULT_SCHEDULE_END,
      simple: normalized.mode === "always" || single !== null
    };
  }

  // Can the flat trio express this schedule without losing anything? Used by the
  // worker before it rebuilds `schedule` from the mirror, and by the UI before
  // it offers the simple controls.
  function scheduleIsFlatExpressible(schedule) {
    return scheduleToLegacy(schedule).simple;
  }

  // Is `now` inside this single window? Handles both same-day and overnight
  // (end <= start) forms, and start === end as "all day".
  function windowCoversMoment(window, now) {
    const startMinutes = timeToMinutes(window.start);
    const endMinutes = timeToMinutes(window.end);

    if (startMinutes === null || endMinutes === null) {
      return false;
    }

    const day = now.getDay();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const yesterday = (day + 6) % 7;

    if (startMinutes === endMinutes) {
      return window.days.includes(day);
    }

    if (startMinutes < endMinutes) {
      return window.days.includes(day) && minutes >= startMinutes && minutes < endMinutes;
    }

    // Overnight: the tail belongs to YESTERDAY's window, so a Friday-night
    // window keeps blocking at 01:00 on Saturday without also blocking Saturday
    // night.
    return (
      (window.days.includes(day) && minutes >= startMinutes) ||
      (window.days.includes(yesterday) && minutes < endMinutes)
    );
  }

  /**
   * Should blocking be enforced right now?
   * @param {object} schedule
   * @param {Date}   [now]
   * @returns {{ active: boolean, reason: string }}
   */
  function evaluateSchedule(schedule, now) {
    const at = now instanceof Date ? now : new Date();
    const normalized = normalizeSchedule(schedule);

    // "Always" is checked FIRST, and deliberately.
    //
    // The override branch used to run first, so pressing "Block until tomorrow"
    // on a default (always-on) profile changed nothing about what was enforced
    // while downgrading the reported state from "always" to "temporary" — the
    // status text went from "FitShield is on all the time" to a weaker claim
    // that implies it stops at midnight. A commitment button must never be able
    // to make the reported protection SMALLER than what is actually enforced.
    if (normalized.mode === "always") {
      return { active: true, reason: "always" };
    }

    // A temporary override ("block until tomorrow") wins while it lasts, then
    // expires on its own — it is stored as an absolute timestamp, so a browser
    // restart or a suspended worker cannot strand the user inside it.
    if (normalized.until !== null && normalized.until > at.getTime()) {
      return { active: true, reason: "temporary" };
    }

    const inWindow = normalized.windows.some((window) => windowCoversMoment(window, at));
    return { active: inWindow, reason: inWindow ? "window" : "outside" };
  }

  /**
   * Is a "block until tomorrow" override in force?
   *
   * The override is a commitment the user made to themselves, so the worker
   * refuses an all-scope ("pause everything") pass while it lasts — otherwise
   * one click on the very next block page turns blocking completely off while
   * Settings goes on reporting "Blocking everything until tomorrow." The master
   * switch is still an escape hatch, and the override expires on its own.
   */
  function scheduleOverrideActive(schedule, now) {
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const normalized = normalizeSchedule(schedule);

    return normalized.until !== null && normalized.until > at;
  }

  // Minutes past local midnight, on whatever local date `date` landed on.
  function localWallMinutes(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  /**
   * The instant of `minutes` past local midnight, `offsetDays` from `at`.
   *
   * setHours() on a wall-clock time that DOES NOT EXIST (the hour daylight
   * saving skips every spring) silently rolls forward: asking for 02:30 on a
   * spring-forward morning yields 03:30, an hour after the schedule actually
   * changed meaning. The worker arms one alarm from this value, so that hour is
   * an hour of blocking past the end of the user's window — against a settings
   * page that promises times "keep their meaning across daylight-saving
   * changes". When the requested time was skipped, bisect for the instant the
   * clock jumped instead, which is exactly when evaluateSchedule flips.
   */
  function localMomentAt(at, offsetDays, minutes) {
    const moment = new Date(at);
    moment.setDate(moment.getDate() + offsetDays);
    moment.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);

    if (localWallMinutes(moment) === minutes) {
      return moment.getTime();
    }

    const dayStart = new Date(moment);
    dayStart.setHours(0, 0, 0, 0);

    const reached = (time) => localWallMinutes(new Date(time)) >= minutes;

    let low = dayStart.getTime();
    let high = moment.getTime();

    if (reached(low) || low >= high) {
      return moment.getTime();
    }

    // Transitions land on whole minutes, so a minute-aligned bisection is exact.
    while (high - low > 60 * 1000) {
      const mid = low + Math.floor((high - low) / 120000) * 60000;

      if (mid <= low || mid >= high) {
        break;
      }

      if (reached(mid)) {
        high = mid;
      } else {
        low = mid;
      }
    }

    return high;
  }

  // The next moment the answer from evaluateSchedule could change, so the worker
  // can arm exactly one alarm. Searched forward over 8 local days, which keeps
  // the arithmetic in local wall-clock terms and therefore DST-correct.
  function nextScheduleBoundary(schedule, now) {
    const at = now instanceof Date ? now : new Date();
    const normalized = normalizeSchedule(schedule);
    const candidates = [];

    if (normalized.until !== null && normalized.until > at.getTime()) {
      candidates.push(normalized.until);
    }

    if (normalized.mode === "windows") {
      // An all-day window (start === end) does not change at either of its own
      // clock times — it changes at LOCAL MIDNIGHT, when the day rolls over.
      // Midnight was never a candidate, so "Mondays, all day" armed its next
      // alarm for Monday 18:00 a week later and left the redirect rules
      // installed through the whole of Tuesday.
      const hasAllDayWindow = normalized.windows.some((window) => {
        const start = timeToMinutes(window.start);
        const end = timeToMinutes(window.end);
        return start !== null && end !== null && start === end;
      });

      for (let offset = 0; offset <= 8; offset += 1) {
        normalized.windows.forEach((window) => {
          [window.start, window.end].forEach((time) => {
            const minutes = timeToMinutes(time);

            if (minutes === null) {
              return;
            }

            const moment = localMomentAt(at, offset, minutes);

            if (moment > at.getTime()) {
              candidates.push(moment);
            }
          });
        });

        if (hasAllDayWindow && offset > 0) {
          const midnight = localMomentAt(at, offset, 0);

          if (midnight > at.getTime()) {
            candidates.push(midnight);
          }
        }
      }
    }

    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  // Local midnight after `now` — the anchor for "until tomorrow" everywhere.
  function nextLocalMidnight(now) {
    const at = now instanceof Date ? now : new Date();
    const midnight = new Date(at);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime();
  }

  function schedulePresetValues(id) {
    const preset = SCHEDULE_PRESETS[id];

    if (!preset) {
      return null;
    }

    return {
      mode: preset.mode,
      windows: preset.windows.map((window) => ({ days: window.days.slice(), start: window.start, end: window.end })),
      until: null
    };
  }

  /**
   * ADD one day's windows to other days. Additive, never destructive.
   *
   * This used to strip the target days off every OTHER window first and drop
   * any window left with no days, so the control labelled "Copy to every day"
   * deleted every window the user had built for any other day — no
   * confirmation, no undo, and the button sits beside "Remove" in the same row.
   * A weekday-lunch plus weekend-evening schedule collapsed to one window.
   *
   * Copying now means what the label says: the source day's hours are added to
   * the target days and nothing else is touched. Adding a window can never lose
   * one, so this needs no confirmation to be safe.
   */
  function copyScheduleDay(schedule, fromDay, toDays) {
    const normalized = normalizeSchedule(schedule);
    const targets = normalizeDays(toDays).filter((day) => day !== fromDay);

    if (targets.length === 0) {
      return normalized;
    }

    const windows = normalized.windows.map((window) => ({
      start: window.start,
      end: window.end,
      days: window.days.includes(fromDay)
        ? normalizeDays([...window.days, ...targets])
        : window.days.slice()
    }));

    return normalizeSchedule({ mode: windows.length > 0 ? "windows" : "always", windows, until: normalized.until });
  }

  // ===========================================================================
  // Temporary passes
  // ===========================================================================
  //
  // A pass is a local, absolute-timestamped permission to reach something that
  // would otherwise be interrupted. Absolute timestamps (never "minutes
  // remaining") are what make expiry survive a browser restart, a suspended MV3
  // worker, system sleep, and an extension update: on every read we simply drop
  // anything whose expiry is in the past.
  //
  // A clock moved BACKWARDS would otherwise extend a pass indefinitely, so each
  // pass also records createdAt and a maxDurationMs; a pass whose apparent age
  // exceeds its own maximum is treated as expired regardless of the wall clock.

  // "category" stays a supported SCOPE even though no preset creates one any
  // more: a pass persisted by an earlier build under the retired `category30`
  // preset must keep running for the minutes it was granted, rather than being
  // silently widened or dropped out from under whoever took it.
  const PASS_SCOPES = ["site", "category", "all"];

  // Every preset is expressible as scope + duration, because that is all the
  // blocking layer can actually enforce: dynamic declarativeNetRequest rules are
  // global and give no callback when a request matches, so the worker cannot
  // observe a single visit and stand back down after it. A "one use only" pass
  // would need a browser-wide navigation listener, which is a permission and an
  // observation surface FitShield will not take for one option — so the option
  // says what it really is, a five-minute pass, rather than claiming a
  // single-use behaviour nothing implements.
  const PASS_PRESETS = {
    // The one preset with no fixed duration: it uses the user's own "Site open
    // time" setting. Before this existed, every preset hard-coded its minutes,
    // so `settings.passDurationMinutes` was unreachable and the slider in the
    // popup and in Settings did nothing at all while three surfaces quoted a
    // duration from it.
    siteDefault: { id: "siteDefault", scope: "site" },
    tab: { id: "tab", scope: "site", minutes: 720, tabBound: true },
    site10: { id: "site10", scope: "site", minutes: 10 },
    site30: { id: "site30", scope: "site", minutes: 30 },
    all30: { id: "all30", scope: "all", minutes: 30 },
    allTomorrow: { id: "allTomorrow", scope: "all", untilTomorrow: true }
    // There is deliberately no `category30`. It was defined here, exported,
    // published in docs/STORAGE.md as a state a profile could hold, and pinned
    // by a passing test — while no screen in the product could select it. A
    // preset no UI offers is not a feature, and a test for it reads as proof
    // that it ships. Reinstating a category pass means adding the option to the
    // block page's chooser first; the `category` scope below still works, so a
    // pass already granted under the old preset keeps running.
  };

  const PASS_PRESET_IDS = Object.keys(PASS_PRESETS);
  const MAX_PASSES = 200;

  let passCounter = 0;

  function makePassId(now) {
    passCounter += 1;
    return `p${now}-${passCounter}`;
  }

  /**
   * Build a pass record. Pure: the caller persists it.
   * @param {object} options { presetId, scope, target, minutes, tabId, now, reason }
   */
  function createPass(options) {
    const opts = safeObject(options);
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    const preset = PASS_PRESETS[opts.presetId] || null;
    const scope = PASS_SCOPES.includes(opts.scope)
      ? opts.scope
      : preset
        ? preset.scope
        : "site";

    const minutes = Number.isFinite(Number(opts.minutes))
      ? Math.min(1440, Math.max(1, Number(opts.minutes)))
      : preset && preset.minutes
        ? preset.minutes
        : DEFAULT_PASS_DURATION_MINUTES;

    const untilTomorrow = !!(preset && preset.untilTomorrow);
    const expiresAt = untilTomorrow ? nextLocalMidnight(new Date(now)) : now + minutes * 60 * 1000;

    return {
      id: makePassId(now),
      preset: preset ? preset.id : "custom",
      scope,
      target: scope === "all" ? "" : String(opts.target || "").trim().toLowerCase(),
      createdAt: now,
      expiresAt,
      // Guards against a backwards clock change stretching the pass.
      maxDurationMs: Math.max(60 * 1000, expiresAt - now),
      tabId: preset && preset.tabBound && Number.isInteger(opts.tabId) ? opts.tabId : null
      // Deliberately NO `reason`. The block page's "what brought you here?"
      // answer used to be stored here, which made the settings page's promise
      // that "the answer is never saved" false, and left a
      // {domain, exact timestamp, why I gave in} triple on disk — the most
      // sensitive thing this product could possibly keep. Nothing ever read it
      // back; the answer does its whole job in the page that asked.
    };
  }

  function normalizePass(value) {
    if (!isPlainObject(value)) {
      return null;
    }

    const expiresAt = Number(value.expiresAt);
    const createdAt = Number(value.createdAt);

    if (!Number.isFinite(expiresAt) || !Number.isFinite(createdAt)) {
      return null;
    }

    // The "once" / "site5" preset shim that used to sit here is gone. Those two
    // labels existed only inside 0.55's development and never shipped, and a pass
    // lives minutes to hours — so no profile can hold one. An unrecognised preset
    // still degrades to "custom" below with its scope, target and expiry intact,
    // which is what kept such a pass running in the first place.
    return {
      id: String(value.id || "").slice(0, 64) || `p${createdAt}`,
      preset: PASS_PRESET_IDS.includes(value.preset) ? value.preset : "custom",
      scope: PASS_SCOPES.includes(value.scope) ? value.scope : "site",
      target: String(value.target || "").trim().toLowerCase().slice(0, 253),
      createdAt,
      expiresAt,
      maxDurationMs: Number.isFinite(Number(value.maxDurationMs))
        ? Number(value.maxDurationMs)
        : Math.max(60 * 1000, expiresAt - createdAt),
      // A pass stored by an earlier build may carry `reason`; dropping it here
      // means the next write of the passes array erases it from disk.
      tabId: Number.isInteger(value.tabId) ? value.tabId : null
    };
  }

  /**
   * The passes that are still valid at `now`. This is the single place expiry is
   * decided; every caller filters through it, so a stale pass can never leak.
   * @param {Array}  passes
   * @param {number} [now]
   * @param {object} [options] { openTabIds: Set|Array }
   */
  function activePasses(passes, now, options) {
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const opts = safeObject(options);
    const openTabs = opts.openTabIds
      ? new Set(Array.isArray(opts.openTabIds) ? opts.openTabIds : [...opts.openTabIds])
      : null;

    return (Array.isArray(passes) ? passes : [])
      .map(normalizePass)
      .filter(Boolean)
      .filter((pass) => {
        if (pass.expiresAt <= at) {
          return false;
        }

        // Clock moved backwards (or the record was tampered with): a pass may
        // never outlive the duration it was granted for.
        if (at >= pass.createdAt && at - pass.createdAt > pass.maxDurationMs) {
          return false;
        }

        // Clock moved backwards past the grant: treat as expired rather than
        // trusting a future createdAt.
        if (at < pass.createdAt - 60 * 1000) {
          return false;
        }

        if (pass.tabId !== null && openTabs && !openTabs.has(pass.tabId)) {
          return false;
        }

        return true;
      })
      .slice(-MAX_PASSES);
  }

  /**
   * Does any active pass cover this destination?
   * @param {Array}  passes
   * @param {object} target { domain, category, tabId }
   * @param {number} [now]
   * @param {object} [options] passed through to activePasses
   * @returns {object|null} the covering pass
   */
  function findCoveringPass(passes, target, now, options) {
    const info = safeObject(target);
    const domain = String(info.domain || "").trim().toLowerCase();
    const category = String(info.category || "").trim().toLowerCase();

    return (
      activePasses(passes, now, options).find((pass) => {
        if (pass.tabId !== null && Number.isInteger(info.tabId) && pass.tabId !== info.tabId) {
          return false;
        }

        if (pass.scope === "all") {
          return true;
        }

        if (pass.scope === "category") {
          return !!category && pass.target === category;
        }

        return !!domain && (pass.target === domain || domain.endsWith(`.${pass.target}`));
      }) || null
    );
  }

  // ===========================================================================
  // Repeat-access friction
  // ===========================================================================
  //
  // Purpose: notice that this is the second time in a short window, say so, and
  // add a small fixed amount of pause. NOT to punish. There is exactly one
  // escalation step, it is capped, it is explained on the block page, and it can
  // be switched off. There is no exponential back-off and no hidden lockout.

  const DEFAULT_REPEAT_WINDOW_MINUTES = 60;
  const MAX_REPEAT_HISTORY_PER_DOMAIN = 12;
  const MAX_REPEAT_DOMAINS = 60;

  // How long a recorded continue is KEPT, as a multiple of the repeat window.
  //
  // This is the difference between "a short-lived behavioural window", which is
  // what the product says repeatHistory is, and a permanent per-brand diary of
  // exact millisecond timestamps, which is what it was: the caps were on COUNT
  // only (60 domains x 12 entries) and nothing ever expired, so a three-year-old
  // {"ubereats.com": [1723173263247, ...]} survived every read untouched. That
  // is browsing history of the most personal kind, on a product that promises it
  // stores none, readable by anyone with a moment at an unlocked machine.
  //
  // repeatFrictionFor already ignores anything older than the window, so the
  // only reason to keep it was that nothing deleted it. The multiple gives some
  // headroom if the user later lengthens their window, and is bounded: with the
  // maximum 720-minute window, nothing survives longer than 36 hours.
  const REPEAT_HISTORY_RETENTION_MULTIPLE = 3;

  function repeatWindowMinutesFor(value) {
    return clampInt(value, 5, 720, DEFAULT_REPEAT_WINDOW_MINUTES);
  }

  function repeatHistoryRetentionMs(windowMinutes) {
    return repeatWindowMinutesFor(windowMinutes) * REPEAT_HISTORY_RETENTION_MULTIPLE * 60 * 1000;
  }

  /**
   * Rebuild a repeat-history map defensively, dropping anything expired.
   *
   * @param {object} value
   * @param {object} [options] { now, windowMinutes } — WITHOUT a finite `now`
   *   this only fixes the shape, because a pure module must not invent a clock
   *   reading it was never handed.
   */
  function normalizeRepeatHistory(value, options) {
    const opts = safeObject(options);
    const source = safeObject(value);
    const at = Number.isFinite(Number(opts.now)) ? Number(opts.now) : null;
    const oldest = at === null ? null : at - repeatHistoryRetentionMs(opts.windowMinutes);
    // A timestamp far in the FUTURE (a tampered record, or one written while the
    // clock was wrong) would otherwise outlive every cutoff forever.
    const newest = at === null ? null : at + 60 * 1000;
    const out = {};

    Object.keys(source)
      .slice(-MAX_REPEAT_DOMAINS)
      .forEach((domain) => {
        const times = (Array.isArray(source[domain]) ? source[domain] : [])
          .map((time) => Number(time))
          .filter((time) => Number.isFinite(time) && time > 0)
          .filter((time) => oldest === null || (time >= oldest && time <= newest))
          .sort((a, b) => a - b)
          .slice(-MAX_REPEAT_HISTORY_PER_DOMAIN);

        if (times.length > 0) {
          out[domain] = times;
        }
      });

    return out;
  }

  // Record that the user deliberately continued to `domain`. Writing prunes, so
  // the stored map can never hold more than the retention window.
  function recordContinue(history, domain, now, options) {
    const opts = safeObject(options);
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const key = String(domain || "").trim().toLowerCase();
    const next = normalizeRepeatHistory(history, { now: at, windowMinutes: opts.windowMinutes });

    if (!key) {
      return next;
    }

    next[key] = [...(next[key] || []), at].slice(-MAX_REPEAT_HISTORY_PER_DOMAIN);
    return next;
  }

  /**
   * How much extra pause (if any) this visit earns, and why.
   * @returns {{ repeat: boolean, recentCount: number, extraSeconds: number, windowMinutes: number }}
   */
  function repeatFrictionFor(history, domain, settings, now) {
    const config = safeObject(settings);
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const windowMinutes = repeatWindowMinutesFor(config.repeatWindowMinutes);
    const none = { repeat: false, recentCount: 0, extraSeconds: 0, windowMinutes };

    if (config.repeatFrictionEnabled === false) {
      return none;
    }

    const key = String(domain || "").trim().toLowerCase();
    const times = normalizeRepeatHistory(history, { now: at, windowMinutes })[key] || [];
    const cutoff = at - windowMinutes * 60 * 1000;
    const recentCount = times.filter((time) => time >= cutoff && time <= at).length;

    if (recentCount < 1) {
      return none;
    }

    // One step only, and capped. Two visits and twenty visits earn the same
    // extra pause — the point is a noticeable nudge, not a penalty that grows.
    const extraSeconds = clampInt(config.repeatExtraSeconds, 0, 120, 20);

    return { repeat: extraSeconds > 0, recentCount, extraSeconds, windowMinutes };
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================
  //
  // Every counter here names an OBSERVED event. Nothing claims an order was
  // prevented, a meal was skipped, or money changed hands — FitShield cannot
  // observe any of those. "Selected" is an intent the user expressed on the block
  // page; "made" is a separate, voluntary confirmation that they cooked it.

  const STAT_EVENTS = [
    "interruptions",       // an ordering page was interrupted
    "left",                // the user went back
    "continued",           // the user deliberately continued to the site
    "passesUsed",          // a scoped temporary pass was granted
    "alternativesViewed",  // an alternative was shown
    "alternativesSelected",// the user picked one to make
    "alternativesMade"     // the user later confirmed they made it
  ];

  // WARNING to anyone building a surface from these: `continued` and
  // `passesUsed` are, today, ONE event under two names. Every exit from the
  // block page to the interrupted brand goes through grantPass, and grantPass is
  // the only writer of either counter, so the two numbers are mathematically
  // incapable of differing. They cannot be separated without observing a
  // navigation, which needs a permission and an observation surface FitShield
  // will not take.
  //
  // So: show ONE of them. Presenting both side by side as independent
  // measurements invites the reader to draw a conclusion from an agreement that
  // is guaranteed by construction, and pads the panel with a figure that is not
  // a second observation.

  const MAX_HISTORY_DAYS = 70;

  function localDayKey(now) {
    const at = now instanceof Date ? now : new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  }

  function emptyStatTotals() {
    const totals = {};
    STAT_EVENTS.forEach((event) => {
      totals[event] = 0;
    });
    return totals;
  }

  function normalizeStatTotals(value) {
    const source = safeObject(value);
    const totals = emptyStatTotals();

    STAT_EVENTS.forEach((event) => {
      const count = Number(source[event]);
      totals[event] = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    });

    return totals;
  }

  // A { key: positive integer } map, defensively rebuilt. Junk keys and values
  // are dropped rather than carried into the stats panel.
  function normalizeCountMap(value) {
    const source = safeObject(value);
    const out = {};

    Object.keys(source)
      .slice(0, 2000)
      .forEach((key) => {
        const count = Number(source[key]);

        if (key.trim() && Number.isFinite(count) && count > 0) {
          out[key] = Math.floor(count);
        }
      });

    return out;
  }

  function normalizeStatHistory(value) {
    return (Array.isArray(value) ? value : [])
      .map((entry) => {
        if (!isPlainObject(entry) || typeof entry.day !== "string") {
          return null;
        }

        return { day: entry.day.slice(0, 10), ...normalizeStatTotals(entry) };
      })
      .filter(Boolean)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
      .slice(-MAX_HISTORY_DAYS);
  }

  /**
   * Apply one event to the totals + per-day history. Pure.
   * @returns {{ totals: object, history: Array }}
   */
  function applyStatEvent(stats, event, now, amount) {
    const source = safeObject(stats);
    const totals = normalizeStatTotals(source.totals);
    const history = normalizeStatHistory(source.history);

    if (!STAT_EVENTS.includes(event)) {
      return { totals, history };
    }

    const by = Number.isFinite(Number(amount)) ? Math.max(1, Math.floor(Number(amount))) : 1;
    const day = localDayKey(now);

    totals[event] += by;

    const existing = history.find((entry) => entry.day === day);

    if (existing) {
      existing[event] += by;
    } else {
      history.push({ day, ...emptyStatTotals(), [event]: by });
    }

    return { totals, history: history.slice(-MAX_HISTORY_DAYS) };
  }

  /**
   * A local, non-judgmental summary of the last 7 local days.
   * Returns counts only — no scores, no streaks, no projections.
   *
   * It also returns ONLY figures from those seven days. It used to add a
   * `topCategory` computed from `blockedByCategory`, which is a lifetime running
   * map with no per-day buckets, and the surfaces printed it under a heading
   * that reads "This week" — so a customer who had not touched pizza in six
   * months was still told their most interrupted category this week was pizza.
   * It was the one row in the panel that could not be reconciled with the
   * others. The all-time breakdown is still shown, honestly labelled, in
   * Settings' "Most blocked categories" list, which reads `blockedByCategory`
   * directly. Restoring it here means bucketing category counts per local day
   * into `history` first, so the number comes from the same seven days as the
   * rest of the panel.
   */
  function weeklyRecap(stats, now) {
    const source = safeObject(stats);
    const history = normalizeStatHistory(source.history);
    const at = now instanceof Date ? now : new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());

    const days = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = new Date(at);
      day.setDate(day.getDate() - offset);
      days.push(localDayKey(day));
    }

    const totals = emptyStatTotals();
    days.forEach((day) => {
      const entry = history.find((item) => item.day === day);

      if (entry) {
        STAT_EVENTS.forEach((event) => {
          totals[event] += entry[event];
        });
      }
    });

    return {
      from: days[0],
      to: days[days.length - 1],
      totals,
      hasActivity: STAT_EVENTS.some((event) => totals[event] > 0)
    };
  }

  // ---------------------------------------------------------------------------
  // Custom blocked sites
  // ---------------------------------------------------------------------------
  //
  // Historically a bare string[]; now { domain, enabled } records. Both forms
  // are accepted because an old profile or an old backup can still hold either.
  //
  // This normalizer lives here, rather than being re-implemented in background.js
  // and settings.js, because `readSettings` did not handle `customSites` at all:
  // it spread the empty default and never overrode it, so a settings EXPORT then
  // IMPORT silently replaced every custom blocked domain with [] and reported
  // success. Anything readSettings does not know about, a backup loses.

  function normalizeCustomDomainValue(value) {
    const text = String(value == null ? "" : value).trim().toLowerCase();

    if (!text) {
      return "";
    }

    // Accept a pasted URL as well as a bare domain.
    const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    const host = withoutScheme.split(/[/?#]/)[0].replace(/^www\./, "").replace(/\.+$/, "");

    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : "";
  }

  function normalizeCustomSites(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const byDomain = new Map();

    value.slice(0, 500).forEach((entry) => {
      const source = typeof entry === "string" ? { domain: entry } : safeObject(entry);
      const domain = normalizeCustomDomainValue(source.domain);

      if (domain && !byDomain.has(domain)) {
        byDomain.set(domain, { domain, enabled: source.enabled !== false });
      }
    });

    return [...byDomain.values()];
  }

  // ===========================================================================
  // Pantry & equipment
  // ===========================================================================
  //
  // A preference list, NOT an inventory. There are no quantities, no purchase
  // dates, no expiry tracking, and no shopping history — the only question asked
  // is "is this usually in your kitchen?", and the only use is ranking.

  const PANTRY_ITEMS = [
    "eggs", "bread", "tortillas", "rice", "pasta", "canned beans", "canned soup",
    "canned tomatoes", "canned tuna", "frozen vegetables", "frozen meals",
    "frozen dumplings", "cheese", "yogurt", "milk", "chicken", "ground meat",
    "potatoes", "oats", "fruit", "peanut butter", "protein powder",
    "tomato sauce", "onion", "garlic", "seasonings", "olive oil", "soy sauce",
    "chickpeas", "lentils", "tofu", "noodles"
  ];

  const EQUIPMENT_ITEMS = ["microwave", "stove", "oven", "air fryer", "toaster", "blender", "rice cooker", "kettle"];

  // The nine allergens the catalog declares (tools/alternatives-audit.js enforces
  // that every entry's list is complete and drawn from exactly these). Unlike the
  // pantry, this is a HARD filter in the matcher: an entry carrying an avoided
  // allergen is never offered, at any position, under any filter.
  const ALLERGENS = ["gluten", "dairy", "egg", "peanut", "tree-nut", "soy", "fish", "shellfish", "sesame"];

  function normalizeAllergens(value) {
    const allowed = new Set(ALLERGENS);
    return toStringList(value, ALLERGENS.length)
      .map((item) => item.toLowerCase())
      .filter((item) => allowed.has(item));
  }

  // Equipment a kitchen is assumed to have when the user has said nothing. Chosen
  // so that an empty preference set never hides alternatives.
  const DEFAULT_EQUIPMENT = ["microwave", "stove", "oven", "toaster", "kettle"];

  function normalizePantry(value) {
    const allowed = new Set(PANTRY_ITEMS);
    return toStringList(value, PANTRY_ITEMS.length)
      .map((item) => item.toLowerCase())
      .filter((item) => allowed.has(item));
  }

  function normalizeEquipment(value) {
    const allowed = new Set(EQUIPMENT_ITEMS);
    const list = toStringList(value, EQUIPMENT_ITEMS.length)
      .map((item) => item.toLowerCase())
      .filter((item) => allowed.has(item));

    return list.length > 0 ? list : DEFAULT_EQUIPMENT.slice();
  }

  // ===========================================================================
  // Diets
  // ===========================================================================

  const DIETS = ["omnivore", "vegetarian", "vegan", "pescatarian"];

  function normalizeDietPreference(value) {
    const text = String(value || "").trim().toLowerCase();
    return DIETS.includes(text) ? text : "omnivore";
  }

  // ===========================================================================
  // Custom alternatives (user-authored)
  // ===========================================================================
  //
  // Everything here is treated as hostile text. Values are length-capped and
  // stored as plain strings; rendering is done exclusively with textContent by
  // the UI, so nothing typed here can become markup or script. Only fields we
  // recognise survive, which also blocks prototype-pollution payloads.

  const CUSTOM_LIMITS = {
    name: 80,
    description: 200,
    ingredient: 80,
    step: 240,
    ingredients: 30,
    steps: 12,
    tags: 12,
    total: 60
  };

  function cleanText(value, max) {
    return String(value == null ? "" : value)
      // Control characters have no place in a recipe name and can break logs.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  /**
   * Validate + normalize one user-authored alternative.
   * @returns {{ ok: boolean, errors: string[], value: object|null }}
   */
  function sanitizeCustomAlternative(input, options) {
    const source = safeObject(input);
    const opts = safeObject(options);
    const errors = [];

    const name = cleanText(source.name || source.title, CUSTOM_LIMITS.name);

    if (!name) {
      errors.push("nameRequired");
    }

    const ingredients = (Array.isArray(source.ingredients) ? source.ingredients : [])
      .map((item) => (isPlainObject(item) ? cleanText(item.text || item.name, CUSTOM_LIMITS.ingredient) : cleanText(item, CUSTOM_LIMITS.ingredient)))
      .filter(Boolean)
      .slice(0, CUSTOM_LIMITS.ingredients);

    const steps = (Array.isArray(source.steps) ? source.steps : [])
      .map((step) => cleanText(step, CUSTOM_LIMITS.step))
      .filter(Boolean)
      .slice(0, CUSTOM_LIMITS.steps);

    if (steps.length === 0) {
      errors.push("stepsRequired");
    }

    const totalMinutes = clampInt(source.totalMinutes, 1, 24 * 60, 10);
    const equipment = normalizeEquipment(source.equipment).slice(0, EQUIPMENT_ITEMS.length);
    const diet = normalizeDietPreference(source.diet === "omnivore" ? "omnivore" : source.diet);

    if (errors.length > 0) {
      return { ok: false, errors, value: null };
    }

    const id = String(source.id || "").trim().slice(0, 64) || `custom-${Date.now().toString(36)}-${Math.floor((opts.seq || 0))}`;

    return {
      ok: true,
      errors: [],
      value: {
        id,
        kind: "custom",
        title: name,
        description: cleanText(source.description, CUSTOM_LIMITS.description),
        ingredients,
        steps,
        totalMinutes,
        activeMinutes: clampInt(source.activeMinutes, 1, totalMinutes, Math.min(totalMinutes, 10)),
        equipment,
        diet,
        categories: toStringList(source.categories, CUSTOM_LIMITS.tags).map((tag) => tag.toLowerCase().slice(0, 40)),
        cravings: toStringList(source.cravings, CUSTOM_LIMITS.tags).map((tag) => tag.toLowerCase().slice(0, 40)),
        favorite: source.favorite === true,
        createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now()
      }
    };
  }

  function normalizeCustomAlternatives(value) {
    return (Array.isArray(value) ? value : [])
      .slice(0, CUSTOM_LIMITS.total)
      .map((entry, index) => sanitizeCustomAlternative(entry, { seq: index }))
      .filter((result) => result.ok)
      .map((result) => result.value);
  }

  // ===========================================================================
  // Theme mode
  // ===========================================================================
  //
  // Only the PURE part lives here: which mode is selected, what a mode's colours
  // are, and whether a stored theme is still one of the presets. Actually
  // applying a theme stays in each page, because the pages legitimately expose
  // different CSS variables (the popup has --popup-width, the block page has
  // --accent-dim, and so on).
  //
  // This was duplicated byte-for-byte between popup.js and settings.js. Theme
  // mode is exactly the kind of thing that must not drift between two surfaces:
  // if the popup and the settings page disagree about what "system" resolves to,
  // the user sees two different themes in the same product.

  /**
   * The narrowest layout FitShield supports, in CSS pixels.
   *
   * Stated once here, mirrored by `--fs-min-layout-width` in
   * extension/fitshield-layout.css and by the "Popup width" slider's `min`
   * attribute in settings.html. A test fails if the three disagree.
   *
   * 420 is not a new number: it is what that slider has always offered as its
   * narrowest popup, so it is the narrowest width the product already asks a
   * user to accept.
   */
  const MIN_LAYOUT_WIDTH = 420;

  /**
   * The popup-width range, matching the slider that sets it.
   *
   * normalizeTheme used to clamp this to 0..1000 while the only control that
   * writes it offered 420..620 — so a hand-edited profile or an imported backup
   * could carry `popupWidth: 12`, and the popup rendered 12 pixels wide with
   * nothing to stop it. The CSS floor now catches that visually; clamping here
   * means the stored value and the control that edits it finally agree.
   */
  const MAX_POPUP_WIDTH = 620;

  const DEFAULT_THEME_MODE = "dark";
  const THEME_MODE_OPTIONS = ["system", "light", "dark"];
  const THEME_MODE_COLOR_KEYS = ["bg", "panel", "border", "text", "muted", "accent"];

  const THEME_MODE_PRESETS = {
    dark: {
      bg: "#0f141b",
      panel: "#1a212b",
      border: "#2c3644",
      text: "#edf2f7",
      muted: "#a9b4c2",
      accent: "#7ef0a8"
    },
    light: {
      bg: "#f4f6fa",
      panel: "#ffffff",
      border: "#d6dde6",
      text: "#1b2430",
      muted: "#5a6675",
      accent: "#15a05a"
    }
  };

  function normalizeThemeMode(mode) {
    return THEME_MODE_OPTIONS.includes(mode) ? mode : DEFAULT_THEME_MODE;
  }

  // Every theme value is written straight into a CSS custom property by the
  // pages, so an imported backup could smuggle `a remote url() value` into one and
  // make the settings page and popup fetch a remote resource — a beacon on a
  // product that promises it makes no network requests. Only literal colours and
  // the two numeric layout values survive; anything else falls back.
  const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%deg]+\))$/i;

  function normalizeTheme(value) {
    const source = safeObject(value);
    const out = {};

    Object.keys(source).forEach((key) => {
      const raw = source[key];

      if (key === "popupWidth") {
        const number = Number(raw);

        if (Number.isFinite(number)) {
          out[key] = Math.min(MAX_POPUP_WIDTH, Math.max(MIN_LAYOUT_WIDTH, Math.round(number)));
        }

        return;
      }

      if (key === "radius") {
        const number = Number(raw);

        if (Number.isFinite(number)) {
          out[key] = Math.min(1000, Math.max(0, Math.round(number)));
        }

        return;
      }

      if (typeof raw === "string" && COLOR_PATTERN.test(raw.trim())) {
        out[key] = raw.trim();
      }
    });

    return out;
  }

  /**
   * Which concrete theme a mode resolves to.
   * @param {string} mode
   * @param {boolean} [prefersLight] the OS preference; the caller reads matchMedia
   *   so this stays free of the DOM and therefore testable.
   */
  function resolveThemeMode(mode, prefersLight) {
    const normalized = normalizeThemeMode(mode);
    return normalized === "system" ? (prefersLight ? "light" : "dark") : normalized;
  }

  function themeMatchesPreset(theme, preset) {
    return THEME_MODE_COLOR_KEYS.every((key) => {
      const value = theme && theme[key];
      return typeof value === "string" && value.toLowerCase() === preset[key];
    });
  }

  // True when a stored theme is still an untouched preset, so following the OS is
  // safe. Once the user has hand-picked colours, "system" must not overwrite them.
  function shouldUseResolvedPreset(theme, mode) {
    return (
      normalizeThemeMode(mode) === "system" &&
      (!theme || themeMatchesPreset(theme, THEME_MODE_PRESETS.dark) || themeMatchesPreset(theme, THEME_MODE_PRESETS.light))
    );
  }

  function hexToRgba(hex, alpha) {
    const normalized = String(hex || "").replace("#", "");
    const expanded = normalized.length === 3
      ? normalized.split("").map((char) => char + char).join("")
      : normalized;
    const red = Number.parseInt(expanded.slice(0, 2), 16);
    const green = Number.parseInt(expanded.slice(2, 4), 16);
    const blue = Number.parseInt(expanded.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  // ===========================================================================
  // Problem reports
  // ===========================================================================
  //
  // A report is composed locally and only ever leaves the device if the user
  // sends it themselves. This reduces whatever they typed to the smallest thing
  // that is still useful to a maintainer: a bare hostname. Paths, query strings,
  // fragments, ports, and credentials are all discarded, because those are the
  // parts that can carry an order id, a search term, or a session token.

  function redactReportSubject(value) {
    const text = String(value == null ? "" : value).trim();

    if (!text) {
      return "";
    }

    const looksLikeUrl = text.includes("://");

    try {
      const url = new URL(looksLikeUrl ? text : `https://${text}`);
      // Strip "www.", a trailing root dot, and the brackets an IPv6 literal
      // carries. What is left is a host and nothing else.
      const host = url.hostname
        .replace(/^www\./, "")
        .replace(/\.+$/, "")
        .replace(/^\[|\]$/g, "")
        .toLowerCase();

      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
        return host;
      }

      // Anything carrying a scheme, a path, a query, or a fragment is a URL,
      // whatever its host looks like — and the note printed above the field
      // promises unconditionally that "Query strings are stripped and only the
      // domain is included". The host test above rejects IP literals
      // ("192.168.1.50"), single-label hosts ("localhost"), and fully-qualified
      // names with a trailing dot, and the fallback below returns the input
      // VERBATIM: an intranet or router-hosted ordering page went into the mail
      // draft complete with its session token. Every URL is now reduced to its
      // host, and only free text reaches the fallback.
      const carriedMoreThanAHost =
        looksLikeUrl || url.pathname !== "/" || url.search !== "" || url.hash !== "";

      if (host && carriedMoreThanAHost) {
        return cleanText(host, 120);
      }
    } catch (error) {
      // Not a URL — fall through and treat it as a plain label.
    }

    // Reached only by input with no scheme that did not parse as a host: a
    // free-text label like "the checkout page", which carries no URL to strip.
    return cleanText(text, 120);
  }

  // ===========================================================================
  // Recently-shown rotation
  // ===========================================================================

  const MAX_RECENT_SHOWN = 24;
  const MAX_DISMISSED = 24;

  function normalizeIdList(value, limit) {
    return toStringList(value, limit).map((id) => id.slice(0, 64));
  }

  function pushRecent(list, id, limit) {
    const clean = String(id || "").trim().slice(0, 64);
    const max = limit || MAX_RECENT_SHOWN;

    if (!clean) {
      return normalizeIdList(list, max);
    }

    return normalizeIdList([...(Array.isArray(list) ? list : []).filter((item) => item !== clean), clean], max);
  }

  // ===========================================================================
  // Defaults + migrations
  // ===========================================================================

  // The complete default profile. Anything absent from storage reads as this.
  function defaultState() {
    return {
      [SCHEMA_KEY]: SCHEMA_VERSION,

      enabled: true,
      timerSeconds: DEFAULT_TIMER_SECONDS,
      passDurationMinutes: DEFAULT_PASS_DURATION_MINUTES,

      frictionProfile: "standard",
      askIntent: true,
      repeatFrictionEnabled: true,
      repeatExtraSeconds: 20,
      repeatWindowMinutes: DEFAULT_REPEAT_WINDOW_MINUTES,

      schedule: { mode: "always", windows: [], until: null },

      deliverySitesEnabled: true,
      fastFoodSitesEnabled: true,
      customSitesEnabled: true,
      disabledDeliverySiteKeys: [],
      disabledFastFoodSiteKeys: [],
      customSites: [],
      enabledCountries: [],
      enabledCategories: [],
      quickAccessCountries: [],
      quickAccessCategories: [],

      passes: [],
      repeatHistory: {},

      dietPreference: "omnivore",
      pantry: [],
      equipment: DEFAULT_EQUIPMENT.slice(),
      avoidAllergens: [],
      alternativeFavorites: [],
      recentAlternatives: [],
      dismissedAlternatives: [],
      customAlternatives: [],

      stats: { totals: emptyStatTotals(), history: [] },
      blockedByDomain: {},
      blockedByCategory: {},
      blockedByCountry: {},

      showEstimates: false,
      recapEnabled: true
      // No `recapDismissedFor`. It was defaulted here, normalized in
      // readSettings, listed in the worker's settings keys, excluded from
      // backups and cleared by the reset — five files carrying a key that
      // nothing ever read or wrote, implying a "dismiss this week's recap"
      // behaviour the build does not have. The recap is gated by `recapEnabled`,
      // which is real.
    };
  }

  // ---------------------------------------------------------------------------
  // Recovering a pre-0.55 site key
  // ---------------------------------------------------------------------------
  //
  // 0.54 built its `siteBypasses` keys with domainToKey, which flattens EVERY
  // run of non-alphanumeric characters — dots and hyphens alike — to a single
  // "-". So "doordash.com" and "just-eat.com" both become "<bucket>-…-com" and
  // the mapping is not reversible on its own: the old code simply replaced every
  // "-" with ".", which turned "delivery-just-eat-com" into "just.eat.com" — a
  // host that does not exist. findCoveringPass then matched nothing, so the pass
  // was shown as active and blocked the user anyway. 128 of the catalog's
  // domains contain a hyphen.
  //
  // Instead of inventing a host, enumerate the readings the key could have had
  // and let the caller confirm one against the real blocklist.

  function legacyBypassDomainCandidates(siteKey) {
    const withoutBucket = String(siteKey || "").replace(/^(delivery|fast-food|fast_food|custom|site)-/, "");
    const parts = withoutBucket.split("-");

    // A key with no separator carries no TLD, and an empty part means the key
    // was not written by domainToKey at all.
    if (parts.length < 2 || parts.some((part) => part === "")) {
      return [];
    }

    const gaps = parts.length - 1;

    // 2^gaps readings. A pathological key must not turn into a huge array.
    if (gaps > 8) {
      return [];
    }

    const candidates = [];

    for (let mask = 0; mask < 1 << gaps; mask += 1) {
      let host = parts[0];

      for (let index = 0; index < gaps; index += 1) {
        host += (mask & (1 << index)) === 0 ? "." : "-";
        host += parts[index + 1];
      }

      candidates.push(host);
    }

    // mask 0 is the all-dots reading, so it is tried first.
    return candidates;
  }

  /**
   * @param {string} siteKey
   * @param {Function} [resolve] (domain) => boolean — "is this a real blocked
   *   brand?". The worker passes a lookup into the loaded catalog.
   * @returns {string} the recovered domain, or "" when it cannot be known.
   */
  function recoverLegacyBypassDomain(siteKey, resolve) {
    const candidates = legacyBypassDomainCandidates(siteKey);

    if (candidates.length === 0) {
      return "";
    }

    if (typeof resolve === "function") {
      const matched = candidates.find((candidate) => {
        try {
          return resolve(candidate) === true;
        } catch (error) {
          return false;
        }
      });

      return matched || "";
    }

    // No catalog to check against. Accept only the one reading that cannot be
    // ambiguous: a single separator can only ever have been the dot before the
    // TLD ("doordash-com" -> "doordash.com"). Anything else is dropped rather
    // than guessed — the original map is kept at legacy.siteBypasses either way.
    return candidates.length === 2 ? candidates[0] : "";
  }

  // ---------------------------------------------------------------------------
  // Migration steps. Each is [fromVersion, fn(state) -> state]. They run in
  // order, are idempotent, and must tolerate missing and malformed input. A step
  // NEVER deletes a key it does not understand: anything it cannot interpret is
  // preserved under `legacy.<key>` so it can be recovered.
  // ---------------------------------------------------------------------------

  function migrateV1toV2(state, options) {
    const opts = safeObject(options);
    const next = { ...state };
    const legacy = safeObject(next.legacy);

    // Custom sites: the oldest profiles stored bare strings.
    if (Array.isArray(next.customSites)) {
      next.customSites = next.customSites
        .map((entry) => {
          if (typeof entry === "string") {
            return { domain: entry.trim().toLowerCase(), enabled: true };
          }

          if (isPlainObject(entry) && typeof entry.domain === "string") {
            return { domain: entry.domain.trim().toLowerCase(), enabled: entry.enabled !== false };
          }

          return null;
        })
        .filter((entry) => entry && entry.domain);
    }

    // Schedule: three flat keys become one structured object. The flat keys are
    // deliberately LEFT IN PLACE — an older build reading this profile still
    // finds the window it understands.
    if (!isPlainObject(next.schedule)) {
      next.schedule = scheduleFromLegacy(next);
    }

    // Friction: infer the closest preset from the timer the user already chose,
    // without changing any of their numbers.
    if (typeof next.frictionProfile !== "string") {
      const seconds = normalizeTimerSeconds(next.timerSeconds);
      next.frictionProfile = seconds <= 30 ? "light" : seconds <= 90 ? "standard" : "strict";
    }

    // Passes: the per-key expiry map becomes scoped pass records. The map used
    // site KEYS ("delivery-doordash-com"), not domains, and the key format is not
    // reversible, so these are carried as site-scoped passes keyed by the
    // recovered domain where possible and preserved verbatim otherwise.
    if (!Array.isArray(next.passes)) {
      const bypasses = safeObject(next.siteBypasses);
      next.passes = Object.keys(bypasses)
        .map((siteKey) => {
          const expiresAt = Number(bypasses[siteKey]);

          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            return null;
          }

          // "delivery-doordash-com" -> "doordash.com", checked against the real
          // catalog where one is available. A key whose domain cannot be known
          // is DROPPED rather than pointed at a host that does not exist: a pass
          // with a wrong target is shown as active and blocks the user anyway,
          // which is worse than no pass at all. legacy.siteBypasses below keeps
          // the original either way.
          const domain = recoverLegacyBypassDomain(siteKey, opts.resolveDomain);

          if (!domain) {
            return null;
          }

          return {
            id: `migrated-${siteKey}`,
            preset: "custom",
            scope: "site",
            target: domain,
            createdAt: Math.min(Date.now(), expiresAt),
            expiresAt,
            maxDurationMs: Math.max(60 * 1000, expiresAt - Date.now()),
            tabId: null,
            // no `reason`: see createPass
          };
        })
        .filter(Boolean);

      if (Object.keys(bypasses).length > 0) {
        legacy.siteBypasses = bypasses;
      }
    }

    // Statistics. The old counters are TRANSLATED, never discarded:
    //   blockedVisits  -> stats.totals.interruptions   (same observed event)
    //   recipesChosen  -> stats.totals.alternativesSelected
    // The originals stay in place so nothing a user has watched grow disappears,
    // and caloriesAvoided is preserved verbatim: it is no longer a headline
    // number, but it is their data.
    if (!isPlainObject(next.stats)) {
      const totals = emptyStatTotals();
      const blockedVisits = Number(next.blockedVisits);
      const recipesChosen = Number(next.recipesChosen);

      totals.interruptions = Number.isFinite(blockedVisits) && blockedVisits > 0 ? Math.floor(blockedVisits) : 0;
      totals.alternativesSelected = Number.isFinite(recipesChosen) && recipesChosen > 0 ? Math.floor(recipesChosen) : 0;

      next.stats = { totals, history: [] };
    }

    if (Number.isFinite(Number(next.caloriesAvoided)) && Number(next.caloriesAvoided) > 0) {
      legacy.caloriesAvoided = Number(next.caloriesAvoided);
      // The estimate panel stays available, but it is opt-in from now on and is
      // labelled as an estimate rather than an outcome.
      if (typeof next.showEstimates !== "boolean") {
        next.showEstimates = true;
      }
    }

    // recipeFavorites was written by nothing; if a profile somehow has one, keep
    // the ids as alternative favorites rather than dropping them.
    if (Array.isArray(next.recipeFavorites) && !Array.isArray(next.alternativeFavorites)) {
      next.alternativeFavorites = normalizeIdList(next.recipeFavorites, 200);
    }

    if (Object.keys(legacy).length > 0) {
      next.legacy = legacy;
    }

    next[SCHEMA_KEY] = 2;
    return next;
  }

  const MIGRATIONS = [[1, migrateV1toV2]];

  function storedVersion(state) {
    const version = Number(safeObject(state)[SCHEMA_KEY]);
    return Number.isInteger(version) && version >= 1 ? version : 1;
  }

  /**
   * Bring a stored profile up to SCHEMA_VERSION.
   *
   * Idempotent (running it twice changes nothing), versioned, safe on missing
   * and malformed data, and safe across several versions at once because the
   * steps run in order. If any step throws, the ORIGINAL state is returned
   * untouched and the failure is reported — a broken migration must never reset
   * a user's data.
   *
   * @param {object} [options] { resolveDomain } — an optional
   *   (domain) => boolean lookup into the real blocklist, used to recover the
   *   host behind a pre-0.55 site key. Absent, ambiguous keys are dropped.
   * @returns {{ state: object, from: number, to: number, changed: boolean, notes: string[], error: string|null }}
   */
  function migrateState(state, options) {
    const source = safeObject(state);
    const from = storedVersion(source);
    const notes = [];

    if (from >= SCHEMA_VERSION) {
      return { state: source, from, to: from, changed: false, notes, error: null };
    }

    let working = source;

    try {
      MIGRATIONS.forEach(([version, step]) => {
        if (storedVersion(working) === version) {
          working = step(working, options);
          notes.push(`migrated schema ${version} -> ${storedVersion(working)}`);
        }
      });
    } catch (error) {
      return {
        state: source,
        from,
        to: from,
        changed: false,
        notes,
        error: String((error && error.message) || error)
      };
    }

    return { state: working, from, to: storedVersion(working), changed: true, notes, error: null };
  }

  /**
   * Read a raw storage snapshot as a fully normalized settings object. Every
   * consumer goes through this, so a missing or junk value can never mean
   * something different in two places.
   */
  /**
   * Every storage key `readSettings` reads — and therefore the exact set a caller
   * needs to fetch before calling it.
   *
   * It lives here because it is a property of readSettings, and because the two
   * callers that need it were each solving the problem differently and wrongly:
   * background.js kept its own hand-maintained copy (which still listed
   * `siteBypasses`, a key readSettings drops), and preferences.js gave up and
   * called `storage.local.get(null)` — pulling the whole profile, including the
   * three unbounded lifetime `blockedBy*` count maps, on every preference save.
   *
   * A test asserts that readSettings(get(SETTINGS_KEYS)) equals
   * readSettings(get(null)) for a populated profile, so this cannot drift out of
   * step with what readSettings actually reads.
   */
  const SETTINGS_KEYS = [
    SCHEMA_KEY,
    "enabled",
    "timerSeconds",
    "passDurationMinutes",
    "frictionProfile",
    "askIntent",
    "repeatFrictionEnabled",
    "repeatExtraSeconds",
    "schedule",
    "scheduleEnabled",
    "scheduleStart",
    "scheduleEnd",
    "deliverySitesEnabled",
    "fastFoodSitesEnabled",
    "customSitesEnabled",
    "disabledDeliverySiteKeys",
    "disabledFastFoodSiteKeys",
    "customSites",
    "passes",
    "repeatHistory",
    "enabledCountries",
    "enabledCategories",
    "quickAccessCountries",
    "quickAccessCategories",
    "dietPreference",
    "pantry",
    "equipment",
    "avoidAllergens",
    "alternativeFavorites",
    "recentAlternatives",
    "dismissedAlternatives",
    "customAlternatives",
    "stats",
    "showEstimates",
    "recapEnabled",

    // readSettings normalizes these too, so a caller that omits them gets a
    // defaulted value rather than the user's. background.js's hand-maintained
    // copy of this list omitted all five — exactly the drift the paired test
    // exists to catch.
    "blockedByDomain",
    "blockedByCategory",
    "blockedByCountry",
    "theme",
    "themeMode"
  ];

  function readSettings(raw, options) {
    const defaults = defaultState();
    const source = safeObject(raw);
    const opts = safeObject(options);
    const get = (key) => (Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined);

    // Expiry is decided on READ, for passes and for repeat history alike, so a
    // profile that is simply left alone cannot keep either past its lifetime.
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    // NOT read from storage. `repeatWindowMinutes` was read in six places and
    // written by nothing: no control offers it, no friction preset sets it, and
    // `onInstalled` does not seed it — so the only value it could ever hold was
    // this default, while it was carried in every backup, listed as a setting,
    // and named by a reset button. A value no code path can set is not a
    // setting; it is a constant with a misleading amount of machinery around it.
    // It stays a named constant because it is a real part of the repeat-friction
    // rule and of how long repeat history is kept, and it is documented as such
    // in docs/STORAGE.md. Adding a control for it means adding the control AND
    // reading the key back here, together.
    const repeatWindowMinutes = DEFAULT_REPEAT_WINDOW_MINUTES;

    const schedule = isPlainObject(get("schedule"))
      ? normalizeSchedule(get("schedule"))
      : normalizeSchedule(scheduleFromLegacy(source));

    return {
      ...defaults,
      enabled: get("enabled") !== false,
      timerSeconds: normalizeTimerSeconds(get("timerSeconds")),
      passDurationMinutes: normalizePassDurationMinutes(get("passDurationMinutes")),

      frictionProfile: FRICTION_PROFILE_IDS.includes(get("frictionProfile"))
        ? get("frictionProfile")
        : detectFrictionProfile(source),
      askIntent: get("askIntent") !== false,
      repeatFrictionEnabled: get("repeatFrictionEnabled") !== false,
      repeatExtraSeconds: clampInt(get("repeatExtraSeconds"), 0, 120, defaults.repeatExtraSeconds),
      repeatWindowMinutes,

      schedule,

      // The flat trio, PROJECTED from the canonical schedule rather than read
      // from storage. Every surface renders from readSettings, and because these
      // three were missing the popup and Settings both destructured their own
      // defaults — so a user whose schedule was 19:30-02:00 was shown "off,
      // 18:00-23:00" while the worker enforced their real window. `scheduleSimple`
      // tells a surface whether two time inputs can represent this schedule at
      // all, so it can stop offering controls that would destroy the rest of it.
      ...(() => {
        const legacy = scheduleToLegacy(schedule);
        return {
          scheduleEnabled: legacy.scheduleEnabled,
          scheduleStart: legacy.scheduleStart,
          scheduleEnd: legacy.scheduleEnd,
          scheduleSimple: legacy.simple
        };
      })(),

      deliverySitesEnabled: get("deliverySitesEnabled") !== false,
      fastFoodSitesEnabled: get("fastFoodSitesEnabled") !== false,
      customSitesEnabled: get("customSitesEnabled") !== false,
      // Was absent, so an export/import round trip replaced every custom blocked
      // domain with the empty default and called it a success.
      customSites: normalizeCustomSites(get("customSites")),
      disabledDeliverySiteKeys: toStringList(get("disabledDeliverySiteKeys"), 5000),
      disabledFastFoodSiteKeys: toStringList(get("disabledFastFoodSiteKeys"), 5000),
      enabledCountries: toStringList(get("enabledCountries"), 500),
      enabledCategories: toStringList(get("enabledCategories"), 500),
      quickAccessCountries: toStringList(get("quickAccessCountries"), 100),
      quickAccessCategories: toStringList(get("quickAccessCategories"), 100),

      passes: activePasses(get("passes"), now),
      // Pruned to its retention window here, so every consumer — including the
      // worker, which writes the result straight back — sees a map that has
      // actually aged out rather than one that only ever grew to its count caps.
      repeatHistory: normalizeRepeatHistory(get("repeatHistory"), { now, windowMinutes: repeatWindowMinutes }),

      dietPreference: normalizeDietPreference(get("dietPreference")),
      pantry: normalizePantry(get("pantry")),
      equipment: normalizeEquipment(get("equipment")),
      // Was missing entirely, so the chips in Settings saved a value that
      // readSettings then dropped: getBlockContext handed the block page
      // `undefined` and the matcher's hard allergen filter never ran. A user who
      // ticked "peanut" was still shown peanut recipes.
      avoidAllergens: normalizeAllergens(get("avoidAllergens")),
      alternativeFavorites: normalizeIdList(get("alternativeFavorites"), 200),
      recentAlternatives: normalizeIdList(get("recentAlternatives"), MAX_RECENT_SHOWN),
      dismissedAlternatives: normalizeIdList(get("dismissedAlternatives"), MAX_DISMISSED),
      customAlternatives: normalizeCustomAlternatives(get("customAlternatives")),

      stats: {
        totals: normalizeStatTotals(safeObject(get("stats")).totals),
        history: normalizeStatHistory(safeObject(get("stats")).history)
      },

      // Aggregate brand breakdowns. Counts only, keyed by curated blocklist
      // metadata — never a URL, path, or anything from the user's history.
      blockedByDomain: normalizeCountMap(get("blockedByDomain")),
      blockedByCategory: normalizeCountMap(get("blockedByCategory")),
      blockedByCountry: normalizeCountMap(get("blockedByCountry")),

      showEstimates: get("showEstimates") === true,
      recapEnabled: get("recapEnabled") !== false,
      // Colours only. Every value here is written into a CSS custom property, so
      // an imported backup could otherwise smuggle a remote url() value into one and
      // make the settings page fetch a remote resource.
      theme: normalizeTheme(get("theme")),
      themeMode: normalizeThemeMode(get("themeMode"))
    };
  }

  const api = {
    // schema
    SCHEMA_VERSION,
    SCHEMA_KEY,
    defaultState,
    migrateState,
    readSettings,
    SETTINGS_KEYS,
    storedVersion,
    recoverLegacyBypassDomain,

    // limits
    MIN_TIMER_SECONDS,
    MAX_TIMER_SECONDS,
    DEFAULT_TIMER_SECONDS,
    MIN_PASS_DURATION_MINUTES,
    MAX_PASS_DURATION_MINUTES,
    DEFAULT_PASS_DURATION_MINUTES,
    normalizeTimerSeconds,
    normalizePassDurationMinutes,

    // friction
    FRICTION_PROFILES,
    FRICTION_PROFILE_IDS,
    detectFrictionProfile,
    frictionProfileValues,

    // schedule
    DEFAULT_SCHEDULE_START,
    DEFAULT_SCHEDULE_END,
    SCHEDULE_PRESETS,
    SCHEDULE_PRESET_IDS,
    ALL_DAYS,
    WEEKDAYS,
    WEEKEND,
    // Exported so a surface offering "Add a window" can disable the control at
    // the cap instead of accepting a click that normalizeSchedule truncates
    // away with no message.
    MAX_WINDOWS,
    normalizeSchedule,
    normalizeTime,
    scheduleFromLegacy,
    scheduleToLegacy,
    scheduleIsFlatExpressible,
    normalizeCustomSites,
    evaluateSchedule,
    scheduleOverrideActive,
    nextScheduleBoundary,
    nextLocalMidnight,
    schedulePresetValues,
    copyScheduleDay,

    // passes
    PASS_SCOPES,
    PASS_PRESETS,
    PASS_PRESET_IDS,
    createPass,
    activePasses,
    findCoveringPass,

    // repeat friction
    DEFAULT_REPEAT_WINDOW_MINUTES,
    MAX_REPEAT_DOMAINS,
    MAX_REPEAT_HISTORY_PER_DOMAIN,
    REPEAT_HISTORY_RETENTION_MULTIPLE,
    repeatHistoryRetentionMs,
    normalizeRepeatHistory,
    recordContinue,
    repeatFrictionFor,

    // stats
    STAT_EVENTS,
    emptyStatTotals,
    normalizeStatTotals,
    normalizeCountMap,
    normalizeStatHistory,
    applyStatEvent,
    weeklyRecap,
    localDayKey,

    // preferences
    DIETS,
    PANTRY_ITEMS,
    EQUIPMENT_ITEMS,
    DEFAULT_EQUIPMENT,
    normalizePantry,
    normalizeEquipment,
    normalizeDietPreference,

    // theme mode (pure; applying a theme stays per-page)
    MIN_LAYOUT_WIDTH,
    MAX_POPUP_WIDTH,
    DEFAULT_THEME_MODE,
    THEME_MODE_OPTIONS,
    THEME_MODE_COLOR_KEYS,
    THEME_MODE_PRESETS,
    normalizeThemeMode,
    normalizeTheme,
    resolveThemeMode,
    themeMatchesPreset,
    shouldUseResolvedPreset,
    hexToRgba,

    // custom alternatives
    CUSTOM_LIMITS,
    redactReportSubject,
    sanitizeCustomAlternative,
    normalizeCustomAlternatives,

    // rotation
    MAX_RECENT_SHOWN,
    pushRecent,
    normalizeIdList,

    // shared guards
    safeObject,
    isPlainObject,
    cleanText,
    clampInt,
    toStringList
  };

  global.FitShieldCore = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
