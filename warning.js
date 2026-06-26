const DEFAULT_TIMER_SECONDS = 60;
const DEFAULT_PASS_DURATION_MINUTES = 5;

// Localization helper (i18n.js loads first). Falls back to the key so missing
// strings stay visible rather than blank.
const t = (key, subs) =>
  (typeof FitShieldI18n !== "undefined" ? FitShieldI18n.t(key, subs) : key);

function minuteUnit(value) {
  return t(value === 1 ? "unitMinute" : "unitMinutes");
}

// Base styling for the warning screen before custom theme preferences load.
const DEFAULT_THEME = {
  bg: "#0d1117",
  panel: "rgba(21, 27, 35, 0.92)",
  border: "rgba(126, 240, 168, 0.18)",
  text: "#f3f8fb",
  muted: "#a8b4c3",
  accent: "#7ef0a8",
  accentDim: "#243228",
  radius: 24
};

const timerEl = document.getElementById("timer");
const ringEl = document.getElementById("ring");
const hintEl = document.getElementById("hint");
const brandEl = document.getElementById("brand");
const backButton = document.getElementById("back");
const continueButton = document.getElementById("continue");

const params = new URLSearchParams(window.location.search);
const siteKey = params.get("site") || "";
const timerParam = Number.parseInt(params.get("timer"), 10);
const passDurationParam = Number.parseInt(params.get("pass"), 10);

// The site that triggered the block is resolved from the JSON blocklist metadata
// by the background service worker (see getBlockedSiteInfo). Until that resolves
// we have no hard-coded destination; the bypass response carries the real one.
let destination = "";
let siteLabel = "";

// Query params are mainly for manual URL overrides; normal users fall back to stored defaults.
let secondsLeft = Number.isFinite(timerParam) && timerParam >= 10 ? timerParam : DEFAULT_TIMER_SECONDS;
let totalSeconds = secondsLeft;
let passDurationMinutes = Number.isFinite(passDurationParam) && passDurationParam >= 1
  ? passDurationParam
  : DEFAULT_PASS_DURATION_MINUTES;
let unlocked = false;

function applyTheme(theme = {}) {
  // Accept partial theme overrides from storage without requiring every value.
  const mergedTheme = {
    ...DEFAULT_THEME,
    ...theme
  };
  const root = document.documentElement;

  root.style.setProperty("--bg", mergedTheme.bg);
  root.style.setProperty("--panel", mergedTheme.panel);
  root.style.setProperty("--border", mergedTheme.border);
  root.style.setProperty("--text", mergedTheme.text);
  root.style.setProperty("--muted", mergedTheme.muted);
  root.style.setProperty("--accent", mergedTheme.accent);
  root.style.setProperty("--accent-dim", mergedTheme.accentDim);
  root.style.setProperty("--panel-radius", `${mergedTheme.radius}px`);
}

function renderTimer() {
  // Updates the visible countdown and the subtle progress animation around it.
  timerEl.textContent = String(secondsLeft);

  const progress = (totalSeconds - secondsLeft) / totalSeconds;
  ringEl.style.transform = `scale(${1 + progress * 0.08})`;
  ringEl.style.boxShadow = `0 0 ${24 + progress * 26}px rgba(126, 240, 168, 0.22)`;
}

// Render every JS-managed string based on current state. Called on load and
// whenever the language changes, so the block screen stays consistent.
function renderDynamicText() {
  if (siteLabel) {
    brandEl.textContent = t("warningTriggeredBy", [siteLabel]);
    brandEl.hidden = false;
  } else {
    brandEl.hidden = true;
  }

  hintEl.textContent = unlocked
    ? t("warningUnlockHint", [String(passDurationMinutes), minuteUnit(passDurationMinutes)])
    : t("warningHintLocked", [String(passDurationMinutes), minuteUnit(passDurationMinutes)]);

  // Leave the button alone while it is mid-navigation ("Opening…").
  if (continueButton.dataset.state !== "opening") {
    continueButton.textContent = unlocked ? t("warningContinueButton") : t("warningLockedButton");
  }
}

function unlock() {
  // Unlocking enables the one-click temporary bypass flow.
  unlocked = true;
  continueButton.disabled = false;
  continueButton.classList.add("ready");
  renderDynamicText();
}

let timerInterval;

function startTimer() {
  // Counts down once per second until the user is allowed to continue.
  timerInterval = window.setInterval(() => {
    secondsLeft -= 1;

    if (secondsLeft <= 0) {
      secondsLeft = 0;
      window.clearInterval(timerInterval);
      unlock();
    }

    renderTimer();
  }, 1000);
}

backButton.addEventListener("click", () => {
  window.history.back();
});

continueButton.addEventListener("click", async () => {
  // The background script owns bypass state so the warning page just requests it.
  if (!unlocked) {
    return;
  }

  continueButton.disabled = true;
  continueButton.dataset.state = "opening";
  continueButton.textContent = t("warningOpeningButton");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "startTemporaryBypass",
      site: siteKey
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Temporary bypass failed.");
    }

    window.location.href = response.destination || destination || "about:blank";
  } catch (error) {
    console.error(error);
    delete continueButton.dataset.state;
    continueButton.disabled = false;
    continueButton.textContent = t("warningContinueButton");
    hintEl.textContent = t("warningErrorHint");
  }
});

async function loadBlockedSite() {
  // Pull the brand + destination for the site key from the JSON-backed catalog.
  if (!siteKey) {
    return;
  }

  try {
    const info = await chrome.runtime.sendMessage({ type: "getBlockedSiteInfo", site: siteKey });

    if (info?.ok && info.found) {
      destination = info.home || destination;
      siteLabel = info.label || "";
    }
  } catch (error) {
    console.error("Failed to load blocked site info:", error);
  }
}

async function initializeTimer() {
  try {
    // Pull the latest theme and timer values so this page matches extension settings.
    const { theme } = await chrome.storage.local.get(["theme"]);
    applyTheme(theme);

    const response = await chrome.runtime.sendMessage({ type: "getBlockState" });
    const configuredSeconds = Number.parseInt(response?.timerSeconds, 10);
    const configuredPassMinutes = Number.parseInt(response?.passDurationMinutes, 10);

    if (!Number.isFinite(timerParam) && Number.isFinite(configuredSeconds) && configuredSeconds >= 10) {
      secondsLeft = configuredSeconds;
      totalSeconds = configuredSeconds;
    }

    if (!Number.isFinite(passDurationParam) && Number.isFinite(configuredPassMinutes) && configuredPassMinutes >= 1) {
      passDurationMinutes = configuredPassMinutes;
    }
  } catch (error) {
    console.error("Failed to load timer settings:", error);
  }

  await loadBlockedSite();

  renderDynamicText();
  renderTimer();
  startTimer();
}

// Re-render JS-managed strings when the language changes mid-screen.
if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.onChange) {
  FitShieldI18n.onChange(renderDynamicText);
}

// Wait until the stored UI language is applied so the screen does not flash the
// browser default, then start the countdown.
const i18nReady = (typeof FitShieldI18n !== "undefined" && FitShieldI18n.ready)
  ? FitShieldI18n.ready
  : Promise.resolve();

i18nReady.then(initializeTimer);
