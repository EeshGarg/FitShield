/**
 * FitShield settings — the preference surfaces added for the decision flow:
 * friction profiles, schedules, kitchen preferences, the user's own
 * alternatives, the weekly recap, preview mode, and problem reporting.
 *
 * Kept out of settings.js on purpose: that file already owns the blocklist,
 * appearance, language, stats, and reset surfaces, and these are a separable
 * concern with their own storage keys.
 *
 * Two rules run through the whole file:
 *   - every value the user typed is rendered with textContent, never innerHTML,
 *     and is validated through FitShieldCore before it is stored;
 *   - nothing here transmits anything. The report builder produces text and
 *     hands it to the clipboard or a mail draft; the user does the sending.
 */
(function () {
  "use strict";

  const core = typeof FitShieldCore !== "undefined" ? FitShieldCore : null;

  if (!core) {
    console.error("FitShield: preferences need fitshield-core.js");
    return;
  }

  const t = (key, subs) => (typeof FitShieldI18n !== "undefined" ? FitShieldI18n.t(key, subs) : key);
  const el = (id) => document.getElementById(id);

  // Every section is optional: settings.html is also rendered by tests with a
  // partial DOM, and a missing container must never throw.
  const has = (id) => !!el(id);

  let settings = null;
  // The POSITION of the entry being edited, not its id — see the delete handler.
  let editingIndex = null;

  async function load() {
    const raw = await chrome.storage.local.get(null);
    settings = core.readSettings(raw);
    return settings;
  }

  async function save(partial) {
    await chrome.storage.local.set(partial);
    await load();
  }

  // ---------------------------------------------------------------------------
  // Shared chip control
  // ---------------------------------------------------------------------------

  function renderChips(container, options, isOn, onToggle) {
    if (!container) {
      return;
    }

    container.replaceChildren();

    options.forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pref-chip";
      button.textContent = option.label;
      button.setAttribute("aria-pressed", String(isOn(option.value)));

      if (option.title) {
        button.title = option.title;
      }

      button.addEventListener("click", () => onToggle(option.value));
      container.appendChild(button);
    });
  }

  const toOptions = (values, labeller) =>
    values.map((value) => ({ value, label: labeller ? labeller(value) : value }));

  // ---------------------------------------------------------------------------
  // Friction
  // ---------------------------------------------------------------------------

  // Which preset, if any, still describes the values actually stored.
  //
  // The page prints `frictionIntro` — "You can change any value afterwards —
  // doing so simply moves you to Custom." Nothing ever wrote
  // `frictionProfile: "custom"`, so a user who dragged the popup's timer to 300
  // seconds opened Settings to find "Standard" highlighted directly above
  // "300-second pause". The stored id is therefore a cache, not the truth: what
  // the chips claim is derived from the numbers themselves.
  //
  // The field list comes from `frictionProfileValues` so it cannot drift from
  // what a preset writes — core.detectFrictionProfile compares only two of the
  // six, which is why turning "Ask what brought me here" off never moved the
  // label either.
  const FRICTION_VALUE_KEYS = Object.keys(core.frictionProfileValues("standard")).filter(
    (key) => key !== "frictionProfile"
  );

  function frictionProfileFor(values) {
    return (
      core.FRICTION_PROFILE_IDS.find((id) => {
        const preset = core.frictionProfileValues(id);
        return FRICTION_VALUE_KEYS.every((key) => preset[key] === values[key]);
      }) || "custom"
    );
  }

  // Persist a friction value AND the profile that now describes the result, so
  // the stored label agrees with the stored numbers on every other surface too.
  async function saveFrictionValue(partial) {
    const next = { ...settings, ...partial };
    await save({ ...partial, frictionProfile: frictionProfileFor(next) });
  }

  function renderFriction() {
    if (!has("frictionPresets")) {
      return;
    }

    const profile = frictionProfileFor(settings);

    renderChips(
      el("frictionPresets"),
      [
        { value: "light", label: t("frictionLight") },
        { value: "standard", label: t("frictionStandard") },
        { value: "strict", label: t("frictionStrict") }
      ],
      (value) => profile === value,
      async (value) => {
        await save(core.frictionProfileValues(value));
        renderFriction();
      }
    );

    el("frictionCurrent").textContent =
      profile === "custom"
        ? t("frictionCustomSummary", [String(settings.timerSeconds), String(settings.passDurationMinutes)])
        : t("frictionSummary", [String(settings.timerSeconds), String(settings.passDurationMinutes)]);

    el("askIntentToggle").checked = settings.askIntent;
    el("repeatFrictionToggle").checked = settings.repeatFrictionEnabled;
  }

  function wireFriction() {
    if (!has("askIntentToggle")) {
      return;
    }

    el("askIntentToggle").addEventListener("change", async (event) => {
      await saveFrictionValue({ askIntent: event.target.checked });
      renderFriction();
    });

    el("repeatFrictionToggle").addEventListener("change", async (event) => {
      await saveFrictionValue({ repeatFrictionEnabled: event.target.checked });
      renderFriction();
    });
  }

  // ---------------------------------------------------------------------------
  // Schedule
  // ---------------------------------------------------------------------------

  const DAY_KEYS = ["daySun", "dayMon", "dayTue", "dayWed", "dayThu", "dayFri", "daySat"];

  // The three legacy flat keys are kept in step with the structured schedule so
  // an older build — and the popup's simple start/end controls — keep working.
  // Derived by the core so there is exactly one projection rule. The previous
  // local copy fell back to `settings.scheduleStart || "18:00"` for anything
  // that was not a single window — and readSettings did not carry that key, so
  // the fallback ALWAYS won: adding a second window silently rewrote a migrated
  // 19:30-02:00 profile to 18:00-23:00, and the worker then rebuilt the whole
  // schedule from those stale values.
  function legacyMirror(schedule) {
    const { scheduleEnabled, scheduleStart, scheduleEnd } = core.scheduleToLegacy(schedule);
    return { scheduleEnabled, scheduleStart, scheduleEnd };
  }

  async function saveSchedule(schedule) {
    const normalized = core.normalizeSchedule(schedule);
    await save({ schedule: normalized, ...legacyMirror(normalized) });
    renderSchedule();
  }

  function describeSchedule(schedule) {
    if (schedule.until && schedule.until > Date.now()) {
      return t("scheduleOverrideActive");
    }

    if (schedule.mode === "always") {
      return t("scheduleAlwaysSummary");
    }

    const count = schedule.windows.length;

    // Two real strings, not one with an "s" bolted on: the singular writes the
    // count out ("1 time window set.") so a locale is free to inflect it.
    return t(count === 1 ? "scheduleWindowsSummaryOne" : "scheduleWindowsSummary", [String(count)]);
  }

  function renderScheduleWindows() {
    const container = el("scheduleWindows");

    if (!container) {
      return;
    }

    container.replaceChildren();

    settings.schedule.windows.forEach((window, index) => {
      const row = document.createElement("div");
      row.className = "pref-window";

      const days = document.createElement("div");
      days.className = "days";
      days.setAttribute("role", "group");
      days.setAttribute("aria-label", t("scheduleDaysLabel"));

      core.ALL_DAYS.forEach((day) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "day";
        button.textContent = t(DAY_KEYS[day]);
        button.setAttribute("aria-pressed", String(window.days.includes(day)));
        button.addEventListener("click", () => {
          const next = window.days.includes(day)
            ? window.days.filter((value) => value !== day)
            : [...window.days, day];

          // A window with no days would silently never fire, so the last day
          // cannot be removed.
          if (next.length === 0) {
            return;
          }

          const windows = settings.schedule.windows.slice();
          windows[index] = { ...window, days: next };
          saveSchedule({ mode: "windows", windows, until: settings.schedule.until });
        });
        days.appendChild(button);
      });

      const makeTime = (value, key) => {
        const wrapper = document.createElement("div");
        const label = document.createElement("label");
        const id = `window-${index}-${key}`;
        label.setAttribute("for", id);
        label.textContent = t(key === "start" ? "startTimeLabel" : "endTimeLabel");

        const input = document.createElement("input");
        input.type = "time";
        input.id = id;
        input.value = value;
        input.addEventListener("change", () => {
          const windows = settings.schedule.windows.slice();
          windows[index] = { ...window, [key]: core.normalizeTime(input.value, window[key]) };
          saveSchedule({ mode: "windows", windows, until: settings.schedule.until });
        });

        wrapper.append(label, input);
        return wrapper;
      };

      const actions = document.createElement("div");
      actions.className = "pref-item-actions";

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "secondary";
      copy.textContent = t("scheduleCopyToAll");
      copy.addEventListener("click", () => {
        const source = window.days[0];
        saveSchedule(core.copyScheduleDay(settings.schedule, source, core.ALL_DAYS));
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = t("removeButton");
      remove.setAttribute("aria-label", t("scheduleRemoveWindow", [String(index + 1)]));
      remove.addEventListener("click", () => {
        const windows = settings.schedule.windows.filter((_, position) => position !== index);
        saveSchedule({ mode: windows.length > 0 ? "windows" : "always", windows, until: settings.schedule.until });
      });

      actions.append(copy, remove);
      row.append(days, makeTime(window.start, "start"), makeTime(window.end, "end"), actions);
      container.appendChild(row);
    });
  }

  function renderSchedule() {
    if (!has("schedulePresets")) {
      return;
    }

    const current = settings.schedule;

    renderChips(
      el("schedulePresets"),
      [
        { value: "always", label: t("schedulePresetAlways") },
        { value: "evenings", label: t("schedulePresetEvenings") },
        { value: "lateNight", label: t("schedulePresetLateNight") },
        { value: "workdayLunch", label: t("schedulePresetWorkdayLunch") },
        { value: "eveningsAndWeekends", label: t("schedulePresetEveningsWeekends") }
      ],
      (value) => {
        const preset = core.schedulePresetValues(value);
        return JSON.stringify(core.normalizeSchedule(preset).windows) === JSON.stringify(current.windows) &&
          preset.mode === current.mode;
      },
      (value) => saveSchedule({ ...core.schedulePresetValues(value), until: current.until })
    );

    el("scheduleStatus").textContent = describeSchedule(current);
    el("clearScheduleOverride").hidden = !(current.until && current.until > Date.now());
    renderScheduleWindows();
  }

  function wireSchedule() {
    if (!has("addScheduleWindow")) {
      return;
    }

    el("addScheduleWindow").addEventListener("click", () => {
      saveSchedule({
        mode: "windows",
        windows: [...settings.schedule.windows, { days: core.ALL_DAYS.slice(), start: "18:00", end: "23:00" }],
        until: settings.schedule.until
      });
    });

    el("blockUntilTomorrow").addEventListener("click", () => {
      saveSchedule({ ...settings.schedule, until: core.nextLocalMidnight(new Date()) });
    });

    el("clearScheduleOverride").addEventListener("click", () => {
      saveSchedule({ ...settings.schedule, until: null });
    });
  }

  // ---------------------------------------------------------------------------
  // Kitchen
  // ---------------------------------------------------------------------------

  const ALLERGENS = ["gluten", "dairy", "egg", "peanut", "tree-nut", "soy", "fish", "shellfish", "sesame"];

  function renderKitchen() {
    if (!has("dietSelect")) {
      return;
    }

    const diet = el("dietSelect");
    diet.replaceChildren();
    core.DIETS.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = t(`dietOption_${value}`);
      option.selected = settings.dietPreference === value;
      diet.appendChild(option);
    });

    renderChips(
      el("allergenChips"),
      toOptions(ALLERGENS, (value) => t(`allergen_${value.replace("-", "")}`)),
      (value) => (settings.avoidAllergens || []).includes(value),
      async (value) => {
        const current = settings.avoidAllergens || [];
        const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
        await save({ avoidAllergens: next });
        renderKitchen();
      }
    );

    renderChips(
      el("equipmentChips"),
      toOptions(core.EQUIPMENT_ITEMS),
      (value) => settings.equipment.includes(value),
      async (value) => {
        const next = settings.equipment.includes(value)
          ? settings.equipment.filter((item) => item !== value)
          : [...settings.equipment, value];

        // normalizeEquipment falls back to the default set when the list empties,
        // which would silently re-enable everything — so keep at least one.
        await save({ equipment: next.length > 0 ? next : [value] });
        renderKitchen();
      }
    );

    renderChips(
      el("pantryChips"),
      toOptions(core.PANTRY_ITEMS),
      (value) => settings.pantry.includes(value),
      async (value) => {
        const next = settings.pantry.includes(value)
          ? settings.pantry.filter((item) => item !== value)
          : [...settings.pantry, value];
        await save({ pantry: next });
        renderKitchen();
      }
    );
  }

  function wireKitchen() {
    if (!has("dietSelect")) {
      return;
    }

    el("dietSelect").addEventListener("change", async (event) => {
      await save({ dietPreference: event.target.value });
      renderKitchen();
    });
  }

  // ---------------------------------------------------------------------------
  // Custom alternatives
  // ---------------------------------------------------------------------------

  // A short, honest subset of the craving vocabulary — enough to place an entry
  // without making the user learn the whole taxonomy.
  const CUSTOM_CRAVINGS = [
    "pizza", "burger", "fried-chicken", "taco", "burrito", "rice-bowl", "noodles",
    "pasta", "sandwich", "breakfast", "dessert", "late-night", "comfort", "high-protein"
  ];

  function renderCustomAlternatives() {
    if (!has("customAltList")) {
      return;
    }

    const list = el("customAltList");
    list.replaceChildren();

    settings.customAlternatives.forEach((entry, index) => {
      const item = document.createElement("div");
      item.className = "pref-item";

      const main = document.createElement("div");
      main.className = "pref-item-main";

      const title = document.createElement("div");
      title.className = "pref-item-title";
      title.textContent = entry.title;

      const sub = document.createElement("div");
      sub.className = "pref-item-sub";
      sub.textContent = t("customAltSummary", [
        String(entry.totalMinutes),
        String(entry.ingredients.length),
        String(entry.steps.length)
      ]);

      main.append(title, sub);

      const actions = document.createElement("div");
      actions.className = "pref-item-actions";

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "secondary";
      edit.textContent = t("editButton");
      edit.setAttribute("aria-label", `${t("editButton")}: ${entry.title}`);
      edit.addEventListener("click", () => startEditing(entry, index));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = t("removeButton");
      remove.setAttribute("aria-label", `${t("removeButton")}: ${entry.title}`);
      remove.addEventListener("click", async () => {
        // By POSITION, not by id. Filtering on `item.id !== entry.id` deleted
        // every entry sharing that id, and ids are not guaranteed unique: a
        // hand-edited or third-party backup can carry several with the same one.
        // backup.js now re-issues collisions on import, but deleting the wrong
        // recipe is unrecoverable, so this removes exactly the row that was
        // clicked regardless of what the ids say.
        await save({
          customAlternatives: settings.customAlternatives.filter((_, position) => position !== index)
        });
        renderCustomAlternatives();
      });

      actions.append(edit, remove);
      item.append(main, actions);
      list.appendChild(item);
    });

    el("customAltEmpty").hidden = settings.customAlternatives.length > 0;

    const dietSelect = el("customAltDiet");
    if (dietSelect.childElementCount === 0) {
      core.DIETS.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = t(`dietOption_${value}`);
        dietSelect.appendChild(option);
      });
    }

    renderChips(
      el("customAltEquipment"),
      toOptions(core.EQUIPMENT_ITEMS),
      (value) => formDraft.equipment.includes(value),
      (value) => {
        formDraft.equipment = formDraft.equipment.includes(value)
          ? formDraft.equipment.filter((item) => item !== value)
          : [...formDraft.equipment, value];
        renderCustomAlternatives();
      }
    );

    renderChips(
      el("customAltCravings"),
      toOptions(CUSTOM_CRAVINGS, (value) => value.replace(/-/g, " ")),
      (value) => formDraft.cravings.includes(value),
      (value) => {
        formDraft.cravings = formDraft.cravings.includes(value)
          ? formDraft.cravings.filter((item) => item !== value)
          : [...formDraft.cravings, value];
        renderCustomAlternatives();
      }
    );

    el("customAltCancel").hidden = editingIndex === null;
    el("customAltSave").textContent = editingIndex === null ? t("customAltSave") : t("customAltUpdate");
  }

  const formDraft = { equipment: ["stove"], cravings: [] };

  function resetForm() {
    editingIndex = null;
    formDraft.equipment = ["stove"];
    formDraft.cravings = [];
    el("customAltForm").reset();
    el("customAltMinutes").value = "10";
    renderCustomAlternatives();
  }

  function startEditing(entry, index) {
    editingIndex = index;
    formDraft.equipment = entry.equipment.slice();
    formDraft.cravings = entry.cravings.slice();

    el("customAltName").value = entry.title;
    el("customAltDescription").value = entry.description || "";
    el("customAltIngredients").value = entry.ingredients.join("\n");
    el("customAltSteps").value = entry.steps.join("\n");
    el("customAltMinutes").value = String(entry.totalMinutes);
    el("customAltDiet").value = entry.diet;

    renderCustomAlternatives();
    el("customAltName").focus();
  }

  const splitLines = (value) =>
    String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  function wireCustomAlternatives() {
    if (!has("customAltForm")) {
      return;
    }

    el("customAltForm").addEventListener("submit", async (event) => {
      event.preventDefault();

      const editing = editingIndex === null ? null : settings.customAlternatives[editingIndex] || null;

      const result = core.sanitizeCustomAlternative({
        id: editing ? editing.id : undefined,
        name: el("customAltName").value,
        description: el("customAltDescription").value,
        ingredients: splitLines(el("customAltIngredients").value),
        steps: splitLines(el("customAltSteps").value),
        totalMinutes: el("customAltMinutes").value,
        diet: el("customAltDiet").value,
        equipment: formDraft.equipment,
        cravings: formDraft.cravings,
        categories: []
      });

      if (!result.ok) {
        // Errors are announced through a live region and name the field, so a
        // screen reader user learns what to fix without hunting.
        el("customAltNotice").textContent = result.errors
          .map((code) => t(code === "nameRequired" ? "customAltErrorName" : "customAltErrorSteps"))
          .join(" ");

        el(result.errors.includes("nameRequired") ? "customAltName" : "customAltSteps").focus();
        return;
      }

      // Replace the row being edited IN PLACE. Rebuilding the list as
      // "everything whose id differs, plus the edited copy" collapsed every
      // entry sharing that id into one, and moved an edited entry to the end of
      // the user's own list for no reason.
      const next = settings.customAlternatives.slice();

      if (editing) {
        next[editingIndex] = result.value;
      } else {
        next.push(result.value);
      }

      await save({ customAlternatives: next });

      el("customAltNotice").textContent = t("customAltSaved", [result.value.title]);
      resetForm();
    });

    el("customAltCancel").addEventListener("click", () => {
      el("customAltNotice").textContent = "";
      resetForm();
    });
  }

  // ---------------------------------------------------------------------------
  // Weekly recap
  // ---------------------------------------------------------------------------

  async function renderRecap() {
    if (!has("recapBody")) {
      return;
    }

    const body = el("recapBody");
    body.replaceChildren();
    el("recapEnabled").checked = settings.recapEnabled;

    if (!settings.recapEnabled) {
      const note = document.createElement("p");
      note.className = "pref-note";
      note.textContent = t("recapHidden");
      body.appendChild(note);
      return;
    }

    const { blockedByCategory } = await chrome.storage.local.get(["blockedByCategory"]);
    const recap = core.weeklyRecap(settings.stats, Date.now(), { blockedByCategory });

    if (!recap.hasActivity) {
      const note = document.createElement("p");
      note.className = "pref-note";
      note.textContent = t("recapNoActivity");
      body.appendChild(note);
      return;
    }

    // Counts only. No score, no streak, no ranking, no projection.
    const figures = [
      ["recapInterrupted", recap.totals.interruptions],
      ["recapLeft", recap.totals.left],
      ["recapContinued", recap.totals.continued],
      ["recapPasses", recap.totals.passesUsed],
      ["recapSelected", recap.totals.alternativesSelected],
      ["recapMade", recap.totals.alternativesMade]
    ];

    figures.forEach(([key, value]) => {
      const row = document.createElement("div");
      row.className = "recap-figure";

      const label = document.createElement("span");
      label.textContent = t(key);

      const number = document.createElement("span");
      number.className = "recap-value";
      number.textContent = String(value);

      row.append(label, number);
      body.appendChild(row);
    });

    if (recap.topCategory) {
      const row = document.createElement("div");
      row.className = "recap-figure";

      const label = document.createElement("span");
      label.textContent = t("recapTopCategory");

      const value = document.createElement("span");
      value.className = "recap-value";
      value.textContent = recap.topCategory.name;

      row.append(label, value);
      body.appendChild(row);
    }
  }

  function wireRecap() {
    if (!has("recapEnabled")) {
      return;
    }

    el("recapEnabled").addEventListener("change", async (event) => {
      await save({ recapEnabled: event.target.checked });
      renderRecap();
    });
  }

  // ---------------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------------

  // Real site keys, so the preview exercises the same resolution path a genuine
  // interruption does — while ?preview=1 keeps every recording path inert.
  const PREVIEW_SITES = [
    { key: "delivery-doordash-com", labelKey: "previewDelivery" },
    { key: "fast-food-dominos-com", labelKey: "previewPizza" },
    { key: "fast-food-kfc-com", labelKey: "previewChicken" },
    { key: "fast-food-starbucks-com", labelKey: "previewCoffee" }
  ];

  function wirePreview() {
    if (!has("previewCategory")) {
      return;
    }

    const select = el("previewCategory");
    select.replaceChildren();
    PREVIEW_SITES.forEach((site) => {
      const option = document.createElement("option");
      option.value = site.key;
      option.textContent = t(site.labelKey);
      select.appendChild(option);
    });

    el("openPreview").addEventListener("click", () => {
      const url = new URL(chrome.runtime.getURL("warning.html"));
      url.searchParams.set("site", select.value);
      url.searchParams.set("preview", "1");
      window.open(url.toString(), "_blank", "noopener");
    });

    el("openDiagnostics").addEventListener("click", () => {
      window.open(chrome.runtime.getURL("diagnostics.html"), "_blank", "noopener");
    });
  }

  // ---------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------

  const REPORT_TYPES = [
    { value: "missing-site", labelKey: "reportMissingSite" },
    { value: "false-positive", labelKey: "reportFalsePositive" },
    { value: "wrong-category", labelKey: "reportWrongCategory" },
    { value: "broken-alternative", labelKey: "reportBrokenAlternative" },
    { value: "wrong-diet-label", labelKey: "reportWrongDiet" },
    { value: "wrong-allergen-label", labelKey: "reportWrongAllergen" },
    { value: "bad-instructions", labelKey: "reportBadInstructions" },
    { value: "suggest-alternative", labelKey: "reportSuggestAlternative" }
  ];

  // The settings page does not load the alternatives catalog (it has no need
  // to), so this is best-effort and never a hard dependency.
  function catalogVersion() {
    try {
      const catalog = typeof FitShieldRecipes !== "undefined" ? FitShieldRecipes.getCatalog() : null;
      return (catalog && catalog.version) || "not loaded";
    } catch (error) {
      return "not loaded";
    }
  }

  // What a hostname looks like once core.redactReportSubject has reduced the
  // input to a domain. Same shape the core tests for.
  const DOMAIN_SHAPE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

  /**
   * The note printed above this field promises, unconditionally, that "query
   * strings are stripped and only the domain is included".
   *
   * `core.redactReportSubject` reduces every input that PARSES as a URL to its
   * host, which covers pasted links, intranet hosts and localhost pages. What it
   * cannot reduce it returns verbatim, correctly — free text is a label, not a
   * URL, and truncating it would mangle a perfectly good subject like
   * "pizza w/ extra cheese".
   *
   * But a link pasted into a sentence ("ordered from intranet/checkout?token=x
   * and it broke") does not parse as a URL and so reaches that fallback with its
   * query string intact. A privacy-first product does not print a guarantee next
   * to a field and then keep the token, so drop any query/fragment tail here.
   * Only `?` and `#` — never a path separator, which appears in ordinary prose.
   */
  function redactSubject(value) {
    const redacted = core.redactReportSubject(value);

    if (DOMAIN_SHAPE.test(redacted)) {
      return redacted;
    }

    return core.cleanText(redacted.replace(/[?#][\s\S]*$/, ""), 120);
  }

  function buildReport() {
    const type = el("reportType").value;
    const subject = redactSubject(el("reportSubject").value);
    const details = core.cleanText(el("reportDetails").value, 800);
    const version =
      typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest
        ? chrome.runtime.getManifest().version
        : "";

    const lines = [
      `FitShield report: ${type}`,
      `Subject: ${subject || "(not given)"}`,
      `Extension version: ${version}`,
      `Catalog version: ${catalogVersion()}`,
      "",
      "Details:",
      details || "(none)"
    ];

    return lines.join("\n");
  }

  function renderReport() {
    if (!has("reportPreview")) {
      return;
    }

    // Shown verbatim, so what the user sees IS what would be sent.
    el("reportPreview").textContent = buildReport();
  }

  function wireReport() {
    if (!has("reportType")) {
      return;
    }

    const select = el("reportType");
    select.replaceChildren();
    REPORT_TYPES.forEach((type) => {
      const option = document.createElement("option");
      option.value = type.value;
      option.textContent = t(type.labelKey);
      select.appendChild(option);
    });

    ["reportType", "reportSubject", "reportDetails"].forEach((id) => {
      el(id).addEventListener("input", renderReport);
      el(id).addEventListener("change", renderReport);
    });

    el("reportCopy").addEventListener("click", async () => {
      const text = buildReport();

      try {
        await navigator.clipboard.writeText(text);
        el("reportNotice").textContent = t("reportCopied");
      } catch (error) {
        // Clipboard access can be refused; the text is already on screen and
        // selectable, so say that rather than failing silently.
        el("reportNotice").textContent = t("reportCopyFailed");
        el("reportPreview").focus();
      }
    });

    // There is deliberately no second action. A "mail draft" button used to sit
    // here targeting reports@fitshield.net; that domain publishes no MX record,
    // so the draft had nowhere to go. The report is composed locally, shown
    // verbatim, and copied on request — the user chooses where it goes, and
    // FitShield never transmits anything.

    renderReport();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function renderAll() {
    renderFriction();
    renderSchedule();
    renderKitchen();
    renderCustomAlternatives();
    await renderRecap();
  }

  async function initialize() {
    await load();

    wireFriction();
    wireSchedule();
    wireKitchen();
    wireCustomAlternatives();
    wireRecap();
    wirePreview();
    wireReport();

    await renderAll();
  }

  if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.onChange) {
    FitShieldI18n.onChange(() => {
      if (settings) {
        renderAll();
      }
    });
  }

  const ready =
    typeof FitShieldI18n !== "undefined" && FitShieldI18n.ready ? FitShieldI18n.ready : Promise.resolve();

  ready.then(initialize).catch((error) => console.error("FitShield: preferences failed to start", error));
})();
