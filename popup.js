const DEFAULT_TIMER_SECONDS = 60;
const MIN_TIMER_SECONDS = 10;
const DEFAULT_PASS_DURATION_MINUTES = 5;
const MIN_PASS_DURATION_MINUTES = 1;
const DEFAULT_SCHEDULE_START = "18:00";
const DEFAULT_SCHEDULE_END = "23:00";

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

function applyTheme(theme = {}) {
  const mergedTheme = {
    ...DEFAULT_THEME,
    ...theme
  };
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

async function loadTheme() {
  const { theme } = await chrome.storage.local.get(["theme"]);
  applyTheme(theme);
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

  return `${startDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} to ${endDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
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
    return "Inactive. All sites are accessible.";
  }

  if (activeSiteCount === 0) {
    return "Blocker is on, but every individual site is disabled. Open Settings to turn some sites back on.";
  }

  if (bypassActive) {
    return `Temporary pass is active. Blocking resumes in ${formatTimeRemaining(bypassUntil - Date.now())}.`;
  }

  if (scheduleEnabled && !scheduleActive) {
    return `Blocker is armed, but outside scheduled hours. It will block from ${formatScheduleText(scheduleStart, scheduleEnd)}.`;
  }

  const passMinutes = normalizePassDurationMinutes(passDurationMinutes);
  const passUnit = passMinutes === 1 ? "minute" : "minutes";

  return `Shield up. ${normalizeTimerSeconds(timerSeconds)} seconds countdown, ${passMinutes} ${passUnit} pass.`;
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
  deliveryCount.textContent = `${deliverySites.filter((site) => site.enabled).length} of ${deliverySites.length} delivery sites enabled.`;
  fastFoodCount.textContent = `${fastFoodSites.filter((site) => site.enabled).length} of ${fastFoodSites.length} fast food sites enabled.`;

  scheduleSummary.textContent = scheduleEnabled
    ? `Current schedule: ${formatScheduleText(scheduleStart, scheduleEnd)}${scheduleStart === scheduleEnd ? " every day" : ""}.`
    : "Blocking will follow your daily schedule when this is enabled.";

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

loadState();
loadTheme();
setInterval(refreshStatusOnly, 1000);
