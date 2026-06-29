"use strict";
/**
 * Shared paths, loaders, and reference data for the tools/ validators.
 * Node built-ins only; developer-only, never bundled into the extension.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const BLOCKLISTS_DIR = path.join(ROOT, "blocklists");
const LOCALES_DIR = path.join(ROOT, "_locales");
const CHANGELOG_DIR = path.join(ROOT, "changelog");
const ICONS_DIR = path.join(ROOT, "icons");
const BRANDING_DIR = path.join(ROOT, "Branding");

const DATASET_FILES = ["fast-food.json", "delivery.json"];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Returns { name, path, raw (string), data, error } — never throws, so a tool
// can report a malformed file instead of crashing.
function loadDataset(name) {
  const file = path.join(BLOCKLISTS_DIR, name);
  const result = { name, path: file, raw: null, data: null, error: null };
  try {
    result.raw = fs.readFileSync(file, "utf8");
    result.data = JSON.parse(result.raw);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function loadDatasets() {
  return DATASET_FILES.map(loadDataset);
}

function localeDirs() {
  if (!fs.existsSync(LOCALES_DIR)) {
    return [];
  }
  return fs
    .readdirSync(LOCALES_DIR)
    .filter((d) => fs.existsSync(path.join(LOCALES_DIR, d, "messages.json")))
    .sort();
}

function loadLocale(code) {
  const file = path.join(LOCALES_DIR, code, "messages.json");
  const result = { code, path: file, raw: null, data: null, error: null };
  try {
    result.raw = fs.readFileSync(file, "utf8");
    result.data = JSON.parse(result.raw);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function manifest() {
  return readJson(path.join(ROOT, "manifest.json"));
}

function pkg() {
  return readJson(path.join(ROOT, "package.json"));
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// ISO 3166-1 alpha-2 codes used to validate the `countries` metadata. Kept here
// (not in the extension) so adding a code is a one-line tooling change.
const ISO_COUNTRIES = new Set([
  "AD","AE","AF","AG","AL","AM","AO","AR","AT","AU","AZ","BA","BB","BD","BE","BF","BG","BH","BI","BJ",
  "BN","BO","BR","BS","BT","BW","BY","BZ","CA","CD","CF","CG","CH","CI","CL","CM","CN","CO","CR","CU",
  "CV","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE","EG","ER","ES","ET","FI","FJ","FM","FR","GA",
  "GB","GD","GE","GH","GM","GN","GQ","GR","GT","GW","GY","HK","HN","HR","HT","HU","ID","IE","IL","IN",
  "IQ","IR","IS","IT","JM","JO","JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KZ","LA","LB","LC",
  "LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MG","MH","MK","ML","MM","MN","MO","MR",
  "MT","MU","MV","MW","MX","MY","MZ","NA","NE","NG","NI","NL","NO","NP","NZ","OM","PA","PE","PG","PH",
  "PK","PL","PT","PW","PY","QA","RO","RS","RU","RW","SA","SB","SC","SD","SE","SG","SI","SK","SL","SM",
  "SN","SO","SR","SS","ST","SV","SY","SZ","TD","TG","TH","TJ","TL","TM","TN","TO","TR","TT","TV","TW",
  "TZ","UA","UG","US","UY","UZ","VA","VC","VE","VN","VU","WS","XK","YE","ZA","ZM","ZW"
]);

const KNOWN_REGIONS = new Set(["NA", "SA", "EU", "AS", "AF", "OC", "AN"]);

// True for a clean apex domain: lowercase, no scheme/path/port/whitespace, has
// at least one dot, and parses to a hostname. Accepts internationalized (IDN)
// domains such as "saemaeul식당.com" — the extension punycodes them at
// rule-build time, so they are valid blocklist entries.
function isApexDomain(value) {
  const domain = String(value || "");
  if (!domain || domain !== domain.toLowerCase()) {
    return false;
  }
  if (/[\s/:?#]/.test(domain) || !domain.includes(".") || domain.startsWith("www.")) {
    return false;
  }
  try {
    return new URL(`https://${domain}`).hostname.length > 0;
  } catch {
    return false;
  }
}

// Country -> continent/region tag, used to flag entries whose `regions` are
// inconsistent with their `countries`. Covers every code currently in the
// datasets; codes not listed are simply skipped by the consistency check.
const COUNTRY_REGION = {
  // North America
  US: "NA", CA: "NA", MX: "NA", CR: "NA", GT: "NA", PA: "NA", SV: "NA", DO: "NA", NI: "NA", HN: "NA",
  CU: "NA", JM: "NA", HT: "NA", BS: "NA", BB: "NA", TT: "NA", BZ: "NA",
  // South America
  BR: "SA", AR: "SA", CL: "SA", CO: "SA", PE: "SA", EC: "SA", UY: "SA", PY: "SA", BO: "SA", VE: "SA",
  GY: "SA", SR: "SA",
  // Europe
  GB: "EU", IE: "EU", FR: "EU", DE: "EU", ES: "EU", IT: "EU", PT: "EU", NL: "EU", BE: "EU", AT: "EU",
  CH: "EU", SE: "EU", NO: "EU", DK: "EU", FI: "EU", PL: "EU", CZ: "EU", HU: "EU", RO: "EU", GR: "EU",
  RU: "EU", UA: "EU", BG: "EU", HR: "EU", RS: "EU", SK: "EU", SI: "EU", LT: "EU", LV: "EU", EE: "EU",
  IS: "EU", CY: "EU", LU: "EU", MT: "EU", AL: "EU", MK: "EU", BA: "EU", ME: "EU", MD: "EU", XK: "EU",
  AD: "EU", MC: "EU", SM: "EU", LI: "EU", BY: "EU",
  // Asia (incl. Middle East, Caucasus, Central Asia)
  TR: "AS", AE: "AS", SA: "AS", QA: "AS", KW: "AS", BH: "AS", OM: "AS", JO: "AS", LB: "AS", IL: "AS",
  IQ: "AS", IR: "AS", YE: "AS", SY: "AS", IN: "AS", PK: "AS", BD: "AS", LK: "AS", NP: "AS", BT: "AS",
  MV: "AS", CN: "AS", HK: "AS", MO: "AS", TW: "AS", JP: "AS", KR: "AS", KP: "AS", SG: "AS", MY: "AS",
  TH: "AS", PH: "AS", ID: "AS", VN: "AS", BN: "AS", KH: "AS", LA: "AS", MM: "AS", MN: "AS", KZ: "AS",
  KG: "AS", TJ: "AS", TM: "AS", UZ: "AS", AZ: "AS", AM: "AS", GE: "AS", TL: "AS",
  // Africa
  EG: "AF", MA: "AF", ZA: "AF", NG: "AF", KE: "AF", GH: "AF", TN: "AF", DZ: "AF", ET: "AF", UG: "AF",
  CI: "AF", SN: "AF", CM: "AF", TZ: "AF", AO: "AF", MZ: "AF", ZM: "AF", ZW: "AF", BW: "AF", NA: "AF",
  RW: "AF", LY: "AF", SD: "AF", MU: "AF", TG: "AF", GA: "AF", BJ: "AF", CD: "AF", CG: "AF", ML: "AF",
  BF: "AF", NE: "AF", MG: "AF", MW: "AF", SS: "AF",
  // Oceania
  AU: "OC", NZ: "OC", FJ: "OC", PG: "OC"
};

module.exports = {
  ROOT, BLOCKLISTS_DIR, LOCALES_DIR, CHANGELOG_DIR, ICONS_DIR, BRANDING_DIR,
  DATASET_FILES,
  readJson, loadDataset, loadDatasets, localeDirs, loadLocale, manifest, pkg, exists,
  isApexDomain, ISO_COUNTRIES, KNOWN_REGIONS, COUNTRY_REGION
};
