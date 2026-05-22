const DEFAULT_THEME = {
  bg: "#0f141b",
  panel: "#1a212b",
  border: "#2c3644",
  text: "#edf2f7",
  muted: "#a9b4c2",
  accent: "#7ef0a8",
  danger: "#ff8b8b",
  radius: 24,
  popupWidth: 468
};

const bgColorInput = document.getElementById("bgColor");
const panelColorInput = document.getElementById("panelColor");
const borderColorInput = document.getElementById("borderColor");
const textColorInput = document.getElementById("textColor");
const mutedColorInput = document.getElementById("mutedColor");
const accentColorInput = document.getElementById("accentColor");
const dangerColorInput = document.getElementById("dangerColor");
const radiusRange = document.getElementById("radiusRange");
const radiusValue = document.getElementById("radiusValue");
const popupWidthRange = document.getElementById("popupWidthRange");
const popupWidthValue = document.getElementById("popupWidthValue");
const resetThemeButton = document.getElementById("resetTheme");
const openTestingButton = document.getElementById("openTesting");

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
  root.style.setProperty("--danger", mergedTheme.danger);
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
    danger: dangerColorInput.value,
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
  dangerColorInput.value = theme.danger;
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

[bgColorInput, panelColorInput, borderColorInput, textColorInput, mutedColorInput, accentColorInput, dangerColorInput].forEach((input) => {
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

openTestingButton.addEventListener("click", () => {
  window.open(chrome.runtime.getURL("testing.html"), "_blank");
});

loadTheme();
