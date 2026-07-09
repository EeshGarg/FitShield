// Runtime diagnostics. A single in-memory record of WHY blocking is (or isn't)
// active, surfaced to diagnostics.html and the popup via the getDiagnostics
// message, and echoed to the service-worker console with a [FitShield] prefix.
// This exists so the classic failure — "nothing blocks and there's no obvious
// error" — becomes a readable state instead of a white screen.
const FS_DIAG = {
  engineLoaded: false,
  bootError: null,
  blocklistCount: 0,
  deliveryCount: 0,
  fastFoodCount: 0,
  lastRuleCount: 0,
  lastDecision: "not-yet-evaluated",
  lastError: null
};

function fsLog(...args) {
  console.log("[FitShield]", ...args);
}

function fsError(message, error) {
  FS_DIAG.lastError = {
    message: String(message),
    detail: error ? String(error && error.message ? error.message : error) : "",
    at: Date.now()
  };
  console.error("[FitShield]", message, error || "");
}

// Load the shared blocklist engine bundle. In Chrome (MV3 service worker) this
// runs via importScripts. In Firefox the module is loaded ahead of this file
// through the manifest's background.scripts array, so FitShieldBlocklist already
// exists and importScripts is unavailable — guard for both so the same file runs
// in either. If the bundle is missing, the worker would otherwise die at
// registration with a cryptic error and block NOTHING. That is the signature of
// loading a SOURCE folder (repo root or extension/) instead of the built
// dist/chrome — so catch it and fail LOUDLY with an actionable message.
if (typeof FitShieldBlocklist === "undefined" && typeof importScripts === "function") {
  try {
    importScripts("blocklist.js");
  } catch (error) {
    FS_DIAG.bootError =
      'Could not load "blocklist.js" (the generated FS Engine bundle). This almost ' +
      "always means an UNBUILT source folder was loaded. Fix: run `node build.js`, " +
      "then Load unpacked from dist/chrome — never the repository root or extension/.";
    console.error("[FitShield] FATAL:", FS_DIAG.bootError, error);
  }
}

if (typeof FitShieldBlocklist !== "undefined") {
  FS_DIAG.engineLoaded = true;
} else if (!FS_DIAG.bootError) {
  // Firefox path where background.scripts should have defined the global, or any
  // other reason the engine is absent without importScripts throwing.
  FS_DIAG.bootError =
    "FS Engine global (FitShieldBlocklist) is undefined — the engine bundle did not " +
    "load. Build with `node build.js` and load dist/chrome (or dist/firefox).";
  console.error("[FitShield] FATAL:", FS_DIAG.bootError);
}

fsLog(
  `service worker booted · engine ${FS_DIAG.engineLoaded ? "loaded" : "MISSING"}` +
    (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest
      ? ` · v${chrome.runtime.getManifest().version}`
      : "")
);
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
  fsLog("diagnostics page:", chrome.runtime.getURL("diagnostics.html"));
}

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

// Legacy keys stripped the TLD, which caused regional domains to collide
// ("mcdonalds.com" and "mcdonalds.cl" both became "mcdonalds"). Keep this only
// so existing saved disabled-site preferences still apply after the safer key
// format below.
function legacyDomainToKey(domain) {
  return String(domain || "")
    .toLowerCase()
    .replace(/\.[a-z]+$/, "")
    .replace(/[^a-z0-9]/g, "");
}

// Derive a stable, collision-resistant key from the full hostname and bucket.
function domainToKey(domain, type) {
  const bucket = String(type || "site")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const host = String(domain || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${bucket}-${host}`;
}

// Map a JSON blocklist entry to the site-record shape used throughout the
// background script, preserving the metadata so it can be filtered later.
// All supported JSON metadata is carried through: the apex domain, alternate
// alias domains, country codes, region tags, the food category and the
// searchable specialties.
function entryToSiteRecord(entry) {
  const domains = FitShieldBlocklist.getEntryDomains(entry);
  const domain = domains[0] || FitShieldBlocklist.normalizeHostname(entry.domain);
  const aliases = domains.slice(1);

  return {
    key: domainToKey(domain, entry.type),
    legacyKey: legacyDomainToKey(domain),
    label: entry.name || domain,
    match: domain,
    home: `https://www.${domain}/`,
    domain,
    // The JSON `domain` is the apex used for boundary-anchored matching.
    apex: domain,
    aliases,
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

  // The engine bundle must have loaded (see the boot guard). Without it there is
  // nothing to match against — surface the actionable boot error rather than a
  // "Cannot read properties of undefined" deep in the load chain.
  if (typeof FitShieldBlocklist === "undefined") {
    throw new Error(FS_DIAG.bootError || "FS Engine bundle (blocklist.js) is not loaded.");
  }

  if (!blocklistLoadPromise) {
    blocklistLoadPromise = FitShieldBlocklist.loadBlocklists()
      .then((entries) => {
        const recordsByTypeAndDomain = new Map();

        entries.map(entryToSiteRecord).forEach((record) => {
          const dedupeKey = `${record.type}:${record.domain}`;

          if (!recordsByTypeAndDomain.has(dedupeKey)) {
            recordsByTypeAndDomain.set(dedupeKey, record);
          }
        });

        const records = [...recordsByTypeAndDomain.values()];
        DELIVERY_SITES = records.filter((record) => record.type === "delivery");
        FAST_FOOD_SITES = records.filter((record) => record.type === "fast_food");
        blocklistsLoaded = true;
        FS_DIAG.blocklistCount = records.length;
        FS_DIAG.deliveryCount = DELIVERY_SITES.length;
        FS_DIAG.fastFoodCount = FAST_FOOD_SITES.length;
        fsLog(
          `blocklists loaded — ${DELIVERY_SITES.length} delivery + ` +
            `${FAST_FOOD_SITES.length} fast-food brands (${records.length} total)`
        );
      })
      .catch((error) => {
        fsError("Failed to load blocklists", error);
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
    enabled: !disabledSet.has(site.key) && !disabledSet.has(site.legacyKey)
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

// declarativeNetRequest urlFilter values must be ASCII. Convert IDN / unicode
// hostnames (e.g. "saemaeul식당.com") to their punycode form so they still
// block, and drop anything that cannot be made into a valid host. This matters
// because a single invalid rule makes Chrome reject the ENTIRE
// updateDynamicRules batch, which silently disables all blocking.
function toUrlFilterHost(domain) {
  const host = String(domain || "").trim().toLowerCase();

  if (!host) {
    return null;
  }

  if (/^[a-z0-9.-]+$/.test(host)) {
    return host;
  }

  try {
    const ascii = new URL(`https://${host}`).hostname;
    return /^[a-z0-9.-]+$/.test(ascii) ? ascii : null;
  } catch {
    return null;
  }
}

function createRules(settings) {
  const rules = [];

  getRuleCatalog(settings).forEach((site) => {
    const warningUrl = new URL(chrome.runtime.getURL("warning.html"));
    warningUrl.searchParams.set("site", site.key);
    warningUrl.searchParams.set("timer", String(settings.timerSeconds));
    warningUrl.searchParams.set("pass", String(settings.passDurationMinutes));

    // Block the apex domain plus any alias domains the brand owns. Each alias
    // gets its own rule but keeps the same site key, so the warning page and
    // the bypass flow still resolve back to one record. Hostnames are
    // normalized to ASCII so every urlFilter is valid.
    const matchDomains = [site.match, ...(Array.isArray(site.aliases) ? site.aliases : [])]
      .map(toUrlFilterHost)
      .filter(Boolean);

    new Set(matchDomains).forEach((matchDomain) => {
      rules.push({
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
          urlFilter: `||${matchDomain}`,
          resourceTypes: ["main_frame"]
        }
      });
    });
  });

  // Rule IDs must be unique and stable within a single update call.
  return rules.map((rule, index) => ({ id: index + 1, ...rule }));
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

  // A domain can appear in more than one bucket (e.g. doordash.com is listed as
  // both a delivery and a fast-food brand). A temporary pass is granted for one
  // record's key, so resolve the bypassed keys to their domains and exclude the
  // whole domain. Otherwise the other bucket's identical rule would re-block the
  // user the instant they continue.
  const bypassableSites = [
    ...filteredSettings.deliverySites,
    ...filteredSettings.fastFoodSites,
    ...filteredSettings.customSites.map((site) => ({ key: getCustomSiteKey(site.domain), domain: site.domain }))
  ];
  const bypassedDomains = new Set(
    bypassableSites
      .filter((site) => bypassedSiteKeys.has(site.key))
      .map((site) => site.domain || site.match)
      .filter(Boolean)
  );

  const notBypassed = (site) => !bypassedDomains.has(site.domain || site.match);
  const rules = createRules({
    ...filteredSettings,
    deliverySites: filteredSettings.deliverySites.filter(notBypassed),
    fastFoodSites: filteredSettings.fastFoodSites.filter(notBypassed),
    customSites: filteredSettings.customSites.filter((site) => !bypassedDomains.has(site.domain))
  });
  const hasBlockingRules = rules.length > 0;

  if (!settings.enabled || !scheduleActive || !hasActiveSites || !hasBlockingRules) {
    const reason = !settings.enabled
      ? "master switch off"
      : !scheduleActive
        ? "outside the active schedule window"
        : !hasActiveSites
          ? "no blocklists or toggles enabled"
          : "no matching redirect rules";
    FS_DIAG.lastRuleCount = 0;
    FS_DIAG.lastDecision = `inactive — ${reason}`;
    fsLog("blocking inactive —", reason);
    await updateDynamicRules([]);
    await chrome.storage.local.set({ siteBypasses: filteredSettings.siteBypasses });
    await syncAlarms(filteredSettings);
    return;
  }

  FS_DIAG.lastRuleCount = rules.length;
  FS_DIAG.lastDecision = `active — ${rules.length} redirect rule(s)`;
  fsLog(`blocking active — ${rules.length} redirect rule(s)`);
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

// Snapshot of the runtime for diagnostics.html and the popup: whether the engine
// bundle loaded, how many brands are in the blocklist, how many redirect rules
// are live in Chrome right now, the last blocking decision + error, and the
// block-page URL. Passing a domain also runs it through the engine so a user can
// confirm a specific site is (or is not) blocked without visiting it.
async function getDiagnostics(testDomain) {
  const manifest = chrome.runtime.getManifest();

  let dynamicRuleCount = null;
  let dynamicRuleError = null;
  try {
    dynamicRuleCount = (await getDynamicRules()).length;
  } catch (error) {
    dynamicRuleError = String(error && error.message ? error.message : error);
  }

  const result = {
    ok: true,
    manifestVersion: manifest.version,
    manifestName: manifest.name,
    engineLoaded: FS_DIAG.engineLoaded,
    bootError: FS_DIAG.bootError,
    blocklistCount: FS_DIAG.blocklistCount,
    deliveryCount: FS_DIAG.deliveryCount,
    fastFoodCount: FS_DIAG.fastFoodCount,
    dynamicRuleCount,
    dynamicRuleError,
    lastRuleCount: FS_DIAG.lastRuleCount,
    lastDecision: FS_DIAG.lastDecision,
    lastError: FS_DIAG.lastError,
    blockPageUrl: chrome.runtime.getURL("warning.html")
  };

  const domain = String(testDomain || "").trim();
  if (domain) {
    if (!FS_DIAG.engineLoaded) {
      result.test = { input: domain, error: "engine not loaded" };
    } else {
      try {
        await ensureBlocklistsLoaded();
        const host = FitShieldBlocklist.normalizeHostname(domain);
        result.test = { input: domain, host, blocked: FitShieldBlocklist.isBlockedHost(host) };
      } catch (error) {
        result.test = { input: domain, error: String(error && error.message ? error.message : error) };
      }
    }
  }

  return result;
}

// Resolve the JSON-derived site record that triggered a block from its key so
// the warning page can show the brand it interrupted and reopen the right
// destination. Looks across the live rule catalog first, then all branded and
// custom sites, so it still resolves a record even when the bucket toggle that
// produced the rule is currently off.
async function getBlockedSiteInfo(siteKey) {
  const settings = await getSettings();

  const customRecords = settings.customSites.map((site) => ({
    key: getCustomSiteKey(site.domain),
    label: site.domain,
    match: site.domain,
    home: `https://${site.domain}/`,
    domain: site.domain,
    apex: site.domain,
    aliases: [],
    type: "custom",
    category: "custom",
    countries: [],
    regions: [],
    specialties: []
  }));

  const lookup = [
    ...getRuleCatalog(settings),
    ...settings.deliverySites,
    ...settings.fastFoodSites,
    ...customRecords
  ];

  const site = lookup.find((entry) => entry.key === siteKey);

  if (!site) {
    return { ok: true, found: false };
  }

  return {
    ok: true,
    found: true,
    key: site.key,
    label: site.label,
    domain: site.domain || site.match,
    apex: site.apex || site.domain || site.match,
    aliases: Array.isArray(site.aliases) ? site.aliases : [],
    home: site.home,
    type: site.type || "",
    category: site.category || "",
    countries: Array.isArray(site.countries) ? site.countries : [],
    regions: Array.isArray(site.regions) ? site.regions : [],
    specialties: Array.isArray(site.specialties) ? site.specialties : []
  };
}

// Increment the local blocked-visit counter. This is the only thing FitShield
// counts: a single integer, bumped once each time the block page is shown. No
// URL, domain, or any browsing detail is ever stored — privacy-first by design.
async function recordBlockedVisit() {
  const { blockedVisits } = await chrome.storage.local.get(["blockedVisits"]);
  const next = (Number(blockedVisits) || 0) + 1;
  await chrome.storage.local.set({ blockedVisits: next });
  return next;
}

// Defaults for the local-only calorie estimate. A typical fast-food / delivery
// meal is treated as ~1000 kcal; when a chosen recipe has no calorie data we
// assume a modest home portion. Both are estimates, configurable by the user.
const DEFAULT_AVG_MEAL_CALORIES = 1000;
const DEFAULT_RECIPE_CALORIES = 500;

function normalizeMealCalories(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AVG_MEAL_CALORIES;
}

// Record that the user picked a home recipe instead of ordering. Adds the
// estimated calories avoided (configured meal calories minus the recipe's, never
// below zero) and bumps an aggregate count. Only aggregate numbers are stored —
// never which recipe, site, or page. Falls back gracefully when recipe calories
// are unknown.
async function recordRecipeChoice(recipeCalories) {
  const stored = await chrome.storage.local.get(["avgMealCalories", "caloriesAvoided", "recipesChosen"]);
  const mealCalories = normalizeMealCalories(stored.avgMealCalories);
  // null/undefined means the recipe has no calorie data — fall back to a default
  // home-portion estimate. (Number(null) is 0, so guard before converting.)
  const hasRecipeCalories = recipeCalories !== null && recipeCalories !== undefined && Number.isFinite(Number(recipeCalories));
  const recipeCals = hasRecipeCalories ? Number(recipeCalories) : DEFAULT_RECIPE_CALORIES;
  const added = Math.max(0, Math.round(mealCalories - recipeCals));
  const caloriesAvoided = (Number(stored.caloriesAvoided) || 0) + added;
  const recipesChosen = (Number(stored.recipesChosen) || 0) + 1;

  await chrome.storage.local.set({ caloriesAvoided, recipesChosen });
  return { added, caloriesAvoided, recipesChosen };
}

// Bump the integer count for `key` inside a plain count-map object, returning a
// new object so callers can store it. Junk values are coerced to a clean map.
function incrementCount(map, key, by) {
  const next = (map && typeof map === "object" && !Array.isArray(map)) ? { ...map } : {};
  const cleanKey = String(key || "").trim();

  if (!cleanKey) {
    return next;
  }

  next[cleanKey] = (Number(next[cleanKey]) || 0) + (Number(by) || 1);
  return next;
}

// Record an aggregate, local-only breakdown of WHICH curated brand triggered a
// block, so Your Stats can show the most blocked sites, categories, and
// countries. This stays privacy-first: it counts only the brands already on the
// curated blocklist — by apex domain, food category, and the countries the brand
// operates in — and never stores a URL, page, path, timestamp, or any browsing
// history. The plain blocked-visit counter (recordBlockedVisit) deliberately
// stays a single integer; this is the opt-in-by-design richer breakdown.
async function recordBlockedBrand(meta) {
  const info = meta && typeof meta === "object" ? meta : {};
  const domain = FitShieldBlocklist.normalizeHostname(info.domain);
  const category = String(info.category || "").trim().toLowerCase();
  const countries = normalizeStringList(info.countries).map((code) => code.toUpperCase());

  // Nothing identifiable to record (e.g. the block page could not resolve the
  // brand). Skip silently rather than writing empty keys.
  if (!domain && !category && countries.length === 0) {
    return { ok: true, recorded: false };
  }

  const stored = await chrome.storage.local.get([
    "blockedByDomain",
    "blockedByCategory",
    "blockedByCountry"
  ]);

  const blockedByDomain = domain ? incrementCount(stored.blockedByDomain, domain, 1) : (stored.blockedByDomain || {});
  // "delivery"/"fast_food" are the rule buckets, already shown elsewhere; only
  // count true food categories (pizza, coffee, …) so the breakdown is useful.
  const isBucketCategory = category === "delivery" || category === "fast_food" || category === "custom";
  const blockedByCategory = (category && !isBucketCategory)
    ? incrementCount(stored.blockedByCategory, category, 1)
    : (stored.blockedByCategory || {});

  // Count only the brand's PRIMARY (first-listed) operating market. Many brands
  // operate in dozens of countries (e.g. McDonald's in ~50); counting every one
  // would let a single block inflate the whole list and drown out the signal.
  // The primary market is the most meaningful heuristic and still uses only
  // curated brand metadata — never the user's real location or browsing data.
  const primaryCountry = countries[0];
  const blockedByCountry = primaryCountry
    ? incrementCount(stored.blockedByCountry, primaryCountry, 1)
    : (stored.blockedByCountry || {});

  await chrome.storage.local.set({ blockedByDomain, blockedByCategory, blockedByCountry });
  return { ok: true, recorded: true };
}

// Open an extension page in a new tab. tabs.create does not require the "tabs"
// permission.
function openExtensionPage(path) {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  } catch (error) {
    console.error(`Failed to open ${path}:`, error);
  }
}

async function showOnboardingOrWhatsNew(reason) {
  const currentVersion = chrome.runtime.getManifest().version;

  if (reason === "install") {
    // First install: run the welcome tour and mark this version as seen.
    await chrome.storage.local.set({ lastSeenVersion: currentVersion });
    openExtensionPage("welcome.html");
    return;
  }

  if (reason === "update") {
    const { lastSeenVersion } = await chrome.storage.local.get(["lastSeenVersion"]);

    if (lastSeenVersion !== currentVersion) {
      // whats-new.js records lastSeenVersion on load; set it here too so the
      // page never re-opens even if it is closed immediately.
      await chrome.storage.local.set({ lastSeenVersion: currentVersion });
      openExtensionPage("whats-new.html");
    }
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
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
  await showOnboardingOrWhatsNew(details?.reason);
});

chrome.runtime.onStartup.addListener(() => {
  queueRefreshBlockingState().catch((error) => {
    fsError("Failed to refresh blocking state on startup", error);
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
      fsError("Failed to refresh blocking state", error);
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

  if (message?.type === "getDiagnostics") {
    getDiagnostics(message.domain).then(sendResponse).catch((error) => {
      fsError("Failed to build diagnostics", error);
      sendResponse({ ok: false, error: error.message });
    });

    return true;
  }

  if (message?.type === "getBlockedSiteInfo") {
    getBlockedSiteInfo(message.site).then(sendResponse).catch((error) => {
      console.error("Failed to get blocked site info:", error);
      sendResponse({ ok: false, error: error.message });
    });

    return true;
  }

  if (message?.type === "recordBlockedVisit") {
    recordBlockedVisit()
      .then((blockedVisits) => sendResponse({ ok: true, blockedVisits }))
      .catch((error) => {
        console.error("Failed to record blocked visit:", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message?.type === "recordBlockedBrand") {
    recordBlockedBrand(message.meta)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("Failed to record blocked brand:", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message?.type === "recordRecipeChoice") {
    recordRecipeChoice(message.recipeCalories)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.error("Failed to record recipe choice:", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  return false;
});
