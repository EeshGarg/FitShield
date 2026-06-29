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

function siteUnit(count) {
  return t(count === 1 ? "unitSite" : "unitSites");
}

const DEFAULT_THEME = {
  bg: "#0f141b",
  panel: "#1a212b",
  border: "#2c3644",
  text: "#edf2f7",
  muted: "#a9b4c2",
  accent: "#7ef0a8",
  radius: 24,
  popupWidth: 516
};

const DEFAULT_THEME_MODE = "dark";
const THEME_MODE_OPTIONS = ["system", "light", "dark"];
const THEME_MODE_COLOR_KEYS = ["bg", "panel", "border", "text", "muted", "accent"];
const systemThemeQuery = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: light)")
  : null;

// Color palettes for the theme mode selector. Radius and popup width
// are layout settings, so they are preserved when switching modes.
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

const bgColorInput = document.getElementById("bgColor");
const panelColorInput = document.getElementById("panelColor");
const borderColorInput = document.getElementById("borderColor");
const textColorInput = document.getElementById("textColor");
const mutedColorInput = document.getElementById("mutedColor");
const accentColorInput = document.getElementById("accentColor");
const radiusRange = document.getElementById("radiusRange");
const radiusValue = document.getElementById("radiusValue");
const popupWidthRange = document.getElementById("popupWidthRange");
const popupWidthValue = document.getElementById("popupWidthValue");
const resetThemeButton = document.getElementById("resetTheme");
const themeModeButtons = Array.from(document.querySelectorAll("[data-theme-mode]"));
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
const deliverySitesEnabledInput = document.getElementById("deliverySitesEnabled");
const fastFoodSitesEnabledInput = document.getElementById("fastFoodSitesEnabled");
const customSitesEnabledInput = document.getElementById("customSitesEnabled");
const toggleDeliveryListButton = document.getElementById("toggleDeliveryList");
const toggleFastFoodListButton = document.getElementById("toggleFastFoodList");
const toggleCustomListButton = document.getElementById("toggleCustomList");
const deliveryList = document.getElementById("deliveryList");
const fastFoodList = document.getElementById("fastFoodList");
const deliveryCount = document.getElementById("deliveryCount");
const fastFoodCount = document.getElementById("fastFoodCount");
const blocklistSearchInput = document.getElementById("blocklistSearchInput");
const blocklistSearchButton = document.getElementById("blocklistSearchButton");
const clearBlocklistSearchButton = document.getElementById("clearBlocklistSearch");
const customSiteInput = document.getElementById("customSiteInput");
const addCustomSiteButton = document.getElementById("addCustomSite");
const customSiteList = document.getElementById("customSiteList");
const customSiteEmpty = document.getElementById("customSiteEmpty");
const blocklistNotice = document.getElementById("blocklistNotice");

let latestBlockState = null;
let currentSearch = "";

const expandedSiteLists = {
  delivery: false,
  fastfood: false,
  custom: false
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

function buildTheme(theme) {
  const mergedTheme = {
    ...DEFAULT_THEME,
    ...theme
  };

  return {
    ...mergedTheme,
    panelSoft: hexToRgba(mergedTheme.text, 0.03),
    panelStrong: hexToRgba(mergedTheme.text, 0.045),
    shadow: hexToRgba(mergedTheme.accent, 0.14),
    accentDim: hexToRgba(mergedTheme.accent, 0.22)
  };
}

function applyTheme(theme) {
  const mergedTheme = buildTheme(theme);
  const root = document.documentElement;

  root.style.setProperty("--bg", mergedTheme.bg);
  root.style.setProperty("--panel", mergedTheme.panel);
  root.style.setProperty("--panel-soft", mergedTheme.panelSoft);
  root.style.setProperty("--border", mergedTheme.border);
  root.style.setProperty("--text", mergedTheme.text);
  root.style.setProperty("--muted", mergedTheme.muted);
  root.style.setProperty("--accent", mergedTheme.accent);
  root.style.setProperty("--panel-radius", `${mergedTheme.radius}px`);
}

function readThemeFromInputs() {
  return buildTheme({
    bg: bgColorInput.value,
    panel: panelColorInput.value,
    border: borderColorInput.value,
    text: textColorInput.value,
    muted: mutedColorInput.value,
    accent: accentColorInput.value,
    radius: Number.parseInt(radiusRange.value, 10),
    popupWidth: Number.parseInt(popupWidthRange.value, 10)
  });
}

function populateInputs(theme) {
  bgColorInput.value = theme.bg;
  panelColorInput.value = theme.panel;
  borderColorInput.value = theme.border;
  textColorInput.value = theme.text;
  mutedColorInput.value = theme.muted;
  accentColorInput.value = theme.accent;
  radiusRange.value = theme.radius;
  radiusValue.textContent = String(theme.radius);
  popupWidthRange.value = theme.popupWidth;
  popupWidthValue.textContent = String(theme.popupWidth);
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

async function saveTheme() {
  const theme = readThemeFromInputs();
  applyTheme(theme);
  await chrome.storage.local.set({ theme });
}

function applyThemeMode(mode) {
  const normalizedMode = normalizeThemeMode(mode);
  const isLight = resolveThemeMode(normalizedMode) === "light";
  document.documentElement.classList.toggle("theme-light", isLight);
  document.documentElement.style.colorScheme = isLight ? "light" : "dark";

  themeModeButtons.forEach((button) => {
    const isActive = button.dataset.themeMode === normalizedMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

async function setThemeMode(mode) {
  const normalizedMode = normalizeThemeMode(mode);
  const theme = buildThemeForMode(normalizedMode, {
    radius: Number.parseInt(radiusRange.value, 10),
    popupWidth: Number.parseInt(popupWidthRange.value, 10)
  });

  populateInputs(theme);
  applyTheme(theme);
  applyThemeMode(normalizedMode);
  await chrome.storage.local.set({ theme, themeMode: normalizedMode });
}

async function loadTheme() {
  const { theme, themeMode } = await chrome.storage.local.get(["theme", "themeMode"]);
  const normalizedMode = normalizeThemeMode(themeMode);
  const mergedTheme = shouldUseResolvedPreset(theme, normalizedMode)
    ? buildThemeForMode(normalizedMode, theme)
    : buildTheme(theme);

  populateInputs(mergedTheme);
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

function formatTimerDisplay(seconds) {
  return `${seconds}s`;
}

function formatPassDisplay(minutes) {
  return `${minutes}m`;
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

function updateScheduleControls(scheduleEnabled) {
  scheduleStartInput.disabled = !scheduleEnabled;
  scheduleEndInput.disabled = !scheduleEnabled;
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

function getDisabledKeys(sites) {
  return sites.filter((site) => site.enabled === false).map((site) => site.key);
}

function setNotice(message) {
  blocklistNotice.textContent = message;
}

function getSearchableText(site) {
  return [
    site.label,
    site.domain,
    site.match,
    site.home,
    site.key
  ].filter(Boolean).join(" ").toLowerCase();
}

function getFilteredSites(sites) {
  if (!currentSearch) {
    return sites;
  }

  return sites.filter((site) => getSearchableText(site).includes(currentSearch));
}

function createEmptyRow(message) {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = message;
  return empty;
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
    removeButton.className = "secondary";
    removeButton.textContent = t("removeButton");
    removeButton.dataset.removeDomain = site.domain;
    controls.appendChild(removeButton);
  }

  row.append(meta, controls);
  return row;
}

function renderSiteList(container, sites, category, emptyMessage) {
  container.replaceChildren();

  if (sites.length === 0) {
    container.appendChild(createEmptyRow(emptyMessage));
    return;
  }

  sites.forEach((site) => {
    container.appendChild(createSiteRow(site, category));
  });
}

function renderCustomSites(customSites) {
  customSiteList.replaceChildren();

  if (customSites.length === 0) {
    customSiteEmpty.textContent = currentSearch
      ? t("customNoMatch")
      : t("customEmptyDefault");
    customSiteEmpty.hidden = !expandedSiteLists.custom;
    return;
  }

  customSiteEmpty.hidden = true;

  customSites.forEach((site) => {
    customSiteList.appendChild(createSiteRow(site, "custom"));
  });
}

function setListExpanded(category, expanded) {
  expandedSiteLists[category] = expanded;
}

function updateListToggle(button, category, shownText = t("showSitesButton"), hiddenText = t("hideSitesButton")) {
  const expanded = expandedSiteLists[category];
  button.textContent = expanded ? hiddenText : shownText;
  button.setAttribute("aria-expanded", String(expanded));
}

function updateBlockingControls(state) {
  const {
    timerSeconds = DEFAULT_TIMER_SECONDS,
    passDurationMinutes = DEFAULT_PASS_DURATION_MINUTES,
    scheduleEnabled = false,
    scheduleStart = DEFAULT_SCHEDULE_START,
    scheduleEnd = DEFAULT_SCHEDULE_END
  } = state;

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

  scheduleSummary.textContent = scheduleEnabled
    ? t("currentScheduleSummary", [
        formatScheduleText(scheduleStart, scheduleEnd) + (scheduleStart === scheduleEnd ? t("everyDaySuffix") : "")
      ])
    : t("scheduleDefaultSummary");
}

function renderBlocklist(state) {
  latestBlockState = state;
  updateBlockingControls(state);

  const {
    deliverySitesEnabled = true,
    fastFoodSitesEnabled = true,
    customSitesEnabled = true,
    deliverySites = [],
    fastFoodSites = [],
    customSites = []
  } = state;

  const filteredDeliverySites = getFilteredSites(deliverySites);
  const filteredFastFoodSites = getFilteredSites(fastFoodSites);
  const filteredCustomSites = getFilteredSites(customSites);

  deliverySitesEnabledInput.checked = deliverySitesEnabled;
  fastFoodSitesEnabledInput.checked = fastFoodSitesEnabled;
  customSitesEnabledInput.checked = customSitesEnabled;
  const deliveryEnabledCount = deliverySites.filter((site) => site.enabled).length;
  const fastFoodEnabledCount = fastFoodSites.filter((site) => site.enabled).length;
  deliveryCount.textContent = t("deliverySitesEnabledCount", [String(deliveryEnabledCount), String(deliverySites.length)])
    + (currentSearch ? t("searchMatchSuffix", [String(filteredDeliverySites.length)]) : "");
  fastFoodCount.textContent = t("fastFoodSitesEnabledCount", [String(fastFoodEnabledCount), String(fastFoodSites.length)])
    + (currentSearch ? t("searchMatchSuffix", [String(filteredFastFoodSites.length)]) : "");

  renderSiteList(deliveryList, filteredDeliverySites, "delivery", t("emptyDeliverySearch"));
  renderSiteList(fastFoodList, filteredFastFoodSites, "fastfood", t("emptyFastFoodSearch"));
  renderCustomSites(filteredCustomSites);

  deliveryList.hidden = !expandedSiteLists.delivery;
  fastFoodList.hidden = !expandedSiteLists.fastfood;
  customSiteList.hidden = !expandedSiteLists.custom || filteredCustomSites.length === 0;
  updateListToggle(toggleDeliveryListButton, "delivery");
  updateListToggle(toggleFastFoodListButton, "fastfood");
  updateListToggle(toggleCustomListButton, "custom", t("showUrlsButton"), t("hideUrlsButton"));

  if (currentSearch) {
    const matchCount = filteredDeliverySites.length + filteredFastFoodSites.length + filteredCustomSites.length;
    setNotice(t("noticeMatched", [String(matchCount), siteUnit(matchCount), blocklistSearchInput.value.trim()]));
  } else if (!blocklistNotice.textContent) {
    setNotice("");
  }

  // Now that brand records are loaded, the "most blocked sites" list can resolve
  // domains to their display labels. Guard for the stats block not being present.
  if (typeof renderMostBlocked === "function") {
    renderMostBlocked();
  }
}

async function loadBlocklist() {
  const response = await chrome.runtime.sendMessage({ type: "getBlockState" });

  if (response?.ok) {
    renderBlocklist(response);
  }
}

async function saveSettings(partialState) {
  await chrome.storage.local.set(partialState);
  await loadBlocklist();
}

function applyBlocklistSearch(value) {
  currentSearch = String(value || "").trim().toLowerCase();

  if (currentSearch) {
    expandedSiteLists.delivery = true;
    expandedSiteLists.fastfood = true;
    expandedSiteLists.custom = true;
  }

  if (latestBlockState) {
    renderBlocklist(latestBlockState);
  }
}

[bgColorInput, panelColorInput, borderColorInput, textColorInput, mutedColorInput, accentColorInput].forEach((input) => {
  input.addEventListener("input", saveTheme);
});

radiusRange.addEventListener("input", () => {
  radiusValue.textContent = radiusRange.value;
  saveTheme();
});

popupWidthRange.addEventListener("input", () => {
  popupWidthValue.textContent = popupWidthRange.value;
  saveTheme();
});

themeModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setThemeMode(button.dataset.themeMode);
  });
});

resetThemeButton.addEventListener("click", async () => {
  const theme = buildTheme(DEFAULT_THEME);
  populateInputs(theme);
  applyTheme(theme);
  applyThemeMode(DEFAULT_THEME_MODE);
  await chrome.storage.local.set({ theme, themeMode: DEFAULT_THEME_MODE });
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
  if (!latestBlockState) {
    return;
  }

  setListExpanded("delivery", !expandedSiteLists.delivery);
  renderBlocklist(latestBlockState);
});

toggleFastFoodListButton.addEventListener("click", () => {
  if (!latestBlockState) {
    return;
  }

  setListExpanded("fastfood", !expandedSiteLists.fastfood);
  renderBlocklist(latestBlockState);
});

toggleCustomListButton.addEventListener("click", () => {
  if (!latestBlockState) {
    return;
  }

  setListExpanded("custom", !expandedSiteLists.custom);
  renderBlocklist(latestBlockState);
});

blocklistSearchButton.addEventListener("click", () => {
  applyBlocklistSearch(blocklistSearchInput.value);
});

blocklistSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyBlocklistSearch(blocklistSearchInput.value);
  }
});

clearBlocklistSearchButton.addEventListener("click", () => {
  blocklistSearchInput.value = "";
  currentSearch = "";
  setNotice("");

  if (latestBlockState) {
    renderBlocklist(latestBlockState);
  }
});

deliveryList.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-category='delivery']");

  if (!input || !latestBlockState) {
    return;
  }

  const deliverySites = latestBlockState.deliverySites.map((site) =>
    site.key === input.dataset.key ? { ...site, enabled: input.checked } : site
  );

  await saveSettings({
    disabledDeliverySiteKeys: getDisabledKeys(deliverySites)
  });
});

fastFoodList.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-category='fastfood']");

  if (!input || !latestBlockState) {
    return;
  }

  const fastFoodSites = latestBlockState.fastFoodSites.map((site) =>
    site.key === input.dataset.key ? { ...site, enabled: input.checked } : site
  );

  await saveSettings({
    disabledFastFoodSiteKeys: getDisabledKeys(fastFoodSites)
  });
});

addCustomSiteButton.addEventListener("click", async () => {
  const domain = normalizeCustomDomain(customSiteInput.value);

  if (!domain) {
    setNotice(t("invalidUrlNotice"));
    return;
  }

  const currentSites = latestBlockState?.customSites || [];
  const updatedSites = [...currentSites];
  const existingSite = updatedSites.find((site) => site.domain === domain);

  if (existingSite) {
    existingSite.enabled = true;
    setNotice(t("alreadyOnBlocklist", [domain]));
  } else {
    updatedSites.push({ domain, enabled: true });
    setNotice(t("addedToBlocklist", [domain]));
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

customSiteList.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-category='custom']");

  if (!input || !latestBlockState) {
    return;
  }

  const customSites = latestBlockState.customSites.map((site) =>
    site.domain === input.dataset.key ? { ...site, enabled: input.checked } : site
  );

  await saveSettings({ customSites });
});

customSiteList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-remove-domain]");

  if (!button || !latestBlockState) {
    return;
  }

  const domain = button.dataset.removeDomain;

  if (!(await confirmAction(t("confirmRemoveCustomSite", [domain])))) {
    return;
  }

  const customSites = latestBlockState.customSites.filter((site) => site.domain !== domain);
  setNotice(t("removedFromBlocklist", [domain]));
  await saveSettings({ customSites });
});

const initialSearch = new URLSearchParams(window.location.search).get("q");

if (initialSearch) {
  blocklistSearchInput.value = initialSearch;
  applyBlocklistSearch(initialSearch);
}

// Resolve once the stored UI language has been applied, so the first render
// uses the right locale instead of flashing the browser default.
const i18nReady = (typeof FitShieldI18n !== "undefined" && FitShieldI18n.ready)
  ? FitShieldI18n.ready
  : Promise.resolve();

loadTheme();
i18nReady.then(loadBlocklist);

// ===========================================================================
// Country & category blocking (metadata-driven).
// Available countries/categories are discovered from the blocklist metadata via
// blocklist.js; enabled/quick-access selections live in chrome.storage.local
// and the background service worker turns them into block rules.
// ===========================================================================

const MB_MAX_RESULTS = 8;

const countrySearchInput = document.getElementById("countrySearchInput");
const countrySearchResults = document.getElementById("countrySearchResults");
const countryQuickAccess = document.getElementById("countryQuickAccess");
const countryQuickEmpty = document.getElementById("countryQuickEmpty");
const categorySearchInput = document.getElementById("categorySearchInput");
const categorySearchResults = document.getElementById("categorySearchResults");
const categoryQuickAccess = document.getElementById("categoryQuickAccess");
const categoryQuickEmpty = document.getElementById("categoryQuickEmpty");

const metadataBlocking = {
  countries: [], // [{ code, name, count }]
  categories: [], // [{ category, count, specialties }]
  enabledCountries: [],
  enabledCategories: [],
  quickAccessCountries: [],
  quickAccessCategories: []
};

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function addUnique(list, value) {
  return list.includes(value) ? list : [...list, value];
}

function removeValue(list, value) {
  return list.filter((item) => item !== value);
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function pluralizeSites(count) {
  return `${count} ${siteUnit(count)}`;
}

function buildResultRow(name, sub, enabled, onToggle, labels) {
  const onLabel = labels && labels.onLabel ? labels.onLabel : t("mbBlocking");
  const offLabel = labels && labels.offLabel ? labels.offLabel : t("mbBlock");

  const row = document.createElement("div");
  row.className = "mb-result";

  const label = document.createElement("div");
  label.className = "mb-result-label";

  const nameEl = document.createElement("div");
  nameEl.className = "mb-result-name";
  nameEl.textContent = name;

  const subEl = document.createElement("div");
  subEl.className = "mb-result-sub";
  subEl.textContent = sub;

  label.append(nameEl, subEl);

  const button = document.createElement("button");
  button.type = "button";
  button.className = `mb-pill ${enabled ? "on" : "off"}`;
  button.textContent = enabled ? onLabel : offLabel;
  button.addEventListener("click", onToggle);

  row.append(label, button);
  return row;
}

function buildQuickChip(label, enabled, onToggle, onRemove) {
  const chip = document.createElement("div");
  chip.className = "mb-chip";

  const labelEl = document.createElement("span");
  labelEl.className = "mb-chip-label";
  labelEl.textContent = label;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = `mb-chip-toggle ${enabled ? "on" : "off"}`;
  toggle.textContent = enabled ? t("mbOn") : t("mbOff");
  toggle.title = enabled ? t("mbChipToggleOnTitle") : t("mbChipToggleOffTitle");
  toggle.addEventListener("click", onToggle);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mb-chip-remove";
  remove.textContent = "×";
  remove.title = t("mbChipRemoveTitle");
  remove.setAttribute("aria-label", t("mbChipRemoveAria", [label]));
  remove.addEventListener("click", onRemove);

  chip.append(labelEl, toggle, remove);
  return chip;
}

async function persistMetadataBlocking(partial) {
  await chrome.storage.local.set(partial);
}

// --- Country actions ---

async function setCountryEnabled(code, enabled) {
  // Toggle = enable/disable the block. Enabling also pins it to quick access.
  metadataBlocking.enabledCountries = enabled
    ? addUnique(metadataBlocking.enabledCountries, code)
    : removeValue(metadataBlocking.enabledCountries, code);

  if (enabled) {
    metadataBlocking.quickAccessCountries = addUnique(metadataBlocking.quickAccessCountries, code);
  }

  await persistMetadataBlocking({
    enabledCountries: metadataBlocking.enabledCountries,
    quickAccessCountries: metadataBlocking.quickAccessCountries
  });

  renderCountryResults();
  renderCountryQuickAccess();
}

async function unpinCountry(code) {
  // X = remove the shortcut only; the block itself stays as-is and remains
  // discoverable through search.
  metadataBlocking.quickAccessCountries = removeValue(metadataBlocking.quickAccessCountries, code);
  await persistMetadataBlocking({ quickAccessCountries: metadataBlocking.quickAccessCountries });
  renderCountryQuickAccess();
}

function renderCountryResults() {
  const query = countrySearchInput.value.trim().toLowerCase();
  countrySearchResults.replaceChildren();

  if (!query) {
    countrySearchResults.hidden = true;
    return;
  }

  const matches = metadataBlocking.countries
    .filter((country) =>
      country.name.toLowerCase().includes(query) || country.code.toLowerCase().includes(query)
    )
    .slice(0, MB_MAX_RESULTS);

  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mb-empty";
    empty.textContent = t("noCountriesMatch");
    countrySearchResults.appendChild(empty);
  } else {
    matches.forEach((country) => {
      const enabled = metadataBlocking.enabledCountries.includes(country.code);
      countrySearchResults.appendChild(
        buildResultRow(
          country.name,
          `${country.code} · ${pluralizeSites(country.count)}`,
          enabled,
          () => setCountryEnabled(country.code, !enabled)
        )
      );
    });
  }

  countrySearchResults.hidden = false;
}

function renderCountryQuickAccess() {
  countryQuickAccess.replaceChildren();
  const codes = metadataBlocking.quickAccessCountries;
  countryQuickEmpty.hidden = codes.length > 0;

  codes.forEach((code) => {
    const meta = metadataBlocking.countries.find((country) => country.code === code);
    const label = meta ? `${meta.name} (${code})` : code;
    const enabled = metadataBlocking.enabledCountries.includes(code);

    countryQuickAccess.appendChild(
      buildQuickChip(
        label,
        enabled,
        () => setCountryEnabled(code, !enabled),
        () => unpinCountry(code)
      )
    );
  });
}

// --- Category actions ---

async function setCategoryEnabled(category, enabled) {
  metadataBlocking.enabledCategories = enabled
    ? addUnique(metadataBlocking.enabledCategories, category)
    : removeValue(metadataBlocking.enabledCategories, category);

  if (enabled) {
    metadataBlocking.quickAccessCategories = addUnique(metadataBlocking.quickAccessCategories, category);
  }

  await persistMetadataBlocking({
    enabledCategories: metadataBlocking.enabledCategories,
    quickAccessCategories: metadataBlocking.quickAccessCategories
  });

  renderCategoryResults();
  renderCategoryQuickAccess();
}

async function unpinCategory(category) {
  metadataBlocking.quickAccessCategories = removeValue(metadataBlocking.quickAccessCategories, category);
  await persistMetadataBlocking({ quickAccessCategories: metadataBlocking.quickAccessCategories });
  renderCategoryQuickAccess();
}

function renderCategoryResults() {
  const query = categorySearchInput.value.trim().toLowerCase();
  categorySearchResults.replaceChildren();

  if (!query) {
    categorySearchResults.hidden = true;
    return;
  }

  const matches = metadataBlocking.categories
    .filter((entry) => {
      if (entry.category.toLowerCase().includes(query)) {
        return true;
      }
      // Specialties are searchable even though the toggle blocks by category.
      return entry.specialties.some((specialty) => specialty.toLowerCase().includes(query));
    })
    .slice(0, MB_MAX_RESULTS);

  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mb-empty";
    empty.textContent = t("noCategoriesMatch");
    categorySearchResults.appendChild(empty);
  } else {
    matches.forEach((entry) => {
      const enabled = metadataBlocking.enabledCategories.includes(entry.category);
      const specialtyHint = entry.specialties.slice(0, 3).join(", ");
      const sub = specialtyHint
        ? `${pluralizeSites(entry.count)} · ${specialtyHint}`
        : pluralizeSites(entry.count);

      categorySearchResults.appendChild(
        buildResultRow(
          capitalize(entry.category),
          sub,
          enabled,
          () => setCategoryEnabled(entry.category, !enabled)
        )
      );
    });
  }

  categorySearchResults.hidden = false;
}

function renderCategoryQuickAccess() {
  categoryQuickAccess.replaceChildren();
  const categories = metadataBlocking.quickAccessCategories;
  categoryQuickEmpty.hidden = categories.length > 0;

  categories.forEach((category) => {
    const enabled = metadataBlocking.enabledCategories.includes(category);

    categoryQuickAccess.appendChild(
      buildQuickChip(
        capitalize(category),
        enabled,
        () => setCategoryEnabled(category, !enabled),
        () => unpinCategory(category)
      )
    );
  });
}

async function initMetadataBlocking() {
  try {
    const entries = await FitShieldBlocklist.loadBlocklists();
    metadataBlocking.countries = FitShieldBlocklist.getAvailableCountries(entries);
    metadataBlocking.categories = FitShieldBlocklist.getAvailableCategories(entries);
  } catch (error) {
    console.error("Failed to load blocklist metadata:", error);
  }

  const stored = await chrome.storage.local.get([
    "enabledCountries",
    "enabledCategories",
    "quickAccessCountries",
    "quickAccessCategories"
  ]);

  metadataBlocking.enabledCountries = asStringArray(stored.enabledCountries);
  metadataBlocking.enabledCategories = asStringArray(stored.enabledCategories);
  metadataBlocking.quickAccessCountries = asStringArray(stored.quickAccessCountries);
  metadataBlocking.quickAccessCategories = asStringArray(stored.quickAccessCategories);

  renderCountryResults();
  renderCategoryResults();
  renderCountryQuickAccess();
  renderCategoryQuickAccess();
}

countrySearchInput.addEventListener("input", renderCountryResults);
categorySearchInput.addEventListener("input", renderCategoryResults);

i18nReady.then(initMetadataBlocking);

// ===========================================================================
// Display language selector.
// The chosen language is stored in chrome.storage.local under "uiLanguage" and
// applied by i18n.js. Selecting "System default" clears the override and falls
// back to Chrome's normal chrome.i18n behavior.
// ===========================================================================

const languageSearchInput = document.getElementById("languageSearchInput");
const languageSearchResults = document.getElementById("languageSearchResults");
const languageCurrent = document.getElementById("languageCurrent");

// The display-language list lives in the shared languages.js module so the
// Settings selector and the welcome page stay in sync.
const LANGUAGE_OPTIONS = (typeof FITSHIELD_LANGUAGE_OPTIONS !== "undefined")
  ? FITSHIELD_LANGUAGE_OPTIONS
  : [];

function getActiveLanguage() {
  return (typeof FitShieldI18n !== "undefined" && FitShieldI18n.getLanguage)
    ? FitShieldI18n.getLanguage()
    : "";
}

async function selectLanguage(value) {
  if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.setLanguage) {
    await FitShieldI18n.setLanguage(value, { persist: true });
  }
  // i18n.js fires its change listeners after applying, which re-renders the
  // localized views (including this list), so no extra render is needed here.
}

function languageNative(option) {
  return option.native || t(option.nativeKey);
}

function compareLanguageOptions(a, b) {
  if (a.value === b.value) {
    return 0;
  }

  if (a.value === "en") {
    return -1;
  }

  if (b.value === "en") {
    return 1;
  }

  return t(a.labelKey).localeCompare(t(b.labelKey), undefined, { sensitivity: "base" })
    || languageNative(a).localeCompare(languageNative(b), undefined, { sensitivity: "base" })
    || a.value.localeCompare(b.value);
}

function renderLanguageResults() {
  const query = languageSearchInput ? languageSearchInput.value.trim().toLowerCase() : "";
  languageSearchResults.replaceChildren();

  const active = getActiveLanguage();
  const matches = LANGUAGE_OPTIONS
    .filter((option) => {
      if (!query) {
        return true;
      }

      const haystack = `${t(option.labelKey)} ${languageNative(option)} ${option.value}`.toLowerCase();
      return haystack.includes(query);
    })
    .sort(compareLanguageOptions);

  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mb-empty";
    empty.textContent = t("noLanguagesMatch");
    languageSearchResults.appendChild(empty);
    return;
  }

  matches.forEach((option) => {
    const selected = option.value === active;
    languageSearchResults.appendChild(
      buildResultRow(
        t(option.labelKey),
        languageNative(option),
        selected,
        () => selectLanguage(option.value),
        { onLabel: t("languageActiveButton"), offLabel: t("languageUseButton") }
      )
    );
  });
}

function renderLanguageCurrent() {
  languageCurrent.replaceChildren();

  const active = getActiveLanguage();
  const option = LANGUAGE_OPTIONS.find((entry) => entry.value === active) || LANGUAGE_OPTIONS[0];

  const chip = document.createElement("div");
  chip.className = "mb-chip";

  const labelEl = document.createElement("span");
  labelEl.className = "mb-chip-label";
  labelEl.textContent = `${t(option.labelKey)} · ${languageNative(option)}`;

  chip.appendChild(labelEl);
  languageCurrent.appendChild(chip);
}

function renderLanguageViews() {
  renderLanguageResults();
  renderLanguageCurrent();
}

if (languageSearchInput) {
  languageSearchInput.addEventListener("input", renderLanguageResults);
}

// Re-render every localized dynamic view when the language changes. Static
// data-i18n elements are handled by i18n.js itself.
if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.onChange) {
  FitShieldI18n.onChange(() => {
    if (latestBlockState) {
      renderBlocklist(latestBlockState);
    }
    renderCountryResults();
    renderCategoryResults();
    renderCountryQuickAccess();
    renderCategoryQuickAccess();
    renderLanguageViews();
    refreshStats({ persist: true });
  });
}

i18nReady.then(renderLanguageViews);

// ===========================================================================
// Backup & restore (one JSON file, fully local).
// ===========================================================================

const exportSettingsButton = document.getElementById("exportSettings");
const importSettingsButton = document.getElementById("importSettings");
const importSettingsInput = document.getElementById("importSettingsInput");
const backupNotice = document.getElementById("backupNotice");

function setBackupNotice(message) {
  if (backupNotice) {
    backupNotice.textContent = message;
  }
}

if (exportSettingsButton && typeof FitShieldBackup !== "undefined") {
  exportSettingsButton.addEventListener("click", async () => {
    try {
      await FitShieldBackup.downloadBackup();
      setBackupNotice(t("exportSuccessNotice"));
    } catch (error) {
      console.error("Failed to export settings:", error);
      setBackupNotice(t("importErrorNotice"));
    }
  });
}

if (importSettingsButton && importSettingsInput) {
  importSettingsButton.addEventListener("click", () => importSettingsInput.click());

  importSettingsInput.addEventListener("change", async () => {
    const file = importSettingsInput.files && importSettingsInput.files[0];

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const count = await FitShieldBackup.importFromText(text);
      setBackupNotice(t("importSuccessNotice", [String(count)]));
      // Reload so every control reflects the restored values.
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      console.error("Failed to import settings:", error);
      setBackupNotice(t("importErrorNotice"));
    } finally {
      importSettingsInput.value = "";
    }
  });
}

// ===========================================================================
// Protection Status (local-only health snapshot) + estimated savings.
// Every value comes from data already on the device — the blocklist metadata,
// the recipe catalog, the supported-locale list, and a local blocked-visit
// counter. No network requests.
// ===========================================================================

const DEFAULT_AVG_MEAL_COST = 15;
const DEFAULT_AVG_MEAL_CALORIES = 1000;

const currencyApi = typeof FitShieldCurrency !== "undefined" ? FitShieldCurrency : null;

const protectionStatusGrid = document.getElementById("protectionStatusGrid");
const avgMealCostInput = document.getElementById("avgMealCost");
const avgMealCaloriesInput = document.getElementById("avgMealCalories");
const currencySelect = document.getElementById("currencyMode");
const avgMealCostLabelEl = document.getElementById("avgMealCostLabel");

const protectionData = {
  blockedVisits: 0,
  avgMealCost: DEFAULT_AVG_MEAL_COST,
  avgMealCalories: DEFAULT_AVG_MEAL_CALORIES,
  caloriesAvoided: 0,
  currencyChoice: "", // "" => follow the display language
  customized: false,  // true once the user edits cost or calories by hand
  // Aggregate, local-only breakdowns of what got blocked (counts keyed by the
  // curated brand's apex domain, food category, and operating countries). No
  // URLs, pages, or browsing history — only the brands already on the blocklist.
  blockedByDomain: {},
  blockedByCategory: {},
  blockedByCountry: {}
};

const mostBlockedContainer = document.getElementById("mostBlockedContainer");
const MOST_BLOCKED_LIMIT = 5;

// The locale the stats format against: the pinned UI language, or the browser
// locale when "System default" is selected.
function statsLocale() {
  const ui = (typeof FitShieldI18n !== "undefined" && FitShieldI18n.getLanguage)
    ? FitShieldI18n.getLanguage()
    : "";
  return ui || (typeof navigator !== "undefined" && navigator.language) || "en";
}

function resolvedCurrency() {
  return currencyApi
    ? currencyApi.resolveCurrency(protectionData.currencyChoice, statsLocale())
    : "USD";
}

function normalizeMealCost(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AVG_MEAL_COST;
}

function normalizeMealCalories(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AVG_MEAL_CALORIES;
}

// Format the savings figure in the resolved currency ("$1,234" / "¥1,234"),
// falling back to a bare number if Intl/the currency module is unavailable.
function formatSavings(amount) {
  if (currencyApi) {
    return currencyApi.formatMoney(amount, resolvedCurrency(), statsLocale());
  }
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function formatCount(amount) {
  return (Number(amount) || 0).toLocaleString();
}

function buildStatCard(value, label, valueClass) {
  const card = document.createElement("div");
  card.className = "stat-card";

  const valueEl = document.createElement("div");
  valueEl.className = valueClass ? `stat-value ${valueClass}` : "stat-value";
  valueEl.textContent = value;

  const labelEl = document.createElement("div");
  labelEl.className = "stat-label";
  labelEl.textContent = label;

  card.append(valueEl, labelEl);
  return card;
}

// Compact, Brave-style stat strip: the three numbers that actually accumulate
// as you use FitShield. Everything is a local aggregate — no per-site history.
function renderProtectionStatus() {
  if (!protectionStatusGrid) {
    return;
  }

  const savings = protectionData.blockedVisits * protectionData.avgMealCost;

  const cards = [
    buildStatCard(formatCount(protectionData.blockedVisits), t("statusBlockedVisits")),
    buildStatCard(formatSavings(savings), t("statusEstimatedSavings"), "savings"),
    buildStatCard(formatCount(protectionData.caloriesAvoided), t("statusCaloriesAvoided"))
  ];

  protectionStatusGrid.replaceChildren(...cards);
  renderMostBlocked();
}

// BCP-47 form of the stats locale ("pt_BR" -> "pt-BR") for Intl APIs.
function intlLocale() {
  return statsLocale().replace(/_/g, "-");
}

// Resolve a curated brand's apex domain to its display label (e.g.
// "doordash.com" -> "DoorDash") from the loaded blocklist. Falls back to the
// domain itself for custom sites or anything not currently loaded.
function brandLabelForDomain(domain) {
  if (latestBlockState) {
    const sites = [...(latestBlockState.deliverySites || []), ...(latestBlockState.fastFoodSites || [])];
    const match = sites.find((site) => (site.domain || site.match) === domain);
    if (match && match.label) {
      return match.label;
    }
  }
  return domain;
}

// Title-case a raw category id for display: "fast_casual" -> "Fast Casual".
// Used as the universal fallback when a category has no localized name.
function prettifyCategory(category) {
  return String(category || "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Localized display name for a category id. Core food categories have a
// `catLabel<PascalCase>` message; anything else (or any locale missing the
// string) falls back to the prettified id, so every category reads cleanly in
// every language without inventing translations for niche categories.
function categoryDisplayName(category) {
  const pascal = String(category || "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  const key = pascal ? `catLabel${pascal}` : "";

  if (key) {
    const localized = t(key);
    if (localized && localized !== key) {
      return localized;
    }
  }

  return prettifyCategory(category);
}

// Localized country name from an ISO code; falls back to the code when Intl has
// no name for it (e.g. XK). Memoized via a single cached formatter per render.
let regionNamesFormatter = null;
function countryDisplayName(code) {
  const upper = String(code || "").trim().toUpperCase();
  if (!upper) {
    return "";
  }
  try {
    if (!regionNamesFormatter) {
      regionNamesFormatter = new Intl.DisplayNames([intlLocale()], { type: "region" });
    }
    return regionNamesFormatter.of(upper) || upper;
  } catch (error) {
    return upper;
  }
}

// Coerce a stored value into a clean { key: positive-number } map. Defensive
// against junk (non-objects, arrays, NaN counts) from older or hand-edited data.
function readCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const out = {};
  Object.entries(value).forEach(([key, count]) => {
    const n = Number(count);
    if (key && Number.isFinite(n) && n > 0) {
      out[key] = n;
    }
  });
  return out;
}

// Turn a { key: count } map into the top-N [key, count] pairs, highest first,
// breaking ties alphabetically so the list is stable.
function topEntries(map) {
  return Object.entries(map && typeof map === "object" ? map : {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, MOST_BLOCKED_LIMIT);
}

// Fill one ranked list (sites / categories / countries). `nameFor` maps a raw
// key to its display label. Shows a muted "no data yet" note when empty.
function renderRankedList(listEl, map, nameFor) {
  if (!listEl) {
    return false;
  }

  const entries = topEntries(map);
  listEl.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "most-blocked-empty";
    empty.textContent = t("statsMostBlockedEmpty");
    listEl.appendChild(empty);
    return false;
  }

  entries.forEach(([key, count]) => {
    const item = document.createElement("li");

    const name = document.createElement("span");
    name.className = "mb-name";
    name.textContent = nameFor(key);
    name.title = name.textContent;

    const countEl = document.createElement("span");
    countEl.className = "mb-count";
    countEl.textContent = `${formatCount(count)}×`;

    item.append(name, countEl);
    listEl.appendChild(item);
  });

  return true;
}

// Render the three "most blocked" lists. The whole block is hidden until at
// least one block has been recorded, so a fresh install stays uncluttered.
function renderMostBlocked() {
  if (!mostBlockedContainer) {
    return;
  }

  regionNamesFormatter = null; // rebuild per render so a language switch re-localizes.

  const hasSites = renderRankedList(
    document.getElementById("mostBlockedSites"),
    protectionData.blockedByDomain,
    (domain) => brandLabelForDomain(domain)
  );
  const hasCategories = renderRankedList(
    document.getElementById("mostBlockedCategories"),
    protectionData.blockedByCategory,
    (category) => categoryDisplayName(category)
  );
  const hasCountries = renderRankedList(
    document.getElementById("mostBlockedCountries"),
    protectionData.blockedByCountry,
    (code) => countryDisplayName(code)
  );

  mostBlockedContainer.hidden = !(hasSites || hasCategories || hasCountries);
}

// Build the currency picker: a "follow language" option (globe) plus every
// supported currency, each shown with its localized name and symbol. No
// translation strings needed — Intl localizes the names and symbols.
function buildCurrencyOptions() {
  if (!currencySelect || !currencyApi) {
    return;
  }

  const locale = statsLocale();
  const autoCode = currencyApi.localeDefaults(locale).currency;
  const frag = document.createDocumentFragment();

  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = `🌐 ${currencyApi.displayName(autoCode, locale)} (${currencyApi.symbolFor(autoCode, locale)})`;
  frag.appendChild(auto);

  currencyApi.currencyCodes().forEach((code) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${currencyApi.displayName(code, locale)} (${currencyApi.symbolFor(code, locale)})`;
    frag.appendChild(opt);
  });

  currencySelect.replaceChildren(frag);
  currencySelect.value = protectionData.currencyChoice;
}

// Show the active currency symbol next to the "Average meal cost" label.
function updateCostLabel() {
  if (!avgMealCostLabelEl || !currencyApi) {
    return;
  }
  const symbol = currencyApi.symbolFor(resolvedCurrency(), statsLocale());
  avgMealCostLabelEl.textContent = `${t("avgMealCostLabel")} (${symbol})`;
}

// Re-seed cost & calories from the locale/currency until the user customizes
// them, then refresh the label and the stat cards. `persist` writes the seeded
// values so the background's calorie estimate matches what's shown here.
async function applyCurrencyDefaults(options) {
  const persist = !!(options && options.persist);

  if (!protectionData.customized && currencyApi) {
    const code = resolvedCurrency();
    protectionData.avgMealCost = currencyApi.defaultCost(code);
    protectionData.avgMealCalories = currencyApi.defaultCalories(statsLocale());

    if (avgMealCostInput) {
      avgMealCostInput.value = protectionData.avgMealCost;
    }
    if (avgMealCaloriesInput) {
      avgMealCaloriesInput.value = protectionData.avgMealCalories;
    }

    if (persist) {
      await chrome.storage.local.set({
        avgMealCost: protectionData.avgMealCost,
        avgMealCalories: protectionData.avgMealCalories
      });
    }
  }

  updateCostLabel();
  renderProtectionStatus();
}

// Rebuild the picker (names/symbols are locale-dependent) and re-apply defaults.
async function refreshStats(options) {
  buildCurrencyOptions();
  await applyCurrencyDefaults(options);
}

async function initProtectionStatus() {
  const stored = await chrome.storage.local.get([
    "blockedVisits",
    "avgMealCost",
    "avgMealCalories",
    "caloriesAvoided",
    "currency",
    "mealStatsCustomized",
    "blockedByDomain",
    "blockedByCategory",
    "blockedByCountry"
  ]);

  protectionData.blockedVisits = Number(stored.blockedVisits) || 0;
  protectionData.caloriesAvoided = Number(stored.caloriesAvoided) || 0;
  protectionData.currencyChoice = typeof stored.currency === "string" ? stored.currency : "";
  protectionData.customized = !!stored.mealStatsCustomized;
  protectionData.blockedByDomain = readCountMap(stored.blockedByDomain);
  protectionData.blockedByCategory = readCountMap(stored.blockedByCategory);
  protectionData.blockedByCountry = readCountMap(stored.blockedByCountry);

  // Customized values are the user's own; otherwise they get seeded from the
  // locale in refreshStats() below.
  if (protectionData.customized) {
    protectionData.avgMealCost = normalizeMealCost(stored.avgMealCost);
    protectionData.avgMealCalories = normalizeMealCalories(stored.avgMealCalories);

    if (avgMealCostInput) {
      avgMealCostInput.value = protectionData.avgMealCost;
    }
    if (avgMealCaloriesInput) {
      avgMealCaloriesInput.value = protectionData.avgMealCalories;
    }
  }

  await refreshStats({ persist: true });
}

if (currencySelect) {
  currencySelect.addEventListener("change", async () => {
    protectionData.currencyChoice = currencySelect.value || "";
    await chrome.storage.local.set({ currency: protectionData.currencyChoice });
    await applyCurrencyDefaults({ persist: true });
  });
}

if (avgMealCostInput) {
  avgMealCostInput.addEventListener("change", async () => {
    protectionData.avgMealCost = normalizeMealCost(avgMealCostInput.value);
    avgMealCostInput.value = protectionData.avgMealCost;
    protectionData.customized = true;
    await chrome.storage.local.set({
      avgMealCost: protectionData.avgMealCost,
      mealStatsCustomized: true
    });
    renderProtectionStatus();
  });
}

if (avgMealCaloriesInput) {
  avgMealCaloriesInput.addEventListener("change", async () => {
    protectionData.avgMealCalories = normalizeMealCalories(avgMealCaloriesInput.value);
    avgMealCaloriesInput.value = protectionData.avgMealCalories;
    protectionData.customized = true;
    await chrome.storage.local.set({
      avgMealCalories: protectionData.avgMealCalories,
      mealStatsCustomized: true
    });
    renderProtectionStatus();
  });
}

// Keep the stats live if a block or recipe choice happens (or settings are
// restored) while this page is open.
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }

    if (changes.blockedVisits) {
      protectionData.blockedVisits = Number(changes.blockedVisits.newValue) || 0;
      renderProtectionStatus();
    }

    if (changes.caloriesAvoided) {
      protectionData.caloriesAvoided = Number(changes.caloriesAvoided.newValue) || 0;
      renderProtectionStatus();
    }

    if (changes.blockedByDomain || changes.blockedByCategory || changes.blockedByCountry) {
      if (changes.blockedByDomain) {
        protectionData.blockedByDomain = readCountMap(changes.blockedByDomain.newValue);
      }
      if (changes.blockedByCategory) {
        protectionData.blockedByCategory = readCountMap(changes.blockedByCategory.newValue);
      }
      if (changes.blockedByCountry) {
        protectionData.blockedByCountry = readCountMap(changes.blockedByCountry.newValue);
      }
      renderMostBlocked();
    }
  });
}

i18nReady.then(initProtectionStatus);

// ===========================================================================
// Confirmation dialog + Reset & Data.
// A single reusable modal guards every destructive action so an accidental
// click never wipes settings. Resets remove the relevant keys and let the
// background defaults repopulate, then reload so every control reflects them.
// ===========================================================================

const confirmOverlay = document.getElementById("confirmOverlay");
const confirmMessageEl = document.getElementById("confirmMessage");
const confirmOkButton = document.getElementById("confirmOk");
const confirmCancelButton = document.getElementById("confirmCancel");
const resetBlockingButton = document.getElementById("resetBlocking");
const resetAppearanceButton = document.getElementById("resetAppearance");
const resetPreferencesButton = document.getElementById("resetPreferences");
const factoryResetButton = document.getElementById("factoryReset");
const resetNotice = document.getElementById("resetNotice");

// Show the modal and resolve true (confirm) or false (cancel / Escape / backdrop).
function confirmAction(message) {
  if (!confirmOverlay || !confirmMessageEl) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    confirmMessageEl.textContent = message;
    confirmOverlay.hidden = false;
    confirmOkButton.focus();

    const cleanup = (result) => {
      confirmOverlay.hidden = true;
      confirmOkButton.removeEventListener("click", onOk);
      confirmCancelButton.removeEventListener("click", onCancel);
      confirmOverlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (event) => {
      if (event.target === confirmOverlay) {
        cleanup(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        cleanup(false);
      }
    };

    confirmOkButton.addEventListener("click", onOk);
    confirmCancelButton.addEventListener("click", onCancel);
    confirmOverlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

const BLOCKING_KEYS = [
  "enabled",
  "timerSeconds",
  "passDurationMinutes",
  "scheduleEnabled",
  "scheduleStart",
  "scheduleEnd",
  "deliverySitesEnabled",
  "fastFoodSitesEnabled",
  "customSitesEnabled",
  "disabledDeliverySiteKeys",
  "disabledFastFoodSiteKeys",
  "customSites",
  "siteBypasses",
  "enabledCountries",
  "enabledCategories",
  "quickAccessCountries",
  "quickAccessCategories"
];

const APPEARANCE_KEYS = ["theme", "themeMode", "cardOrder"];
const PREFERENCE_KEYS = ["avgMealCost", "avgMealCalories", "currency", "mealStatsCustomized", "blockedVisits", "caloriesAvoided", "recipesChosen", "recipeFavorites", "blockedByDomain", "blockedByCategory", "blockedByCountry"];

function reloadSoon() {
  if (resetNotice) {
    resetNotice.textContent = t("resetDoneNotice");
  }
  setTimeout(() => window.location.reload(), 700);
}

async function resetKeys(keys) {
  await chrome.storage.local.remove(keys);
  reloadSoon();
}

if (resetBlockingButton) {
  resetBlockingButton.addEventListener("click", async () => {
    if (await confirmAction(t("confirmResetBlocking"))) {
      await resetKeys(BLOCKING_KEYS);
    }
  });
}

if (resetAppearanceButton) {
  resetAppearanceButton.addEventListener("click", async () => {
    if (await confirmAction(t("confirmResetAppearance"))) {
      await resetKeys(APPEARANCE_KEYS);
    }
  });
}

if (resetPreferencesButton) {
  resetPreferencesButton.addEventListener("click", async () => {
    if (await confirmAction(t("confirmResetPreferences"))) {
      await resetKeys(PREFERENCE_KEYS);
    }
  });
}

if (factoryResetButton) {
  factoryResetButton.addEventListener("click", async () => {
    if (await confirmAction(t("confirmFactoryReset"))) {
      await chrome.storage.local.clear();
      reloadSoon();
    }
  });
}

// ===========================================================================
// Dashboard cards: drag-and-drop reorder (with keyboard fallback) and a subtle,
// damped hover tilt. The chosen order is saved locally in chrome.storage and
// restored on load. Both are progressive enhancements: with reduced motion the
// tilt is skipped, and the cards stay fully usable either way. No libraries.
// ===========================================================================

(function setupDashboardCards() {
  const layout = document.querySelector(".layout");

  if (!layout || typeof chrome === "undefined" || !chrome.storage) {
    return;
  }

  const CARD_ORDER_KEY = "cardOrder";
  const reduceMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const getSections = () => Array.from(layout.querySelectorAll(":scope > .section"));

  let draggingEl = null;
  let pointerActive = false;

  function persistOrder() {
    const order = getSections().map((section) => section.id).filter(Boolean);
    chrome.storage.local.set({ [CARD_ORDER_KEY]: order });
  }

  // Re-order the cards to match a saved id list. Cards not named in the saved
  // order (e.g. a section added in a later release) keep their natural order and
  // follow the saved ones.
  function applyStoredOrder(order) {
    if (!Array.isArray(order) || order.length === 0) {
      return;
    }

    const current = getSections();
    const saved = new Set(order);
    const inSaved = order
      .map((id) => current.find((section) => section.id === id))
      .filter(Boolean);
    const rest = current.filter((section) => !saved.has(section.id));

    [...inSaved, ...rest].forEach((section) => layout.appendChild(section));
  }

  function moveSection(section, direction) {
    const list = getSections();
    const index = list.indexOf(section);
    const target = index + direction;

    if (target < 0 || target >= list.length) {
      return;
    }

    if (direction < 0) {
      layout.insertBefore(section, list[target]);
    } else {
      layout.insertBefore(section, list[target].nextSibling);
    }

    persistOrder();
  }

  function addHandle(section) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "drag-handle";

    const title = (section.querySelector("h2")?.textContent || "").trim();
    const label = t("reorderCardLabel", [title]);
    handle.setAttribute("aria-label", label);
    handle.title = label;

    // A drag only begins from the handle: arm draggable on press, disarm after.
    handle.addEventListener("pointerdown", () => {
      section.setAttribute("draggable", "true");
    });

    handle.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        moveSection(section, -1);
        handle.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        moveSection(section, 1);
        handle.focus();
      }
    });

    // First in DOM order so keyboard users reach the reorder control before the
    // card's content; it is positioned visually at the top-center via CSS.
    section.insertBefore(handle, section.firstChild);
  }

  function onDragStart(section, event) {
    draggingEl = section;
    section.classList.add("dragging");
    section.style.transform = "";
    event.dataTransfer.effectAllowed = "move";

    try {
      event.dataTransfer.setData("text/plain", section.id);
    } catch (error) {
      // Some browsers restrict setData; the reorder still works without it.
    }
  }

  function onDragEnd(section) {
    section.classList.remove("dragging");
    section.removeAttribute("draggable");
    draggingEl = null;
    persistOrder();
  }

  function onDragOver(section, event) {
    if (!draggingEl || draggingEl === section) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const box = section.getBoundingClientRect();
    const insertBefore = (event.clientY - box.top) < box.height / 2;

    if (insertBefore) {
      layout.insertBefore(draggingEl, section);
    } else {
      layout.insertBefore(draggingEl, section.nextSibling);
    }
  }

  function setupTilt(section) {
    if (reduceMotion) {
      return;
    }

    let rafId = 0;
    let lastEvent = null;

    section.addEventListener("pointermove", (event) => {
      if (draggingEl || pointerActive || event.pointerType === "touch") {
        return;
      }

      lastEvent = event;

      if (rafId) {
        return;
      }

      rafId = requestAnimationFrame(() => {
        rafId = 0;

        if (draggingEl || pointerActive || !lastEvent) {
          return;
        }

        const box = section.getBoundingClientRect();
        const px = (lastEvent.clientX - box.left) / box.width - 0.5;
        const py = (lastEvent.clientY - box.top) / box.height - 0.5;
        const max = 2.2;

        section.style.transform =
          `perspective(900px) rotateX(${(-py * max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg)`;
      });
    });

    section.addEventListener("pointerleave", () => {
      section.style.transform = "";
    });
  }

  async function init() {
    let stored = {};

    try {
      stored = await chrome.storage.local.get([CARD_ORDER_KEY]);
    } catch (error) {
      console.error("Failed to read card order:", error);
    }

    applyStoredOrder(stored[CARD_ORDER_KEY]);

    getSections().forEach((section) => {
      addHandle(section);
      section.addEventListener("dragstart", (event) => onDragStart(section, event));
      section.addEventListener("dragend", () => onDragEnd(section));
      section.addEventListener("dragover", (event) => onDragOver(section, event));
      setupTilt(section);
    });

    layout.addEventListener("drop", (event) => event.preventDefault());

    // Flatten any tilt while the pointer is pressed so editing sliders/inputs
    // stays stable, and never leave a card "armed" for drag after a release.
    document.addEventListener("pointerdown", () => {
      pointerActive = true;
      if (!reduceMotion) {
        getSections().forEach((section) => { section.style.transform = ""; });
      }
    });

    document.addEventListener("pointerup", () => {
      pointerActive = false;
      getSections().forEach((section) => section.removeAttribute("draggable"));
    });
  }

  i18nReady.then(init);
})();
