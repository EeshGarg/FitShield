const DEFAULT_TIMER_SECONDS = 60;
const MIN_TIMER_SECONDS = 10;
const DEFAULT_PASS_DURATION_MINUTES = 5;
const MIN_PASS_DURATION_MINUTES = 1;
const DEFAULT_SCHEDULE_START = "18:00";
const DEFAULT_SCHEDULE_END = "23:00";

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

const DEFAULT_THEME_MODE = "dark";
const THEME_MODE_OPTIONS = ["system", "light", "dark"];
const THEME_MODE_COLOR_KEYS = ["bg", "panel", "border", "text", "muted", "accent"];
const systemThemeQuery = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: light)")
  : null;

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

function hexToRgba(hex, alpha) {
  const normalized = hex.replace("#", "");
  const expanded = normalized.length === 3
    ? normalized.split("").map((char) => char + char).join("")
    : normalized;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

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

function normalizeThemeMode(mode) {
  return THEME_MODE_OPTIONS.includes(mode) ? mode : DEFAULT_THEME_MODE;
}

function resolveThemeMode(mode) {
  const normalizedMode = normalizeThemeMode(mode);

  if (normalizedMode === "system") {
    return systemThemeQuery?.matches ? "light" : "dark";
  }

  return normalizedMode;
}

function themeMatchesPreset(theme, preset) {
  return THEME_MODE_COLOR_KEYS.every((key) => {
    const value = theme?.[key];
    return typeof value === "string" && value.toLowerCase() === preset[key];
  });
}

function shouldUseResolvedPreset(theme, mode) {
  return normalizeThemeMode(mode) === "system"
    && (!theme || themeMatchesPreset(theme, THEME_MODE_PRESETS.dark) || themeMatchesPreset(theme, THEME_MODE_PRESETS.light));
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

function normalizeTimerSeconds(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(MIN_TIMER_SECONDS, parsed) : DEFAULT_TIMER_SECONDS;
}

function normalizePassDurationMinutes(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(MIN_PASS_DURATION_MINUTES, parsed) : DEFAULT_PASS_DURATION_MINUTES;
}

function formatTimeRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
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

function updateScheduleControls(scheduleEnabled) {
  scheduleStartInput.disabled = !scheduleEnabled;
  scheduleEndInput.disabled = !scheduleEnabled;
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

  const bypassActive = enabled && bypassUntil > Date.now();
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
    return t("statusBypassActive", [formatTimeRemaining(bypassUntil - Date.now())]);
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

function refreshStatusOnly() {
  if (!latestState) {
    return;
  }

  status.textContent = getStatusMessage(latestState);
}

function updateUI(state) {
  latestState = state;

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
  timerDisplay.textContent = formatTimerDisplay(normalizeTimerSeconds(timerSeconds));
  passDurationSlider.value = normalizePassDurationMinutes(passDurationMinutes);
  passDurationMinutesInput.value = normalizePassDurationMinutes(passDurationMinutes);
  passDurationDisplay.textContent = formatPassDisplay(normalizePassDurationMinutes(passDurationMinutes));
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

  scheduleSummary.textContent = scheduleEnabled
    ? t("currentScheduleSummary", [
        formatScheduleText(scheduleStart, scheduleEnd) + (scheduleStart === scheduleEnd ? t("everyDaySuffix") : "")
      ])
    : t("scheduleDefaultSummary");

  card.classList.toggle("glow", enabled && activeSiteCount > 0 && (scheduleActive || !scheduleEnabled) && !bypassActive);

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
  window.open(chrome.runtime.getURL(path), "_blank");
}

function openBlocklistSettings(searchTerm = "") {
  const url = new URL(chrome.runtime.getURL("settings.html"));
  const query = String(searchTerm || "").trim();

  if (query) {
    url.searchParams.set("q", query);
  }

  url.hash = "customize-blocklist";
  window.open(url.toString(), "_blank");
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

timerSlider.addEventListener("input", () => {
  const timerSeconds = normalizeTimerSeconds(timerSlider.value);
  timerSecondsInput.value = timerSeconds;
  timerDisplay.textContent = formatTimerDisplay(timerSeconds);
  chrome.storage.local.set({ timerSeconds });
});

timerSecondsInput.addEventListener("change", async () => {
  const timerSeconds = normalizeTimerSeconds(timerSecondsInput.value);
  timerSecondsInput.value = timerSeconds;
  timerSlider.value = timerSeconds;
  timerDisplay.textContent = formatTimerDisplay(timerSeconds);
  await saveSettings({ timerSeconds });
});

passDurationSlider.addEventListener("input", () => {
  const passDurationMinutes = normalizePassDurationMinutes(passDurationSlider.value);
  passDurationMinutesInput.value = passDurationMinutes;
  passDurationDisplay.textContent = formatPassDisplay(passDurationMinutes);
  chrome.storage.local.set({ passDurationMinutes });
});

passDurationMinutesInput.addEventListener("change", async () => {
  const passDurationMinutes = normalizePassDurationMinutes(passDurationMinutesInput.value);
  passDurationMinutesInput.value = passDurationMinutes;
  passDurationSlider.value = passDurationMinutes;
  passDurationDisplay.textContent = formatPassDisplay(passDurationMinutes);
  await saveSettings({ passDurationMinutes });
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

i18nReady.then(loadState);
loadTheme();
setInterval(refreshStatusOnly, 1000);

// Re-render dynamic strings when the language changes. Static data-i18n
// elements are handled by i18n.js itself.
if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.onChange) {
  FitShieldI18n.onChange(() => {
    if (latestState) {
      updateUI(latestState);
    }
  });
}
