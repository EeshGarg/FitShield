// Runtime diagnostics. A single in-memory record of WHY blocking is (or isn't)
// active, surfaced to diagnostics.html and the popup via the getDiagnostics
// message, and echoed to the service-worker console with a [FitShield] prefix.
// This exists so the classic problem — "nothing blocks and there's no obvious
// error" — becomes a readable state instead of a white screen.
const FS_DIAG = {
  engineLoaded: false,
  coreLoaded: false,
  bootError: null,
  blocklistCount: 0,
  deliveryCount: 0,
  fastFoodCount: 0,
  lastRuleCount: 0,
  lastDecision: "not-yet-evaluated",
  lastError: null,
  schemaVersion: null,
  migration: null
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

// Load the shared modules. In Chrome (MV3 service worker) this runs via
// importScripts. In Firefox they are loaded ahead of this file through the
// manifest's background.scripts array, so the globals already exist and
// importScripts is unavailable — guard for both so the same file runs in either.
//
// blocklist.js is the generated FS Engine bundle; fitshield-core.js is the
// shared decision layer (schema, schedules, passes, stats). Both are committed
// artifacts, so loading extension/ OR dist/chrome unpacked finds them. If either
// is missing the worker would otherwise die at registration with a cryptic error
// and block NOTHING — the signature of an out-of-sync folder — so catch it and
// fail LOUDLY with an actionable message.
if (typeof importScripts === "function") {
  try {
    if (typeof FitShieldBlocklist === "undefined") {
      importScripts("blocklist.js");
    }

    if (typeof FitShieldCore === "undefined") {
      importScripts("fitshield-core.js");
    }
  } catch (error) {
    FS_DIAG.bootError =
      'Could not load "blocklist.js" (the FS Engine bundle) and/or "fitshield-core.js" ' +
      "(the shared decision layer). The loaded folder is missing a runtime file. " +
      "Fix: run `npm run sync` (regenerates extension/blocklist.js) or `node build.js`, " +
      "then Load unpacked from extension/ or dist/chrome.";
    console.error("[FitShield] FATAL:", FS_DIAG.bootError, error);
  }
}

if (typeof FitShieldBlocklist !== "undefined") {
  FS_DIAG.engineLoaded = true;
} else if (!FS_DIAG.bootError) {
  FS_DIAG.bootError =
    "FS Engine global (FitShieldBlocklist) is undefined — the engine bundle did not " +
    "load. Run `npm run sync` (or `node build.js`) and load extension/ or dist/chrome.";
  console.error("[FitShield] FATAL:", FS_DIAG.bootError);
}

if (typeof FitShieldCore !== "undefined") {
  FS_DIAG.coreLoaded = true;
} else if (!FS_DIAG.bootError) {
  FS_DIAG.bootError =
    "FitShieldCore is undefined — fitshield-core.js did not load. Schedules, passes, " +
    "and statistics all depend on it. Run `npm run sync` and reload the extension.";
  console.error("[FitShield] FATAL:", FS_DIAG.bootError);
}

fsLog(
  `service worker booted · engine ${FS_DIAG.engineLoaded ? "loaded" : "MISSING"}` +
    ` · core ${FS_DIAG.coreLoaded ? "loaded" : "MISSING"}` +
    (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest
      ? ` · v${chrome.runtime.getManifest().version}`
      : "")
);
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
  fsLog("diagnostics page:", chrome.runtime.getURL("diagnostics.html"));
}

const PASS_ALARM = "temporaryPassExpired";
const SCHEDULE_ALARM = "scheduleBoundaryReached";

// Storage keys the worker reads. Kept explicit rather than get(null) so the
// worker never depends on unrelated keys existing.
const SETTINGS_KEYS = [
  "schemaVersion",
  "enabled",
  "timerSeconds",
  "passDurationMinutes",
  "frictionProfile",
  "askIntent",
  "repeatFrictionEnabled",
  "repeatExtraSeconds",
  "repeatWindowMinutes",
  "settingsDelaySeconds",
  "schedule",
  "scheduleEnabled",
  "scheduleStart",
  "scheduleEnd",
  "deliverySitesEnabled",
  "fastFoodSitesEnabled",
  "customSitesEnabled",
  "disabledDeliverySiteKeys",
  "disabledFastFoodSiteKeys",
  "customSites",
  "passes",
  "siteBypasses",
  "repeatHistory",
  "enabledCountries",
  "enabledCategories",
  "quickAccessCountries",
  "quickAccessCategories",
  "dietPreference",
  "pantry",
  "equipment",
  "avoidAllergens",
  "alternativeFavorites",
  "recentAlternatives",
  "dismissedAlternatives",
  "customAlternatives",
  "stats",
  "showEstimates",
  "recapEnabled",
  "recapDismissedFor"
];

// The legacy delivery/fast-food site lists are sourced from the JSON blocklists.
// They are populated on demand by ensureBlocklistsLoaded() and keep the
// { key, label, match, home, ... } shape the rest of the code expects.
let DELIVERY_SITES = [];
let FAST_FOOD_SITES = [];
let blocklistsLoaded = false;
let blocklistLoadPromise = null;

// Legacy keys stripped the TLD, which caused regional domains to collide
// ("mcdonalds.com" and "mcdonalds.cl" both became "mcdonalds"). Kept only so
// existing saved disabled-site preferences still apply.
function legacyDomainToKey(domain) {
  return String(domain || "")
    .toLowerCase()
    .replace(/\.[a-z]+$/, "")
    .replace(/[^a-z0-9]/g, "");
}

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

// ---------------------------------------------------------------------------
// Storage: migration + normalized reads
// ---------------------------------------------------------------------------

let migrationPromise = null;

// Bring storage up to the current schema exactly once per worker generation.
// An MV3 worker can be torn down at any moment, so this must be safe to run
// again on the next wake-up — migrateState is idempotent, which is what makes
// that safe.
async function ensureMigrated() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const raw = await chrome.storage.local.get(null);
      const result = FitShieldCore.migrateState(raw);

      FS_DIAG.schemaVersion = result.to;

      if (result.error) {
        // A failed migration leaves storage untouched. Blocking still works off
        // the legacy keys, so this degrades rather than breaks.
        FS_DIAG.migration = `failed: ${result.error}`;
        fsError("Storage migration failed — the profile was left untouched", result.error);
        return;
      }

      if (result.changed) {
        await chrome.storage.local.set(result.state);
        FS_DIAG.migration = result.notes.join("; ");
        fsLog(`storage migrated: ${result.notes.join("; ")}`);
      } else {
        FS_DIAG.migration = "up to date";
      }
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }

  return migrationPromise;
}

// Tabs that currently exist, for tab-scoped passes. chrome.tabs.query and the
// onRemoved event both work without the "tabs" permission (that permission only
// gates reading a tab's URL), so this adds no new permission.
async function openTabIds() {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id));
  } catch (error) {
    return null;
  }
}

function mergeSitesWithEnabledState(sites, disabledKeys) {
  const disabledSet = new Set(disabledKeys || []);
  return sites.map((site) => ({
    ...site,
    enabled: !disabledSet.has(site.key) && !disabledSet.has(site.legacyKey)
  }));
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
  return domain ? { domain, enabled: entry.enabled !== false } : null;
}

function getCustomSiteKey(domain) {
  return `custom-${domain.replace(/[^a-z0-9]+/g, "-")}`;
}

async function getSettings() {
  await ensureMigrated();
  await ensureBlocklistsLoaded();

  const raw = await chrome.storage.local.get(SETTINGS_KEYS);
  const settings = FitShieldCore.readSettings(raw);
  const customSites = Array.isArray(raw.customSites)
    ? raw.customSites.map(createCustomSiteRecord).filter(Boolean)
    : [];

  return {
    ...settings,
    deliverySites: mergeSitesWithEnabledState(DELIVERY_SITES, settings.disabledDeliverySiteKeys),
    fastFoodSites: mergeSitesWithEnabledState(FAST_FOOD_SITES, settings.disabledFastFoodSiteKeys),
    customSites: [...new Map(customSites.map((site) => [site.domain, site])).values()]
  };
}

// ---------------------------------------------------------------------------
// Rule building
// ---------------------------------------------------------------------------

function normalizeStringList(value) {
  return FitShieldCore.toStringList(value, 5000);
}

// Build the de-duplicated set of sites to block. The catalog is the UNION of:
//   1. existing toggle behavior  (delivery / fast-food buckets + custom URLs)
//   2. metadata country blocks   (any enabled country in the entry's countries)
//   3. metadata category blocks  (the entry's category is enabled)
function getRuleCatalog(settings) {
  const byDomain = new Map();

  const addSite = (site, bucket) => {
    const domain = site.domain || site.match;

    if (domain && !byDomain.has(domain)) {
      byDomain.set(domain, { ...site, category: bucket });
    }
  };

  if (settings.deliverySitesEnabled) {
    settings.deliverySites.filter((site) => site.enabled).forEach((site) => addSite(site, "delivery"));
  }

  if (settings.fastFoodSitesEnabled) {
    settings.fastFoodSites.filter((site) => site.enabled).forEach((site) => addSite(site, "fastfood"));
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
// hostnames to punycode so they still block, and drop anything that cannot be
// made into a valid host — a single invalid rule makes Chrome reject the ENTIRE
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

    const matchDomains = [site.match, ...(Array.isArray(site.aliases) ? site.aliases : [])]
      .map(toUrlFilterHost)
      .filter(Boolean);

    new Set(matchDomains).forEach((matchDomain) => {
      rules.push({
        priority: 1,
        action: { type: "redirect", redirect: { url: warningUrl.toString() } },
        condition: {
          // "||" anchors to a domain-name boundary so subdomains match but
          // look-alikes (e.g. fake-mcdonalds.com) do not.
          urlFilter: `||${matchDomain}`,
          resourceTypes: ["main_frame"]
        }
      });
    });
  });

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
    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function syncAlarms(settings) {
  await chrome.alarms.clear(PASS_ALARM);
  await chrome.alarms.clear(SCHEDULE_ALARM);

  const nextPassExpiry = settings.passes
    .map((pass) => pass.expiresAt)
    .filter((expiry) => expiry > Date.now())
    .sort((a, b) => a - b)[0];

  if (nextPassExpiry) {
    await chrome.alarms.create(PASS_ALARM, { when: nextPassExpiry });
  }

  const boundary = FitShieldCore.nextScheduleBoundary(settings.schedule);

  if (boundary) {
    await chrome.alarms.create(SCHEDULE_ALARM, { when: boundary });
  }
}

let refreshChain = Promise.resolve();

async function refreshBlockingState() {
  const settings = await getSettings();
  const schedule = FitShieldCore.evaluateSchedule(settings.schedule);
  const tabs = await openTabIds();
  const activePasses = FitShieldCore.activePasses(settings.passes, Date.now(), { openTabIds: tabs });
  const hasActiveSites = getRuleCatalog(settings).length > 0;

  // A domain can appear in more than one bucket (doordash.com is listed as both
  // delivery and fast-food). A pass is granted for a domain, so exclude by
  // DOMAIN — otherwise the other bucket's identical rule re-blocks the user the
  // instant they continue.
  const passCovers = (site) =>
    !!FitShieldCore.findCoveringPass(
      activePasses,
      { domain: site.domain || site.match, category: site.category },
      Date.now(),
      { openTabIds: tabs }
    );

  const rules = createRules({
    ...settings,
    deliverySites: settings.deliverySites.filter((site) => !passCovers(site)),
    fastFoodSites: settings.fastFoodSites.filter((site) => !passCovers(site)),
    customSites: settings.customSites.filter((site) => !passCovers({ domain: site.domain, category: "custom" }))
  });

  const hasBlockingRules = rules.length > 0;
  const globalPause = activePasses.some((pass) => pass.scope === "all");

  if (!settings.enabled || !schedule.active || globalPause || !hasActiveSites || !hasBlockingRules) {
    const reason = !settings.enabled
      ? "master switch off"
      : !schedule.active
        ? "outside the active schedule window"
        : globalPause
          ? "all blocking is paused by a temporary pass"
          : !hasActiveSites
            ? "no blocklists or toggles enabled"
            : "no matching redirect rules";

    FS_DIAG.lastRuleCount = 0;
    FS_DIAG.lastDecision = `inactive — ${reason}`;
    fsLog("blocking inactive —", reason);
    await updateDynamicRules([]);
    await chrome.storage.local.set({ passes: activePasses });
    await syncAlarms({ ...settings, passes: activePasses });
    return;
  }

  FS_DIAG.lastRuleCount = rules.length;
  FS_DIAG.lastDecision = `active — ${rules.length} redirect rule(s)`;
  fsLog(`blocking active — ${rules.length} redirect rule(s)`);
  await updateDynamicRules(rules);
  await chrome.storage.local.set({ passes: activePasses });
  await syncAlarms({ ...settings, passes: activePasses });
}

function queueRefreshBlockingState() {
  refreshChain = refreshChain.catch(() => {}).then(() => refreshBlockingState());
  return refreshChain;
}

// ---------------------------------------------------------------------------
// Block-page support
// ---------------------------------------------------------------------------

function customRecordsFor(settings) {
  return settings.customSites.map((site) => ({
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
}

function findSite(settings, siteKey) {
  const lookup = [
    ...getRuleCatalog(settings),
    ...settings.deliverySites,
    ...settings.fastFoodSites,
    ...customRecordsFor(settings)
  ];

  return lookup.find((entry) => entry.key === siteKey) || null;
}

async function getBlockedSiteInfo(siteKey) {
  const settings = await getSettings();
  const site = findSite(settings, siteKey);

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

/**
 * Everything the block page needs, in ONE round trip: which brand was
 * interrupted, how long the pause is (including any repeat-access addition and
 * why), which pass options are offered, and the user's own matching preferences.
 *
 * One message rather than six matters here: the page has to render before a
 * countdown that may only be twenty seconds long, and every extra round trip to
 * an MV3 worker can pay a wake-up cost.
 */
async function getBlockContext(siteKey, options) {
  const opts = options && typeof options === "object" ? options : {};
  const settings = await getSettings();
  const site = findSite(settings, siteKey);
  const domain = site ? site.domain || site.match : "";

  const repeat = FitShieldCore.repeatFrictionFor(settings.repeatHistory, domain, settings, Date.now());
  const baseSeconds = settings.timerSeconds;
  const timerSeconds = Math.min(FitShieldCore.MAX_TIMER_SECONDS, baseSeconds + repeat.extraSeconds);

  return {
    ok: true,
    preview: opts.preview === true,
    found: !!site,
    site: site
      ? {
          key: site.key,
          label: site.label,
          domain,
          home: site.home,
          type: site.type || "",
          category: site.category || "",
          countries: Array.isArray(site.countries) ? site.countries : [],
          specialties: Array.isArray(site.specialties) ? site.specialties : []
        }
      : null,
    timerSeconds,
    baseTimerSeconds: baseSeconds,
    repeat,
    passDurationMinutes: settings.passDurationMinutes,
    frictionProfile: settings.frictionProfile,
    askIntent: settings.askIntent,
    preferences: {
      dietPreference: settings.dietPreference,
      pantry: settings.pantry,
      equipment: settings.equipment,
      avoidAllergens: settings.avoidAllergens,
      alternativeFavorites: settings.alternativeFavorites,
      recentAlternatives: settings.recentAlternatives,
      dismissedAlternatives: settings.dismissedAlternatives,
      customAlternatives: settings.customAlternatives
    }
  };
}

// ---------------------------------------------------------------------------
// Statistics — see fitshield-core.js for what each event means.
// ---------------------------------------------------------------------------

// Preview mode must be able to exercise the whole flow without touching real
// numbers, so every recording path takes the same `preview` escape hatch.
async function recordEvent(event, options) {
  const opts = options && typeof options === "object" ? options : {};

  if (opts.preview === true) {
    return { ok: true, recorded: false, preview: true };
  }

  await ensureMigrated();
  const { stats } = await chrome.storage.local.get(["stats"]);
  const next = FitShieldCore.applyStatEvent(stats, event, Date.now());
  await chrome.storage.local.set({ stats: next });

  return { ok: true, recorded: true, totals: next.totals };
}

function incrementCount(map, key, by) {
  const next = map && typeof map === "object" && !Array.isArray(map) ? { ...map } : {};
  const cleanKey = String(key || "").trim();

  if (!cleanKey || cleanKey === "__proto__") {
    return next;
  }

  next[cleanKey] = (Number(next[cleanKey]) || 0) + (Number(by) || 1);
  return next;
}

// Record an aggregate, local-only breakdown of WHICH curated brand was
// interrupted, so the stats panel can show the most interrupted sites,
// categories, and countries. This counts only brands already on the curated
// blocklist and never stores a URL, path, timestamp, or browsing history.
async function recordBlockedBrand(meta, options) {
  const opts = options && typeof options === "object" ? options : {};

  if (opts.preview === true) {
    return { ok: true, recorded: false, preview: true };
  }

  const info = meta && typeof meta === "object" ? meta : {};
  const domain = FitShieldBlocklist.normalizeHostname(info.domain);
  const category = String(info.category || "").trim().toLowerCase();
  const countries = normalizeStringList(info.countries).map((code) => code.toUpperCase());

  if (!domain && !category && countries.length === 0) {
    return { ok: true, recorded: false };
  }

  const stored = await chrome.storage.local.get(["blockedByDomain", "blockedByCategory", "blockedByCountry"]);

  const blockedByDomain = domain ? incrementCount(stored.blockedByDomain, domain, 1) : stored.blockedByDomain || {};
  const isBucketCategory = category === "delivery" || category === "fast_food" || category === "custom";
  const blockedByCategory =
    category && !isBucketCategory
      ? incrementCount(stored.blockedByCategory, category, 1)
      : stored.blockedByCategory || {};

  // Count only the brand's PRIMARY (first-listed) operating market. Many brands
  // operate in dozens of countries; counting every one would let a single block
  // inflate the whole list. This still uses only curated brand metadata — never
  // the user's real location.
  const primaryCountry = countries[0];
  const blockedByCountry = primaryCountry
    ? incrementCount(stored.blockedByCountry, primaryCountry, 1)
    : stored.blockedByCountry || {};

  await chrome.storage.local.set({ blockedByDomain, blockedByCategory, blockedByCountry });
  return { ok: true, recorded: true };
}

// Remember what was shown so "show another" can move on, and what was dismissed
// so it stops coming back for a while. Local ids only.
async function recordAlternativeShown(id, options) {
  const opts = options && typeof options === "object" ? options : {};

  if (opts.preview === true) {
    return { ok: true, recorded: false, preview: true };
  }

  await ensureMigrated();
  const { recentAlternatives } = await chrome.storage.local.get(["recentAlternatives"]);
  await chrome.storage.local.set({ recentAlternatives: FitShieldCore.pushRecent(recentAlternatives, id) });
  return recordEvent("alternativesViewed", opts);
}

async function recordAlternativeDismissed(id, options) {
  const opts = options && typeof options === "object" ? options : {};

  if (opts.preview === true) {
    return { ok: true, recorded: false, preview: true };
  }

  await ensureMigrated();
  const { dismissedAlternatives } = await chrome.storage.local.get(["dismissedAlternatives"]);
  await chrome.storage.local.set({
    dismissedAlternatives: FitShieldCore.pushRecent(dismissedAlternatives, id)
  });
  return { ok: true, recorded: true };
}

// "I'll make this" is an INTENT. It does not claim a meal happened, and it does
// not touch any calorie figure. Confirming it was actually made is a separate,
// voluntary action (markAlternativeMade) taken later from the popup.
async function recordAlternativeSelected(id, options) {
  const opts = options && typeof options === "object" ? options : {};

  if (opts.preview === true) {
    return { ok: true, recorded: false, preview: true };
  }

  await ensureMigrated();
  const { pendingAlternatives } = await chrome.storage.local.get(["pendingAlternatives"]);
  const pending = Array.isArray(pendingAlternatives) ? pendingAlternatives : [];
  const cleanId = String(id || "").slice(0, 64);

  if (cleanId) {
    await chrome.storage.local.set({
      pendingAlternatives: [
        ...pending.filter((item) => item && item.id !== cleanId),
        { id: cleanId, at: Date.now() }
      ].slice(-10)
    });
  }

  return recordEvent("alternativesSelected", opts);
}

async function markAlternativeMade(id) {
  await ensureMigrated();
  const { pendingAlternatives } = await chrome.storage.local.get(["pendingAlternatives"]);
  const pending = Array.isArray(pendingAlternatives) ? pendingAlternatives : [];
  const cleanId = String(id || "").slice(0, 64);

  await chrome.storage.local.set({
    pendingAlternatives: pending.filter((item) => item && item.id !== cleanId)
  });

  return recordEvent("alternativesMade");
}

// ---------------------------------------------------------------------------
// Temporary passes
// ---------------------------------------------------------------------------

/**
 * Grant a scoped temporary pass. Scope comes from a named preset so the UI and
 * the worker can never disagree about what "once" or "until tomorrow" means.
 */
async function grantPass(request) {
  const input = request && typeof request === "object" ? request : {};

  if (input.preview === true) {
    return { ok: true, granted: false, preview: true, destination: "" };
  }

  const settings = await getSettings();
  const site = findSite(settings, input.site);

  // A site key that does not resolve must NOT fall back to some other brand —
  // that would grant access to a site the user never asked about.
  if (!site && input.presetId !== "all30" && input.presetId !== "allTomorrow") {
    return { ok: false, error: "Unknown site." };
  }

  const domain = site ? site.domain || site.match : "";
  const presetId = FitShieldCore.PASS_PRESET_IDS.includes(input.presetId) ? input.presetId : "site10";
  const preset = FitShieldCore.PASS_PRESETS[presetId];

  const pass = FitShieldCore.createPass({
    presetId,
    target: preset.scope === "category" ? site && site.category : domain,
    minutes: preset.minutes === undefined ? settings.passDurationMinutes : preset.minutes,
    tabId: input.tabId,
    now: Date.now()
    // input.intent is deliberately NOT forwarded. Settings promises the "what
    // brought you here?" answer is never saved, and it used to be persisted on
    // the pass record.
  });

  const tabs = await openTabIds();
  const passes = [...FitShieldCore.activePasses(settings.passes, Date.now(), { openTabIds: tabs }), pass];

  const repeatHistory = domain
    ? FitShieldCore.recordContinue(settings.repeatHistory, domain, Date.now())
    : settings.repeatHistory;

  await chrome.storage.local.set({ enabled: true, passes, repeatHistory });
  await recordEvent("passesUsed");
  await recordEvent("continued");
  await queueRefreshBlockingState();

  return {
    ok: true,
    granted: true,
    pass,
    destination: site ? site.home : "",
    label: site ? site.label : "",
    expiresAt: pass.expiresAt
  };
}

async function revokeAllPasses() {
  await ensureMigrated();
  await chrome.storage.local.set({ passes: [] });
  await queueRefreshBlockingState();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// State + diagnostics
// ---------------------------------------------------------------------------

async function getBlockState() {
  const settings = await getSettings();
  const schedule = FitShieldCore.evaluateSchedule(settings.schedule);
  const tabs = await openTabIds();
  const passes = FitShieldCore.activePasses(settings.passes, Date.now(), { openTabIds: tabs });

  return {
    ok: true,
    ...settings,
    passes,
    scheduleActive: schedule.active,
    scheduleReason: schedule.reason,
    // Kept for older UI code and the popup's "paused" message.
    bypassUntil: passes.length > 0 ? Math.max(...passes.map((pass) => pass.expiresAt)) : 0,
    recap: FitShieldCore.weeklyRecap(settings.stats, Date.now(), {
      blockedByCategory: (await chrome.storage.local.get(["blockedByCategory"])).blockedByCategory
    })
  };
}

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
    coreLoaded: FS_DIAG.coreLoaded,
    schemaVersion: FS_DIAG.schemaVersion,
    migration: FS_DIAG.migration,
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
    await chrome.storage.local.set({ lastSeenVersion: currentVersion });
    openExtensionPage("welcome.html");
    return;
  }

  if (reason === "update") {
    const { lastSeenVersion } = await chrome.storage.local.get(["lastSeenVersion"]);

    if (lastSeenVersion !== currentVersion) {
      await chrome.storage.local.set({ lastSeenVersion: currentVersion });
      openExtensionPage("whats-new.html");
    }
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await ensureMigrated();

    // Seed anything a brand-new profile needs, without overwriting an existing
    // one: every value is read first and only defaulted when absent.
    const raw = await chrome.storage.local.get(SETTINGS_KEYS);
    const settings = FitShieldCore.readSettings(raw);

    // Never stamp a newer profile backwards. If the user has downgraded (or runs
    // two channels against one profile), rewriting the stamp to OUR version
    // would make the next migration replay steps against data that is already
    // past them. migrateState deliberately leaves a future profile alone; this
    // keeps the install path from undoing that protection.
    const schemaVersion = Math.max(
      FitShieldCore.storedVersion(raw),
      FitShieldCore.SCHEMA_VERSION
    );

    await chrome.storage.local.set({
      [FitShieldCore.SCHEMA_KEY]: schemaVersion,
      enabled: settings.enabled,
      timerSeconds: settings.timerSeconds,
      passDurationMinutes: settings.passDurationMinutes,
      frictionProfile: settings.frictionProfile,
      schedule: settings.schedule,
      deliverySitesEnabled: settings.deliverySitesEnabled,
      fastFoodSitesEnabled: settings.fastFoodSitesEnabled,
      customSitesEnabled: settings.customSitesEnabled,
      disabledDeliverySiteKeys: settings.disabledDeliverySiteKeys,
      disabledFastFoodSiteKeys: settings.disabledFastFoodSiteKeys,
      customSites: Array.isArray(raw.customSites)
        ? [...new Map(raw.customSites.map(createCustomSiteRecord).filter(Boolean).map((site) => [site.domain, site])).values()]
        : [],
      passes: settings.passes,
      enabledCountries: settings.enabledCountries,
      enabledCategories: settings.enabledCategories,
      quickAccessCountries: settings.quickAccessCountries,
      quickAccessCategories: settings.quickAccessCategories,
      pantry: settings.pantry,
      equipment: settings.equipment,
      dietPreference: settings.dietPreference,
      stats: settings.stats
    });

    await queueRefreshBlockingState();
    await showOnboardingOrWhatsNew(details && details.reason);
  } catch (error) {
    fsError("onInstalled setup failed", error);
  }
});

chrome.runtime.onStartup.addListener(() => {
  // A browser restart is exactly when stale passes must disappear:
  // refreshBlockingState re-reads them through activePasses, which drops
  // anything already expired.
  queueRefreshBlockingState().catch((error) => {
    fsError("Failed to refresh blocking state on startup", error);
  });
});

// Tab-scoped passes end when their tab does.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local
    .get(["passes"])
    .then(({ passes }) => {
      const list = Array.isArray(passes) ? passes : [];

      if (!list.some((pass) => pass && pass.tabId === tabId)) {
        return null;
      }

      return chrome.storage.local.set({ passes: list.filter((pass) => !pass || pass.tabId !== tabId) });
    })
    .catch((error) => fsError("Failed to clear tab-scoped passes", error));
});

const REFRESH_KEYS = [
  "enabled",
  "timerSeconds",
  "passDurationMinutes",
  "schedule",
  "scheduleEnabled",
  "scheduleStart",
  "scheduleEnd",
  "deliverySitesEnabled",
  "fastFoodSitesEnabled",
  "customSitesEnabled",
  "disabledDeliverySiteKeys",
  "disabledFastFoodSiteKeys",
  "customSites",
  "passes",
  "enabledCountries",
  "enabledCategories"
];

const ALL_DAY_COUNT = 7;

// The popup still writes the three flat schedule keys, and older builds only
// understood those. Whenever they change, rebuild the structured schedule from
// them so there is exactly one effective source of truth. Guarded against
// looping: it only writes when the rebuilt schedule actually differs.
async function syncLegacySchedule() {
  const raw = await chrome.storage.local.get(["schedule", "scheduleEnabled", "scheduleStart", "scheduleEnd"]);
  const current = FitShieldCore.normalizeSchedule(raw.schedule);

  // The flat trio can only ever describe ONE window on ALL SEVEN days, so
  // rebuilding from it is lossy. Anything richer than that — "Workday lunch"
  // (Mon-Fri), "Evenings and weekends" (two windows), or any per-day schedule
  // from the advanced editor — must not be regenerated from its own lossy
  // mirror, or the worker silently replaces the schedule the user just saved
  // with a seven-day one and then blocks their Saturday lunch.
  //
  // The advanced editor writes the structured schedule AND the mirror in one
  // set(), which is exactly what used to trip this listener.
  const expressibleByFlatKeys =
    current.mode !== "windows" ||
    (current.windows.length === 1 && current.windows[0].days.length === ALL_DAY_COUNT);

  if (!expressibleByFlatKeys) {
    return;
  }

  const rebuilt = FitShieldCore.normalizeSchedule(FitShieldCore.scheduleFromLegacy(raw));

  // A temporary override lives only on the structured form; preserve it.
  rebuilt.until = current.until;

  if (JSON.stringify(rebuilt) !== JSON.stringify(current)) {
    await chrome.storage.local.set({ schedule: rebuilt });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }

  if (changes.scheduleEnabled || changes.scheduleStart || changes.scheduleEnd) {
    syncLegacySchedule().catch((error) => fsError("Failed to sync the legacy schedule keys", error));
  }

  if (REFRESH_KEYS.some((key) => changes[key])) {
    queueRefreshBlockingState().catch((error) => {
      fsError("Failed to refresh blocking state", error);
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PASS_ALARM || alarm.name === SCHEDULE_ALARM) {
    queueRefreshBlockingState().catch((error) => {
      fsError(`Failed to refresh after ${alarm.name}`, error);
    });
  }
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

// Every handler resolves to a response object; the table keeps the listener flat
// and makes the message surface readable in one place.
const HANDLERS = {
  getBlockState: () => getBlockState(),
  getBlockedSiteInfo: (message) => getBlockedSiteInfo(message.site),
  getBlockContext: (message) => getBlockContext(message.site, message),
  getDiagnostics: (message) => getDiagnostics(message.domain),
  grantPass: (message, sender) =>
    grantPass({ ...message, tabId: message.tabId ?? (sender && sender.tab && sender.tab.id) }),
  revokeAllPasses: () => revokeAllPasses(),
  recordInterruption: (message) => recordEvent("interruptions", message),
  recordLeft: (message) => recordEvent("left", message),
  recordBlockedBrand: (message) => recordBlockedBrand(message.meta, message),
  recordAlternativeShown: (message) => recordAlternativeShown(message.id, message),
  recordAlternativeSelected: (message) => recordAlternativeSelected(message.id, message),
  recordAlternativeDismissed: (message) => recordAlternativeDismissed(message.id, message),
  markAlternativeMade: (message) => markAlternativeMade(message.id),
  refreshBlocking: () => queueRefreshBlockingState().then(() => ({ ok: true }))
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && HANDLERS[message.type];

  if (!handler) {
    return false;
  }

  Promise.resolve()
    .then(() => handler(message, sender))
    .then((result) => sendResponse(result || { ok: true }))
    .catch((error) => {
      fsError(`Message "${message.type}" failed`, error);
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    });

  return true;
});
