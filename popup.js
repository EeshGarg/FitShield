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
const deliveryList = document.getElementById("deliveryList");
const fastFoodList = document.getElementById("fastFoodList");
const customListSection = document.getElementById("customListSection");
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
const customSiteInput = document.getElementById("customSiteInput");
const addCustomSiteButton = document.getElementById("addCustomSite");
const customSiteList = document.getElementById("customSiteList");
const customSiteEmpty = document.getElementById("customSiteEmpty");
const openSettingsButton = document.getElementById("openSettings");

let latestState = null;
const expandedPanels = {
  delivery: false,
  fastfood: false,
  custom: false
};

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
  danger: "#ff8b8b",
  radius: 24,
  popupWidth: 468
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
  root.style.setProperty("--danger", mergedTheme.danger);
  root.style.setProperty("--panel-radius", `${mergedTheme.radius}px`);
  root.style.setProperty("--popup-width", `${mergedTheme.popupWidth}px`);
}

async function loadTheme() {
  const { theme } = await chrome.storage.local.get(["theme"]);
  applyTheme(theme);
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
    return "Blocker is on, but every individual site is disabled. Open a blocklist and turn some sites back on.";
  }

  if (bypassActive) {
    return `Mindfulness mode is on. Temporary pass ends in ${formatTimeRemaining(bypassUntil - Date.now())}.`;
  }

  if (scheduleEnabled && !scheduleActive) {
    return `Blocker is armed, but outside scheduled hours. It will block from ${formatScheduleText(scheduleStart, scheduleEnd)}.`;
  }

  return `Active. Selected sites will show a ${normalizeTimerSeconds(timerSeconds)} second pause screen and a ${normalizePassDurationMinutes(passDurationMinutes)} minute pass.`;
}

function refreshStatusOnly() {
  if (!latestState) {
    return;
  }

  status.textContent = getStatusMessage(latestState);
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

function normalizeTimerSeconds(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(MIN_TIMER_SECONDS, parsed) : DEFAULT_TIMER_SECONDS;
}

function normalizePassDurationMinutes(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(MIN_PASS_DURATION_MINUTES, parsed) : DEFAULT_PASS_DURATION_MINUTES;
}

function normalizeCustomDomain(value) {
  const trimmed = String(value || "").trim().toLowerCase();

  if (!trimmed) {
    return null;
  }

  const withProtocol = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
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

function updateScheduleControls(scheduleEnabled) {
  scheduleStartInput.disabled = !scheduleEnabled;
  scheduleEndInput.disabled = !scheduleEnabled;
}

function updatePanelVisibility() {
  deliveryList.hidden = !expandedPanels.delivery;
  fastFoodList.hidden = !expandedPanels.fastfood;
  customListSection.hidden = !expandedPanels.custom;
  toggleDeliveryListButton.textContent = expandedPanels.delivery ? "Hide Blocklist" : "View Blocklist";
  toggleFastFoodListButton.textContent = expandedPanels.fastfood ? "Hide Blocklist" : "View Blocklist";
  toggleCustomListButton.textContent = expandedPanels.custom ? "Hide Blocklist" : "View Blocklist";
}

function formatTimerDisplay(seconds) {
  return `${seconds}s`;
}

function formatPassDisplay(minutes) {
  return `${minutes}m`;
}

function createSiteRow(site, category) {
  const row = document.createElement("div");
  row.className = "site-item";

  const meta = document.createElement("div");
  meta.className = "site-meta";

  const title = document.createElement("div");
  title.className = "site-title";
  title.textContent = site.label || site.domain;

  const subtitle = document.createElement("div");
  subtitle.className = "site-url";
  subtitle.textContent = site.match || site.domain;

  meta.append(title, subtitle);

  const controls = document.createElement("div");
  controls.className = "site-controls";

  const toggleLabel = document.createElement("label");
  toggleLabel.className = "toggle";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = site.enabled !== false;
  input.dataset.category = category;
  input.dataset.key = site.key || site.domain;

  const slider = document.createElement("span");
  slider.className = "slider";

  toggleLabel.append(input, slider);
  controls.appendChild(toggleLabel);

  if (category === "custom") {
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "button secondary";
    removeButton.textContent = "Remove";
    removeButton.dataset.removeDomain = site.domain;
    controls.appendChild(removeButton);
  }

  row.append(meta, controls);
  return row;
}

function renderSiteList(container, sites, category) {
  container.replaceChildren();

  sites.forEach((site) => {
    container.appendChild(createSiteRow(site, category));
  });
}

function renderCustomSites(customSites) {
  customSiteList.replaceChildren();
  customSiteEmpty.hidden = customSites.length > 0;

  customSites.forEach((site) => {
    customSiteList.appendChild(createSiteRow(site, "custom"));
  });
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
  renderSiteList(deliveryList, deliverySites, "delivery");
  renderSiteList(fastFoodList, fastFoodSites, "fastfood");
  renderCustomSites(customSites);
  updatePanelVisibility();

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

function getDisabledKeys(sites) {
  return sites.filter((site) => site.enabled === false).map((site) => site.key);
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

toggleDeliveryListButton.addEventListener("click", () => {
  expandedPanels.delivery = !expandedPanels.delivery;
  updatePanelVisibility();
});

toggleFastFoodListButton.addEventListener("click", () => {
  expandedPanels.fastfood = !expandedPanels.fastfood;
  updatePanelVisibility();
});

toggleCustomListButton.addEventListener("click", () => {
  expandedPanels.custom = !expandedPanels.custom;
  updatePanelVisibility();
});

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

addCustomSiteButton.addEventListener("click", async () => {
  const domain = normalizeCustomDomain(customSiteInput.value);

  if (!domain) {
    status.textContent = "That custom URL does not look valid yet. Try a domain like example.com.";
    return;
  }

  const currentSites = latestState?.customSites || [];
  const updatedSites = [...currentSites];
  const existingSite = updatedSites.find((site) => site.domain === domain);

  if (existingSite) {
    existingSite.enabled = true;
  } else {
    updatedSites.push({ domain, enabled: true });
  }

  customSiteInput.value = "";
  await saveSettings({ customSites: updatedSites });
});

customSiteInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addCustomSiteButton.click();
  }
});

deliveryList.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-category='delivery']");

  if (!input || !latestState) {
    return;
  }

  const deliverySites = latestState.deliverySites.map((site) =>
    site.key === input.dataset.key ? { ...site, enabled: input.checked } : site
  );

  await saveSettings({
    disabledDeliverySiteKeys: getDisabledKeys(deliverySites)
  });
});

fastFoodList.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-category='fastfood']");

  if (!input || !latestState) {
    return;
  }

  const fastFoodSites = latestState.fastFoodSites.map((site) =>
    site.key === input.dataset.key ? { ...site, enabled: input.checked } : site
  );

  await saveSettings({
    disabledFastFoodSiteKeys: getDisabledKeys(fastFoodSites)
  });
});

customSiteList.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-category='custom']");

  if (!input || !latestState) {
    return;
  }

  const customSites = latestState.customSites.map((site) =>
    site.domain === input.dataset.key ? { ...site, enabled: input.checked } : site
  );

  await saveSettings({ customSites });
});

customSiteList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-remove-domain]");

  if (!button || !latestState) {
    return;
  }

  const customSites = latestState.customSites.filter((site) => site.domain !== button.dataset.removeDomain);
  await saveSettings({ customSites });
});

openSettingsButton.addEventListener("click", () => {
  window.open(chrome.runtime.getURL("settings.html"), "_blank");
});

loadState();
loadTheme();
setInterval(refreshStatusOnly, 1000);
