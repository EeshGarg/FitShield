const DEFAULT_TIMER_SECONDS = 60;
const MIN_TIMER_SECONDS = 10;
const DEFAULT_PASS_DURATION_MINUTES = 5;
const MIN_PASS_DURATION_MINUTES = 1;
const DEFAULT_SCHEDULE_START = "18:00";
const DEFAULT_SCHEDULE_END = "23:00";

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

async function saveTheme() {
  const theme = readThemeFromInputs();
  applyTheme(theme);
  await chrome.storage.local.set({ theme });
}

async function loadTheme() {
  const { theme } = await chrome.storage.local.get(["theme"]);
  const mergedTheme = buildTheme(theme);
  populateInputs(mergedTheme);
  applyTheme(mergedTheme);
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

  return `${startDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} to ${endDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
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
    removeButton.textContent = "Remove";
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
      ? "No custom URLs match this search."
      : "No custom URLs added yet.";
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

function updateListToggle(button, category, shownText = "Show Sites", hiddenText = "Hide Sites") {
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
    ? `Current schedule: ${formatScheduleText(scheduleStart, scheduleEnd)}${scheduleStart === scheduleEnd ? " every day" : ""}.`
    : "Blocking will follow your daily schedule when this is enabled.";
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
  deliveryCount.textContent = `${deliverySites.filter((site) => site.enabled).length} of ${deliverySites.length} delivery sites enabled.${currentSearch ? ` ${filteredDeliverySites.length} match the search.` : ""}`;
  fastFoodCount.textContent = `${fastFoodSites.filter((site) => site.enabled).length} of ${fastFoodSites.length} fast food sites enabled.${currentSearch ? ` ${filteredFastFoodSites.length} match the search.` : ""}`;

  renderSiteList(deliveryList, filteredDeliverySites, "delivery", "No delivery sites match this search.");
  renderSiteList(fastFoodList, filteredFastFoodSites, "fastfood", "No fast food sites match this search.");
  renderCustomSites(filteredCustomSites);

  deliveryList.hidden = !expandedSiteLists.delivery;
  fastFoodList.hidden = !expandedSiteLists.fastfood;
  customSiteList.hidden = !expandedSiteLists.custom || filteredCustomSites.length === 0;
  updateListToggle(toggleDeliveryListButton, "delivery");
  updateListToggle(toggleFastFoodListButton, "fastfood");
  updateListToggle(toggleCustomListButton, "custom", "Show URLs", "Hide URLs");

  if (currentSearch) {
    const matchCount = filteredDeliverySites.length + filteredFastFoodSites.length + filteredCustomSites.length;
    setNotice(`${matchCount} site${matchCount === 1 ? "" : "s"} matched "${blocklistSearchInput.value.trim()}".`);
  } else if (!blocklistNotice.textContent) {
    setNotice("");
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

resetThemeButton.addEventListener("click", async () => {
  const theme = buildTheme(DEFAULT_THEME);
  populateInputs(theme);
  applyTheme(theme);
  await chrome.storage.local.set({ theme });
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
    setNotice("That URL does not look valid yet. Try a domain like example.com.");
    return;
  }

  const currentSites = latestBlockState?.customSites || [];
  const updatedSites = [...currentSites];
  const existingSite = updatedSites.find((site) => site.domain === domain);

  if (existingSite) {
    existingSite.enabled = true;
    setNotice(`${domain} is already on the blocklist, so it has been re-enabled.`);
  } else {
    updatedSites.push({ domain, enabled: true });
    setNotice(`${domain} was added to the custom blocklist.`);
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

  const customSites = latestBlockState.customSites.filter((site) => site.domain !== button.dataset.removeDomain);
  setNotice(`${button.dataset.removeDomain} was removed from the custom blocklist.`);
  await saveSettings({ customSites });
});

const initialSearch = new URLSearchParams(window.location.search).get("q");

if (initialSearch) {
  blocklistSearchInput.value = initialSearch;
  applyBlocklistSearch(initialSearch);
}

loadTheme();
loadBlocklist();

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
  return `${count} site${count === 1 ? "" : "s"}`;
}

function buildResultRow(name, sub, enabled, onToggle) {
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
  button.textContent = enabled ? "Blocking" : "Block";
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
  toggle.textContent = enabled ? "On" : "Off";
  toggle.title = enabled ? "Blocking — click to pause" : "Paused — click to block";
  toggle.addEventListener("click", onToggle);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mb-chip-remove";
  remove.textContent = "×";
  remove.title = "Remove shortcut from quick access";
  remove.setAttribute("aria-label", `Remove ${label} from quick access`);
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
    empty.textContent = "No countries match that search.";
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
    empty.textContent = "No categories match that search.";
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

initMetadataBlocking();
