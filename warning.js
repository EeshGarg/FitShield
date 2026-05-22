const DEFAULT_TIMER_SECONDS = 60;
const DEFAULT_PASS_DURATION_MINUTES = 5;
const DEFAULT_DESTINATION = "https://www.doordash.com/";

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

// Maps the query-string site key to the site we reopen after the pause.
const DESTINATIONS = {
  doordash: "https://www.doordash.com/",
  ubereats: "https://www.ubereats.com/",
  grubhub: "https://www.grubhub.com/"
};

const timerEl = document.getElementById("timer");
const ringEl = document.getElementById("ring");
const hintEl = document.getElementById("hint");
const backButton = document.getElementById("back");
const continueButton = document.getElementById("continue");

const params = new URLSearchParams(window.location.search);
const siteKey = params.get("site") || "doordash";
const timerParam = Number.parseInt(params.get("timer"), 10);
const passDurationParam = Number.parseInt(params.get("pass"), 10);
const destination = DESTINATIONS[siteKey] || DEFAULT_DESTINATION;

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

function unlock() {
  // Unlocking enables the one-click temporary bypass flow.
  unlocked = true;
  continueButton.disabled = false;
  continueButton.classList.add("ready");
  continueButton.textContent = "Continue";
  hintEl.textContent = `You can visit the site now. The blocker will come back automatically after ${passDurationMinutes} minute${passDurationMinutes === 1 ? "" : "s"}.`;
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
  continueButton.textContent = "Opening...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "startTemporaryBypass",
      site: siteKey
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Temporary bypass failed.");
    }

    window.location.href = response.destination || destination;
  } catch (error) {
    console.error(error);
    continueButton.disabled = false;
    continueButton.textContent = "Continue";
    hintEl.textContent = "Something went wrong while opening the site. Please try again.";
  }
});

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

  renderTimer();
  startTimer();
}

initializeTimer();
