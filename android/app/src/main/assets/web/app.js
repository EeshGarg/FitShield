/**
 * FitShield Android UI logic. Talks ONLY to the platform-agnostic fitshield.*
 * API (implemented by android-shim.js over the narrow native bridge) plus the
 * reused FitShieldI18n module. No chrome.*, no direct
 * Android calls. Blocking-config controls are persisted via fitshield.storage;
 * enforcement of timing/filters is wired in the later DNS step (labelled in UI).
 */
(function () {
  "use strict";

  const fs = self.fitshield;
  const t = (k, s) => (self.FitShieldI18n ? self.FitShieldI18n.t(k, s) : k);
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  // Write only when there is something different to write — the rule
  // extension/popup.js states outright, and the reason is the same here: an
  // unconditional `textContent` assignment destroys the existing text node and
  // builds a new one. Most callers below sit on the 2s status poll, where the
  // string is identical to the one already on screen almost every time.
  const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };

  function normalizeDomain(v) {
    let d = String(v || "").trim().toLowerCase();
    if (!d) return "";
    d = d.replace(/^[a-z]+:\/\//, "").split("/")[0].split("?")[0].replace(/^www\./, "");
    return /^[a-z0-9.-]+\.[a-z0-9.-]+$/.test(d) ? d : "";
  }
  // Countries are named by the SAME function as everywhere else, for the same
  // reason `categoryName` below delegates — and this one was simply missed when
  // that fix landed. What sat here was a bare `Intl.DisplayNames`, with its own
  // locale helper and its own memo, and no curated overrides: so "Most blocked
  // countries" and the country picker rendered Intl's "Hong Kong SAR China"
  // where every extension surface says "Hong Kong". FitShieldI18n.countryName
  // carries the curated short forms (mirroring FS Engine's COUNTRY_NAMES), keys
  // its own Intl memo by locale so a language change invalidates it without
  // anyone remembering to, and upper-cases/echoes unknown codes. Delegating
  // deletes a namer, a memo and the `locale()` helper that existed only to feed
  // them.
  function countryName(code) {
    return (self.FitShieldI18n && self.FitShieldI18n.countryName)
      ? self.FitShieldI18n.countryName(code)
      : String(code || "");
  }
  // One namer for the whole product, and it lives in i18n.js — which this page
  // already loads, immediately above this file. The local copy that used to sit
  // here had drifted twice over: its fallback branch dropped the `.filter(Boolean)`
  // the canonical prettifier has, so an empty or leading-underscore category id
  // reached `w[0].toUpperCase()` on `undefined` and threw; and resolving `t()`
  // itself meant any future change to the rule in i18n.js silently stopped at
  // the extension. Delegating is what keeps Android, the block page and Settings
  // saying one word for one category.
  function categoryName(id) {
    return (self.FitShieldI18n && self.FitShieldI18n.categoryName)
      ? self.FitShieldI18n.categoryName(id)
      : String(id || "");
  }

  // ---- dashboard / status --------------------------------------------------
  //
  // WRITE-IF-CHANGED. extension/popup.js states the rule where it implements the
  // same idiom: "assigning textContent unconditionally destroys and rebuilds the
  // text node… Write only when there is something different to write." This
  // function is on a 2s poll, and it was rewriting four textContents, a class
  // name, a classList flag and a `hidden` flag on every tick of it — for a
  // dashboard that had not changed since the tick before.
  //
  // Only the two values that CAN differ between ticks are in the signature. The
  // version/host line is drawn once: see below.
  let statusSig = null;
  let statusMetaDrawn = false;
  async function renderStatus() {
    const enabled = await fs.blocking.isEnabled();
    const pdns = fs.blocking.privateDnsActive ? await fs.blocking.privateDnsActive() : false;

    // IMMUTABLE for the life of the process, so derived once rather than per
    // tick: `rulesVersion` is the APK's own version string, and `hostCount` is
    // the count in a packaged read-only asset. Neither can change without the
    // process being replaced. (The shim memoises both bridge calls too — see
    // android-shim.js — which is what takes the PackageManager binder IPC out of
    // the poll entirely.) `statusMetaDrawn` is only latched once a version has
    // actually come back, so a bridge that is not ready yet is retried instead
    // of pinning an empty line forever.
    if (!statusMetaDrawn) {
      const [version, hosts] = await Promise.all([fs.blocking.rulesVersion(), fs.blocking.hostCount()]);
      const parts = [];
      if (hosts != null) parts.push(`${Number(hosts).toLocaleString()} blocked domains`);
      if (version) parts.push(`rules v${version}`);
      $("meta").textContent = parts.join(" · ");
      $("footerVersion").textContent = version ? `FitShield ${version}` : "FitShield";
      statusMetaDrawn = !!version;
    }

    const sig = `${enabled}|${pdns}`;
    if (sig === statusSig) return;
    statusSig = sig;

    $("status").className = enabled ? "status on" : "status";
    document.documentElement.classList.toggle("on", enabled); // context-aware accent lighting

    $("statusText").textContent = enabled ? "On — blocking locally" : "Off";
    $("toggle").textContent = enabled ? "Disable FitShield" : "Enable FitShield";

    // FitShield blocks by the connection's site name (TLS SNI / HTTP Host), not
    // DNS — so it works alongside encrypted / Private DNS, which it never touches.
    // When Private DNS is active, reassure the user their DNS is untouched.
    const note = $("dnsNote");
    if (pdns && enabled) {
      note.hidden = false;
      note.textContent = "Your encrypted Private DNS is untouched — FitShield blocks by each connection's site name, so it works alongside your DNS provider.";
    } else {
      note.hidden = true;
    }
  }

  // ---- stats (observed counts only; parity with the extension) -------------
  //
  // There is no currency helper here any more, and that is the whole point. The
  // panel used to format `blockedVisits * avgMealCost` as money and call it
  // "Estimated savings". extension/fitshield-core.js states the objection where
  // the 0.55 migration lives: an interruption says nothing about whether an
  // order would have happened, so that multiplication "would invent a saving out
  // of a page load". The extension kept one estimate only because it could
  // ground it in `alternativesMade`, an event the user personally confirms.
  // Android observes no such event — its pause screen shows alternatives and
  // never asks whether one was made — so there is nothing honest to multiply,
  // and currency.js is no longer loaded by this page.

  // Animated counter: eases a stat value from its previous number to the new one
  // (One UI feel). Instant when reduced-motion is on or the value is unchanged.
  function animateNumber(node, to, fmt) {
    if (!node) return;
    fmt = fmt || ((n) => Math.round(n).toLocaleString());
    const target = Number(to) || 0;
    const from = Number(node.dataset.n);
    // Already showing this number: return without touching it. Writing the same
    // string back destroys and rebuilds the text node for no visible reason, and
    // on the 2s poll below that was the overwhelmingly common case.
    if (from === target) return;
    node.dataset.n = String(target);
    if (reduceMotion || !isFinite(from)) { node.textContent = fmt(target); return; }
    const now = () => (self.performance ? performance.now() : Date.now());
    const dur = 650, t0 = now();
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    (function tick() {
      const p = Math.min(1, (now() - t0) / dur);
      node.textContent = fmt(from + (target - from) * ease(p));
      if (p < 1) requestAnimationFrame(tick);
    })();
  }
  // The SAME formatter and the SAME keys warning.js uses, so a duration reads
  // identically on both platforms. `recipeTimeLabel` was not a key at all.
  function formatTime(minutes) {
    const value = Number(minutes) || 0;
    if (value < 60) return t("timeMinutes", [String(value)]);
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest === 0 ? t("timeHours", [String(hours)]) : t("timeHoursMinutes", [String(hours), String(rest)]);
  }
  // Write-if-changed, per list — the same rule renderStatus follows above, and it
  // matters more here. Four of these run per tick, and each one unconditionally
  // `replaceChildren()`-ed its list and rebuilt up to five rows of two spans, so
  // a poll that found nothing new still discarded and re-created ~60 nodes every
  // two seconds.
  //
  // The signature holds the RENDERED LABELS, not just the counts. That is what
  // makes a language change redraw on its own: the numbers are identical after
  // `setLanguage`, but "Hong Kong" becoming "Hongkong" is a different row, so the
  // signature differs and the list is rebuilt. Twenty memoised label lookups is
  // a far cheaper way to be correct than clearing a cache from every caller and
  // hoping none is forgotten.
  const mostBlockedSig = new Map();
  function renderMostBlocked(listId, wrapId, map, labelFor) {
    const entries = Object.entries((map && typeof map === "object") ? map : {})
      .filter(([, n]) => Number(n) > 0)
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 5);
    const rows = entries.map(([k, n]) => [labelFor(k), `${n}×`]);
    const sig = JSON.stringify(rows);
    if (mostBlockedSig.get(listId) === sig) return;
    mostBlockedSig.set(listId, sig);
    const list = $(listId); list.replaceChildren();
    rows.forEach(([label, count]) => { const li = el("li", "item"); li.append(el("span", null, label), el("span", "c", count)); list.appendChild(li); });
    $(wrapId).hidden = rows.length === 0;
  }
  async function renderStats() {
    const data = await fs.stats.get();

    // `blockedVisits` is the stored name; what it counts is an interruption, and
    // that is what the tile is labelled. The key is left alone rather than
    // renamed because renaming it on a phone that already holds a value would
    // reset a number the user has watched grow.
    animateNumber($("visits"), Number(data.blockedVisits) || 0);

    renderMostBlocked("mostBlocked", "mostBlockedWrap", data.blockedByDomain, (h) => h);
    renderMostBlocked("mostBlockedCat", "mostBlockedCatWrap", data.blockedByCategory, categoryName);
    renderMostBlocked("mostBlockedCountry", "mostBlockedCountryWrap", data.blockedByCountry, countryName);
    renderMostBlocked("mostBlockedApps", "mostBlockedAppsWrap", data.blockedByApp, (n) => n);
  }
  // Re-render dynamic strings/values (called after language change / reset).
  // There is no namer to invalidate here any more: FitShieldI18n.countryName keys
  // its own Intl memo by locale, and renderMostBlocked's signature is built from
  // the rendered labels, so a language change redraws the ranked lists by itself.
  async function refresh() {
    renderStatus();
    renderStats();
  }

  // ---- country / category filters (selections stored; enforcement: DNS step)
  async function renderFilters() {
    const meta = (await fs.filters.metadata()) || {};
    const sel = await fs.filters.getSelected();
    const selCountries = new Set(sel.enabledCountries || []);
    const selCategories = new Set(sel.enabledCategories || []);

    function pickerInto(listEl, searchEl, items, labelFor, selectedSet, storageKey) {
      function draw() {
        const q = searchEl.value.trim().toLowerCase();
        listEl.replaceChildren();
        items.filter((it) => labelFor(it.id).toLowerCase().includes(q) || it.id.toLowerCase().includes(q))
          .slice(0, 60)
          .forEach((it) => {
            const row = el("li", "item");
            row.append(el("span", null, `${labelFor(it.id)} · ${it.count}`));
            const on = selectedSet.has(it.id);
            const pill = el("button", on ? "pill on" : "pill", on ? "On" : "Off");
            pill.addEventListener("click", () => {
              if (selectedSet.has(it.id)) selectedSet.delete(it.id); else selectedSet.add(it.id);
              fs.filters.setSelected({ [storageKey]: [...selectedSet] });
              draw();
            });
            row.appendChild(pill);
            listEl.appendChild(row);
          });
      }
      searchEl.addEventListener("input", draw);
      draw();
    }
    pickerInto($("countryResults"), $("countrySearch"),
      (meta.countries || []).map((c) => ({ id: c.code, count: c.count })), countryName, selCountries, "enabledCountries");
    pickerInto($("categoryResults"), $("categorySearch"),
      (meta.categories || []).map((c) => ({ id: c.id, count: c.count })), categoryName, selCategories, "enabledCategories");
  }

  // ---- domain lists (custom blocklist + allow list) ------------------------
  function listEditor(inputId, addId, listId, storageKey, mapItem) {
    async function read() { return (await fs.storage.get([storageKey]))[storageKey] || []; }
    async function draw() {
      const items = await read();
      const list = $(listId); list.replaceChildren();
      if (!items.length) { list.appendChild(el("li", "item muted", "None yet.")); return; }
      items.forEach((raw) => {
        const domain = mapItem(raw);
        const row = el("li", "item");
        row.append(el("span", null, domain));
        const rm = el("button", "pill", t("removeButton") || "Remove");
        rm.addEventListener("click", async () => {
          const cur = await read();
          await fs.storage.set({ [storageKey]: cur.filter((x) => mapItem(x) !== domain) });
          draw();
        });
        row.appendChild(rm);
        list.appendChild(row);
      });
    }
    $(addId).addEventListener("click", async () => {
      const d = normalizeDomain($(inputId).value);
      if (!d) return;
      const cur = await read();
      if (!cur.some((x) => mapItem(x) === d)) {
        const next = storageKey === "customSites" ? [...cur, { domain: d, enabled: true }] : [...cur, d];
        await fs.storage.set({ [storageKey]: next });
      }
      $(inputId).value = "";
      draw();
    });
    draw();
  }

  // ---- timer / schedule / post-timer (stored; enforcement: DNS step) -------

  // The product's ranges, stated ONCE for the Android UI.
  //
  // extension/fitshield-core.js is the source of truth and exports these numbers
  // (MIN/MAX_TIMER_SECONDS = 10..900, MIN/MAX_PASS_DURATION_MINUTES = 1..240).
  // Android disagreed with it at the top end of both, in a way the user could
  // only discover by being overruled:
  //
  //   `timerSeconds`  index.html had min="10" and NO max, and the clamp here was
  //     `Math.max(10, …)` — a floor with nothing above it. So the dashboard
  //     accepted 600, stored 600 and showed 600 back, and then
  //     BlockActivity.timerSeconds() applied `.coerceIn(0, 300)` and counted down
  //     for five minutes. The setting was accepted, persisted, displayed, and
  //     silently not honoured.
  //   `passDurationMinutes`  same open top against AppBlockPolicy.unlockMinutes'
  //     `.coerceIn(1, 240)`.
  //
  // ARCHITECTURE.md states the failure mode for the neighbouring case: when the
  // two places a setting lives disagree, "the switch shows one state and the
  // behaviour is the other, which is strictly worse than either being wrong on
  // its own." A range is the same kind of fact as a default. The UI honours
  // core's range rather than narrowing itself to Kotlin's old 300, because
  // 10..900 is what the product says it offers — so BlockActivity was corrected
  // instead. All three layers (the input's min/max, this clamp, the Kotlin
  // coerceIn) now carry the same two numbers, and test/android-controls.test.js
  // reads core's exported constants and holds every layer to them.
  const LIMITS = { timerSeconds: [10, 900], passDurationMinutes: [1, 240], appUnlockMinutes: [1, 240] };
  // `clampInt` from extension/fitshield-core.js, to the letter: parse as an
  // integer, fall back only when that is not a number at all, and otherwise clamp.
  //
  // The distinction matters for ONE input and it is the kind that hides: with
  // `Number(value) || fallback`, a typed `0` is falsy and becomes the DEFAULT, so
  // Android stored 5 minutes where core stores 1, and 60 seconds where core stores
  // 10. Both are defensible in isolation; disagreeing is not, and the whole point
  // of this block is that the two platforms answer the same way.
  const clampLimit = (key, value, fallback) => {
    const [min, max] = LIMITS[key];
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  async function renderTiming() {
    const s = await fs.storage.get(["timerSeconds", "passDurationMinutes", "scheduleEnabled", "scheduleStart", "scheduleEnd"]);
    $("timerSeconds").value = Number(s.timerSeconds) || 60;
    $("passMinutes").value = Number(s.passDurationMinutes) || 5;
    $("scheduleEnabled").checked = !!s.scheduleEnabled;
    $("scheduleStart").value = s.scheduleStart || "18:00";
    $("scheduleEnd").value = s.scheduleEnd || "23:00";
    const save = () => fs.storage.set({
      timerSeconds: clampLimit("timerSeconds", $("timerSeconds").value, 60),
      passDurationMinutes: clampLimit("passDurationMinutes", $("passMinutes").value, 5),
      scheduleEnabled: $("scheduleEnabled").checked,
      scheduleStart: $("scheduleStart").value || "18:00",
      scheduleEnd: $("scheduleEnd").value || "23:00"
    });
    ["timerSeconds", "passMinutes", "scheduleStart", "scheduleEnd"].forEach((id) => $(id).addEventListener("change", save));
    $("scheduleEnabled").addEventListener("change", save);
  }

  // ---- recipes (canonical data) --------------------------------------------

  // "piece" is a bare counter, not a measure — it exists in the data so every
  // ingredient has a unit, but printing it gives "2 piece naan breads".
  const FILLER_UNIT = "piece";
  // Countable units read naturally with "of" and need pluralising: "2 cloves of
  // garlic". Measures (tbsp, cup, g, ml) do not: "2 tbsp oil".
  const COUNTABLE_UNITS = {
    slice: "slices", clove: "cloves", leaf: "leaves", pinch: "pinches",
    pouch: "pouches", packet: "packets", scoop: "scoops"
  };

  /**
   * Render one catalog ingredient as a phrase.
   *
   * This panel did `(r.ingredients || []).join(", ")` over a list of
   * `{quantity, unit, item}` objects, so every alternative's ingredient line read
   * "[object Object], [object Object], …" on the device — a panel whose entire
   * job is telling you what you could make instead.
   *
   * The rules are the extension's, from `formatIngredient` in
   * extension/warning.js. They are restated here rather than imported because
   * extension/warning.js is not one of the modules bundled into the APK, and
   * test/android-alternatives.test.js drives BOTH implementations across every
   * ingredient in the shipped catalog and fails if they ever disagree — so this
   * is a mirror with a gate on it, not a fork. The right end state is one copy in
   * extension/recipes.js, which is already bundled; that file belongs to another
   * lane.
   */
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

  async function renderRecipes() {
    let recipes = [];
    // `load()` resolves the WHOLE catalog document — the selector needs the
    // taxonomy — and this used to call it and then `.slice(0, 24)` an object.
    // That threw inside an async function nobody awaited, so there was no crash
    // and no log: the panel was simply empty on every device, permanently.
    // `loadEntries()` is the accessor that returns the flat array.
    try { recipes = await fs.recipes.loadEntries(); } catch (e) {}
    const all = Array.isArray(recipes) ? recipes : [];
    const wrap = $("recipeList");
    const search = $("recipeSearch");
    const count = $("recipeCount");

    // The search haystack, derived ONCE, parallel to `all`.
    //
    // `draw()` is the search box's `input` handler, so it runs per keystroke, and
    // it used to call `matchText` for all 88 entries inside the filter — a join
    // of the title, the description and every ingredient run through
    // formatIngredient, then `.toLowerCase()`, ~88 times per character typed. The
    // catalog is fetched once and never mutated, so the text it is searched by
    // cannot change either.
    const haystack = all.map((r) => matchText(r));

    // This drew `.slice(0, 24)` of 88 entries and said nothing about the other
    // 64 — a browse panel that quietly hid two thirds of the catalog. Everything
    // is rendered now, with a filter for finding one and a count that states
    // plainly how many of how many are on screen.
    function draw() {
      const query = (search && search.value || "").trim().toLowerCase();
      const matches = query
        ? all.filter((r, i) => haystack[i].includes(query))
        : all;
      if (count) {
        count.textContent = query
          ? `${matches.length} of ${all.length} alternatives match “${search.value.trim()}”.`
          : `${all.length} alternative${all.length === 1 ? "" : "s"}.`;
      }
      wrap.replaceChildren();
      matches.forEach(renderRecipeCard);
    }

    function matchText(r) {
      return [
        r.title,
        r.description,
        ...(Array.isArray(r.ingredients) ? r.ingredients.map(formatIngredient) : [])
      ].filter(Boolean).join(" ").toLowerCase();
    }

    function renderRecipeCard(r) {
      const card = el("div", "recipe");
      card.appendChild(el("h4", null, r.title));
      // `totalMinutes` is what the catalog carries. This read `r.timeMinutes`,
      // which no entry has ever had, through `t("recipeTimeLabel", …)`, which no
      // locale has ever defined — so the line would have rendered the literal
      // "recipeTimeLabel" had the panel ever managed to draw at all. The calorie
      // chip is gone rather than re-keyed: `r.calories` does not exist either
      // (the catalog carries `calorieRange`), the extension shows no calorie
      // figure anywhere, and FitShield is not a calorie tracker.
      const meta = [formatTime(r.totalMinutes)];
      card.appendChild(el("div", "m", meta.join(" · ")));
      if (r.description) card.appendChild(el("div", "note", r.description));
      const det = el("details");
      det.appendChild(el("summary", null, `${t("recipeIngredientsLabel")} · ${t("recipeStepsLabel")}`));
      const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : []).map(formatIngredient).filter(Boolean);
      det.appendChild(el("div", "note", `${t("recipeIngredientsLabel")}: ${ingredients.join(", ")}`));
      const ol = el("ol", "limits"); (r.steps || []).forEach((s) => ol.appendChild(el("li", null, s))); det.appendChild(ol);
      card.appendChild(det);
      wrap.appendChild(card);
    }

    if (search) search.addEventListener("input", draw);
    draw();
  }

  // ---- theme (mode + full color customization; glass-preserving) ----------
  // Color math + application live in the shared theme.js (FitShieldTheme), used
  // by both this dashboard and the block screen.
  const { presetFor, applyThemeColors } = self.FitShieldTheme;
  function populateThemeInputs(c) {
    $("bgColor").value = c.bg; $("panelColor").value = c.panel; $("textColor").value = c.text; $("accentColor").value = c.accent;
    $("radiusRange").value = c.radius; $("radiusValue").textContent = String(c.radius);
  }
  function readThemeInputs() {
    return { bg: $("bgColor").value, panel: $("panelColor").value, text: $("textColor").value, accent: $("accentColor").value, radius: Number($("radiusRange").value) || 16 };
  }
  async function renderTheme() {
    const mode = await fs.theme.getMode();
    const stored = (await fs.storage.get(["themeColors"])).themeColors;
    document.documentElement.setAttribute("data-theme", mode || "system");
    $("themeMode").value = mode;
    const colors = (stored && stored.bg) ? { ...presetFor(mode), ...stored } : presetFor(mode);
    populateThemeInputs(colors);
    applyThemeColors(colors);

    $("themeMode").addEventListener("change", async () => {
      const m = $("themeMode").value;
      await fs.theme.setMode(m);
      const preset = presetFor(m);
      preset.radius = Number($("radiusRange").value) || preset.radius; // keep chosen radius across light/dark
      document.documentElement.setAttribute("data-theme", m);
      populateThemeInputs(preset);
      applyThemeColors(preset);
      await fs.storage.set({ themeColors: preset });
    });
    const onColor = async () => { const c = readThemeInputs(); $("radiusValue").textContent = String(c.radius); applyThemeColors(c); await fs.storage.set({ themeColors: c }); };
    ["bgColor", "panelColor", "textColor", "accentColor"].forEach((id) => $(id).addEventListener("input", onColor));
    $("radiusRange").addEventListener("input", onColor);
    $("resetTheme").addEventListener("click", async () => {
      await fs.storage.remove(["themeColors"]);
      const preset = presetFor($("themeMode").value);
      populateThemeInputs(preset); applyThemeColors(preset);
    });
  }

  // ---- language (searchable; reuses the shared 83-language list + i18n) -----
  function renderLanguage() {
    const search = $("langSearch");
    const list = $("langResults");
    const i18n = self.FitShieldI18n;
    // Skip the "" (System default) entry: Android has no native i18n fallback,
    // so a language is always explicitly selected (all 83 locales are bundled).
    const opts = (self.FITSHIELD_LANGUAGE_OPTIONS || []).filter((o) => o.value);
    if (!search || !list || !i18n) return;
    const currentLang = () => (i18n.getLanguage ? i18n.getLanguage() : "en");
    const nameOf = (o) => { const n = t(o.labelKey); return (n && n !== o.labelKey) ? n : (o.native || o.value); };
    function draw() {
      const q = (search.value || "").trim().toLowerCase();
      const cur = currentLang();
      list.replaceChildren();
      const matches = opts.filter((o) => !q
        || (o.native || "").toLowerCase().includes(q)
        || nameOf(o).toLowerCase().includes(q)
        || o.value.toLowerCase().includes(q));
      if (!matches.length) { list.appendChild(el("li", "item muted", "No matches")); return; }
      matches.slice(0, 80).forEach((o) => {
        const name = nameOf(o);
        const label = (o.native && o.native !== name) ? `${o.native} · ${name}` : name;
        const row = el("li", "item");
        row.append(el("span", null, label));
        const on = o.value === cur;
        const pill = el("button", on ? "pill on" : "pill", on ? "✓" : "Use");
        pill.addEventListener("click", async () => {
          await i18n.setLanguage(o.value, { persist: true }); // re-localizes static labels
          refresh(); renderFilters(); renderRecipes(); draw(); // re-render dynamic strings
        });
        row.appendChild(pill);
        list.appendChild(row);
      });
    }
    search.addEventListener("input", draw);
    draw();
  }

  // ---- reset (tap-again confirm; no JS dialog dependency) ------------------
  function armConfirm(btn, action) {
    let armed = false, timer;
    const orig = btn.textContent;
    btn.addEventListener("click", async () => {
      if (!armed) { armed = true; btn.textContent = "Tap again to confirm"; timer = setTimeout(() => { armed = false; btn.textContent = orig; }, 3000); return; }
      clearTimeout(timer); armed = false; btn.textContent = orig;
      await action();
    });
  }
  function renderReset() {
    // `caloriesAvoided` and `recipesChosen` are LEGACY keys, kept on this list
    // deliberately. Nothing writes either any more — the calorie figure was an
    // assumed per-meal number multiplied by every block, and it stopped being
    // computed and stopped being shown — but a phone that ran an earlier build
    // still holds the value. CLAUDE.md §6 forbids silently resetting it, and the
    // extension keeps its own copy verbatim for the same reason ("it is no
    // longer a headline number, but it is their data"). Listing it here is what
    // makes it the USER's to clear: drop it and the value is orphaned on the
    // device with no control anywhere that can reach it.
    const STATS = ["blockedVisits", "blockedByDomain", "blockedByCategory", "blockedByCountry", "caloriesAvoided", "recipesChosen"];
    // `avgMealCost`, `avgMealCalories`, `mealStatsCustomized` and `currency` are
    // legacy for the same reason: the estimate row they fed is gone, and the
    // values stay on the device until the user asks for them to go.
    // `appBlockConvenience` is a LEGACY key: the Convenience pill is gone (no
    // blocklist row was ever `convenience`, so it could never match an app), but
    // a phone that ran an earlier build may still hold the value. It stays on the
    // removal list so "Reset settings" sweeps it instead of orphaning it.
    const SETTINGS = ["timerSeconds", "passDurationMinutes", "scheduleEnabled", "scheduleStart", "scheduleEnd", "customSites", "androidAllowlist", "enabledCountries", "enabledCategories", "themeMode", "themeColors", "avgMealCost", "avgMealCalories", "mealStatsCustomized", "currency", "appBlockingEnabled", "appBlockDelivery", "appBlockFastFood", "appBlockRestaurant", "appBlockGrocery", "appBlockConvenience", "appBlockCoffee", "appBlockDessert", "appBlockMealKit", "appUnlockMinutes", "appUnlocks", "appAllowBrands", "blockedByApp"];
    const note = (m) => { $("resetNote").textContent = m; };
    armConfirm($("resetStats"), async () => { await fs.storage.remove(STATS); note("Stats reset."); refresh(); });
    armConfirm($("resetSettings"), async () => { await fs.storage.remove(SETTINGS); note("Settings reset. Reloading…"); setTimeout(() => location.reload(), 500); });
    armConfirm($("factoryReset"), async () => { await fs.storage.clear(); note("Factory reset. Reloading…"); setTimeout(() => location.reload(), 500); });
  }

  // ---- tilting tiles (Aero/One-UI press tilt; reduced-motion aware) --------
  const reduceMotion = !!(self.matchMedia && self.matchMedia("(prefers-reduced-motion: reduce)").matches);
  function initTilt() {
    if (reduceMotion) return;
    document.querySelectorAll(".stat, [data-tilt]").forEach((tile) => {
      let pressed = false;
      // The rect is read ONCE per press, not per sample. `getBoundingClientRect`
      // forces a synchronous layout flush, and this read it inside the
      // `pointermove` handler and then wrote `style.transform` straight after —
      // so every touch sample was read-after-write against a dirty layout tree.
      // A tile cannot move or resize while a finger is held down on it, so one
      // measurement covers the whole gesture.
      let rect = null;
      // …and the write is coalesced to ONE per frame. `pointermove` is delivered
      // at the touch digitiser's rate (120-240 Hz on current phones), while the
      // display can only show one transform per frame, so the extra writes were
      // layout work with no pixel to show for it — on the same main thread the
      // synchronous storage bridge runs on. extension/settings.js already
      // rAF-coalesces its equivalent; this was the platform-local regression from
      // that shared design. The rendered output is unchanged: the transform is
      // still computed from the newest pointer position, just once per frame.
      let queued = null, frame = 0;
      const apply = () => {
        frame = 0;
        const e = queued;
        queued = null;
        if (!e || !rect || !rect.width || !rect.height) return;
        const px = ((e.clientX - rect.left) / rect.width) - 0.5;   // -0.5 … 0.5
        const py = ((e.clientY - rect.top) / rect.height) - 0.5;
        const max = 7;
        tile.style.transform = `perspective(760px) rotateX(${(-py * max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg) scale(.985)`;
      };
      const move = (e) => {
        queued = { clientX: e.clientX, clientY: e.clientY };
        if (!frame) frame = requestAnimationFrame(apply);
      };
      const reset = () => {
        pressed = false;
        queued = null;
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        tile.style.transform = "";
      };
      tile.addEventListener("pointerdown", (e) => { pressed = true; rect = tile.getBoundingClientRect(); move(e); });
      tile.addEventListener("pointermove", (e) => { if (pressed) move(e); });
      ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => tile.addEventListener(ev, reset));
    });
  }

  // Permission/status refresh, published out of renderAppBlocking so the poll
  // below and the main toggle can both run it.
  //
  // It used to be reachable only from inside that function and from a
  // `visibilitychange` listener, and the 2s interval refreshed the headline and
  // the stats but none of the permission rows. So granting VPN consent left
  // "Site blocking (VPN) · Off" on screen next to a dashboard that already said
  // "On — blocking locally", until the app happened to be backgrounded and
  // brought back. Every row this function owns had the same staleness.
  let refreshPermissionStatuses = () => {};

  // Mirrors the stored `appBlockingEnabled`, defaulting ON like AppBlockPolicy.
  // Held here rather than re-read inside refreshStatuses so renderAppBlocking
  // keeps reading its whole state in ONE storage.get — the shape
  // test/android-controls.test.js relies on to prove every pill it draws is
  // drawn from storage.
  let appBlockingOn = true;

  // ---- native app blocking (Android AccessibilityService) ------------------
  async function renderAppBlocking() {
    const ab = fs.appBlocking;
    const panel = $("appBlockPanel");
    if (!panel || !ab || !ab.available) return;   // browser / unsupported: stays hidden
    panel.hidden = false;

    // One entry per app-grouping category, matching the pills in index.html and
    // AppBlockPolicy.categoryEnabled. `convenience` was here, and in the pills,
    // and in the policy — and no package could ever carry it, because no
    // blocklist row is `convenience`. It was a switch that did nothing.
    // test/android-controls.test.js now holds all four lists to each other.
    const CATS = { delivery: "appBlockDelivery", fast_food: "appBlockFastFood", restaurant: "appBlockRestaurant", grocery: "appBlockGrocery", coffee: "appBlockCoffee", dessert: "appBlockDessert", meal_kit: "appBlockMealKit" };

    function mark(id, on, label) {
      const wrap = $(id);
      if (!wrap) return;
      // Write-if-changed. Three of these run on every tick of the 2s poll and the
      // answer is the same almost every time. The signature carries the LABEL as
      // well as the boolean, because the label is localised text that a language
      // change moves while the boolean stands still.
      //
      // The visible text and the aria-label are behind the SAME comparison on
      // purpose: guarding only the text would leave a screen reader announcing
      // "off" on a row a sighted user reads as "On" — the row's state is one fact
      // and both renderings of it move together or neither does.
      const sig = `${on}|${label}`;
      if (wrap.dataset.mark === sig) return;
      wrap.dataset.mark = sig;
      wrap.classList.toggle("on", on);
      const tspan = wrap.querySelector(".t");
      if (tspan) tspan.textContent = `${label} · ${on ? "On" : "Off"}`;
      wrap.setAttribute("aria-label", `${label}: ${on ? "on" : "off"}`);
    }
    async function refreshStatuses() {
      let a11y = false, vpn = false, overlay = false;
      try { a11y = await ab.accessibilityEnabled(); } catch (e) {}
      try { vpn = await ab.vpnEnabled(); } catch (e) {}
      try { overlay = await ab.overlayEnabled(); } catch (e) {}
      mark("stAccessibility", a11y, "Accessibility service");
      mark("stVpn", vpn, "Site blocking (VPN)");
      mark("stOverlay", overlay, "Display over other apps");
      setText($("a11yStatus"), a11y
        ? "Accessibility service is on — app blocking can run."
        : "Turn on the FitShield accessibility service to block apps. It only reads which app comes to the front — never screen content.");
      $("a11yOpen").hidden = a11y;
      $("overlayCard").hidden = overlay;   // shown only when the permission is missing

      // Dashboard prompt for the one step that is left. Shown only when app
      // blocking is switched on (it defaults on) and the service that carries
      // it out is not, which is exactly the state where opening a food app does
      // nothing and there is otherwise no sign of why.
      const setup = $("appBlockSetup");
      if (setup) {
        // `vpn` matters as well as `a11y`: before FitShield is switched on at
        // all, nothing is blocked, and a card opening "Sites are blocked" over
        // a dashboard reading "Off" would be the product contradicting itself
        // on its own front page.
        setup.hidden = a11y || !appBlockingOn || !vpn;
        if (!setup.hidden) {
          setText($("appBlockSetupText"),
            "Sites are blocked. To also pause food APPS on this phone, FitShield needs Android's " +
            "accessibility service — it only reads which app comes to the front, never screen content.");
        }
      }

      // Notifications. POST_NOTIFICATIONS was declared and never requested, so on
      // Android 13+ it was denied on every device — and the notice that says
      // "protection is off after your restart" was posting into nothing. It is
      // requested now when site blocking is first enabled; this is what happens
      // when the user declines, or turns notifications off later.
      if ($("notifStatus") && ab.notificationsEnabled) {
        let notifications = true;
        try { notifications = await ab.notificationsEnabled(); } catch (e) {}
        $("notifStatus").hidden = notifications;
        $("notifOpen").hidden = notifications;
        if (!notifications) {
          setText($("notifStatus"),
            "Notifications are turned off for FitShield. If your phone restarts and Android needs your VPN " +
            "confirmation again, FitShield cannot tell you that site blocking stopped — you would find out by " +
            "opening a site that should have been blocked.");
        }
      }
      // Optional background-protection status (battery-optimization exemption).
      if ($("batteryStatus") && ab.batteryUnrestricted) {
        let unrestricted = false;
        try { unrestricted = await ab.batteryUnrestricted(); } catch (e) {}
        setText($("batteryStatus"), unrestricted
          ? "Battery: unrestricted — the background service won't be paused."
          : "Battery: optimized. For best reliability, set FitShield to unrestricted.");
        $("batteryOpen").hidden = unrestricted;
      }
    }
    const refreshA11y = refreshStatuses;   // (name kept for the toggle handler below)
    refreshPermissionStatuses = refreshStatuses;

    // Prominent disclosure before the accessibility request.
    //
    // "Open Accessibility settings" used to open the system screen immediately.
    // Google requires the disclosure to be shown in the app, before the request,
    // and accepted by an affirmative action — and the AccessibilityService
    // declaration is one of the two most scrutinised things on this listing. The
    // native bridge refuses to open anything until recordConsent() has run, so
    // this is a gate rather than a courtesy.
    const disclosure = $("a11yDisclosure");
    function showDisclosure() {
      if (!disclosure) { ab.openSettings(); return; }
      disclosure.hidden = false;
      $("a11yAccept").focus();
    }
    async function requestAccessibility() {
      let consented = false;
      try { consented = ab.consentGiven ? await ab.consentGiven() : true; } catch (e) {}
      if (consented) { ab.openSettings(); return; }
      showDisclosure();
    }

    $("a11yOpen").addEventListener("click", requestAccessibility);

    // The dashboard prompt takes the SAME path: the disclosure is a Play
    // requirement and a second entry point that skipped it would be the
    // violation, not a shortcut.
    if ($("appBlockSetupOpen")) {
      $("appBlockSetupOpen").addEventListener("click", requestAccessibility);
    }
    if (disclosure) {
      $("a11yAccept").addEventListener("click", async () => {
        try { if (ab.recordConsent) await ab.recordConsent(); } catch (e) {}
        disclosure.hidden = true;
        ab.openSettings();
      });
      $("a11yDecline").addEventListener("click", () => {
        // Declining records nothing and enables nothing. App blocking stays off
        // and site blocking is unaffected.
        disclosure.hidden = true;
      });
    }
    $("overlayOpen").addEventListener("click", () => ab.openOverlaySettings());
    if ($("notifOpen") && ab.openNotificationSettings) {
      $("notifOpen").addEventListener("click", () => ab.openNotificationSettings());
    }
    // Optional "background protection" keep-alive toggle + battery exemption.
    if ($("keepAliveEnabled") && ab.keepAliveEnabled) {
      try { $("keepAliveEnabled").checked = await ab.keepAliveEnabled(); } catch (e) {}
      $("keepAliveEnabled").addEventListener("change", () => {
        if (ab.setKeepAlive) ab.setKeepAlive($("keepAliveEnabled").checked);
      });
    }
    if ($("batteryOpen") && ab.openBatterySettings) {
      $("batteryOpen").addEventListener("click", () => ab.openBatterySettings());
    }
    // Returning from a system settings screen is covered by the single resume
    // handler in start(), which refreshes the headline and the stats as well as
    // these rows. The listener that used to sit here refreshed only the
    // permission rows — and it was registered INSIDE this function, so on any
    // build where the early return above fires there was no resume refresh at
    // all.

    // How many apps can be blocked — and, when that is ZERO, saying so.
    //
    // This was `if (n)`, so a count of 0 left the line blank. Zero is not a boring
    // case: `WebAppBridge.appPackageCount()` now reports the size of the matcher the
    // AccessibilityService actually holds, and the one way it reaches 0 is
    // `PackageBlocklist.fromAssets` failing to read the generated dataset. That
    // failure is deliberately absorbed rather than thrown — a crash-looping
    // accessibility service is worse for the user than app blocking being off — but
    // absorbing it silently left every category pill showing "on" above a feature
    // that could not match a single app. This is the existing line for app-blocking
    // readiness, so it carries the news rather than a new control being invented for
    // it.
    try {
      const n = await ab.packageCount();
      setText($("appBlockCount"), n
        ? `${n} app${n === 1 ? "" : "s"} can be blocked (more brands added over time).`
        : "No apps can be blocked on this build — FitShield could not read its bundled app list, so app blocking " +
          "is inactive. Site blocking is unaffected. Reinstalling the app should restore it.");
    } catch (e) {}

    // Read the key for EVERY pill, not a hand-written subset. This listed four of
    // the eight category keys, so Coffee, Dessert, Meal kit and Convenience read
    // back `undefined` and took the `default ON` branch below: a user who turned
    // Coffee off and reopened Settings was shown Coffee on, while the policy —
    // which reads the stored value — was still not blocking it. The switch and
    // the behaviour disagreed, and only the switch was visible.
    const s = await fs.storage.get(["appBlockingEnabled", "appUnlockMinutes", ...Object.values(CATS)]);
    // Defaults ON when absent, matching AppBlockPolicy.isEnabled and the pills
    // below. `!!s.appBlockingEnabled` showed a fresh install this switch OFF
    // while every category under it read ON — the same switch-disagrees-with-
    // behaviour bug the pills had, in the opposite direction.
    $("appBlockingEnabled").checked = s.appBlockingEnabled !== false;
    appBlockingOn = s.appBlockingEnabled !== false;
    $("appBlockingEnabled").addEventListener("change", () => {
      appBlockingOn = $("appBlockingEnabled").checked;
      fs.storage.set({ appBlockingEnabled: appBlockingOn });
      refreshA11y();
    });

    document.querySelectorAll("#appBlockPanel .pill[data-cat]").forEach((pill) => {
      const key = CATS[pill.dataset.cat];
      const on = s[key] === undefined ? true : !!s[key];   // categories default ON
      pill.classList.toggle("on", on);
      pill.addEventListener("click", () => {
        const next = !pill.classList.contains("on");
        pill.classList.toggle("on", next);
        fs.storage.set({ [key]: next });
      });
    });

    $("appUnlockMinutes").value = Number(s.appUnlockMinutes) || 5;
    $("appUnlockMinutes").addEventListener("change", () =>
      fs.storage.set({ appUnlockMinutes: clampLimit("appUnlockMinutes", $("appUnlockMinutes").value, 5) }));

    renderAppList();
    refreshA11y();
  }

  // Per-app on/off list (opt out specific apps even when their category is on).
  async function renderAppList() {
    const search = $("appSearch"), list = $("appList");
    if (!search || !list) return;
    let apps = [];
    try { apps = await fs.appBlocking.list(); } catch (e) {}
    apps.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    let allowed = new Set(((await fs.storage.get(["appAllowBrands"])).appAllowBrands) || []);
    function draw() {
      const q = (search.value || "").trim().toLowerCase();
      list.replaceChildren();
      const matches = apps.filter((a) => !q || String(a.displayName).toLowerCase().includes(q) || String(a.brandId).includes(q));
      if (!matches.length) { list.appendChild(el("li", "item muted", apps.length ? "No matches" : "No apps mapped yet.")); return; }
      matches.slice(0, 60).forEach((a) => {
        const row = el("li", "item");
        row.append(el("span", null, a.displayName));
        const on = !allowed.has(a.brandId);   // "on" = blocked
        const pill = el("button", on ? "pill on" : "pill", on ? "Blocked" : "Allowed");
        pill.addEventListener("click", async () => {
          if (allowed.has(a.brandId)) allowed.delete(a.brandId); else allowed.add(a.brandId);
          await fs.storage.set({ appAllowBrands: [...allowed] });
          draw();
        });
        row.appendChild(pill);
        list.appendChild(row);
      });
    }
    search.addEventListener("input", draw);
    draw();
  }

  // ---- wiring --------------------------------------------------------------
  function wire() {
    $("toggle").addEventListener("click", async () => {
      (await fs.blocking.isEnabled()) ? await fs.blocking.disable() : await fs.blocking.enable();
      // The permission rows move with this too — turning FitShield on is exactly
      // when "Site blocking (VPN)" becomes true.
      setTimeout(() => { renderStatus(); refreshPermissionStatuses(); }, 600);
    });
    $("checkBtn").addEventListener("click", runCheck);
    $("checkInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runCheck(); });
    $("exportBtn").addEventListener("click", () => fs.importExport.export());
    const importBtn = $("importBtn");
    if (importBtn) importBtn.addEventListener("click", () => fs.importExport.import());
    const bmc = $("bmcBtn");
    if (bmc) bmc.addEventListener("click", () => { if (fs.tabs && fs.tabs.create) fs.tabs.create("https://buymeacoffee.com/eeshgarg"); });
  }
  async function runCheck() {
    const host = normalizeDomain($("checkInput").value) || $("checkInput").value.trim();
    const r = await fs.blocking.check(host);
    $("checkResult").innerHTML = !r ? "Checking isn't available here." : (r.blocked ? `<span class="ok">Blocked</span> — matches ${r.apex}` : `<span class="muted">Not blocked</span>`);
  }

  // ---- first-run welcome (shown once) --------------------------------------
  async function renderWelcome() {
    const overlay = $("welcome");
    if (!overlay) return;
    const seen = (await fs.storage.get(["androidWelcomed"])).androidWelcomed;
    if (seen) return;
    overlay.hidden = false;
    $("welcomeGo").addEventListener("click", () => { fs.storage.set({ androidWelcomed: true }); overlay.hidden = true; });
  }

  async function start() {
    if (!fs || !fs.blocking) { $("statusText").textContent = "Platform bridge unavailable."; return; }
    renderWelcome();
    wire();
    renderTheme();
    renderLanguage();
    renderReset();
    renderAppBlocking();
    renderStatus();
    renderStats();
    renderFilters();
    renderTiming();
    renderRecipes();
    listEditor("customInput", "customAdd", "customList", "customSites", (x) => (x && x.domain) ? x.domain : String(x));
    listEditor("allowInput", "allowAdd", "allowList", "androidAllowlist", (x) => String(x));
    initTilt();

    // Everything the poll refreshes, in one place, so the poll and the resume
    // path cannot drift apart.
    const tick = () => { renderStatus(); renderStats(); refreshPermissionStatuses(); };

    // ONE resume refresh, and it covers all three.
    //
    // The only `visibilitychange` listener used to live inside renderAppBlocking
    // and call refreshStatuses alone, so the permission rows were re-read on
    // resume while the headline and the stats were not — and with the poll now
    // paused while hidden, that would have been the difference between "nothing
    // is stale on resume" and "two thirds of the screen is". It is registered
    // here, unconditionally, rather than behind renderAppBlocking's early return.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

    // THE POLL STAYS, AT THE SAME PERIOD. ARCHITECTURE.md records why: the
    // permission rows are polled rather than latched because Android publishes no
    // change event for accessibility-enabled, overlay-granted, notifications-
    // enabled or battery-unrestricted. Lengthening the period is a user-visible
    // latency change that wants a device to judge, so it is left alone.
    //
    // What changes is that it no longer runs with the app off-screen. MainActivity
    // has no `onPause` override, so WebView timers are never paused for us, and
    // this interval was making roughly seven synchronous bridge hops a second —
    // several of them real binder IPCs (PackageManager, Settings.Global,
    // Settings.Secure, canDrawOverlays, NotificationManagerCompat, PowerManager) —
    // forever, including while the user was in another app entirely. That was the
    // single largest avoidable battery cost in the product, and nothing on screen
    // could be read while it was being paid.
    setInterval(() => { if (!document.hidden) tick(); }, 2000);
  }

  if (self.FitShieldI18n && self.FitShieldI18n.ready) self.FitShieldI18n.ready.then(start, start);
  else start();
})();
