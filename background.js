importScripts("blocklist.js");

const BYPASS_ALARM = "temporaryBypassExpired";
const SCHEDULE_ALARM = "scheduleBoundaryReached";
const DEFAULT_TIMER_SECONDS = 60;
const MIN_TIMER_SECONDS = 10;
const DEFAULT_PASS_DURATION_MINUTES = 5;
const MIN_PASS_DURATION_MINUTES = 1;
const DEFAULT_SCHEDULE_START = "18:00";
const DEFAULT_SCHEDULE_END = "23:00";

// The legacy delivery/fast-food site lists are now sourced from the JSON
// blocklists. They are populated on demand by ensureBlocklistsLoaded() and keep
// the same { key, label, match, home, ... } shape the rest of the code expects.
let DELIVERY_SITES = [];
let FAST_FOOD_SITES = [];
let blocklistsLoaded = false;
let blocklistLoadPromise = null;

// Derive a stable key from an apex domain (e.g. "chick-fil-a.com" -> "chickfila").
function domainToKey(domain) {
  return String(domain || "")
    .toLowerCase()
    .replace(/\.[a-z]+$/, "")
    .replace(/[^a-z0-9]/g, "");
}

// Map a JSON blocklist entry to the site-record shape used throughout the
// background script, preserving the metadata so it can be filtered later.
function entryToSiteRecord(entry) {
  const domain = FitShieldBlocklist.normalizeHostname(entry.domain);

  return {
    key: domainToKey(domain),
    label: entry.name || domain,
    match: domain,
    home: `https://www.${domain}/`,
    domain,
    type: entry.type || "",
    countries: Array.isArray(entry.countries) ? entry.countries : [],
    regions: Array.isArray(entry.regions) ? entry.regions : [],
    category: entry.category || "",
    specialties: Array.isArray(entry.specialties) ? entry.specialties : [],
    enabled: entry.enabled !== false
  };
}

async function ensureBlocklistsLoaded() {
  if (blocklistsLoaded) {
    return;
  }

  if (!blocklistLoadPromise) {
    blocklistLoadPromise = FitShieldBlocklist.loadBlocklists()
      .then((entries) => {
        const records = entries.map(entryToSiteRecord);
        DELIVERY_SITES = records.filter((record) => record.type === "delivery");
        FAST_FOOD_SITES = records.filter((record) => record.type === "fast_food");
        blocklistsLoaded = true;
      })
      .catch((error) => {
        console.error("Failed to load blocklists:", error);
        blocklistLoadPromise = null;
        throw error;
      });
  }

  await blocklistLoadPromise;
}

let refreshChain = Promise.resolve();

function normalizeTimerSeconds(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(MIN_TIMER_SECONDS, parsed) : DEFAULT_TIMER_SECONDS;
}

function normalizePassDurationMinutes(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(MIN_PASS_DURATION_MINUTES, parsed) : DEFAULT_PASS_DURATION_MINUTES;
}

function getActiveBypasses(siteBypasses) {
  const now = Date.now();
  const activeBypasses = {};

  Object.entries(siteBypasses || {}).forEach(([siteKey, expiresAt]) => {
    if (typeof expiresAt === "number" && expiresAt > now) {
      activeBypasses[siteKey] = expiresAt;
    }
  });

  return activeBypasses;
}

function parseTimeString(timeString) {
  const [hour = 0, minute = 0] = (timeString || "").split(":").map(Number);
  return {
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0
  };
}

function getMinutesFromTime(timeString) {
  const { hour, minute } = parseTimeString(timeString);
  return (hour * 60) + minute;
}

function isScheduleActive(scheduleStart, scheduleEnd, now = new Date()) {
  const currentMinutes = (now.getHours() * 60) + now.getMinutes();
  const startMinutes = getMinutesFromTime(scheduleStart);
  const endMinutes = getMinutesFromTime(scheduleEnd);

  if (startMinutes === endMinutes) {
    return true;
  }

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function getNextOccurrence(timeString, now = new Date()) {
  const { hour, minute } = parseTimeString(timeString);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

function getNextScheduleBoundary(scheduleStart, scheduleEnd, now = new Date()) {
  const startBoundary = getNextOccurrence(scheduleStart, now);
  const endBoundary = getNextOccurrence(scheduleEnd, now);
  return startBoundary < endBoundary ? startBoundary : endBoundary;
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

function createCustomSiteRecord(entry) {
  if (typeof entry === "string") {
    const domain = normalizeCustomDomain(entry);
    return domain ? { domain, enabled: true } : null;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const domain = normalizeCustomDomain(entry.domain);

  if (!domain) {
    return null;
  }

  return {
    domain,
    enabled: entry.enabled !== false
  };
}

function getCustomSiteKey(domain) {
  return `custom-${domain.replace(/[^a-z0-9]+/g, "-")}`;
}

function mergeSitesWithEnabledState(sites, disabledKeys) {
  const disabledSet = new Set(disabledKeys || []);
  return sites.map((site) => ({
    ...site,
    enabled: !disabledSet.has(site.key)
  }));
}

// Normalize a stored list of codes/categories into a clean, de-duplicated array
// of trimmed strings. Defensive against non-array / junk values.
function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const result = [];

  value.forEach((item) => {
    const text = String(item || "").trim();

    if (text && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  });

  return result;
}

// Build the de-duplicated set of sites to block. The catalog is the UNION of:
//   1. existing toggle behavior  (delivery / fast-food buckets + custom URLs)
//   2. metadata country blocks   (any enabled country in the entry's countries)
//   3. metadata category blocks  (the entry's category is enabled)
// Country/category blocks are additive, so they can block sites even when a
// bucket toggle is off. Per-site bypasses are already filtered out upstream.
function getRuleCatalog(settings) {
  const byDomain = new Map();

  const addSite = (site, bucket) => {
    const domain = site.domain || site.match;

    if (domain && !byDomain.has(domain)) {
      byDomain.set(domain, { ...site, category: bucket });
    }
  };

  // 1. Existing toggle behavior.
  if (settings.deliverySitesEnabled) {
    settings.deliverySites
      .filter((site) => site.enabled)
      .forEach((site) => addSite(site, "delivery"));
  }

  if (settings.fastFoodSitesEnabled) {
    settings.fastFoodSites
      .filter((site) => site.enabled)
      .forEach((site) => addSite(site, "fastfood"));
  }

  if (settings.customSitesEnabled) {
    settings.customSites
      .filter((site) => site.enabled)
      .forEach((site) =>
        addSite(
          {
            key: getCustomSiteKey(site.domain),
            label: site.domain,
            match: site.domain,
            home: `https://${site.domain}/`,
            domain: site.domain
          },
          "custom"
        )
      );
  }

  // 2 + 3. Metadata-driven country / category blocks across all branded entries.
  const brandedSites = [...settings.deliverySites, ...settings.fastFoodSites];

  brandedSites.forEach((site) => {
    const blockedByCountry = FitShieldBlocklist.shouldBlockByCountry(site, settings.enabledCountries);
    const blockedByCategory = FitShieldBlocklist.shouldBlockByCategory(site, settings.enabledCategories);

    if (blockedByCountry || blockedByCategory) {
      addSite(site, site.type === "delivery" ? "delivery" : "fastfood");
    }
  });

  return [...byDomain.values()];
}

function createRules(settings) {
  return getRuleCatalog(settings).map((site, index) => {
    const warningUrl = new URL(chrome.runtime.getURL("warning.html"));
    warningUrl.searchParams.set("site", site.key);
    warningUrl.searchParams.set("timer", String(settings.timerSeconds));
    warningUrl.searchParams.set("pass", String(settings.passDurationMinutes));

    return {
      id: index + 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          url: warningUrl.toString()
        }
      },
      condition: {
        // "||" anchors to a domain-name boundary so subdomains match but
        // look-alikes (e.g. fake-mcdonalds.com) do not.
        urlFilter: `||${site.match}`,
        resourceTypes: ["main_frame"]
      }
    };
  });
}

function getDynamicRules() {
  return new Promise((resolve) => {
    chrome.declarativeNetRequest.getDynamicRules(resolve);
  });
}

async function updateDynamicRules(addRules) {
  const currentRules = await getDynamicRules();
  const removeRuleIds = currentRules.map((rule) => rule.id);

  return new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.updateDynamicRules(
      {
        removeRuleIds,
        addRules
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve();
      }
    );
  });
}

async function syncAlarms({ bypassUntil, scheduleEnabled, scheduleStart, scheduleEnd }) {
  await chrome.alarms.clear(BYPASS_ALARM);
  await chrome.alarms.clear(SCHEDULE_ALARM);

  if (bypassUntil > Date.now()) {
    await chrome.alarms.create(BYPASS_ALARM, {
      when: bypassUntil
    });
  }

  if (scheduleEnabled) {
    const nextBoundary = getNextScheduleBoundary(scheduleStart, scheduleEnd);
    await chrome.alarms.create(SCHEDULE_ALARM, {
      when: nextBoundary.getTime()
    });
  }
}

async function getSettings() {
  await ensureBlocklistsLoaded();

  const state = await chrome.storage.local.get([
    "enabled",
    "bypassUntil",
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
  ]);

  const customSites = Array.isArray(state.customSites)
    ? state.customSites.map(createCustomSiteRecord).filter(Boolean)
    : [];
  const siteBypasses = getActiveBypasses(state.siteBypasses);
  const bypassUntilValues = Object.values(siteBypasses);

  return {
    enabled: state.enabled ?? true,
    bypassUntil: bypassUntilValues.length > 0 ? Math.max(...bypassUntilValues) : 0,
    timerSeconds: normalizeTimerSeconds(state.timerSeconds),
    passDurationMinutes: normalizePassDurationMinutes(state.passDurationMinutes),
    scheduleEnabled: state.scheduleEnabled ?? false,
    scheduleStart: state.scheduleStart ?? DEFAULT_SCHEDULE_START,
    scheduleEnd: state.scheduleEnd ?? DEFAULT_SCHEDULE_END,
    deliverySitesEnabled: state.deliverySitesEnabled ?? true,
    fastFoodSitesEnabled: state.fastFoodSitesEnabled ?? true,
    customSitesEnabled: state.customSitesEnabled ?? true,
    deliverySites: mergeSitesWithEnabledState(DELIVERY_SITES, state.disabledDeliverySiteKeys),
    fastFoodSites: mergeSitesWithEnabledState(FAST_FOOD_SITES, state.disabledFastFoodSiteKeys),
    customSites: [...new Map(customSites.map((site) => [site.domain, site])).values()],
    siteBypasses,
    enabledCountries: normalizeStringList(state.enabledCountries),
    enabledCategories: normalizeStringList(state.enabledCategories),
    quickAccessCountries: normalizeStringList(state.quickAccessCountries),
    quickAccessCategories: normalizeStringList(state.quickAccessCategories)
  };
}

async function refreshBlockingState() {
  const settings = await getSettings();
  const scheduleActive = settings.scheduleEnabled
    ? isScheduleActive(settings.scheduleStart, settings.scheduleEnd)
    : true;
  const hasActiveSites = getRuleCatalog(settings).length > 0;
  const filteredSettings = {
    ...settings,
    siteBypasses: getActiveBypasses(settings.siteBypasses)
  };
  const bypassedSiteKeys = new Set(Object.keys(filteredSettings.siteBypasses));
  const rules = createRules({
    ...filteredSettings,
    deliverySites: filteredSettings.deliverySites.filter((site) => !bypassedSiteKeys.has(site.key)),
    fastFoodSites: filteredSettings.fastFoodSites.filter((site) => !bypassedSiteKeys.has(site.key)),
    customSites: filteredSettings.customSites.filter((site) => !bypassedSiteKeys.has(getCustomSiteKey(site.domain)))
  });
  const hasBlockingRules = rules.length > 0;

  if (!settings.enabled || !scheduleActive || !hasActiveSites || !hasBlockingRules) {
    await updateDynamicRules([]);
    await chrome.storage.local.set({ siteBypasses: filteredSettings.siteBypasses });
    await syncAlarms(filteredSettings);
    return;
  }

  await updateDynamicRules(rules);
  await chrome.storage.local.set({ siteBypasses: filteredSettings.siteBypasses });
  await syncAlarms(filteredSettings);
}

function queueRefreshBlockingState() {
  refreshChain = refreshChain
    .catch(() => {})
    .then(() => refreshBlockingState());

  return refreshChain;
}

async function startTemporaryBypass(siteKey) {
  const settings = await getSettings();
  const site = getRuleCatalog(settings).find((entry) => entry.key === siteKey) || DELIVERY_SITES[0];
  const bypassDurationMs = settings.passDurationMinutes * 60 * 1000;
  const bypassUntil = Date.now() + bypassDurationMs;
  const nextSiteBypasses = {
    ...settings.siteBypasses,
    [site.key]: bypassUntil
  };

  await chrome.storage.local.set({ enabled: true, siteBypasses: nextSiteBypasses });
  await queueRefreshBlockingState();

  return {
    bypassUntil,
    destination: site.home,
    label: site.label,
    passDurationMinutes: settings.passDurationMinutes
  };
}

async function getBlockState() {
  const settings = await getSettings();
  return {
    ok: true,
    ...settings,
    scheduleActive: settings.scheduleEnabled
      ? isScheduleActive(settings.scheduleStart, settings.scheduleEnd)
      : true
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await chrome.storage.local.get([
    "enabled",
    "bypassUntil",
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
  ]);

  const customSites = Array.isArray(state.customSites)
    ? state.customSites.map(createCustomSiteRecord).filter(Boolean)
    : [];

  await chrome.storage.local.set({
    enabled: state.enabled ?? true,
    timerSeconds: normalizeTimerSeconds(state.timerSeconds),
    passDurationMinutes: normalizePassDurationMinutes(state.passDurationMinutes),
    scheduleEnabled: state.scheduleEnabled ?? false,
    scheduleStart: state.scheduleStart ?? DEFAULT_SCHEDULE_START,
    scheduleEnd: state.scheduleEnd ?? DEFAULT_SCHEDULE_END,
    deliverySitesEnabled: state.deliverySitesEnabled ?? true,
    fastFoodSitesEnabled: state.fastFoodSitesEnabled ?? true,
    customSitesEnabled: state.customSitesEnabled ?? true,
    disabledDeliverySiteKeys: Array.isArray(state.disabledDeliverySiteKeys) ? state.disabledDeliverySiteKeys : [],
    disabledFastFoodSiteKeys: Array.isArray(state.disabledFastFoodSiteKeys) ? state.disabledFastFoodSiteKeys : [],
    customSites: [...new Map(customSites.map((site) => [site.domain, site])).values()],
    siteBypasses: getActiveBypasses(state.siteBypasses),
    enabledCountries: normalizeStringList(state.enabledCountries),
    enabledCategories: normalizeStringList(state.enabledCategories),
    quickAccessCountries: normalizeStringList(state.quickAccessCountries),
    quickAccessCategories: normalizeStringList(state.quickAccessCategories)
  });

  await queueRefreshBlockingState();
});

chrome.runtime.onStartup.addListener(() => {
  queueRefreshBlockingState().catch((error) => {
    console.error("Failed to refresh blocking state on startup:", error);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }

  if (
    changes.enabled ||
    changes.timerSeconds ||
    changes.passDurationMinutes ||
    changes.scheduleEnabled ||
    changes.scheduleStart ||
    changes.scheduleEnd ||
    changes.deliverySitesEnabled ||
    changes.fastFoodSitesEnabled ||
    changes.customSitesEnabled ||
    changes.disabledDeliverySiteKeys ||
    changes.disabledFastFoodSiteKeys ||
    changes.customSites ||
    changes.siteBypasses ||
    changes.enabledCountries ||
    changes.enabledCategories
  ) {
    queueRefreshBlockingState().catch((error) => {
      console.error("Failed to refresh blocking state:", error);
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BYPASS_ALARM) {
    chrome.storage.local.get(["siteBypasses"]).then(({ siteBypasses }) => {
      return chrome.storage.local.set({ siteBypasses: getActiveBypasses(siteBypasses) });
    }).catch((error) => {
      console.error("Failed to clear temporary bypasses:", error);
    });
    return;
  }

  if (alarm.name === SCHEDULE_ALARM) {
    queueRefreshBlockingState().catch((error) => {
      console.error("Failed to refresh scheduled blocking:", error);
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "startTemporaryBypass") {
    startTemporaryBypass(message.site)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.error("Failed to start temporary bypass:", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message?.type === "getBlockState") {
    getBlockState().then(sendResponse).catch((error) => {
      console.error("Failed to get block state:", error);
      sendResponse({ ok: false, error: error.message });
    });

    return true;
  }

  return false;
});
