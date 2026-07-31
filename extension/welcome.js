// First-run onboarding wizard. All choices are written straight to
// chrome.storage.local; nothing leaves the device.

const THEME_PRESETS = {
  dark: { bg: "#0f141b", panel: "#1a212b", border: "#2c3644", text: "#edf2f7", muted: "#a9b4c2", accent: "#7ef0a8" },
  light: { bg: "#f4f6fa", panel: "#ffffff", border: "#d6dde6", text: "#1b2430", muted: "#5a6675", accent: "#15a05a" }
};

const t = (key, subs) =>
  (typeof FitShieldI18n !== "undefined" ? FitShieldI18n.t(key, subs) : key);

function resolveMode(mode) {
  if (mode === "system") {
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  }
  return mode === "light" ? "light" : "dark";
}

function applyTheme(mode) {
  const preset = THEME_PRESETS[resolveMode(mode)];
  const root = document.documentElement;
  Object.entries(preset).forEach(([key, value]) => root.style.setProperty(`--${key}`, value));
}

async function setTheme(mode) {
  const preset = THEME_PRESETS[resolveMode(mode)];
  const theme = { ...preset, radius: 16, popupWidth: 516 };
  await chrome.storage.local.set({ theme, themeMode: mode });
  applyTheme(mode);
}

// --- Language step ---

const languageSelect = document.getElementById("languageSelect");

function populateLanguages() {
  const options = (typeof FITSHIELD_LANGUAGE_OPTIONS !== "undefined") ? FITSHIELD_LANGUAGE_OPTIONS : [];
  const current = (typeof FitShieldI18n !== "undefined" && FitShieldI18n.getLanguage) ? FitShieldI18n.getLanguage() : "";

  languageSelect.replaceChildren();

  options.forEach((option) => {
    const el = document.createElement("option");
    el.value = option.value;
    const label = t(option.labelKey);
    const native = option.native || t(option.nativeKey);
    el.textContent = option.value === "" ? label : `${native} — ${label}`;
    if (option.value === current) {
      el.selected = true;
    }
    languageSelect.appendChild(el);
  });
}

languageSelect.addEventListener("change", async () => {
  if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.setLanguage) {
    await FitShieldI18n.setLanguage(languageSelect.value, { persist: true });
  }
});

// --- Theme step ---

const themeButtons = Array.from(document.querySelectorAll("[data-theme-mode]"));

function setActiveThemeButton(mode) {
  themeButtons.forEach((button) => button.classList.toggle("active", button.dataset.themeMode === mode));
}

async function loadThemeMode() {
  const { themeMode } = await chrome.storage.local.get(["themeMode"]);
  const mode = ["system", "light", "dark"].includes(themeMode) ? themeMode : "dark";
  setActiveThemeButton(mode);
  applyTheme(mode);
}

themeButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    setActiveThemeButton(button.dataset.themeMode);
    await setTheme(button.dataset.themeMode);
  });
});

// --- The three questions (steps 3, 4, 5) ---
//
// Onboarding asks the minimum needed to be useful on the first blocked page.
// Countries, categories, individual sites, the kitchen, and custom alternatives
// are all reachable from settings afterwards and are deliberately not asked
// about here.

const core = typeof FitShieldCore !== "undefined" ? FitShieldCore : null;

// Each answer is a plain settings write, so nothing here is a mode the user has
// to escape later.
const QUESTIONS = [
  {
    container: "interruptChoices",
    key: "interrupt",
    options: [
      { value: "both", labelKey: "onboardingInterruptBoth", settings: { deliverySitesEnabled: true, fastFoodSitesEnabled: true } },
      { value: "delivery", labelKey: "onboardingInterruptDelivery", settings: { deliverySitesEnabled: true, fastFoodSitesEnabled: false } },
      { value: "fastFood", labelKey: "onboardingInterruptFastFood", settings: { deliverySitesEnabled: false, fastFoodSitesEnabled: true } },
      { value: "manual", labelKey: "onboardingInterruptManual", settings: { deliverySitesEnabled: false, fastFoodSitesEnabled: false } }
    ]
  },
  {
    container: "whenChoices",
    key: "when",
    options: [
      { value: "always", labelKey: "schedulePresetAlways", preset: "always" },
      { value: "evenings", labelKey: "schedulePresetEvenings", preset: "evenings" },
      { value: "lateNight", labelKey: "schedulePresetLateNight", preset: "lateNight" },
      { value: "workdayLunch", labelKey: "schedulePresetWorkdayLunch", preset: "workdayLunch" }
    ]
  },
  {
    container: "frictionChoices",
    key: "friction",
    options: [
      { value: "light", labelKey: "frictionLight", friction: "light" },
      { value: "standard", labelKey: "frictionStandard", friction: "standard" },
      { value: "strict", labelKey: "frictionStrict", friction: "strict" }
    ]
  }
];

const answers = { interrupt: "both", when: "always", friction: "standard" };

function describeOption(option) {
  if (option.friction && core) {
    const values = core.FRICTION_PROFILES[option.friction];
    return t("frictionSummary", [String(values.timerSeconds), String(values.passDurationMinutes)]);
  }

  return "";
}

async function applyOption(question, option) {
  answers[question.key] = option.value;

  if (option.settings) {
    await chrome.storage.local.set(option.settings);
  }

  if (option.preset && core) {
    const schedule = core.schedulePresetValues(option.preset);
    const single = schedule.windows.length === 1 ? schedule.windows[0] : null;

    await chrome.storage.local.set({
      schedule,
      // Keep the three flat keys in step so the popup's simple controls agree.
      scheduleEnabled: schedule.mode === "windows",
      scheduleStart: single ? single.start : "18:00",
      scheduleEnd: single ? single.end : "23:00"
    });
  }

  if (option.friction && core) {
    await chrome.storage.local.set(core.frictionProfileValues(option.friction));
  }

  renderQuestions();
}

function renderQuestions() {
  QUESTIONS.forEach((question) => {
    const container = document.getElementById(question.container);

    if (!container) {
      return;
    }

    container.replaceChildren();

    question.options.forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-pressed", String(answers[question.key] === option.value));

      const label = document.createElement("span");
      label.textContent = t(option.labelKey);
      button.appendChild(label);

      const sub = describeOption(option);
      if (sub) {
        const subEl = document.createElement("span");
        subEl.className = "sub";
        subEl.textContent = sub;
        button.appendChild(subEl);
      }

      button.addEventListener("click", () => applyOption(question, option));
      container.appendChild(button);
    });
  });
}

// Reflect whatever is already stored (a re-run, or a restored backup) so the
// wizard never claims a choice the profile does not actually have.
async function loadAnswers() {
  const state = await chrome.storage.local.get([
    "deliverySitesEnabled",
    "fastFoodSitesEnabled",
    "schedule",
    "frictionProfile"
  ]);

  const delivery = state.deliverySitesEnabled !== false;
  const fastFood = state.fastFoodSitesEnabled !== false;
  answers.interrupt = delivery && fastFood ? "both" : delivery ? "delivery" : fastFood ? "fastFood" : "manual";

  if (core) {
    const schedule = core.normalizeSchedule(state.schedule);
    const match = core.SCHEDULE_PRESET_IDS.find((id) => {
      const preset = core.normalizeSchedule(core.schedulePresetValues(id));
      return preset.mode === schedule.mode && JSON.stringify(preset.windows) === JSON.stringify(schedule.windows);
    });
    answers.when = match || "always";
  }

  answers.friction = core && core.FRICTION_PROFILE_IDS.includes(state.frictionProfile)
    ? state.frictionProfile
    : "standard";

  renderQuestions();
}

// --- Preview (step 6) ---

const previewButton = document.getElementById("previewButton");

if (previewButton) {
  previewButton.addEventListener("click", () => {
    // The real block page against a real brand, with ?preview=1 so nothing is
    // recorded and no site is unblocked.
    const url = new URL(chrome.runtime.getURL("warning.html"));
    url.searchParams.set("site", "delivery-doordash-com");
    url.searchParams.set("preview", "1");
    window.open(url.toString(), "_blank", "noopener");
  });
}

// --- Import step ---

const importButton = document.getElementById("importButton");
const importInput = document.getElementById("importInput");
const importNotice = document.getElementById("importNotice");

importButton.addEventListener("click", () => importInput.click());

importInput.addEventListener("change", async () => {
  const file = importInput.files && importInput.files[0];

  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const count = await FitShieldBackup.importFromText(text);
    importNotice.textContent = t("importSuccessNotice", [String(count)]);
    // Reflect restored values in the wizard controls.
    populateLanguages();
    await loadThemeMode();
    await loadAnswers();
  } catch (error) {
    console.error("Failed to import settings:", error);
    importNotice.textContent = t("importErrorNotice");
  } finally {
    importInput.value = "";
  }
});

// --- Wizard navigation ---

const steps = Array.from(document.querySelectorAll(".step"));
const totalSteps = steps.length;
const dots = document.getElementById("dots");
const backButton = document.getElementById("back");
const nextButton = document.getElementById("next");
const stepLabel = document.getElementById("stepLabel");
let currentStep = 1;

steps.forEach(() => {
  const dot = document.createElement("div");
  dot.className = "dot";
  dots.appendChild(dot);
});
const dotEls = Array.from(dots.children);

function render() {
  steps.forEach((step) => step.classList.toggle("active", Number(step.dataset.step) === currentStep));
  dotEls.forEach((dot, index) => dot.classList.toggle("active", index < currentStep));
  backButton.disabled = currentStep === 1;
  nextButton.textContent = currentStep === totalSteps ? t("welcomeFinish") : t("welcomeNext");
  stepLabel.textContent = t("welcomeStepLabel", [String(currentStep), String(totalSteps)]);
}

// Re-render the dynamic strings and re-translate the language list when the
// language changes mid-onboarding (the static data-i18n text is handled by
// i18n.js itself).
if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.onChange) {
  FitShieldI18n.onChange(() => {
    populateLanguages();
    renderQuestions();
    render();
  });
}

backButton.addEventListener("click", () => {
  if (currentStep > 1) {
    currentStep -= 1;
    render();
  }
});

nextButton.addEventListener("click", () => {
  if (currentStep < totalSteps) {
    currentStep += 1;
    render();
  } else {
    window.location.href = chrome.runtime.getURL("settings.html");
  }
});

const i18nReady = (typeof FitShieldI18n !== "undefined" && FitShieldI18n.ready)
  ? FitShieldI18n.ready
  : Promise.resolve();

async function init() {
  await i18nReady;
  await loadThemeMode();
  populateLanguages();
  await loadAnswers();
  render();
}

init();
