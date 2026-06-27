const DEFAULT_TIMER_SECONDS = 60;
const DEFAULT_PASS_DURATION_MINUTES = 5;

// Localization helper (i18n.js loads first). Falls back to the key so missing
// strings stay visible rather than blank.
const t = (key, subs) =>
  (typeof FitShieldI18n !== "undefined" ? FitShieldI18n.t(key, subs) : key);

function minuteUnit(value) {
  return t(value === 1 ? "unitMinute" : "unitMinutes");
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// Map a blocklist rule type to a friendly, localized label.
function blockTypeLabel(type) {
  switch (type) {
    case "delivery":
      return t("blockTypeDelivery");
    case "fast_food":
      return t("blockTypeFastFood");
    case "custom":
      return t("blockTypeCustom");
    default:
      return "";
  }
}

// Build the "Active in" country string from ISO codes. Shows the first few codes
// and a "+N more" suffix so long lists stay compact.
function formatCountryList(codes) {
  const list = (Array.isArray(codes) ? codes : [])
    .map((code) => String(code || "").trim().toUpperCase())
    .filter(Boolean);

  if (list.length === 0) {
    return "";
  }

  const MAX = 6;

  if (list.length <= MAX) {
    return list.join(", ");
  }

  return `${list.slice(0, MAX).join(", ")} ${t("blockReasonMoreCountries", [String(list.length - MAX)])}`;
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
const blockReasonEl = document.getElementById("blockReason");
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
let blockInfo = null;
let selectedRecipes = null;

// Recipe-choice state. A user can pick one suggested recipe per block as the
// "I'll make this instead" alternative; that records the local calories-avoided
// stat once and locks both buttons for this page view.
let recipeChosen = false;
let chosenRecipeDiet = null;

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

// Append one label/value row to the "why you're seeing this" panel.
function appendReasonRow(container, label, value) {
  if (!value) {
    return;
  }

  const row = document.createElement("div");
  row.className = "block-reason-row";

  const labelEl = document.createElement("span");
  labelEl.className = "block-reason-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "block-reason-value";
  valueEl.textContent = value;

  row.append(labelEl, valueEl);
  container.appendChild(row);
}

// Explain exactly why the site was blocked, using the JSON blocklist metadata
// resolved by the background service worker: domain, rule type, food category,
// and the countries the brand is active in. Hidden until that metadata loads.
function renderBlockReason() {
  if (!blockReasonEl) {
    return;
  }

  blockReasonEl.replaceChildren();

  if (!blockInfo || !blockInfo.found) {
    blockReasonEl.hidden = true;
    return;
  }

  const heading = document.createElement("div");
  heading.className = "block-reason-heading";
  heading.textContent = t("blockReasonHeading");
  blockReasonEl.appendChild(heading);

  const domain = blockInfo.domain || blockInfo.apex || "";
  const typeLabel = blockTypeLabel(blockInfo.type);
  const category = blockInfo.category && blockInfo.category !== blockInfo.type && blockInfo.category !== "custom"
    ? capitalize(blockInfo.category)
    : "";
  const countries = formatCountryList(blockInfo.countries);

  appendReasonRow(blockReasonEl, t("blockReasonDomain"), domain);
  appendReasonRow(blockReasonEl, t("blockReasonType"), typeLabel);
  appendReasonRow(blockReasonEl, t("blockReasonCategory"), category);
  appendReasonRow(blockReasonEl, t("blockReasonCountries"), countries);

  blockReasonEl.hidden = blockReasonEl.childElementCount <= 1;
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

  renderBlockReason();
  renderChoiceNote();

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

// Render one recipe into its column (.shell). Labels localize; recipe content
// is from the local catalog (English for now). Hides the column if there is no
// recipe to show.
function renderRecipeInto(col, recipe, diet) {
  if (!col) {
    return;
  }

  col.replaceChildren();

  if (!recipe) {
    col.hidden = true;
    return;
  }

  const badge = document.createElement("span");
  badge.className = `recipe-badge ${diet}`;
  badge.textContent = t(diet === "vegetarian" ? "recipeVegetarianLabel" : "recipeMeatLabel");

  const name = document.createElement("div");
  name.className = "recipe-name";
  name.textContent = recipe.title;

  const meta = document.createElement("div");
  meta.className = "recipe-meta";
  const metaParts = [t("recipeTimeLabel", [String(recipe.timeMinutes)])];
  if (Number.isFinite(Number(recipe.calories))) {
    metaParts.push(t("recipeCaloriesLabel", [String(recipe.calories)]));
  }
  meta.textContent = metaParts.join(" · ");

  const desc = document.createElement("p");
  desc.className = "recipe-desc";
  desc.textContent = recipe.description;

  const ingredients = document.createElement("div");
  ingredients.className = "recipe-ingredients";
  const ingredientsLabel = document.createElement("b");
  ingredientsLabel.textContent = `${t("recipeIngredientsLabel")}: `;
  ingredients.append(ingredientsLabel, document.createTextNode((recipe.ingredients || []).join(", ")));

  col.append(badge, name, meta, desc, ingredients);

  // Steps are shown in full (no collapse); the list scrolls inside the card when
  // a recipe is long.
  if (Array.isArray(recipe.steps) && recipe.steps.length > 0) {
    const steps = document.createElement("div");
    steps.className = "recipe-steps";

    const stepsTitle = document.createElement("div");
    stepsTitle.className = "recipe-steps-title";
    stepsTitle.textContent = t("recipeStepsLabel");

    const list = document.createElement("ol");
    list.className = "recipe-steps-list";
    recipe.steps.forEach((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      list.appendChild(item);
    });

    steps.append(stepsTitle, list);
    col.appendChild(steps);
  }

  // "I'll make this instead" — a compact button that logs the local
  // calories-avoided stat once. The chosen card's button turns into the success
  // state; the card content stays visible.
  const chooseButton = document.createElement("button");
  chooseButton.type = "button";
  chooseButton.className = "recipe-choose";
  const isChosenOne = recipeChosen && chosenRecipeDiet === diet;
  chooseButton.classList.toggle("chosen", isChosenOne);
  chooseButton.textContent = isChosenOne ? t("recipeChosenButton") : t("recipeChooseButton");
  chooseButton.disabled = recipeChosen;
  chooseButton.setAttribute("aria-label", `${t("recipeChooseButton")}: ${recipe.title}`);
  chooseButton.addEventListener("click", () => chooseRecipe(recipe, diet));
  col.appendChild(chooseButton);

  col.hidden = false;
}

// Show or hide the "logged in your stats" confirmation under the block card.
function renderChoiceNote() {
  const noteEl = document.getElementById("recipeChoiceNote");

  if (!noteEl) {
    return;
  }

  noteEl.textContent = t("recipeChoiceNote");
  noteEl.hidden = !recipeChosen;
}

// Record the chosen recipe's calories with the background (single source of
// truth), then re-render so both buttons lock and the note appears. Guarded so
// it only counts once per block view.
async function chooseRecipe(recipe, diet) {
  if (recipeChosen) {
    return;
  }

  recipeChosen = true;
  chosenRecipeDiet = diet;

  const recipeCalories = Number.isFinite(Number(recipe?.calories)) ? Number(recipe.calories) : null;

  try {
    await chrome.runtime.sendMessage({ type: "recordRecipeChoice", recipeCalories });
  } catch (error) {
    console.error("Failed to record recipe choice:", error);
  }

  renderRecipes();
  renderChoiceNote();
}

// Render the vegetarian (middle) and meat (right) columns. Safe to call
// repeatedly (e.g. on language change) because it rebuilds from the
// already-selected recipes.
function renderRecipes() {
  if (!selectedRecipes) {
    return;
  }

  renderRecipeInto(document.getElementById("recipeVeg"), selectedRecipes.vegetarian, "vegetarian");
  renderRecipeInto(document.getElementById("recipeMeat"), selectedRecipes.meat, "meat");
}

async function setupRecipes() {
  if (typeof FitShieldRecipes === "undefined") {
    return;
  }

  try {
    const recipes = await FitShieldRecipes.loadRecipes();
    selectedRecipes = FitShieldRecipes.selectRecipes(blockInfo || { key: siteKey }, recipes);
    renderRecipes();
  } catch (error) {
    console.error("Failed to load recipe suggestions:", error);
  }
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
      blockInfo = info;
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

  // Count this block for the local "estimated savings" stat. Fire-and-forget;
  // the only thing recorded is a single integer counter (no URL or history).
  chrome.runtime.sendMessage({ type: "recordBlockedVisit" }).catch(() => {});

  // Recipe suggestions are non-blocking; the timer runs regardless.
  setupRecipes();
}

// Re-render JS-managed strings (and recipe card labels) when the language
// changes mid-screen.
if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.onChange) {
  FitShieldI18n.onChange(() => {
    renderDynamicText();
    renderRecipes();
  });
}

// Wait until the stored UI language is applied so the screen does not flash the
// browser default, then start the countdown.
const i18nReady = (typeof FitShieldI18n !== "undefined" && FitShieldI18n.ready)
  ? FitShieldI18n.ready
  : Promise.resolve();

i18nReady.then(initializeTimer);
