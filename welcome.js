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

// --- Blocking toggles (steps 3 & 4) ---

const fastFoodToggle = document.getElementById("fastFoodToggle");
const deliveryToggle = document.getElementById("deliveryToggle");

async function loadToggles() {
  const state = await chrome.storage.local.get(["fastFoodSitesEnabled", "deliverySitesEnabled"]);
  fastFoodToggle.checked = state.fastFoodSitesEnabled ?? true;
  deliveryToggle.checked = state.deliverySitesEnabled ?? true;
}

fastFoodToggle.addEventListener("change", () => {
  chrome.storage.local.set({ fastFoodSitesEnabled: fastFoodToggle.checked });
});

deliveryToggle.addEventListener("change", () => {
  chrome.storage.local.set({ deliverySitesEnabled: deliveryToggle.checked });
});

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
    await loadToggles();
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
  nextButton.textContent = currentStep === totalSteps ? "Finish" : "Next";
  stepLabel.textContent = `Step ${currentStep} of ${totalSteps}`;
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
  await loadToggles();
  render();
}

init();
