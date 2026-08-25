/**
 * FitShield block page.
 *
 * The whole product narrows to this screen, so it answers exactly four things
 * and nothing else:
 *
 *   1. why this page was interrupted,
 *   2. how much of the pause is left,
 *   3. one thing you could make instead — with a way to see another,
 *   4. the three ways out: leave, choose the alternative, or continue on purpose.
 *
 * Every string that comes from data (a brand name, a recipe title, an ingredient
 * the user typed themselves) is written with textContent or a text node. Nothing
 * on this page is ever assigned to innerHTML, so no catalog entry, blocklist
 * label, or user-authored alternative can introduce markup.
 */

const t = (key, subs) => (typeof FitShieldI18n !== "undefined" ? FitShieldI18n.t(key, subs) : key);

// A category id and a country code are internal identifiers. Settings prints
// display names for them; this page used to print the identifiers themselves, so
// the same block read "Fast_casual · US, HK" here and "Fast Casual · United
// States, Hong Kong" in the record of it. Both pages now resolve through the one
// implementation in i18n.js — see the "Display names" block there.
const categoryDisplayName = (category) =>
  typeof FitShieldI18n !== "undefined" && FitShieldI18n.categoryName
    ? FitShieldI18n.categoryName(category)
    : String(category || "");

const countryDisplayName = (code) =>
  typeof FitShieldI18n !== "undefined" && FitShieldI18n.countryName
    ? FitShieldI18n.countryName(code)
    : String(code || "");

const params = new URLSearchParams(window.location.search);
const siteKey = params.get("site") || "";
// Preview mode is opt-in through the settings page and is loudly labelled; it
// runs the identical flow but records nothing.
const isPreview = params.get("preview") === "1";

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

const el = (id) => document.getElementById(id);

const ui = {
  brand: el("brand"),
  ring: el("ring"),
  timer: el("timer"),
  timerUnit: el("timerUnit"),
  timerAnnounce: el("timerAnnounce"),
  hint: el("hint"),
  repeatNote: el("repeatNote"),
  back: el("back"),
  continue: el("continue"),
  reasonPanel: el("reasonPanel"),
  reasonBody: el("reasonBody"),
  previewBanner: el("previewBanner"),
  intentPanel: el("intentPanel"),
  intentOptions: el("intentOptions"),
  intentSkip: el("intentSkip"),
  altPanel: el("altPanel"),
  altTitle: el("altTitle"),
  altKind: el("altKind"),
  altMeta: el("altMeta"),
  altWhy: el("altWhy"),
  altDesc: el("altDesc"),
  altIngredients: el("altIngredients"),
  altSteps: el("altSteps"),
  altNote: el("altNote"),
  chooseAlt: el("chooseAlt"),
  anotherAlt: el("anotherAlt"),
  favAlt: el("favAlt"),
  filters: el("filters"),
  chosenNote: el("chosenNote"),
  altAnnounce: el("altAnnounce"),
  passPanel: el("passPanel"),
  passOptions: el("passOptions"),
  passNote: el("passNote"),
  passCancel: el("passCancel")
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  context: null,
  info: null,
  preferences: {},
  secondsLeft: 60,
  totalSeconds: 60,
  unlocked: false,
  rotation: 0,
  filter: "all",
  intent: null,
  current: null,
  // The id last recorded as *seen*. Rendering is not seeing: an alternative
  // prepared behind the intent prompt, or re-rendered after a language change,
  // must not count.
  recordedId: null,
  // Entries already chosen during THIS interruption, so the same dish cannot be
  // counted twice by rotating away and back.
  chosenIds: [],
  chosen: false,
  favorites: []
};

const prefersReducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

// Fire-and-forget recording. The block page must render and count down even if
// the worker is slow to wake, so nothing here is awaited on the render path.
function send(type, payload) {
  return chrome.runtime.sendMessage({ type, preview: isPreview, ...payload }).catch((error) => {
    console.error(`FitShield: "${type}" failed`, error);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const prefersLightOS = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);

// Is the palette we are about to paint a light one? Asked of the resulting
// colour rather than of the mode, so a hand-picked light palette answers "yes"
// as readily as the shipped preset does. Anything unparseable answers "dark",
// which is what this page has always defaulted to.
function isLightColor(value) {
  const text = String(value || "").trim();
  let rgb = null;

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    rgb = [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16));
  } else {
    const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
    if (fn) {
      const parts = fn[1].split(",").map((n) => Number.parseFloat(n));
      if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
        rgb = parts.slice(0, 3);
      }
    }
  }

  if (!rgb) {
    return false;
  }

  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.5;
}

/**
 * Which palette this page should paint.
 *
 * The stored `theme` is not enough on its own. With Theme = System, the popup
 * and the settings page re-resolve the preset against the OS at every load
 * (`shouldUseResolvedPreset` → `THEME_MODE_PRESETS[resolveThemeMode(...)]`) and
 * neither of them writes the result back. So the first time the OS flips
 * light↔dark after that choice, the stored `theme` is a whole theme out of date
 * — and this page, which read only `theme`, rendered fully dark while the popup
 * beside it rendered fully light. Same profile, same session, opposite themes,
 * on the one screen the product is actually about.
 *
 * Reading `themeMode` as well and re-resolving here is the same decision the
 * other surfaces make, from the same shared helpers, so the pages cannot
 * disagree. A hand-picked palette is still honoured untouched:
 * `shouldUseResolvedPreset` is false the moment the stored colours stop matching
 * either preset.
 *
 * `accentDim` is re-derived rather than carried over, because it is a function
 * of the accent (settings.js: `hexToRgba(accent, 0.22)`); keeping the stored one
 * would ring a light-theme page with the DARK theme's mint hairlines.
 */
function resolvePalette(theme, themeMode) {
  const core = typeof FitShieldCore !== "undefined" ? FitShieldCore : null;

  if (!core || !core.shouldUseResolvedPreset || !core.shouldUseResolvedPreset(theme, themeMode)) {
    return { theme, light: isLightColor(theme && theme.bg ? theme.bg : DEFAULT_THEME.bg) };
  }

  const preset = core.THEME_MODE_PRESETS[core.resolveThemeMode(themeMode, prefersLightOS())];
  const resolved = { ...(theme || {}), ...preset };

  if (core.hexToRgba) {
    resolved.accentDim = core.hexToRgba(preset.accent, 0.22);
  }

  return { theme: resolved, light: isLightColor(preset.bg) };
}

function applyTheme(theme, options) {
  const merged = { ...DEFAULT_THEME, ...(theme || {}) };
  const root = document.documentElement;

  root.style.setProperty("--bg", merged.bg);
  root.style.setProperty("--panel", merged.panel);
  root.style.setProperty("--border", merged.border);
  root.style.setProperty("--text", merged.text);
  root.style.setProperty("--muted", merged.muted);
  root.style.setProperty("--accent", merged.accent);
  root.style.setProperty("--accent-dim", merged.accentDim);
  root.style.setProperty("--panel-radius", `${merged.radius}px`);

  // Scrollbars, form-control chrome and the pre-paint canvas come from the UA,
  // not from these variables, so a light palette under `color-scheme: dark`
  // still got a dark scrollbar and a dark flash before first paint.
  root.style.colorScheme = options && options.light ? "light" : "dark";
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

// A screen reader must not be told the number every second. Milestones only.
const ANNOUNCE_AT = new Set([60, 30, 10, 5, 0]);

function renderTimer() {
  ui.timer.textContent = String(state.secondsLeft);
  ui.timerUnit.textContent = t(state.secondsLeft === 1 ? "unitSecond" : "unitSeconds");

  if (ANNOUNCE_AT.has(state.secondsLeft)) {
    ui.timerAnnounce.textContent =
      state.secondsLeft === 0
        ? t("timerDoneAnnounce")
        : t("timerRemainingAnnounce", [String(state.secondsLeft)]);
  }

  if (prefersReducedMotion) {
    return;
  }

  const progress = (state.totalSeconds - state.secondsLeft) / state.totalSeconds;
  ui.ring.style.transform = `scale(${1 + progress * 0.06})`;
  ui.ring.style.boxShadow = `0 0 ${20 + progress * 22}px rgba(126, 240, 168, 0.2)`;
}

let timerInterval = null;

function startTimer() {
  if (state.secondsLeft <= 0) {
    unlock();
    return;
  }

  timerInterval = window.setInterval(() => {
    state.secondsLeft -= 1;

    if (state.secondsLeft <= 0) {
      state.secondsLeft = 0;
      window.clearInterval(timerInterval);
      unlock();
    }

    renderTimer();
  }, 1000);
}

function unlock() {
  state.unlocked = true;
  ui.continue.disabled = false;
  ui.continue.classList.add("ready");
  renderStaticText();
}

// ---------------------------------------------------------------------------
// Why this was interrupted
// ---------------------------------------------------------------------------

// "fastfood" and "fast_food" are one word spelled two ways. The worker's rule
// catalog labels a brand with its BUCKET ("delivery", "fastfood", "custom")
// rather than its curated category, and that bucket is not always spelled the
// way the type is — so the exact comparison this guard used to make let the
// fast-food bucket through, and the panel printed a Category row that only
// restated the Rule row above it, as an identifier: "Rule: Fast food /
// Category: Fastfood". A row that adds nothing does not belong on a screen whose
// whole job is to answer four questions.
function sameWord(a, b) {
  const strip = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return strip(a) === strip(b);
}

// Matched through sameWord rather than by exact string, for the same reason the
// category guard is: "fast_food" and "fastfood" are one word spelled two ways,
// and the two records this page can be handed spell it differently. The branded
// record carries the dataset's `fast_food`; the rule catalog's fallback record
// carries the DNR bucket `fastfood`, and an exact switch answered "" for it —
// so the fallback path rendered a Site row, a Category row, a country list, and
// no Rule at all. Every arm below is an existing string; nothing new is
// invented for an id this page does not recognise, which is what keeps a raw
// underscored identifier off the screen.
const BLOCK_TYPE_LABELS = [
  { type: "delivery", key: "blockTypeDelivery" },
  { type: "fast_food", key: "blockTypeFastFood" },
  { type: "custom", key: "blockTypeCustom" }
];

function blockTypeLabel(type) {
  const match = BLOCK_TYPE_LABELS.find((entry) => sameWord(entry.type, type));
  return match ? t(match.key) : "";
}

function formatCountryList(codes) {
  const list = (Array.isArray(codes) ? codes : [])
    .map((code) => countryDisplayName(code))
    .filter(Boolean);

  if (list.length === 0) {
    return "";
  }

  const MAX = 6;
  return list.length <= MAX
    ? list.join(", ")
    : `${list.slice(0, MAX).join(", ")} ${t("blockReasonMoreCountries", [String(list.length - MAX)])}`;
}

function appendReasonRow(label, value) {
  if (!value) {
    return;
  }

  // A list item, not a div: #reasonBody is a list. Two sibling spans reach a
  // screen reader as two unrelated announcements, because the only thing pairing
  // "Site" with "doordash.com" is the two-column layout, and layout is not in
  // the accessibility tree. One node around both is what makes the row a
  // statement rather than a fragment.
  const row = document.createElement("li");
  row.className = "reason-row";

  const labelEl = document.createElement("span");
  labelEl.className = "reason-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "reason-value";
  // A brand label, a domain and a country list all arrive from data, and a
  // right-to-left one dropped into a left-to-right row lets the bidi algorithm
  // pull the row's neutral characters (the separating commas, the "+7 more")
  // to the wrong end. `dir="auto"` makes each value its own isolated run, so a
  // value can only ever reorder itself.
  valueEl.dir = "auto";
  valueEl.textContent = value;

  row.append(labelEl, valueEl);
  ui.reasonBody.appendChild(row);
}

function renderReason() {
  ui.reasonBody.replaceChildren();

  const info = state.info;

  if (!info) {
    ui.reasonPanel.hidden = true;
    return;
  }

  const category =
    info.category && !sameWord(info.category, info.type) && info.category !== "custom"
      ? categoryDisplayName(info.category)
      : "";

  appendReasonRow(t("blockReasonDomain"), info.domain || "");
  appendReasonRow(t("blockReasonType"), blockTypeLabel(info.type));
  appendReasonRow(t("blockReasonCategory"), category);
  appendReasonRow(t("blockReasonCountries"), formatCountryList(info.countries));

  ui.reasonPanel.hidden = ui.reasonBody.childElementCount === 0;
}

// ---------------------------------------------------------------------------
// Static / stateful copy
// ---------------------------------------------------------------------------

function minuteUnit(value) {
  return t(value === 1 ? "unitMinute" : "unitMinutes");
}

function renderStaticText() {
  if (state.info && state.info.label) {
    ui.brand.replaceChildren();
    const strong = document.createElement("strong");
    // Isolated for the same reason as a reason-value: the sentence ends in a
    // full stop supplied below, and an unisolated right-to-left brand name lets
    // that neutral stop be reordered into the middle of the line.
    strong.dir = "auto";
    strong.textContent = state.info.label;
    // The sentence ends after the brand. Without the stop the line read
    // "You opened DoorDash" between two properly punctuated sentences — and it
    // has to be a text node rather than part of the message, because the brand
    // name is emphasised and the label comes from the blocklist, not from copy.
    ui.brand.append(document.createTextNode(`${t("warningTriggeredByPrefix")} `), strong, document.createTextNode(t("warningSentenceEnd")));
    ui.brand.hidden = false;
  } else {
    ui.brand.hidden = true;
  }

  ui.hint.textContent = state.unlocked ? t("warningUnlockedHint") : t("warningLockedHint");
  ui.continue.textContent = state.unlocked ? t("warningContinueButton") : t("warningLockedButton");

  if (isPreview) {
    ui.previewBanner.textContent = t("previewBanner");
    ui.previewBanner.hidden = false;
  }

  renderReason();
}

function renderRepeatNote() {
  const repeat = state.context && state.context.repeat;

  if (!repeat || !repeat.repeat) {
    ui.repeatNote.hidden = true;
    return;
  }

  ui.repeatNote.textContent = t("repeatFrictionNote", [
    String(repeat.extraSeconds),
    String(repeat.windowMinutes)
  ]);
  ui.repeatNote.hidden = false;
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

// The answer shapes THIS screen only. It is held in a local variable and is
// never written to storage, so nothing about why someone opened a page is kept.
const INTENTS = [
  { id: "hungry", labelKey: "intentHungry" },
  { id: "specific", labelKey: "intentSpecific" },
  { id: "browsing", labelKey: "intentBrowsing" },
  { id: "legitimate", labelKey: "intentLegitimate" },
  { id: "someone-else", labelKey: "intentSomeoneElse" }
];

function renderIntentOptions() {
  ui.intentOptions.replaceChildren();

  INTENTS.forEach((intent) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t(intent.labelKey);
    button.addEventListener("click", () => applyIntent(intent.id));
    ui.intentOptions.appendChild(button);
  });
}

function applyIntent(intentId) {
  state.intent = intentId;
  ui.intentPanel.hidden = true;

  if (intentId === "legitimate" || intentId === "someone-else") {
    // A real order is a legitimate reason to be here. Offer the scoped pass
    // straight away rather than making the user sit out a countdown for
    // something FitShield was never meant to prevent.
    showPassChooser();
    return;
  }

  if (intentId === "browsing") {
    // Nothing here should make food more appealing to someone who is not
    // actually hungry, so the alternative is collapsed and leaving is the focus.
    ui.altPanel.hidden = true;
    ui.altAnnounce.textContent = t("intentBrowsingAnnounce");
    ui.back.focus();
    return;
  }

  state.rotation = 0;
  state.filter = intentId === "hungry" ? "fastest" : "all";
  renderFilters();
  // Reveals and counts the view: this is the first moment the card is on screen.
  showAlternative({});
}

// ---------------------------------------------------------------------------
// Alternatives
// ---------------------------------------------------------------------------

const FILTERS = [
  { id: "all", labelKey: "filterClosest" },
  { id: "fastest", labelKey: "filterFastest" },
  { id: "no-cook", labelKey: "filterNoCook" },
  { id: "microwave", labelKey: "filterMicrowave" }
];

function renderFilters() {
  ui.filters.replaceChildren();

  FILTERS.forEach((filter) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t(filter.labelKey);
    button.setAttribute("aria-pressed", String(state.filter === filter.id));
    button.addEventListener("click", () => {
      state.filter = state.filter === filter.id ? "all" : filter.id;
      state.rotation = 0;
      renderFilters();
      showAlternative({});
    });
    ui.filters.appendChild(button);
  });
}

function formatTime(minutes) {
  const value = Number(minutes) || 0;

  if (value < 60) {
    return t("timeMinutes", [String(value)]);
  }

  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest === 0 ? t("timeHours", [String(hours)]) : t("timeHoursMinutes", [String(hours), String(rest)]);
}

// "piece" is a bare counter, not a measure — it exists in the data so every
// ingredient has a unit, but printing it gives "2 piece naan breads". It is
// dropped on the way to the screen.
const FILLER_UNIT = "piece";

// Countable units read naturally with "of" and need pluralising: "2 cloves of
// garlic", "1 pinch of salt". Measures (tbsp, cup, g, ml) do not: "2 tbsp oil".
const COUNTABLE_UNITS = {
  slice: "slices",
  clove: "cloves",
  leaf: "leaves",
  pinch: "pinches",
  pouch: "pouches",
  packet: "packets",
  scoop: "scoops"
};

function formatIngredient(ingredient) {
  if (!ingredient || typeof ingredient !== "object") {
    return String(ingredient || "");
  }

  const item = String(ingredient.item || "");
  const quantity = Number(ingredient.quantity);
  const unit = String(ingredient.unit || "");
  let text = item;

  if (Number.isFinite(quantity) && unit) {
    if (unit === FILLER_UNIT) {
      text = `${quantity} ${item}`;
    } else if (COUNTABLE_UNITS[unit]) {
      const word = quantity === 1 ? unit : COUNTABLE_UNITS[unit];
      text = `${quantity} ${word} of ${item}`;
    } else {
      text = `${quantity} ${unit} ${item}`;
    }
  }

  if (ingredient.note) {
    text += ` (${ingredient.note})`;
  }

  return text;
}

function addChip(container, text, strong) {
  if (!text) {
    return;
  }

  const chip = document.createElement("span");
  chip.className = strong ? "chip strong" : "chip";
  chip.textContent = text;
  container.appendChild(chip);
}

function reasonText(reasons, relaxed) {
  const parts = [];

  (reasons || []).forEach((reason) => {
    if (reason.key === "craving" && reason.value) {
      parts.push(t("whyCraving", [reason.value.replace(/-/g, " ")]));
    } else if (reason.key === "pantry") {
      parts.push(reason.value === "1" ? t("whyPantryOne") : t("whyPantry", [reason.value]));
    } else if (reason.key === "favorite") {
      parts.push(t("whyFavorite"));
    } else if (reason.key === "custom") {
      parts.push(t("whyCustom"));
    }
  });

  // If a constraint had to be dropped, say so plainly rather than quietly
  // showing something that does not meet what was asked for.
  const RELAXED_LABELS = {
    equipment: "relaxedEquipment",
    time: "relaxedTime",
    fastest: "relaxedFastest",
    "no-cook": "relaxedNoCook",
    microwave: "relaxedMicrowave"
  };

  (relaxed || []).forEach((constraint) => {
    const key = RELAXED_LABELS[constraint];

    if (key) {
      parts.push(t(key));
    }
  });

  return parts.join(" · ");
}

function renderAlternative(entry, reasons, relaxed, position) {
  ui.altTitle.textContent = entry.title || "";
  ui.altKind.textContent = t(entry.kind === "quick" ? "kindQuick" : entry.kind === "custom" ? "kindCustom" : "kindRecipe");

  ui.altMeta.replaceChildren();
  addChip(ui.altMeta, formatTime(entry.totalMinutes), true);

  if (Number(entry.activeMinutes) && Number(entry.activeMinutes) < Number(entry.totalMinutes)) {
    addChip(ui.altMeta, t("activeEffort", [String(entry.activeMinutes)]));
  }

  if (entry.servings) {
    addChip(ui.altMeta, t("servings", [String(entry.servings)]));
  }

  if (entry.diet && entry.diet !== "omnivore") {
    addChip(ui.altMeta, t(`diet_${entry.diet}`));
  }

  (Array.isArray(entry.equipment) ? entry.equipment : []).forEach((item) => addChip(ui.altMeta, item));

  if (Array.isArray(entry.allergens) && entry.allergens.length > 0) {
    addChip(ui.altMeta, t("containsAllergens", [entry.allergens.join(", ")]));
  }

  const why = reasonText(reasons, relaxed);
  ui.altWhy.textContent = why;
  ui.altWhy.hidden = !why;

  ui.altDesc.textContent = entry.description || "";

  ui.altIngredients.replaceChildren();
  (Array.isArray(entry.ingredients) ? entry.ingredients : []).forEach((ingredient) => {
    const item = document.createElement("li");
    item.textContent = formatIngredient(ingredient);

    if (ingredient && ingredient.optional) {
      item.className = "optional";
      item.append(document.createTextNode(` — ${t("optionalIngredient")}`));
    }

    ui.altIngredients.appendChild(item);
  });

  ui.altSteps.replaceChildren();
  (Array.isArray(entry.steps) ? entry.steps : []).forEach((step) => {
    const item = document.createElement("li");
    item.textContent = step;
    ui.altSteps.appendChild(item);
  });

  const notes = [];
  if (entry.storage) {
    notes.push(entry.storage);
  }
  if (Array.isArray(entry.substitutions) && entry.substitutions.length > 0) {
    notes.push(
      `${t("substitutionsLabel")}: ` +
        entry.substitutions.map((swap) => `${swap.for} → ${swap.use}`).join("; ")
    );
  }
  ui.altNote.textContent = notes.join(" ");

  const isFavorite = state.favorites.includes(entry.id);
  ui.favAlt.setAttribute("aria-pressed", String(isFavorite));

  ui.chooseAlt.textContent = state.chosen ? t("alternativeChosenButton") : t("alternativeChooseButton");
  ui.chooseAlt.disabled = state.chosen;

  // Spoken, not abbreviated: "12 minutes", not "12 min". The unit comes from the
  // shared singular/plural pair so a one-minute entry — which a user can author
  // themselves — is not announced as "1 minutes".
  const spokenMinutes = Number(entry.totalMinutes) || 0;

  ui.altAnnounce.textContent = t("alternativeAnnounce", [
    entry.title || "",
    `${spokenMinutes} ${minuteUnit(spokenMinutes)}`,
    String(position.index + 1),
    String(position.count)
  ]);
}

/**
 * Count an alternative as viewed — but only once it is genuinely on screen.
 *
 * This is not bookkeeping pedantry. `recordAlternativeShown` does two things:
 * it increments `alternativesViewed`, and it pushes the id into the recently-
 * shown rotation. Recording something the user never saw therefore inflates a
 * statistic the product promises is an observed event, *and* penalises that
 * entry the next time they are interrupted — suppressing a suggestion that was
 * never made.
 */
function recordShown(entry) {
  if (!entry || state.recordedId === entry.id) {
    return;
  }

  state.recordedId = entry.id;
  send("recordAlternativeShown", { id: entry.id });
}

// Uncover an alternative that was prepared while something else was on top of
// it (the intent prompt). Only now has it actually been shown.
function revealAlternative() {
  if (!state.current) {
    return;
  }

  ui.altPanel.hidden = false;
  recordShown(state.current);
}

/**
 * Render the current alternative.
 *
 * `opts.silent` renders it without revealing or counting it — used to have the
 * card ready behind the intent prompt so revealing it costs no round trip.
 * `opts.focus` moves focus to the new title, for "show another".
 */
function showAlternative(options) {
  const opts = options || {};

  if (typeof FitShieldRecipes === "undefined") {
    return;
  }

  const selection = FitShieldRecipes.selectAlternative(state.info || { key: siteKey }, state.preferences, {
    filter: state.filter,
    rotation: state.rotation,
    intent: state.intent,
    seed: siteKey
  });

  if (!selection.entry) {
    ui.altPanel.hidden = true;
    ui.altAnnounce.textContent = t("noAlternativeFound");
    return;
  }

  state.current = selection.entry;
  // "Chosen" is per ENTRY, not per render. Resetting it unconditionally meant
  // choosing an alternative, rotating away, rotating back and choosing again
  // counted "alternatives you chose" twice for the same dish in a single
  // interruption.
  state.chosen = state.chosenIds.includes(selection.entry.id);
  ui.chosenNote.hidden = true;

  renderAlternative(selection.entry, selection.reasons, selection.relaxed, selection);

  if (opts.silent) {
    return;
  }

  ui.altPanel.hidden = false;
  recordShown(selection.entry);

  if (opts.focus) {
    ui.altTitle.setAttribute("tabindex", "-1");
    ui.altTitle.focus();
  }
}

// ---------------------------------------------------------------------------
// Pass chooser
// ---------------------------------------------------------------------------

const PASS_OPTIONS = [
  // Uses the user's own "Site open time" setting; its label is generated from
  // that number so it can never quote a duration the pass does not honour.
  { presetId: "siteDefault", minutesFromSettings: true, scopeKey: "passScopeSite" },
  { presetId: "site10", labelKey: "passTenMinutes", scopeKey: "passScopeSite" },
  { presetId: "site30", labelKey: "passThirtyMinutes", scopeKey: "passScopeSite" },
  { presetId: "tab", labelKey: "passUntilTabCloses", scopeKey: "passScopeSite" },
  { presetId: "all30", labelKey: "passAllThirtyMinutes", scopeKey: "passScopeAll" },
  { presetId: "allTomorrow", labelKey: "passAllUntilTomorrow", scopeKey: "passScopeAll" }
];

// The durations the fixed presets already offer, so the user's own setting is
// not listed twice when it happens to match one of them.
const FIXED_PASS_MINUTES = { site10: 10, site30: 30 };

function renderPassOptions() {
  ui.passOptions.replaceChildren();

  const configured = Number(state.context && state.context.passDurationMinutes) || 0;

  PASS_OPTIONS.filter((option) => {
    if (option.minutesFromSettings) {
      return configured > 0;
    }
    return FIXED_PASS_MINUTES[option.presetId] !== configured;
  }).forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";

    const label = document.createElement("span");
    label.textContent = option.minutesFromSettings
      ? t(configured === 1 ? "passConfiguredMinute" : "passConfiguredMinutes", [String(configured)])
      : t(option.labelKey);

    const scope = document.createElement("span");
    scope.className = "scope";
    scope.textContent = t(option.scopeKey);

    button.append(label, scope);
    // The label element is handed over, not the button: writing textContent on
    // the button itself would collapse both spans into one string, so restoring
    // it after a preview or a failure would fuse the option and its scope into
    // "For 10 minutesThis site only".
    button.addEventListener("click", () => grantPass(option.presetId, button, label));
    ui.passOptions.appendChild(button);
  });
}

// Report an outcome next to the buttons it is about. Clearing first and setting
// on the next frame re-fires the alert even when the same sentence is written
// twice — pressing a second option after a failure has to say so again.
function setPassNote(message) {
  ui.passNote.textContent = "";
  ui.passNote.hidden = !message;

  if (message) {
    window.requestAnimationFrame(() => {
      ui.passNote.textContent = message;
    });
  }
}

function showPassChooser() {
  renderPassOptions();
  setPassNote("");
  ui.passPanel.hidden = false;
  const first = ui.passOptions.querySelector("button");
  if (first) {
    first.focus();
  }
}

async function grantPass(presetId, button, labelEl) {
  button.disabled = true;
  const original = labelEl.textContent;
  labelEl.textContent = t("passOpening");

  if (isPreview) {
    // Preview mode grants nothing on purpose, so saying so belongs beside the
    // option that was just pressed. It used to go only to the screen-reader-only
    // #altAnnounce inside the ALTERNATIVE card, which is hidden entirely when a
    // preview is opened straight to the chooser — the press looked ignored.
    setPassNote(t("previewPassNote"));
    button.disabled = false;
    labelEl.textContent = original;
    return;
  }

  const response = await send("grantPass", { site: siteKey, presetId, intent: state.intent });

  if (!response || !response.ok) {
    button.disabled = false;
    labelEl.textContent = original;
    setPassNote(t("warningErrorHint"));
    return;
  }

  window.location.href = response.destination || "about:blank";
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

ui.back.addEventListener("click", () => {
  send("recordLeft", {});

  // history.back() does nothing when the blocked page was the first navigation
  // in the tab, which would leave the user stuck on the block screen.
  const returned = window.history.length > 1;
  if (returned) {
    window.history.back();
    // If the navigation did not actually happen, fall through to a blank page.
    window.setTimeout(() => {
      if (!document.hidden) {
        window.location.href = "about:blank";
      }
    }, 400);
  } else {
    window.location.href = "about:blank";
  }
});

ui.continue.addEventListener("click", () => {
  if (!state.unlocked) {
    return;
  }

  showPassChooser();
});

ui.passCancel.addEventListener("click", () => {
  setPassNote("");
  ui.passPanel.hidden = true;
  ui.continue.focus();
});

ui.anotherAlt.addEventListener("click", () => {
  if (state.current) {
    send("recordAlternativeDismissed", { id: state.current.id });
  }

  state.rotation += 1;
  showAlternative({ focus: true });
});

ui.chooseAlt.addEventListener("click", () => {
  if (!state.current || state.chosen) {
    return;
  }

  state.chosen = true;
  state.chosenIds.push(state.current.id);
  ui.chooseAlt.disabled = true;
  ui.chooseAlt.textContent = t("alternativeChosenButton");

  // "Chose" is an intention, not a completed meal. Confirming it was actually
  // made is a separate, optional action in the popup — the page says so rather
  // than implying anything happened.
  ui.chosenNote.textContent = t("alternativeChosenNote");
  ui.chosenNote.hidden = false;

  send("recordAlternativeSelected", { id: state.current.id });
});

ui.favAlt.addEventListener("click", async () => {
  if (!state.current) {
    return;
  }

  const id = state.current.id;
  const next = state.favorites.includes(id)
    ? state.favorites.filter((item) => item !== id)
    : [...state.favorites, id];

  state.favorites = next;
  state.preferences.alternativeFavorites = next;
  ui.favAlt.setAttribute("aria-pressed", String(next.includes(id)));

  if (!isPreview) {
    try {
      await chrome.storage.local.set({ alternativeFavorites: next });
    } catch (error) {
      console.error("FitShield: could not save favourite", error);
    }
  }
});

ui.intentSkip.addEventListener("click", () => {
  ui.intentPanel.hidden = true;
  revealAlternative();
  ui.back.focus();
});

// ---------------------------------------------------------------------------
// Counting an interruption exactly once per interruption
// ---------------------------------------------------------------------------

/**
 * Pressing reload on the block page is not a new interruption — but the worker
 * has no way to know that. The message arrives on the same tab, from the same
 * `sender.url`, and a reload creates a NEW documentId, so every one of the
 * worker's identifiers says "different document, count it". Hold F5 and
 * `interruptions` and the per-brand breakdown climb as fast as the page can
 * load, which is a statistic the product presents as an observed event.
 *
 * Only the page itself can tell the difference, and it needs two facts:
 *
 *   1. Is this document a re-run of one the user was already looking at?
 *      `PerformanceNavigationTiming.type` answers exactly that: "reload" and
 *      "back_forward" are re-runs, "navigate" is a genuinely new arrival.
 *   2. Has this tab already counted an interruption for this site?
 *      `sessionStorage` is scoped to the tab and survives a reload, so it can
 *      carry that across the re-run. Nothing here leaves the tab, and it dies
 *      with it.
 *
 * BOTH are required, and each one alone is wrong:
 *
 *   - The marker alone would suppress a GENUINE second interruption. Leaving
 *     the block page and coming back to the same site an hour later is a real
 *     new interruption, and the marker is still sitting in the tab.
 *   - The navigation type alone would suppress a genuine FIRST one. Turning
 *     blocking on while a delivery site is already open and hitting reload is
 *     a very ordinary way to meet the block page for the first time, and that
 *     navigation is a "reload".
 *
 * Together they say precisely what is meant: skip the recording only when this
 * document is a re-run AND this tab has already counted this site. Every
 * failure mode of the two APIs (private mode, disabled storage, an engine
 * without navigation timing) falls through to recording, because under-counting
 * a real interruption is a worse lie than the duplicate this removes.
 */
const INTERRUPTION_MARKER = `fitshield:counted:${siteKey}`;

function isRerunOfSameDocument() {
  try {
    const [entry] = performance.getEntriesByType("navigation");
    return !!entry && (entry.type === "reload" || entry.type === "back_forward");
  } catch (error) {
    return false;
  }
}

function tabAlreadyCountedThisSite() {
  try {
    return sessionStorage.getItem(INTERRUPTION_MARKER) !== null;
  } catch (error) {
    return false;
  }
}

function markTabCountedThisSite() {
  try {
    sessionStorage.setItem(INTERRUPTION_MARKER, String(Date.now()));
  } catch (error) {
    // Private mode, partitioned storage, or a quota error. Counting one extra
    // interruption is a far smaller harm than throwing on the block page.
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function initialize() {
  try {
    const { theme, themeMode } = await chrome.storage.local.get(["theme", "themeMode"]);
    const palette = resolvePalette(theme, themeMode);
    applyTheme(palette.theme, { light: palette.light });
  } catch (error) {
    applyTheme(null, { light: false });
  }

  const context = await send("getBlockContext", { site: siteKey });

  if (context && context.ok) {
    state.context = context;
    state.info = context.site;
    state.preferences = context.preferences || {};
    state.favorites = Array.isArray(state.preferences.alternativeFavorites)
      ? state.preferences.alternativeFavorites.slice()
      : [];
    state.secondsLeft = Number(context.timerSeconds) || 60;
    state.totalSeconds = state.secondsLeft;
  }

  renderStaticText();
  renderRepeatNote();
  renderTimer();
  startTimer();

  // Counted once per interruption, and never in preview mode. The brand
  // breakdown is the same event seen from the other side, so it is gated on the
  // same decision — a reload inflated both counters identically.
  if (!(isRerunOfSameDocument() && tabAlreadyCountedThisSite())) {
    markTabCountedThisSite();
    send("recordInterruption", {});

    if (state.info) {
      send("recordBlockedBrand", {
        meta: {
          domain: state.info.domain || "",
          category: state.info.category || "",
          countries: Array.isArray(state.info.countries) ? state.info.countries : []
        }
      });
    }
  }

  // Alternatives are non-blocking: the countdown and the exits work regardless
  // of whether the catalog loads.
  try {
    await FitShieldRecipes.loadCatalog();
    renderFilters();

    if (state.context && state.context.askIntent) {
      renderIntentOptions();
      ui.intentPanel.hidden = false;
      // Prepared, not shown: whichever way the prompt is answered, the card is
      // ready instantly, and nothing is counted for an answer that never
      // reveals it ("bored", "ordering for someone else").
      ui.altPanel.hidden = true;
      showAlternative({ silent: true });
    } else {
      showAlternative({});
    }
  } catch (error) {
    console.error("FitShield: could not load alternatives", error);
    ui.altPanel.hidden = true;
  }
}

if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.onChange) {
  FitShieldI18n.onChange(() => {
    renderStaticText();
    renderRepeatNote();
    renderFilters();
    renderIntentOptions();

    // Re-render in the new language without changing what is on screen: a
    // hidden card stays hidden (the user answered "bored", or has not answered
    // the intent prompt yet), and a visible one is not counted a second time.
    if (state.current) {
      showAlternative({ silent: ui.altPanel.hidden });
    }
  });
}

const i18nReady =
  typeof FitShieldI18n !== "undefined" && FitShieldI18n.ready ? FitShieldI18n.ready : Promise.resolve();

i18nReady.then(initialize);
