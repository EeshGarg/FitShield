/**
 * FitShield settings — blocklist customization, country/category blocking,
 * language, appearance, statistics, backup, and reset.
 *
 * The preference surfaces added for the decision flow (friction, schedules,
 * kitchen, custom alternatives, recap, preview, reporting) live in
 * preferences.js, which loads after this file.
 */

// Localization helper (i18n.js loads first). Falls back to the key when a
// message is missing so the gap is visible rather than blank.
const t = (key, subs) =>
  (typeof FitShieldI18n !== "undefined" ? FitShieldI18n.t(key, subs) : key);

// `t` returns the raw key when a message is missing, which is the right
// behaviour for a label (the gap is obvious) and the wrong behaviour for a
// sentence shown to a user (they read "confirmImportBackup"). For strings added
// after the locale files were last synced, fall back to the English text instead
// so the sentence is always readable; the key wins the moment it exists.
function tOr(key, fallback, subs) {
  const value = t(key, subs);
  return value === key ? fallback : value;
}

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

// Color palettes for the theme mode selector. Radius and popup width
// are layout settings, so they are preserved when switching modes.

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
const passDurationSlider = document.getElementById("passDurationSlider");
const passDurationDisplay = document.getElementById("passDurationDisplay");
const passDurationMinutesInput = document.getElementById("passDurationMinutes");
const allBlocklistsEnabledInput = document.getElementById("allBlocklistsEnabled");
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



function formatTimerDisplay(seconds) {
  return `${seconds}s`;
}

function formatPassDisplay(minutes) {
  return `${minutes}m`;
}

// This page used to carry a SECOND schedule control: a start/end pair in
// Blocking Options, projected from the canonical `schedule` object, with a
// summary sentence, a time formatter, a flat-expressibility flag, an enable/
// disable rule and a save path of its own. Two editable controls for one setting
// is what finding F007 was, so the pair was deleted from settings.html and every
// function that existed only to drive it has gone with it. What was left after
// the markup went was unreachable by construction — each lookup returned null,
// so each guard returned early — which is worse than wrong: it reads like a
// feature.
//
// The schedule is now owned entirely by the presets + per-window editor in the
// "When FitShield is on" section (#schedulePresets / #scheduleWindows /
// #scheduleAdvanced), built by preferences.js. The popup keeps its own
// at-a-glance pair on purpose; that is a different surface, in popup.js.

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
  // The site name is in a sibling div that nothing associated with this control,
  // so every row in a list hundreds long announced as a bare "checkbox, checked".
  // The name is the site's own label, so there is no string to localize.
  input.setAttribute("aria-label", site.label || site.domain);

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

// Blocking Options is now only the two friction values. The schedule keys the
// worker also projects into this state (scheduleEnabled / scheduleStart /
// scheduleEnd / scheduleSimple) are deliberately not read here: this page has no
// control that renders them, and the section that owns the schedule reads the
// canonical `schedule` object directly in preferences.js.
function updateBlockingControls(state) {
  const {
    timerSeconds = DEFAULT_TIMER_SECONDS,
    passDurationMinutes = DEFAULT_PASS_DURATION_MINUTES
  } = state;

  timerSlider.value = normalizeTimerSeconds(timerSeconds);
  timerSecondsInput.value = normalizeTimerSeconds(timerSeconds);
  timerDisplay.textContent = formatTimerDisplay(normalizeTimerSeconds(timerSeconds));
  passDurationSlider.value = normalizePassDurationMinutes(passDurationMinutes);
  passDurationMinutesInput.value = normalizePassDurationMinutes(passDurationMinutes);
  passDurationDisplay.textContent = formatPassDisplay(normalizePassDurationMinutes(passDurationMinutes));
}

// Keep the "All Blocklists" master toggle in sync with the three group toggles:
// checked when all three are on, cleared when all off, and indeterminate (the
// dash state) when they are mixed.
function updateMasterBlocklistToggle() {
  if (!allBlocklistsEnabledInput) {
    return;
  }

  const states = [
    deliverySitesEnabledInput.checked,
    fastFoodSitesEnabledInput.checked,
    customSitesEnabledInput.checked
  ];
  const allOn = states.every(Boolean);
  const allOff = states.every((on) => !on);

  allBlocklistsEnabledInput.checked = allOn;
  allBlocklistsEnabledInput.indeterminate = !allOn && !allOff;
}

// The " N match the search." tail on a blocklist count line, or nothing when no
// search is running. English needs the verb to agree — "1 match the search" was
// ungrammatical — so exactly one match takes its own string rather than the
// plural with a 1 substituted into it.
function searchMatchSuffix(count) {
  if (!currentSearch) {
    return "";
  }

  return t(count === 1 ? "searchMatchSuffixOne" : "searchMatchSuffix", [String(count)]);
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
  updateMasterBlocklistToggle();
  const deliveryEnabledCount = deliverySites.filter((site) => site.enabled).length;
  const fastFoodEnabledCount = fastFoodSites.filter((site) => site.enabled).length;
  deliveryCount.textContent = t("deliverySitesEnabledCount", [String(deliveryEnabledCount), String(deliverySites.length)])
    + searchMatchSuffix(filteredDeliverySites.length);
  fastFoodCount.textContent = t("fastFoodSitesEnabledCount", [String(fastFoodEnabledCount), String(fastFoodSites.length)])
    + searchMatchSuffix(filteredFastFoodSites.length);

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

// Rebuild the block state directly from chrome.storage.local + the loaded engine
// when the background worker can't answer getBlockState (it is asleep/evicted,
// or the folder was loaded unbuilt so blocklist.js/the worker is missing).
// Without this, that section would render its unchecked HTML defaults and look
// like every saved toggle "reset". Uses the shared FitShieldBlocklistRecords
// key/record logic so the site keys match what the worker writes.
async function buildLocalBlockState() {
  const stored = await chrome.storage.local.get([
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
    "customSites"
  ]);

  let deliverySites = [];
  let fastFoodSites = [];

  if (typeof FitShieldBlocklist !== "undefined" && typeof FitShieldBlocklistRecords !== "undefined") {
    try {
      const entries = await FitShieldBlocklist.loadBlocklists();
      const records = FitShieldBlocklistRecords.buildSiteRecords(entries, FitShieldBlocklist);
      deliverySites = FitShieldBlocklistRecords.mergeEnabledState(
        records.filter((record) => record.type === "delivery"),
        stored.disabledDeliverySiteKeys
      );
      fastFoodSites = FitShieldBlocklistRecords.mergeEnabledState(
        records.filter((record) => record.type === "fast_food"),
        stored.disabledFastFoodSiteKeys
      );
    } catch (error) {
      console.error("Failed to build local site lists:", error);
    }
  }

  const customSites = Array.isArray(stored.customSites)
    ? stored.customSites
        .map((site) => (site && typeof site === "object" && site.domain
          ? { domain: String(site.domain), enabled: site.enabled !== false }
          : null))
        .filter(Boolean)
    : [];

  return {
    ok: true,
    enabled: stored.enabled ?? true,
    timerSeconds: normalizeTimerSeconds(stored.timerSeconds),
    passDurationMinutes: normalizePassDurationMinutes(stored.passDurationMinutes),
    scheduleEnabled: stored.scheduleEnabled ?? false,
    scheduleStart: stored.scheduleStart ?? DEFAULT_SCHEDULE_START,
    scheduleEnd: stored.scheduleEnd ?? DEFAULT_SCHEDULE_END,
    deliverySitesEnabled: stored.deliverySitesEnabled ?? true,
    fastFoodSitesEnabled: stored.fastFoodSitesEnabled ?? true,
    customSitesEnabled: stored.customSitesEnabled ?? true,
    deliverySites,
    fastFoodSites,
    customSites,
    local: true
  };
}

async function loadBlocklist() {
  let response = null;

  try {
    response = await chrome.runtime.sendMessage({ type: "getBlockState" });
  } catch (error) {
    // No receiver (worker not registered/awake) — fall through to the local
    // rebuild so saved settings still display instead of snapping to defaults.
  }

  if (response?.ok) {
    renderBlocklist(response);
    return;
  }

  try {
    renderBlocklist(await buildLocalBlockState());
  } catch (error) {
    console.error("Failed to load block state:", error);
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

// ---------------------------------------------------------------------------
// Friction values, and the label that has to keep up with them.
//
// Onboarding and this page both print `frictionIntro`: "You can change any value
// afterwards — doing so simply moves you to Custom." Nothing ever wrote
// `frictionProfile: "custom"`, so the promise was never kept: a user who dragged
// the timer to 300 seconds still saw "Standard" selected, above the sentence
// "60-second pause, then the site stays open for 5 minutes".
//
// The comparison is derived from `frictionProfileValues` itself rather than a
// hand-written field list, so it cannot drift from what a preset actually
// writes. (core.detectFrictionProfile compares only timerSeconds and
// passDurationMinutes, so turning "Ask what brought me here" off would not move
// the label; extending it there is the durable home for this.)
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

// Persist a friction value AND whichever profile now describes the result, so
// every other surface reads a label that matches the numbers underneath it.
async function saveFrictionValues(partial) {
  const stored = await chrome.storage.local.get(FRICTION_VALUE_KEYS);
  const next = { ...core.readSettings(stored), ...partial };

  await saveSettings({ ...partial, frictionProfile: frictionProfileFor(next) });
}

timerSlider.addEventListener("input", () => {
  const timerSeconds = normalizeTimerSeconds(timerSlider.value);
  timerSecondsInput.value = timerSeconds;
  timerDisplay.textContent = formatTimerDisplay(timerSeconds);
  chrome.storage.local.set({ timerSeconds });
});

// Dragging fires `input` per pixel and `change` once, on release — so the live
// value stays cheap and the profile is recomputed once the user has settled.
timerSlider.addEventListener("change", async () => {
  await saveFrictionValues({ timerSeconds: normalizeTimerSeconds(timerSlider.value) });
});

timerSecondsInput.addEventListener("change", async () => {
  const timerSeconds = normalizeTimerSeconds(timerSecondsInput.value);
  timerSecondsInput.value = timerSeconds;
  timerSlider.value = timerSeconds;
  timerDisplay.textContent = formatTimerDisplay(timerSeconds);
  await saveFrictionValues({ timerSeconds });
});

passDurationSlider.addEventListener("input", () => {
  const passDurationMinutes = normalizePassDurationMinutes(passDurationSlider.value);
  passDurationMinutesInput.value = passDurationMinutes;
  passDurationDisplay.textContent = formatPassDisplay(passDurationMinutes);
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
  passDurationDisplay.textContent = formatPassDisplay(passDurationMinutes);
  await saveFrictionValues({ passDurationMinutes });
});

if (allBlocklistsEnabledInput) {
  allBlocklistsEnabledInput.addEventListener("change", async () => {
    // Master toggle: move all three group toggles to match, immediately (so the
    // UI responds before the async save), then persist them together.
    const enabled = allBlocklistsEnabledInput.checked;
    allBlocklistsEnabledInput.indeterminate = false;
    deliverySitesEnabledInput.checked = enabled;
    fastFoodSitesEnabledInput.checked = enabled;
    customSitesEnabledInput.checked = enabled;

    await saveSettings({
      deliverySitesEnabled: enabled,
      fastFoodSitesEnabled: enabled,
      customSitesEnabled: enabled
    });
  });
}

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
  // Searching "United" produced a list of countries whose buttons all announced
  // as "Block, button" — blocking every brand in a country with no way to hear
  // WHICH country. The visible word stays first in the name so it still matches
  // what is on screen, and aria-pressed carries the state independently of it
  // (the pill's on/off is otherwise a colour class only).
  button.setAttribute("aria-label", `${enabled ? onLabel : offLabel}: ${name}`);
  button.setAttribute("aria-pressed", String(!!enabled));
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
  // The same two words the search results use, now from the same two keys.
  // mbOn/mbOff carried identical English to mbBlocking/mbBlock but were never
  // translated — they exist in en/messages.json alone, so every non-English user
  // read an English "Blocking" on the chip beside a translated one in the list
  // above it. One pair of keys is also the only way that cannot drift again.
  const stateLabel = enabled ? t("mbBlocking") : t("mbBlock");

  toggle.textContent = stateLabel;
  toggle.title = enabled ? t("mbChipToggleOnTitle") : t("mbChipToggleOffTitle");
  // Same fix as buildResultRow: "On"/"Off" alone never said what was on or off,
  // and title is a description, not a name. The remove button beside it has
  // always done this correctly.
  toggle.setAttribute("aria-label", `${stateLabel}: ${label}`);
  toggle.setAttribute("aria-pressed", String(!!enabled));
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
          categoryDisplayName(entry.category),
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
        categoryDisplayName(category),
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

/**
 * The reason an import failed, in the user's language where possible.
 *
 * backup.js goes to real trouble to produce actionable reasons — "that backup
 * was written by a newer version of FitShield, update it first", "that file is
 * 3,204 KB", "reload the page". All of them used to be caught and thrown away
 * for one message: "That file isn't a valid FitShield backup." A backup written
 * by a newer FitShield IS a valid FitShield backup, and telling a user it is not
 * invites them to delete the only copy of their settings.
 */
function backupErrorMessage(error) {
  if (error && error.i18nKey) {
    const localized = t(error.i18nKey, error.i18nSubs);

    if (localized !== error.i18nKey) {
      return localized;
    }
  }

  // backup.js writes its `message` for a person, in English. Preferred over the
  // generic notice; the generic notice is the last resort, for an error that
  // came from somewhere else entirely and has no sentence in it.
  const message = error && typeof error.message === "string" ? error.message.trim() : "";
  return message || t("importErrorNotice");
}

if (exportSettingsButton && typeof FitShieldBackup !== "undefined") {
  exportSettingsButton.addEventListener("click", async () => {
    try {
      await FitShieldBackup.downloadBackup();
      setBackupNotice(t("exportSuccessNotice"));
    } catch (error) {
      console.error("Failed to export settings:", error);
      // This used to report `importErrorNotice` — "That file isn't a valid
      // FitShield backup." — for a failure to WRITE one, which is nonsense: at
      // that point there is no file, and nothing the user chose was at fault.
      setBackupNotice(
        tOr(
          "exportErrorNotice",
          "FitShield could not save the backup file. Check that downloads are allowed for this browser, then try again."
        )
      );
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

      // Validate FIRST. Asking someone to confirm a destructive action for a
      // file that was never going to import is a worse experience than either
      // half alone, and validation is pure — it touches no storage.
      const settings = FitShieldBackup.normalizeImported(FitShieldBackup.parseBackup(text));
      const count = FitShieldBackup.restoredCount(settings);

      // Import is the one destructive action in Settings that never asked. It
      // overwrites live settings AND clears install-local state nothing warned
      // about: an active temporary pass, and any unanswered "did you make it?"
      // prompt (which feeds the "meals actually made" figure). Every reset on
      // this page confirms; so does this now, and it names what it will clear.
      const confirmed = await confirmAction(
        tOr(
          "confirmImportBackup",
          `Restore ${count} settings from this file? They replace what is on this profile, and any active temporary pass and unanswered "did you make it?" prompt are cleared. This cannot be undone.`,
          [String(count)]
        )
      );

      if (!confirmed) {
        setBackupNotice(tOr("importCancelledNotice", "Import cancelled. Nothing was changed."));
        return;
      }

      setBackupNotice(t("importSuccessNotice", [String(await FitShieldBackup.applyImport(settings))]));
      // Reload so every control reflects the restored values.
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      console.error("Failed to import settings:", error);
      setBackupNotice(backupErrorMessage(error));
    } finally {
      importSettingsInput.value = "";
    }
  });
}

// ===========================================================================
// Your Stats — the honest counters, plus one optional estimate.
//
// Every figure here is a count of something FitShield actually observed, read
// from the single `stats` object the worker maintains (see fitshield-core.js
// for what each event means). Nothing is derived from a page block: a block
// tells FitShield that a page was interrupted and nothing whatsoever about
// whether an order would have happened.
//
// This panel used to read `blockedVisits` and `caloriesAvoided` and present
// "Blocked visits", "Estimated savings" (visits x meal cost) and "Calories
// avoided". Both of those keys stopped being written when the statistics
// vocabulary was rebuilt, so the whole panel had quietly frozen — a new install
// showed zeros forever while the popup's recap counted correctly.
// ===========================================================================

const DEFAULT_AVG_MEAL_COST = 15;

// The counters, in the order they tell the story: what happened, what you did
// about it, and what came of the alternative. The labels are shared with the
// popup's weekly recap so the two surfaces cannot drift into two vocabularies.
// `passesUsed` is deliberately absent. fitshield-core.js documents it and
// `continued` as ONE event under two names: grantPass is the only writer of
// either, so the two numbers are mathematically incapable of differing.
// Rendering both side by side padded the panel with a second figure that was
// not a second observation, and invited the reader to draw a conclusion from an
// agreement guaranteed by construction. The popup and the weekly recap already
// showed only one; this panel was the last surface that did not.
const STAT_CARDS = [
  ["interruptions", "recapInterrupted"],
  ["left", "recapLeft"],
  ["continued", "recapContinued"],
  ["alternativesViewed", "recapViewed"],
  ["alternativesSelected", "recapSelected"],
  ["alternativesMade", "recapMade"]
];

const currencyApi = typeof FitShieldCurrency !== "undefined" ? FitShieldCurrency : null;

const protectionStatusGrid = document.getElementById("protectionStatusGrid");
const avgMealCostInput = document.getElementById("avgMealCost");
const currencySelect = document.getElementById("currencyMode");
const avgMealCostLabelEl = document.getElementById("avgMealCostLabel");
const showEstimatesToggle = document.getElementById("showEstimates");
const estimateSettings = document.getElementById("estimateSettings");
const estimateValueEl = document.getElementById("estimateValue");
const estimateBasisEl = document.getElementById("estimateBasis");

const protectionData = {
  // The live totals, keyed by the event names in fitshield-core.js.
  totals: {},
  avgMealCost: DEFAULT_AVG_MEAL_COST,
  showEstimates: false,
  currencyChoice: "", // "" => follow the display language
  customized: false,  // true once the user edits the cost by hand
  // False until initProtectionStatus has read storage. Until then `customized`
  // is only the initial guess, and acting on it would overwrite a real one.
  loaded: false,
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

// No variant argument. There was a third parameter that chose a `.stat-value.on`
// or `.stat-value.off` modifier, and no caller ever passed it — so both rules
// were unreachable and every card rendered in the one neutral style. A styling
// hook nothing can reach is not a feature waiting to be used; it reads as one
// that already works.
function buildStatCard(value, label) {
  const card = document.createElement("div");
  card.className = "stat-card";

  const valueEl = document.createElement("div");
  valueEl.className = "stat-value";
  valueEl.textContent = value;

  const labelEl = document.createElement("div");
  labelEl.className = "stat-label";
  labelEl.textContent = label;

  card.append(valueEl, labelEl);
  return card;
}

// The counters that actually accumulate as FitShield is used. Local aggregates
// only — no per-site history, no timestamps, no URLs.
function renderProtectionStatus() {
  if (!protectionStatusGrid) {
    return;
  }

  const cards = STAT_CARDS.map(([event, labelKey]) =>
    buildStatCard(formatCount(protectionData.totals[event]), t(labelKey))
  );

  protectionStatusGrid.replaceChildren(...cards);
  renderEstimate();
  renderMostBlocked();
}

/**
 * The one optional estimate.
 *
 * It is deliberately based on `alternativesMade` — the only event in the whole
 * vocabulary the user personally confirmed — rather than on interruptions. A
 * page being interrupted says nothing about whether an order would have been
 * placed, so multiplying interruptions by a meal price would invent a saving
 * out of a page load. The basis line spells the arithmetic out on screen so the
 * number can never read as a measurement.
 */
function renderEstimate() {
  if (!estimateSettings) {
    return;
  }

  estimateSettings.hidden = !protectionData.showEstimates;

  if (!protectionData.showEstimates || !estimateValueEl) {
    return;
  }

  const made = Number(protectionData.totals.alternativesMade) || 0;
  estimateValueEl.textContent = formatSavings(made * protectionData.avgMealCost);

  if (estimateBasisEl) {
    // The singular writes the count into the sentence itself, so it takes ONE
    // placeholder (the price) where the plural takes two. Passing the plural's
    // two arguments to it would leave the price in $1's slot and drop it.
    const price = formatSavings(protectionData.avgMealCost);

    estimateBasisEl.textContent =
      made === 1 ? t("estimateBasisOne", [price]) : t("estimateBasis", [String(made), price]);
  }
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

// Display names for category ids and ISO country codes.
//
// Both resolvers used to live here, and the block page — which prints the SAME
// two identifiers in its "why you were interrupted" panel — had neither, so it
// title-cased the raw id and joined bare ISO codes. They now live in i18n.js,
// the one module both pages load, so the two surfaces cannot describe one block
// differently. Do not reintroduce a local copy: a second implementation of this
// rule is the defect, not the fix.
function categoryDisplayName(category) {
  return typeof FitShieldI18n !== "undefined" && FitShieldI18n.categoryName
    ? FitShieldI18n.categoryName(category)
    : String(category || "");
}

function countryDisplayName(code) {
  return typeof FitShieldI18n !== "undefined" && FitShieldI18n.countryName
    ? FitShieldI18n.countryName(code)
    : String(code || "").trim().toUpperCase();
}

// Coerce a stored value into a clean { key: positive-number } map. Defensive
// against junk (non-objects, arrays, NaN counts) from older or hand-edited data.
// The stored `stats` object, defensively reduced to the totals this page shows.
// Normalization lives in the core so the popup's recap and this panel can never
// disagree about what a counter is worth.
function readStatTotals(value) {
  const stats = value && typeof value === "object" ? value : {};
  return core.normalizeStatTotals(stats.totals);
}

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

  // The Intl formatter behind countryDisplayName is memoized per locale inside
  // i18n.js, so a language switch re-localizes these lists without this render
  // having to remember to drop a cache it no longer owns.
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

// Build the currency picker: a "follow language" option plus every supported
// currency, each shown with its localized name and symbol. Intl localizes the
// names and symbols; the first entry needs a real string because naming the
// resolved currency is not the same as saying the choice follows the language.
// When the display language already resolves to, say, USD, the auto entry and
// the pinned USD entry render identical text, and the globe emoji that used to
// be the sole difference is exactly what a screen reader drops.
function buildCurrencyOptions() {
  if (!currencySelect || !currencyApi) {
    return;
  }

  const locale = statsLocale();
  const autoCode = currencyApi.localeDefaults(locale).currency;
  const frag = document.createDocumentFragment();

  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = t("currencyAuto", [
    currencyApi.displayName(autoCode, locale),
    currencyApi.symbolFor(autoCode, locale)
  ]);
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

// Re-seed the meal cost from the locale/currency until the user customizes it,
// then refresh the label and the stat cards. `persist` writes the seeded value
// so a later read agrees with what is on screen.
async function applyCurrencyDefaults(options) {
  const persist = !!(options && options.persist);

  // The language handler calls refreshStats, and on a cold load it can win the
  // race against initProtectionStatus. Seeding then would read `customized` as
  // false before storage had been consulted, replace a cost the user had set
  // with the locale default, and — because persist is on — write it back,
  // silently losing the setting. Nothing is seeded until storage has been read.
  if (!protectionData.loaded) {
    updateCostLabel();
    renderProtectionStatus();
    return;
  }

  if (!protectionData.customized && currencyApi) {
    protectionData.avgMealCost = currencyApi.defaultCost(resolvedCurrency());

    if (avgMealCostInput) {
      avgMealCostInput.value = protectionData.avgMealCost;
    }

    if (persist) {
      await chrome.storage.local.set({ avgMealCost: protectionData.avgMealCost });
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
    "stats",
    "avgMealCost",
    "showEstimates",
    "currency",
    "mealStatsCustomized",
    "blockedByDomain",
    "blockedByCategory",
    "blockedByCountry"
  ]);

  protectionData.totals = readStatTotals(stored.stats);
  protectionData.showEstimates = stored.showEstimates === true;
  protectionData.currencyChoice = typeof stored.currency === "string" ? stored.currency : "";
  protectionData.customized = !!stored.mealStatsCustomized;

  if (showEstimatesToggle) {
    showEstimatesToggle.checked = protectionData.showEstimates;
  }
  protectionData.blockedByDomain = readCountMap(stored.blockedByDomain);
  protectionData.blockedByCategory = readCountMap(stored.blockedByCategory);
  protectionData.blockedByCountry = readCountMap(stored.blockedByCountry);

  // Customized values are the user's own; otherwise they get seeded from the
  // locale in refreshStats() below.
  if (protectionData.customized) {
    protectionData.avgMealCost = normalizeMealCost(stored.avgMealCost);

    if (avgMealCostInput) {
      avgMealCostInput.value = protectionData.avgMealCost;
    }
  }

  protectionData.loaded = true;
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

if (showEstimatesToggle) {
  showEstimatesToggle.addEventListener("change", async () => {
    protectionData.showEstimates = showEstimatesToggle.checked;
    await chrome.storage.local.set({ showEstimates: protectionData.showEstimates });
    renderEstimate();
  });
}

// Keep the stats live if a block or recipe choice happens (or settings are
// restored) while this page is open.
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }

    if (changes.stats) {
      protectionData.totals = readStatTotals(changes.stats.newValue);
      renderProtectionStatus();
    }

    if (changes.showEstimates) {
      protectionData.showEstimates = changes.showEstimates.newValue === true;

      if (showEstimatesToggle) {
        showEstimatesToggle.checked = protectionData.showEstimates;
      }

      renderEstimate();
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

    // The flat scheduleEnabled / scheduleStart / scheduleEnd mirror used to be
    // echoed back into a second set of controls here, so the duplicate pair in
    // Blocking Options would not sit showing the pre-edit window until reload.
    // That pair is gone (F007), and the section that owns the schedule re-renders
    // itself from the canonical `schedule` object, so there is nothing on this
    // page left for those keys to keep in step.
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

    // Whatever the user was on when they opened this. Focus goes back there on
    // close; it used to land on <body>, so a keyboard user was returned to the
    // top of a 130-control page having lost their place entirely.
    const opener = document.activeElement;

    // Open on the SAFE choice. This focused the destructive button, so the
    // Enter or Space that opened the dialog could confirm it on key repeat —
    // the accidental wipe the dialog exists to prevent.
    confirmCancelButton.focus();

    const cleanup = (result) => {
      confirmOverlay.hidden = true;
      confirmOkButton.removeEventListener("click", onOk);
      confirmCancelButton.removeEventListener("click", onCancel);
      confirmOverlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);

      if (opener && typeof opener.focus === "function") {
        opener.focus();
      }

      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (event) => {
      if (event.target === confirmOverlay) {
        cleanup(false);
      }
    };

    // The dialog declares aria-modal="true", which tells assistive technology
    // the rest of the page is inert. Tab did not honour that: one press moved
    // into the page behind a dimmed overlay, where every control was still
    // operable and none of it was visible as focused. Two controls, so the trap
    // is just a wrap in both directions.
    const onKey = (event) => {
      if (event.key === "Escape") {
        cleanup(false);
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const stops = [confirmCancelButton, confirmOkButton];
      const at = stops.indexOf(document.activeElement);
      const next = event.shiftKey
        ? stops[(at <= 0 ? stops.length : at) - 1]
        : stops[(at + 1) % stops.length];

      event.preventDefault();
      next.focus();
    };

    // A click on the dimmed page, or focus moved by anything other than Tab,
    // can still land outside. Pull it back rather than leaving the user
    // somewhere the dialog claims does not exist.
    const onFocusIn = (event) => {
      if (!confirmOverlay.hidden && !confirmOverlay.contains(event.target)) {
        confirmCancelButton.focus();
      }
    };

    confirmOkButton.addEventListener("click", onOk);
    confirmCancelButton.addEventListener("click", onCancel);
    confirmOverlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
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
  // The LIVE pass list. This named only the retired `siteBypasses` key, so
  // "Reset blocking settings" left an active temporary pass running: the user
  // reset everything and the site they had unblocked stayed unblocked.
  "passes",
  "siteBypasses",
  // The schedule the worker actually enforces. Clearing only the flat mirror
  // left the structured schedule in place, so blocking hours survived a reset
  // that claimed to have cleared them.
  "schedule",
  // Friction is a blocking setting; leaving it behind made Settings show
  // "Strict" over freshly-defaulted Standard values.
  "frictionProfile",
  "askIntent",
  "repeatFrictionEnabled",
  "repeatExtraSeconds",
  // `settingsDelaySeconds` and `repeatWindowMinutes` were both here. Each has
  // been retired from the runtime — written, documented and tested, and read by
  // nothing — so a reset must not name a key the extension no longer owns.
  // Repeat retention is a documented constant now; a stored value is ignored.
  "repeatHistory",
  "enabledCountries",
  "enabledCategories",
  "quickAccessCountries",
  "quickAccessCategories"
];

const APPEARANCE_KEYS = ["theme", "themeMode", "cardOrder"];
// "Reset statistics & estimates" — everything the numbers are made of, and the
// assumptions behind the optional estimate. NOT the blocklist, the schedule,
// the kitchen, or the alternatives the user wrote themselves: those are content
// and settings, and deleting them here would be data loss the button does not
// warn about.
//
// This list previously named only the pre-0.55 counters, so pressing it left
// the live `stats` object — every number actually on screen — untouched.
const PREFERENCE_KEYS = [
  // the live vocabulary and the aggregate brand breakdowns
  "stats",
  "blockedByDomain",
  "blockedByCategory",
  "blockedByCountry",
  // estimate assumptions
  "avgMealCost",
  "avgMealCalories",
  "currency",
  "mealStatsCustomized",
  "showEstimates",
  // pre-0.55 counters the migration preserved, so a reset does not leave old
  // numbers behind for an upgraded profile
  "blockedVisits",
  "caloriesAvoided",
  "recipesChosen",
  "legacy",
  // personal alternatives state: favourites, rotation, and the pending
  // "did you make it?" question
  "alternativeFavorites",
  "recentAlternatives",
  "dismissedAlternatives",
  "pendingAlternatives",
  "recapDismissedFor"
];

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
    if (await confirmAction(t("confirmResetStats"))) {
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
