/**
 * FitShield popup — the at-a-glance surface: master switch, bucket toggles, the
 * pause and pass sliders, the simple schedule window, the weekly recap, and the
 * optional "did you make it?" follow-up.
 *
 * Everything it shows comes from ONE getBlockState message, so the popup can
 * never disagree with the worker about what is currently blocked.
 */

// Localization helper (i18n.js loads first). Falls back to the key when a
// message is missing so the gap is visible rather than blank.
const t = (key, subs) =>
  (typeof FitShieldI18n !== "undefined" ? FitShieldI18n.t(key, subs) : key);

function minuteUnit(value) {
  return t(value === 1 ? "unitMinute" : "unitMinutes");
}

const toggle = document.getElementById("toggle");
const status = document.getElementById("status");
const card = document.querySelector(".card");
const deliverySitesEnabledInput = document.getElementById("deliverySitesEnabled");
const fastFoodSitesEnabledInput = document.getElementById("fastFoodSitesEnabled");
const customSitesEnabledInput = document.getElementById("customSitesEnabled");
const toggleDeliveryListButton = document.getElementById("toggleDeliveryList");
const toggleFastFoodListButton = document.getElementById("toggleFastFoodList");
const toggleCustomListButton = document.getElementById("toggleCustomList");
const timerSlider = document.getElementById("timerSlider");
const timerDisplay = document.getElementById("timerDisplay");
const timerSecondsInput = document.getElementById("timerSeconds");
const scheduleEnabledInput = document.getElementById("scheduleEnabled");
const scheduleStartInput = document.getElementById("scheduleStart");
const scheduleEndInput = document.getElementById("scheduleEnd");
const scheduleSummary = document.getElementById("scheduleSummary");
const passDurationSlider = document.getElementById("passDurationSlider");
const passDurationDisplay = document.getElementById("passDurationDisplay");
const passDurationMinutesInput = document.getElementById("passDurationMinutes");
const deliveryCount = document.getElementById("deliveryCount");
const fastFoodCount = document.getElementById("fastFoodCount");
const popupSearchInput = document.getElementById("popupSearchInput");
const popupSearchButton = document.getElementById("popupSearchButton");
const openSettingsButton = document.getElementById("openSettings");
const openMetadataBlockingButton = document.getElementById("openMetadataBlocking");

let latestState = null;

const DEFAULT_THEME = {
  bg: "#0f141b",
  panel: "#1a212b",
  panelSoft: "rgba(255, 255, 255, 0.03)",
  panelStrong: "rgba(255, 255, 255, 0.045)",
  border: "#2c3644",
  text: "#edf2f7",
  muted: "#a9b4c2",
  accent: "#7ef0a8",
  shadow: "rgba(126, 240, 168, 0.14)",
  radius: 16,
  popupWidth: 516
};

const systemThemeQuery = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: light)")
  : null;

// Shared, page-independent values and helpers live in fitshield-core.js
// (FitShieldCore). They are aliased here so this file reads the same as before,
// while the popup, the settings page, and the service worker can no longer drift
// apart on what a limit is or what "system" theme resolves to.
const core = FitShieldCore;

const DEFAULT_TIMER_SECONDS = core.DEFAULT_TIMER_SECONDS;
const MIN_TIMER_SECONDS = core.MIN_TIMER_SECONDS;
const DEFAULT_PASS_DURATION_MINUTES = core.DEFAULT_PASS_DURATION_MINUTES;
const MIN_PASS_DURATION_MINUTES = core.MIN_PASS_DURATION_MINUTES;
const DEFAULT_SCHEDULE_START = core.DEFAULT_SCHEDULE_START;
const DEFAULT_SCHEDULE_END = core.DEFAULT_SCHEDULE_END;
const DEFAULT_THEME_MODE = core.DEFAULT_THEME_MODE;
const THEME_MODE_OPTIONS = core.THEME_MODE_OPTIONS;
const THEME_MODE_COLOR_KEYS = core.THEME_MODE_COLOR_KEYS;
const THEME_MODE_PRESETS = core.THEME_MODE_PRESETS;

// These now clamp the MAXIMUM as well as the minimum. The page-local copies only
// clamped the minimum, so a pasted value like 999999 was stored as typed and then
// silently clamped on every read — the field and the behaviour disagreed.
const normalizeTimerSeconds = (value) => core.normalizeTimerSeconds(value);
const normalizePassDurationMinutes = (value) => core.normalizePassDurationMinutes(value);

const hexToRgba = (hex, alpha) => core.hexToRgba(hex, alpha);
const normalizeThemeMode = (mode) => core.normalizeThemeMode(mode);
const themeMatchesPreset = (theme, preset) => core.themeMatchesPreset(theme, preset);
const shouldUseResolvedPreset = (theme, mode) => core.shouldUseResolvedPreset(theme, mode);
const resolveThemeMode = (mode) => core.resolveThemeMode(mode, !!(systemThemeQuery && systemThemeQuery.matches));

function buildTheme(theme = {}) {
  const sourceTheme = theme || {};
  const mergedTheme = {
    ...DEFAULT_THEME,
    ...sourceTheme
  };
  const hasThemeText = typeof sourceTheme.text === "string";
  const hasThemeAccent = typeof sourceTheme.accent === "string";

  return {
    ...mergedTheme,
    panelSoft: sourceTheme.panelSoft
      || (hasThemeText ? hexToRgba(mergedTheme.text, 0.03) : DEFAULT_THEME.panelSoft),
    panelStrong: sourceTheme.panelStrong
      || (hasThemeText ? hexToRgba(mergedTheme.text, 0.045) : DEFAULT_THEME.panelStrong),
    shadow: sourceTheme.shadow
      || (hasThemeAccent ? hexToRgba(mergedTheme.accent, 0.14) : DEFAULT_THEME.shadow)
  };
}

function buildThemeForMode(mode, baseTheme = {}) {
  const base = buildTheme(baseTheme);
  const preset = THEME_MODE_PRESETS[resolveThemeMode(mode)] || THEME_MODE_PRESETS[DEFAULT_THEME_MODE];

  return buildTheme({
    ...preset,
    radius: base.radius,
    popupWidth: base.popupWidth
  });
}

function applyTheme(theme = {}) {
  const mergedTheme = buildTheme(theme);
  const root = document.documentElement;

  root.style.setProperty("--bg", mergedTheme.bg);
  root.style.setProperty("--panel", mergedTheme.panel);
  root.style.setProperty("--panel-soft", mergedTheme.panelSoft);
  root.style.setProperty("--panel-strong", mergedTheme.panelStrong);
  root.style.setProperty("--border", mergedTheme.border);
  root.style.setProperty("--text", mergedTheme.text);
  root.style.setProperty("--muted", mergedTheme.muted);
  root.style.setProperty("--accent", mergedTheme.accent);
  root.style.setProperty("--shadow", mergedTheme.shadow);
  root.style.setProperty("--panel-radius", `${mergedTheme.radius}px`);
  root.style.setProperty("--popup-width", `${mergedTheme.popupWidth}px`);
}

function applyThemeMode(mode) {
  const isLight = resolveThemeMode(mode) === "light";
  document.documentElement.classList.toggle("theme-light", isLight);
  document.documentElement.style.colorScheme = isLight ? "light" : "dark";
}

async function loadTheme() {
  const { theme, themeMode } = await chrome.storage.local.get(["theme", "themeMode"]);
  const normalizedMode = normalizeThemeMode(themeMode);
  const mergedTheme = shouldUseResolvedPreset(theme, normalizedMode)
    ? buildThemeForMode(normalizedMode, theme)
    : buildTheme(theme);

  applyTheme(mergedTheme);
  applyThemeMode(normalizedMode);
}

// Units are cumulative, largest first. Without the hours unit the longest pass
// the product offers — "Pause everything until tomorrow", up to 24 hours — was
// printed as "Blocking resumes in 1439m 59s", a number nobody can read as a
// time. The rollover is the same arithmetic in both directions, so a 90-second
// pause still reads "1m 30s" and a 30-second one still reads "30s".
function formatTimeRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatScheduleText(start, end) {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);

  const startDate = new Date();
  startDate.setHours(startHour, startMinute, 0, 0);

  const endDate = new Date();
  endDate.setHours(endHour, endMinute, 0, 0);

  return t("scheduleRange", [
    startDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    endDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  ]);
}

function formatTimerDisplay(seconds) {
  return `${seconds}s`;
}

function formatPassDisplay(minutes) {
  return `${minutes}m`;
}

function secondUnit(value) {
  return t(value === 1 ? "unitSecond" : "unitSeconds");
}

/**
 * A range input is announced by its accessible name and its NUMBER. The chip
 * beside it reads "60s", but that chip is a separate element: a screen reader
 * reaching the slider itself hears "Timer duration, slider, 60" — sixty of
 * what, on a card that also carries a "Site open time" slider announced as the
 * bare number "5"? One is seconds and the other is minutes, and neither said
 * so. `aria-valuetext` replaces the number with the number AND its unit, and it
 * is written through the same helper that writes the chip so the two can never
 * drift apart — including on a language change, which re-runs updateUI.
 */
function setTimerDisplay(seconds) {
  timerDisplay.textContent = formatTimerDisplay(seconds);
  timerSlider.setAttribute("aria-valuetext", `${seconds} ${secondUnit(seconds)}`);
}

function setPassDisplay(minutes) {
  passDurationDisplay.textContent = formatPassDisplay(minutes);
  passDurationSlider.setAttribute("aria-valuetext", `${minutes} ${minuteUnit(minutes)}`);
}

// Set from the worker's projection of the canonical schedule.
let scheduleIsSimple = true;

/**
 * The popup's start/end pair writes only the three flat keys, and the worker
 * rebuilds the schedule from them — which can only ever mean one window across
 * all seven days. Over a "Workday lunch" or multi-window schedule a single nudge
 * silently destroyed the rest, so the pair is offered only when it can represent
 * what is stored. The full editor lives in Settings.
 */
function updateScheduleControls(scheduleEnabled) {
  const usable = scheduleEnabled && scheduleIsSimple;

  scheduleStartInput.disabled = !usable;
  scheduleEndInput.disabled = !usable;
  scheduleEnabledInput.disabled = !scheduleIsSimple;
}

/**
 * The one-line summary under the simple start/end pair.
 *
 * The "every day" suffix used to be appended when `scheduleStart ===
 * scheduleEnd`, which is the opposite of what that means: equal times describe
 * one window covering the whole 24 hours, not a set of days. Whether the window
 * repeats every day is a property of the PROJECTION — the flat trio can only
 * ever express a single window across all seven days (see
 * `FitShieldCore.scheduleToLegacy`) — so whenever the pair can honestly
 * represent the stored schedule at all, it is by definition every day. Settings
 * was corrected the same way; this is the popup agreeing with it.
 *
 * When the pair CANNOT represent it, the two times on screen are placeholders,
 * and printing them as "Current schedule" told a user with a "Workday lunch"
 * schedule that their schedule was 6:00 PM to 11:00 PM. The count of stored
 * windows is the same sentence the schedule editor shows for that schedule, and
 * unlike the times it is true.
 */
function describeSimpleSchedule(schedule, scheduleEnabled, scheduleStart, scheduleEnd) {
  if (!scheduleEnabled) {
    return t("scheduleDefaultSummary");
  }

  if (!scheduleIsSimple) {
    const windows = schedule && Array.isArray(schedule.windows) ? schedule.windows.length : 0;
    // A response that carried the flag but not the schedule behind it cannot be
    // counted, and an invented "0 windows" would be one more untrue sentence.
    // The disabled pair says enough on its own.
    return windows > 0 ? t("scheduleWindowsSummary", [String(windows)]) : "";
  }

  return t("currentScheduleSummary", [formatScheduleText(scheduleStart, scheduleEnd) + t("everyDaySuffix")]);
}

/**
 * The passes that are still running RIGHT NOW.
 *
 * `getBlockState` already filters expired passes, but the popup re-reads that
 * one response every second for as long as it stays open, so a pass that ran
 * out while the popup was on screen would otherwise keep naming itself.
 */
function activePassesOf(state, now) {
  const passes = Array.isArray(state && state.passes) ? state.passes : [];

  return passes.filter((pass) => pass && Number(pass.expiresAt) > now);
}

/**
 * How many sites the status line will NAME before it falls back to counting.
 *
 * Naming them is the guarantee: a count tells you that something is open, not
 * WHICH thing, and "which" is the entire correction F039 made. So the names are
 * given for as long as they can be read, and only then does the count take
 * over.
 *
 * Three is where that turns, measured rather than guessed. Domains in the
 * shipped blocklists run to 13 characters at the median and 18 at the 90th
 * percentile; three of those joined by ", " plus the sentence around them come
 * to roughly 120 characters, which is the two lines `.status` is already sized
 * for (min-height 38px at 0.92rem/1.35 in popup.html). A fourth name spills
 * onto a third line and resizes the popup underneath the user's cursor every
 * time a pass is taken or expires.
 */
const MAX_NAMED_PASS_SITES = 3;

/**
 * The list separator is a plain ", " rather than Intl.ListFormat or a
 * translated conjunction, deliberately. These are ASCII machine names, not
 * prose: a localized "and"/"und"/"و" inserted between two domains adds a word
 * without adding meaning, and it would make the sentence engine-dependent —
 * this string is recomputed every second and asserted in tests, so it should
 * not vary with which Intl data the host happens to ship. The part of the
 * sentence that genuinely depends on the language is the message itself, and
 * that is translated.
 */
function joinSites(targets) {
  return targets.join(", ");
}

/**
 * Say what is ACTUALLY paused.
 *
 * A pass carries its own scope. Two of the six presets ("Turn off all blocking
 * for 30 minutes", "…until tomorrow") are scope "all"; the other four unblock
 * exactly one site, and the pass chooser says so. The status line ignored the
 * scope and printed "Blocking resumes in X" for every one of them, which told a
 * user who had opened one delivery site for five minutes that FitShield was
 * off. It was not: every other site was still being blocked, and would have
 * been interrupted normally.
 *
 * So the global sentence is kept for the passes it is true of, and a scoped
 * pass names its site and says, in words, that nothing else was unblocked.
 *
 * The scoped branches used to be assembled from fragments — `doordash.com ·
 * This site only · 4m 12s`. That is a caption, not a sentence: the reader has
 * to infer what the separators mean, a screen reader announces it as three
 * unrelated runs, and the one thing the fix exists to say — that everything
 * else is still blocked — was never actually said. Each branch is now one
 * translatable sentence, which is also the only form the other 84 locales can
 * render correctly: word order is theirs to choose, not ours to impose with
 * interpuncts.
 */
function passStatusMessage(passes, now) {
  const remaining = formatTimeRemaining(
    Math.max(...passes.map((pass) => Number(pass.expiresAt) || 0)) - now
  );

  // "All blocking" really is paused — the original sentence is accurate here.
  if (passes.some((pass) => pass.scope === "all")) {
    return t("statusBypassActive", [remaining]);
  }

  const targets = [...new Set(passes.map((pass) => String(pass.target || "").trim()).filter(Boolean))];

  // A scoped pass with no target cannot name a site; the generic sentence is
  // still better than an empty one.
  if (targets.length === 0) {
    return t("statusBypassActive", [remaining]);
  }

  // One site: name it, and say that nothing else was opened with it.
  if (targets.length === 1) {
    return t("statusPassSite", [targets[0], remaining]);
  }

  // A few: name every one of them, and the time the last one ends.
  if (targets.length <= MAX_NAMED_PASS_SITES) {
    return t("statusPassSitesNamed", [joinSites(targets), remaining]);
  }

  // Too many to read as a list. The count is the honest summary, and the
  // promise it is paired with — that everything else is still blocked — is the
  // part that has to survive at any length.
  return t("statusPassSites", [String(targets.length), remaining]);
}

function getStatusMessage(state) {
  const {
    enabled = false,
    bypassUntil = 0,
    timerSeconds = DEFAULT_TIMER_SECONDS,
    passDurationMinutes = DEFAULT_PASS_DURATION_MINUTES,
    scheduleEnabled = false,
    scheduleStart = DEFAULT_SCHEDULE_START,
    scheduleEnd = DEFAULT_SCHEDULE_END,
    scheduleActive = false,
    deliverySitesEnabled = true,
    fastFoodSitesEnabled = true,
    customSitesEnabled = true,
    deliverySites = [],
    fastFoodSites = [],
    customSites = []
  } = state;

  const now = Date.now();
  const passes = activePassesOf(state, now);
  const bypassActive = enabled && bypassUntil > now;
  const activeSiteCount =
    (deliverySitesEnabled ? deliverySites.filter((site) => site.enabled).length : 0) +
    (fastFoodSitesEnabled ? fastFoodSites.filter((site) => site.enabled).length : 0) +
    (customSitesEnabled ? customSites.filter((site) => site.enabled).length : 0);

  if (!enabled) {
    return t("statusInactive");
  }

  if (activeSiteCount === 0) {
    return t("statusAllDisabled");
  }

  if (bypassActive) {
    // Older responses (and any state without the pass records) still have only
    // `bypassUntil` to go on, so fall back to the sentence that predates scopes.
    return passes.length > 0
      ? passStatusMessage(passes, now)
      : t("statusBypassActive", [formatTimeRemaining(bypassUntil - now)]);
  }

  if (scheduleEnabled && !scheduleActive) {
    return t("statusOutsideSchedule", [formatScheduleText(scheduleStart, scheduleEnd)]);
  }

  const passMinutes = normalizePassDurationMinutes(passDurationMinutes);

  return t("statusShieldUp", [
    String(normalizeTimerSeconds(timerSeconds)),
    String(passMinutes),
    minuteUnit(passMinutes)
  ]);
}

// ---------------------------------------------------------------------------
// Ending a pass early
// ---------------------------------------------------------------------------

/**
 * The worker has implemented AND registered `revokeAllPasses` for as long as
 * passes have existed, and nothing ever sent it. So once a pass was running the
 * only ways to get blocking back were to wait it out or to flip the master
 * switch — and the master switch turns FitShield OFF, which is the opposite of
 * what someone ending a pass early is asking for. Changing your mind is exactly
 * the moment this product is supposed to be on your side.
 *
 * The label is the one Settings already uses to end the OTHER temporary
 * override ("Block everything until tomorrow" -> "Cancel that"), so the same
 * action reads the same way in both places and in all 85 locales.
 */
let endPassButton = null;

function ensureEndPassButton() {
  if (endPassButton || !status || !status.parentNode) {
    return endPassButton;
  }

  const button = document.createElement("button");

  button.id = "endPass";
  button.type = "button";
  button.className = "button secondary";
  button.hidden = true;
  // "Cancel that" is only meaningful next to the sentence saying what "that"
  // is, so the status line is its description rather than a second string.
  button.setAttribute("aria-describedby", "status");
  button.addEventListener("click", async () => {
    button.disabled = true;

    try {
      await chrome.runtime.sendMessage({ type: "revokeAllPasses" });
    } catch (error) {
      console.error("Failed to end the temporary pass:", error);
    }

    button.disabled = false;
    await loadState();
  });

  status.parentNode.insertBefore(button, status.nextSibling);
  endPassButton = button;

  return endPassButton;
}

function renderPassControls(state) {
  const button = ensureEndPassButton();

  if (!button) {
    return;
  }

  button.textContent = t("clearScheduleOverride");
  button.hidden = !(state && state.enabled && activePassesOf(state, Date.now()).length > 0);
}

// Set by updateUI so a new state always re-renders, and by the ticker so an
// unchanged sentence is not rewritten. Not a cache of the state — a cache of
// the STRING, which is the only thing the DOM cares about.
let lastStatusText = null;

function refreshStatusOnly() {
  if (!latestState) {
    return;
  }

  const text = getStatusMessage(latestState);

  // This runs once a second for as long as the popup is open. While a pass is
  // counting down the sentence really does change every tick, but the rest of
  // the time it is byte-identical — and assigning textContent unconditionally
  // destroys and rebuilds the text node, invalidating layout every second for
  // no visible change. Write only when there is something different to write.
  if (text === lastStatusText) {
    return;
  }

  lastStatusText = text;
  status.textContent = text;
  renderPassControls(latestState);
}

// ---------------------------------------------------------------------------
// Weekly recap + the voluntary "did you make it?" follow-up
// ---------------------------------------------------------------------------

const madePrompt = document.getElementById("madePrompt");
const madePromptText = document.getElementById("madePromptText");
const markMadeButton = document.getElementById("markMade");
const dismissMadeButton = document.getElementById("dismissMade");
const popupRecap = document.getElementById("popupRecap");
const popupRecapGrid = document.getElementById("popupRecapGrid");

// Counts only — no score, no streak, no ranking, no projection.
const RECAP_FIGURES = [
  ["interruptions", "recapInterrupted"],
  ["left", "recapLeft"],
  ["continued", "recapContinued"],
  ["alternativesSelected", "recapSelected"],
  ["alternativesMade", "recapMade"]
];

function renderRecap(state) {
  if (!popupRecap || !popupRecapGrid) {
    return;
  }

  const recap = state && state.recap;

  if (!recap || !recap.hasActivity || state.recapEnabled === false) {
    popupRecap.hidden = true;
    return;
  }

  popupRecapGrid.replaceChildren();

  RECAP_FIGURES.forEach(([event, labelKey]) => {
    const label = document.createElement("dt");
    label.textContent = t(labelKey);

    const value = document.createElement("dd");
    value.textContent = String(recap.totals[event] || 0);

    popupRecapGrid.append(label, value);
  });

  popupRecap.hidden = false;
}

/**
 * Resolve a pending alternative's id to the title the user actually saw.
 *
 * A pending entry is `{ id, at }` — the id of a catalog entry or of something
 * the user wrote themselves. The popup does not load the recipe module, so it
 * reads the packaged catalog directly (a same-origin, extension-local file:
 * this is not a network request) and the user's own alternatives from storage.
 * Both lookups are best effort — an unknown id simply goes unnamed, exactly as
 * before, rather than blocking the prompt.
 */
let alternativeTitles = null;

async function loadAlternativeTitles() {
  if (alternativeTitles) {
    return alternativeTitles;
  }

  const titles = new Map();

  try {
    const { customAlternatives } = await chrome.storage.local.get(["customAlternatives"]);
    (Array.isArray(customAlternatives) ? customAlternatives : []).forEach((entry) => {
      if (entry && entry.id && entry.title) {
        titles.set(String(entry.id), String(entry.title));
      }
    });
  } catch (error) {
    console.error("Could not read your own alternatives:", error);
  }

  try {
    const response = await fetch(chrome.runtime.getURL("data/recipes.json"));
    const catalog = await response.json();

    [...(catalog.recipes || []), ...(catalog.quickAlternatives || [])].forEach((entry) => {
      if (entry && entry.id && entry.title) {
        titles.set(String(entry.id), String(entry.title));
      }
    });
  } catch (error) {
    console.error("Could not read the alternatives catalog:", error);
  }

  alternativeTitles = titles;
  return alternativeTitles;
}

/**
 * "3 hours ago", in the user's language, with no message key of its own.
 *
 * Intl.RelativeTimeFormat is a platform API, so this stays correct in all 85
 * locales — including the ones where the plural rules are not "add an s" —
 * without inventing a string anyone has to translate. i18n.js has already
 * stamped the active language onto <html lang>, so reading it here is what
 * makes the phrasing follow the language the user picked.
 */
function formatRoughAge(at, now) {
  const elapsed = now - Number(at);

  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return "";
  }

  const language = (document.documentElement && document.documentElement.lang) || "en";
  const hours = Math.round(elapsed / (60 * 60 * 1000));
  const minutes = Math.round(elapsed / (60 * 1000));

  try {
    const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
    return hours >= 1 ? relative.format(-hours, "hour") : relative.format(-Math.max(minutes, 0), "minute");
  } catch (error) {
    return "";
  }
}

// Shown only when there is something pending, and only ever asked once per
// choice: answering either way clears it. FitShield never chases the user for
// an answer and never sends a notification about it.
//
// It used to ask "Did you make it?" and name nothing at all. The entry it means
// can be up to 48 hours old (the core expires them at that point) and the user
// may have chosen several things since, so "it" was unanswerable: saying yes
// recorded a meal against an entry they could not identify. It now says which
// one, and roughly when they chose it.
async function renderMadePrompt() {
  if (!madePrompt) {
    return;
  }

  const { pendingAlternatives } = await chrome.storage.local.get(["pendingAlternatives"]);
  const pending = Array.isArray(pendingAlternatives) ? pendingAlternatives : [];
  const latest = pending[pending.length - 1];

  if (!latest || !latest.id) {
    madePrompt.hidden = true;
    return;
  }

  const titles = await loadAlternativeTitles();
  const title = titles.get(String(latest.id)) || "";
  const age = formatRoughAge(latest.at, Date.now());

  madePromptText.replaceChildren();

  if (title) {
    const name = document.createElement("strong");
    name.textContent = title;
    madePromptText.append(name);

    if (age) {
      const when = document.createElement("span");
      when.className = "muted";
      when.textContent = ` · ${age}`;
      madePromptText.append(when);
    }

    madePromptText.append(document.createTextNode(` — ${t("popupMarkMade")}`));
  } else {
    // An id with no title left (a custom alternative the user has since
    // deleted). Ask the plain question rather than an empty one.
    madePromptText.textContent = t("popupMarkMade");
  }

  madePrompt.dataset.alternativeId = latest.id;
  madePrompt.hidden = false;
}

async function clearPending(id) {
  const { pendingAlternatives } = await chrome.storage.local.get(["pendingAlternatives"]);
  const pending = Array.isArray(pendingAlternatives) ? pendingAlternatives : [];
  await chrome.storage.local.set({ pendingAlternatives: pending.filter((item) => item && item.id !== id) });
}

if (markMadeButton) {
  markMadeButton.addEventListener("click", async () => {
    const id = madePrompt.dataset.alternativeId;
    madePrompt.hidden = true;

    try {
      await chrome.runtime.sendMessage({ type: "markAlternativeMade", id });
    } catch (error) {
      console.error("Failed to record that the alternative was made:", error);
    }

    await loadState();
  });
}

if (dismissMadeButton) {
  dismissMadeButton.addEventListener("click", async () => {
    // Dismissing records nothing at all. Not making it is not a failure and is
    // not something FitShield keeps a number for.
    const id = madePrompt.dataset.alternativeId;
    madePrompt.hidden = true;
    await clearPending(id);
  });
}

function updateUI(state) {
  latestState = state;

  const {
    enabled = false,
    bypassUntil = 0,
    timerSeconds = DEFAULT_TIMER_SECONDS,
    passDurationMinutes = DEFAULT_PASS_DURATION_MINUTES,
    schedule = null,
    scheduleEnabled = false,
    scheduleStart = DEFAULT_SCHEDULE_START,
    scheduleEnd = DEFAULT_SCHEDULE_END,
    scheduleSimple = true,
    scheduleActive = false,
    deliverySitesEnabled = true,
    fastFoodSitesEnabled = true,
    customSitesEnabled = true,
    deliverySites = [],
    fastFoodSites = [],
    customSites = []
  } = state;

  // The worker projects this out of the canonical schedule, and it is the flag
  // the two time inputs and the summary below are gated on. It was destructured
  // here and then dropped, so the module-level copy stayed at its `true`
  // default: over a multi-window schedule the pair rendered enabled, accepted
  // an edit, and the worker correctly refused the lossy rebuild — a control
  // that takes input and discards it.
  scheduleIsSimple = scheduleSimple !== false;

  const bypassActive = enabled && bypassUntil > Date.now();
  const activeSiteCount =
    (deliverySitesEnabled ? deliverySites.filter((site) => site.enabled).length : 0) +
    (fastFoodSitesEnabled ? fastFoodSites.filter((site) => site.enabled).length : 0) +
    (customSitesEnabled ? customSites.filter((site) => site.enabled).length : 0);

  toggle.checked = enabled;
  deliverySitesEnabledInput.checked = deliverySitesEnabled;
  fastFoodSitesEnabledInput.checked = fastFoodSitesEnabled;
  customSitesEnabledInput.checked = customSitesEnabled;
  timerSlider.value = normalizeTimerSeconds(timerSeconds);
  timerSecondsInput.value = normalizeTimerSeconds(timerSeconds);
  setTimerDisplay(normalizeTimerSeconds(timerSeconds));
  passDurationSlider.value = normalizePassDurationMinutes(passDurationMinutes);
  passDurationMinutesInput.value = normalizePassDurationMinutes(passDurationMinutes);
  setPassDisplay(normalizePassDurationMinutes(passDurationMinutes));
  scheduleEnabledInput.checked = scheduleEnabled;
  scheduleStartInput.value = scheduleStart;
  scheduleEndInput.value = scheduleEnd;
  updateScheduleControls(scheduleEnabled);
  deliveryCount.textContent = t("deliverySitesEnabledCount", [
    String(deliverySites.filter((site) => site.enabled).length),
    String(deliverySites.length)
  ]);
  fastFoodCount.textContent = t("fastFoodSitesEnabledCount", [
    String(fastFoodSites.filter((site) => site.enabled).length),
    String(fastFoodSites.length)
  ]);

  scheduleSummary.textContent = describeSimpleSchedule(schedule, scheduleEnabled, scheduleStart, scheduleEnd);

  card.classList.toggle("glow", enabled && activeSiteCount > 0 && (scheduleActive || !scheduleEnabled) && !bypassActive);

  renderRecap(state);
  renderPassControls(state);

  // A fresh state always re-renders the sentence, even if it happens to read
  // the same as the last tick — otherwise the memo above would swallow a
  // language change, which rewrites every string without changing the state.
  lastStatusText = null;
  refreshStatusOnly();
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "getBlockState" });

  if (response?.ok) {
    updateUI(response);
  }
}

async function saveSettings(partialState) {
  await chrome.storage.local.set(partialState);
  await loadState();
}

function openSettings(path = "settings.html") {
  window.open(chrome.runtime.getURL(path), "_blank", "noopener");
}

function openBlocklistSettings(searchTerm = "") {
  const url = new URL(chrome.runtime.getURL("settings.html"));
  const query = String(searchTerm || "").trim();

  if (query) {
    url.searchParams.set("q", query);
  }

  url.hash = "customize-blocklist";
  window.open(url.toString(), "_blank", "noopener");
}

toggle.addEventListener("change", async () => {
  await saveSettings({
    enabled: toggle.checked,
    bypassUntil: 0
  });
});

deliverySitesEnabledInput.addEventListener("change", async () => {
  await saveSettings({ deliverySitesEnabled: deliverySitesEnabledInput.checked });
});

fastFoodSitesEnabledInput.addEventListener("change", async () => {
  await saveSettings({ fastFoodSitesEnabled: fastFoodSitesEnabledInput.checked });
});

customSitesEnabledInput.addEventListener("change", async () => {
  await saveSettings({ customSitesEnabled: customSitesEnabledInput.checked });
});

toggleDeliveryListButton.addEventListener("click", () => openBlocklistSettings());
toggleFastFoodListButton.addEventListener("click", () => openBlocklistSettings());
toggleCustomListButton.addEventListener("click", () => openBlocklistSettings());

// ---------------------------------------------------------------------------
// Friction values, and the label that has to keep up with them.
//
// Two of the values a friction profile is made of — the countdown and the site
// open time — are editable from THIS page as well as from Settings. Settings
// derives `frictionProfile` from the resulting numbers and stores it alongside
// them; the popup wrote the numbers alone. So dragging the popup's timer to 300
// seconds left `frictionProfile: "standard"` in storage describing values that
// are nothing of the sort, and an exported backup carried that contradiction to
// the next device.
//
// Every surface now derives the label when it renders, so nothing shows the
// wrong one — but storage and the backup were still wrong, and the backup is
// the copy that outlives this machine. Same derivation as settings.js, from the
// same `frictionProfileValues`, so the two pages cannot drift apart.
const FRICTION_VALUE_KEYS = Object.keys(core.frictionProfileValues("standard")).filter(
  (key) => key !== "frictionProfile"
);

function frictionProfileFor(values) {
  return (
    core.FRICTION_PROFILE_IDS.find((id) => {
      const preset = core.frictionProfileValues(id);
      return FRICTION_VALUE_KEYS.every((key) => preset[key] === values[key]);
    }) || "custom"
  );
}

async function saveFrictionValues(partial) {
  const stored = await chrome.storage.local.get(FRICTION_VALUE_KEYS);
  const next = { ...core.readSettings(stored), ...partial };

  await saveSettings({ ...partial, frictionProfile: frictionProfileFor(next) });
}

// Dragging fires `input` per pixel and `change` once, on release — so the live
// value stays a cheap single-key write and the profile is recomputed once the
// user has settled, exactly as the settings page does it.
timerSlider.addEventListener("input", () => {
  const timerSeconds = normalizeTimerSeconds(timerSlider.value);
  timerSecondsInput.value = timerSeconds;
  setTimerDisplay(timerSeconds);
  chrome.storage.local.set({ timerSeconds });
});

timerSlider.addEventListener("change", async () => {
  await saveFrictionValues({ timerSeconds: normalizeTimerSeconds(timerSlider.value) });
});

timerSecondsInput.addEventListener("change", async () => {
  const timerSeconds = normalizeTimerSeconds(timerSecondsInput.value);
  timerSecondsInput.value = timerSeconds;
  timerSlider.value = timerSeconds;
  setTimerDisplay(timerSeconds);
  await saveFrictionValues({ timerSeconds });
});

passDurationSlider.addEventListener("input", () => {
  const passDurationMinutes = normalizePassDurationMinutes(passDurationSlider.value);
  passDurationMinutesInput.value = passDurationMinutes;
  setPassDisplay(passDurationMinutes);
  chrome.storage.local.set({ passDurationMinutes });
});

passDurationSlider.addEventListener("change", async () => {
  await saveFrictionValues({
    passDurationMinutes: normalizePassDurationMinutes(passDurationSlider.value)
  });
});

passDurationMinutesInput.addEventListener("change", async () => {
  const passDurationMinutes = normalizePassDurationMinutes(passDurationMinutesInput.value);
  passDurationMinutesInput.value = passDurationMinutes;
  passDurationSlider.value = passDurationMinutes;
  setPassDisplay(passDurationMinutes);
  await saveFrictionValues({ passDurationMinutes });
});

scheduleEnabledInput.addEventListener("change", async () => {
  updateScheduleControls(scheduleEnabledInput.checked);
  await saveSettings({
    scheduleEnabled: scheduleEnabledInput.checked
  });
});

scheduleStartInput.addEventListener("change", async () => {
  await saveSettings({
    scheduleStart: scheduleStartInput.value || DEFAULT_SCHEDULE_START
  });
});

scheduleEndInput.addEventListener("change", async () => {
  await saveSettings({
    scheduleEnd: scheduleEndInput.value || DEFAULT_SCHEDULE_END
  });
});

popupSearchButton.addEventListener("click", () => {
  openBlocklistSettings(popupSearchInput.value);
});

popupSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    openBlocklistSettings(popupSearchInput.value);
  }
});

openSettingsButton.addEventListener("click", () => {
  openSettings();
});

openMetadataBlockingButton.addEventListener("click", () => {
  // Deep-link to the country & category blocking section in settings.
  openSettings("settings.html#metadata-blocking");
});

// Resolve once the stored UI language has been applied so the first render
// uses the right locale instead of flashing the browser default.
const i18nReady = (typeof FitShieldI18n !== "undefined" && FitShieldI18n.ready)
  ? FitShieldI18n.ready
  : Promise.resolve();

i18nReady.then(loadState).then(renderMadePrompt);
loadTheme();
setInterval(refreshStatusOnly, 1000);

// Re-render dynamic strings when the language changes. Static data-i18n
// elements are handled by i18n.js itself.
if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.onChange) {
  FitShieldI18n.onChange(() => {
    if (latestState) {
      updateUI(latestState);
    }

    // The follow-up prompt now carries a localized relative time ("3 hours
    // ago"), so it has to be rebuilt in the new language too — it was the one
    // dynamic string on this page that a language change left behind.
    renderMadePrompt();
  });
}
