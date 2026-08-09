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

  const FRICTION_PROFILES = {
    light: {
      id: "light",
      timerSeconds: 20,
      passDurationMinutes: 15,
      askIntent: false,
      repeatFrictionEnabled: false,
      repeatExtraSeconds: 0,
      settingsDelaySeconds: 0
    },
    standard: {
      id: "standard",
      timerSeconds: 60,
      passDurationMinutes: 5,
      askIntent: true,
      repeatFrictionEnabled: true,
      repeatExtraSeconds: 20,
      settingsDelaySeconds: 0
    },
    strict: {
      id: "strict",
      timerSeconds: 120,
      passDurationMinutes: 3,
      askIntent: true,
      repeatFrictionEnabled: true,
      repeatExtraSeconds: 45,
      // A short cooling-off delay before *weakening* protection settings takes
      // effect. Never applied to strengthening a setting, and never to the block
      // page's own override.
      settingsDelaySeconds: 60
    }
  };

  const FRICTION_PROFILE_IDS = Object.keys(FRICTION_PROFILES);

  // Which stored profile id best describes these values, or "custom".
  function detectFrictionProfile(state) {
    const source = safeObject(state);

    return (
      FRICTION_PROFILE_IDS.find((id) => {
        const profile = FRICTION_PROFILES[id];
        return (
          normalizeTimerSeconds(source.timerSeconds) === profile.timerSeconds &&
          normalizePassDurationMinutes(source.passDurationMinutes) === profile.passDurationMinutes
        );
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
      repeatExtraSeconds: profile.repeatExtraSeconds,
      settingsDelaySeconds: profile.settingsDelaySeconds
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

    // A temporary override ("block until tomorrow") wins while it lasts, then
    // expires on its own — it is stored as an absolute timestamp, so a browser
    // restart or a suspended worker cannot strand the user inside it.
    if (normalized.until !== null && normalized.until > at.getTime()) {
      return { active: true, reason: "temporary" };
    }

    if (normalized.mode === "always") {
      return { active: true, reason: "always" };
    }

    const inWindow = normalized.windows.some((window) => windowCoversMoment(window, at));
    return { active: inWindow, reason: inWindow ? "window" : "outside" };
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
      for (let offset = 0; offset <= 8; offset += 1) {
        normalized.windows.forEach((window) => {
          [window.start, window.end].forEach((time) => {
            const minutes = timeToMinutes(time);

            if (minutes === null) {
              return;
            }

            const moment = new Date(at);
            moment.setDate(moment.getDate() + offset);
            moment.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);

            if (moment.getTime() > at.getTime()) {
              candidates.push(moment.getTime());
            }
          });
        });
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

  // Copy one day's windows onto other days, replacing whatever those days had.
  function copyScheduleDay(schedule, fromDay, toDays) {
    const normalized = normalizeSchedule(schedule);
    const targets = normalizeDays(toDays).filter((day) => day !== fromDay);

    if (targets.length === 0) {
      return normalized;
    }

    const sourceWindows = normalized.windows
      .filter((window) => window.days.includes(fromDay))
      .map((window) => ({ start: window.start, end: window.end }));

    const windows = normalized.windows
      .map((window) => ({
        start: window.start,
        end: window.end,
        days: window.days.filter((day) => !targets.includes(day))
      }))
      .filter((window) => window.days.length > 0);

    sourceWindows.forEach((window) => {
      windows.push({ days: targets.slice(), start: window.start, end: window.end });
    });

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
    site5: { id: "site5", scope: "site", minutes: 5 },
    tab: { id: "tab", scope: "site", minutes: 720, tabBound: true },
    site10: { id: "site10", scope: "site", minutes: 10 },
    site30: { id: "site30", scope: "site", minutes: 30 },
    category30: { id: "category30", scope: "category", minutes: 30 },
    all30: { id: "all30", scope: "all", minutes: 30 },
    allTomorrow: { id: "allTomorrow", scope: "all", untilTomorrow: true }
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

    // An earlier 0.55 development build wrote passes under the retired "once"
    // preset. Their scope, target, and expiry are all still valid, so such a
    // pass keeps running as what it always was — a five-minute site pass —
    // rather than being dropped out from under whoever granted it.
    const preset = value.preset === "once" ? "site5" : value.preset;

    return {
      id: String(value.id || "").slice(0, 64) || `p${createdAt}`,
      preset: PASS_PRESET_IDS.includes(preset) ? preset : "custom",
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

  function normalizeRepeatHistory(value) {
    const source = safeObject(value);
    const out = {};

    Object.keys(source)
      .slice(-MAX_REPEAT_DOMAINS)
      .forEach((domain) => {
        const times = (Array.isArray(source[domain]) ? source[domain] : [])
          .map((time) => Number(time))
          .filter((time) => Number.isFinite(time) && time > 0)
          .sort((a, b) => a - b)
          .slice(-MAX_REPEAT_HISTORY_PER_DOMAIN);

        if (times.length > 0) {
          out[domain] = times;
        }
      });

    return out;
  }

  // Record that the user deliberately continued to `domain`.
  function recordContinue(history, domain, now) {
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const key = String(domain || "").trim().toLowerCase();
    const next = normalizeRepeatHistory(history);

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
    const windowMinutes = clampInt(config.repeatWindowMinutes, 5, 720, DEFAULT_REPEAT_WINDOW_MINUTES);
    const none = { repeat: false, recentCount: 0, extraSeconds: 0, windowMinutes };

    if (config.repeatFrictionEnabled === false) {
      return none;
    }

    const key = String(domain || "").trim().toLowerCase();
    const times = normalizeRepeatHistory(history)[key] || [];
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
   */
  function weeklyRecap(stats, now, options) {
    const source = safeObject(stats);
    const history = normalizeStatHistory(source.history);
    const opts = safeObject(options);
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

    const categories = safeObject(opts.blockedByCategory);
    const topCategory =
      Object.keys(categories)
        .map((name) => ({ name, count: Number(categories[name]) || 0 }))
        .filter((item) => item.count > 0)
        .sort((a, b) => b.count - a.count)[0] || null;

    return {
      from: days[0],
      to: days[days.length - 1],
      totals,
      topCategory,
      hasActivity: STAT_EVENTS.some((event) => totals[event] > 0)
    };
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

    try {
      const url = new URL(text.includes("://") ? text : `https://${text}`);
      const host = url.hostname.replace(/^www\./, "").toLowerCase();

      // A bare word parses as a hostname too; only accept something that looks
      // like a domain, otherwise fall through to plain text.
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
        return host;
      }
    } catch (error) {
      // Not a URL — fall through and treat it as a plain label.
    }

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
      settingsDelaySeconds: 0,

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
      recapEnabled: true,
      recapDismissedFor: ""
    };
  }

  // ---------------------------------------------------------------------------
  // Migration steps. Each is [fromVersion, fn(state) -> state]. They run in
  // order, are idempotent, and must tolerate missing and malformed input. A step
  // NEVER deletes a key it does not understand: anything it cannot interpret is
  // preserved under `legacy.<key>` so it can be recovered.
  // ---------------------------------------------------------------------------

  function migrateV1toV2(state) {
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

          // "delivery-doordash-com" / "fast_food-mcdonalds-com" -> "doordash.com".
          const withoutBucket = siteKey.replace(/^(delivery|fast-food|fast_food|custom|site)-/, "");
          const domain = withoutBucket.replace(/-/g, ".");

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
   * @returns {{ state: object, from: number, to: number, changed: boolean, notes: string[], error: string|null }}
   */
  function migrateState(state) {
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
          working = step(working);
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
  function readSettings(raw) {
    const defaults = defaultState();
    const source = safeObject(raw);
    const get = (key) => (Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined);

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
      repeatWindowMinutes: clampInt(get("repeatWindowMinutes"), 5, 720, defaults.repeatWindowMinutes),
      settingsDelaySeconds: clampInt(get("settingsDelaySeconds"), 0, 600, 0),

      schedule,

      deliverySitesEnabled: get("deliverySitesEnabled") !== false,
      fastFoodSitesEnabled: get("fastFoodSitesEnabled") !== false,
      customSitesEnabled: get("customSitesEnabled") !== false,
      disabledDeliverySiteKeys: toStringList(get("disabledDeliverySiteKeys"), 5000),
      disabledFastFoodSiteKeys: toStringList(get("disabledFastFoodSiteKeys"), 5000),
      enabledCountries: toStringList(get("enabledCountries"), 500),
      enabledCategories: toStringList(get("enabledCategories"), 500),
      quickAccessCountries: toStringList(get("quickAccessCountries"), 100),
      quickAccessCategories: toStringList(get("quickAccessCategories"), 100),

      passes: activePasses(get("passes")),
      repeatHistory: normalizeRepeatHistory(get("repeatHistory")),

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
      recapDismissedFor: String(get("recapDismissedFor") || "").slice(0, 16)
    };
  }

  const api = {
    // schema
    SCHEMA_VERSION,
    SCHEMA_KEY,
    defaultState,
    migrateState,
    readSettings,
    storedVersion,

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
    normalizeSchedule,
    normalizeTime,
    scheduleFromLegacy,
    evaluateSchedule,
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
    DEFAULT_THEME_MODE,
    THEME_MODE_OPTIONS,
    THEME_MODE_COLOR_KEYS,
    THEME_MODE_PRESETS,
    normalizeThemeMode,
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
