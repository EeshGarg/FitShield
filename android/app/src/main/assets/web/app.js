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

  function locale() {
    const ui = (self.FitShieldI18n && self.FitShieldI18n.getLanguage) ? self.FitShieldI18n.getLanguage() : "";
    return (ui || "en").replace(/_/g, "-");
  }
  function normalizeDomain(v) {
    let d = String(v || "").trim().toLowerCase();
    if (!d) return "";
    d = d.replace(/^[a-z]+:\/\//, "").split("/")[0].split("?")[0].replace(/^www\./, "");
    return /^[a-z0-9.-]+\.[a-z0-9.-]+$/.test(d) ? d : "";
  }
  let regionNames = null;
  function countryName(code) {
    try { regionNames = regionNames || new Intl.DisplayNames([locale()], { type: "region" }); return regionNames.of(code) || code; }
    catch (e) { return code; }
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
  async function renderStatus() {
    const enabled = await fs.blocking.isEnabled();
    $("status").className = enabled ? "status on" : "status";
    document.documentElement.classList.toggle("on", enabled); // context-aware accent lighting

    $("statusText").textContent = enabled ? "On — blocking locally" : "Off";
    $("toggle").textContent = enabled ? "Disable FitShield" : "Enable FitShield";
    const [version, hosts] = await Promise.all([fs.blocking.rulesVersion(), fs.blocking.hostCount()]);
    const parts = [];
    if (hosts != null) parts.push(`${Number(hosts).toLocaleString()} blocked domains`);
    if (version) parts.push(`rules v${version}`);
    $("meta").textContent = parts.join(" · ");
    $("footerVersion").textContent = version ? `FitShield ${version}` : "FitShield";

    // FitShield blocks by the connection's site name (TLS SNI / HTTP Host), not
    // DNS — so it works alongside encrypted / Private DNS, which it never touches.
    // When Private DNS is active, reassure the user their DNS is untouched.
    const note = $("dnsNote");
    const pdns = fs.blocking.privateDnsActive ? await fs.blocking.privateDnsActive() : false;
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
    node.dataset.n = String(target);
    if (reduceMotion || !isFinite(from) || from === target) { node.textContent = fmt(target); return; }
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
  function renderMostBlocked(listId, wrapId, map, labelFor) {
    const entries = Object.entries((map && typeof map === "object") ? map : {})
      .filter(([, n]) => Number(n) > 0)
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 5);
    const list = $(listId); list.replaceChildren();
    entries.forEach(([k, n]) => { const li = el("li", "item"); li.append(el("span", null, labelFor(k)), el("span", "c", `${n}×`)); list.appendChild(li); });
    $(wrapId).hidden = entries.length === 0;
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
  async function refresh() {
    regionNames = null; // DisplayNames are locale-bound; rebuild for the new locale
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
  async function renderTiming() {
    const s = await fs.storage.get(["timerSeconds", "passDurationMinutes", "scheduleEnabled", "scheduleStart", "scheduleEnd"]);
    $("timerSeconds").value = Number(s.timerSeconds) || 60;
    $("passMinutes").value = Number(s.passDurationMinutes) || 5;
    $("scheduleEnabled").checked = !!s.scheduleEnabled;
    $("scheduleStart").value = s.scheduleStart || "18:00";
    $("scheduleEnd").value = s.scheduleEnd || "23:00";
    const save = () => fs.storage.set({
      timerSeconds: Math.max(10, Number($("timerSeconds").value) || 60),
      passDurationMinutes: Math.max(1, Number($("passMinutes").value) || 5),
      scheduleEnabled: $("scheduleEnabled").checked,
      scheduleStart: $("scheduleStart").value || "18:00",
      scheduleEnd: $("scheduleEnd").value || "23:00"
    });
    ["timerSeconds", "passMinutes", "scheduleStart", "scheduleEnd"].forEach((id) => $(id).addEventListener("change", save));
    $("scheduleEnabled").addEventListener("change", save);
  }

  // ---- recipes (canonical data) --------------------------------------------
  async function renderRecipes() {
    let recipes = [];
    // `load()` resolves the WHOLE catalog document — the selector needs the
    // taxonomy — and this used to call it and then `.slice(0, 24)` an object.
    // That threw inside an async function nobody awaited, so there was no crash
    // and no log: the panel was simply empty on every device, permanently.
    // `loadEntries()` is the accessor that returns the flat array.
    try { recipes = await fs.recipes.loadEntries(); } catch (e) {}
    const wrap = $("recipeList"); wrap.replaceChildren();
    (Array.isArray(recipes) ? recipes : []).slice(0, 24).forEach((r) => {
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
      det.appendChild(el("div", "note", `${t("recipeIngredientsLabel")}: ${(r.ingredients || []).join(", ")}`));
      const ol = el("ol", "limits"); (r.steps || []).forEach((s) => ol.appendChild(el("li", null, s))); det.appendChild(ol);
      card.appendChild(det);
      wrap.appendChild(card);
    });
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
      const move = (e) => {
        const r = tile.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) - 0.5;   // -0.5 … 0.5
        const py = ((e.clientY - r.top) / r.height) - 0.5;
        const max = 7;
        tile.style.transform = `perspective(760px) rotateX(${(-py * max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg) scale(.985)`;
      };
      const reset = () => { pressed = false; tile.style.transform = ""; };
      tile.addEventListener("pointerdown", (e) => { pressed = true; move(e); });
      tile.addEventListener("pointermove", (e) => { if (pressed) move(e); });
      ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => tile.addEventListener(ev, reset));
    });
  }

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
      $("a11yStatus").textContent = a11y
        ? "Accessibility service is on — app blocking can run."
        : "Turn on the FitShield accessibility service to block apps. It only reads which app comes to the front — never screen content.";
      $("a11yOpen").hidden = a11y;
      $("overlayCard").hidden = overlay;   // shown only when the permission is missing
      // Optional background-protection status (battery-optimization exemption).
      if ($("batteryStatus") && ab.batteryUnrestricted) {
        let unrestricted = false;
        try { unrestricted = await ab.batteryUnrestricted(); } catch (e) {}
        $("batteryStatus").textContent = unrestricted
          ? "Battery: unrestricted — the background service won't be paused."
          : "Battery: optimized. For best reliability, set FitShield to unrestricted.";
        $("batteryOpen").hidden = unrestricted;
      }
    }
    const refreshA11y = refreshStatuses;   // (name kept for the toggle handler below)
    $("a11yOpen").addEventListener("click", () => ab.openSettings());
    $("overlayOpen").addEventListener("click", () => ab.openOverlaySettings());
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
    // Re-check when returning from a system settings screen.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshStatuses(); });

    try { const n = await ab.packageCount(); if (n) $("appBlockCount").textContent = `${n} app${n === 1 ? "" : "s"} can be blocked (more brands added over time).`; } catch (e) {}

    // Read the key for EVERY pill, not a hand-written subset. This listed four of
    // the eight category keys, so Coffee, Dessert, Meal kit and Convenience read
    // back `undefined` and took the `default ON` branch below: a user who turned
    // Coffee off and reopened Settings was shown Coffee on, while the policy —
    // which reads the stored value — was still not blocking it. The switch and
    // the behaviour disagreed, and only the switch was visible.
    const s = await fs.storage.get(["appBlockingEnabled", "appUnlockMinutes", ...Object.values(CATS)]);
    $("appBlockingEnabled").checked = !!s.appBlockingEnabled;
    $("appBlockingEnabled").addEventListener("change", () => { fs.storage.set({ appBlockingEnabled: $("appBlockingEnabled").checked }); refreshA11y(); });

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
      fs.storage.set({ appUnlockMinutes: Math.max(1, Math.min(240, Number($("appUnlockMinutes").value) || 5)) }));

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
      setTimeout(renderStatus, 600);
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
    setInterval(() => { renderStatus(); renderStats(); }, 2000);
  }

  if (self.FitShieldI18n && self.FitShieldI18n.ready) self.FitShieldI18n.ready.then(start, start);
  else start();
})();
