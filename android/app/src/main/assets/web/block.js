/**
 * FitShield native block screen logic. Talks to the platform-agnostic fitshield.*
 * API (android-shim.js) for stats/recipes/theme, plus the block-specific
 * `AndroidBlock` bridge (BlockActivity) for the blocked brand + the leave /
 * temporary-unlock / open-FitShield actions. Mirrors the extension's block page.
 */
(function () {
  "use strict";

  const fs = self.fitshield;
  const AB = self.AndroidBlock || null;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const t = (k, s) => (self.FitShieldI18n ? self.FitShieldI18n.t(k, s) : k);
  const reduceMotion = !!(self.matchMedia && self.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function locale() {
    const ui = (self.FitShieldI18n && self.FitShieldI18n.getLanguage) ? self.FitShieldI18n.getLanguage() : "";
    return (ui || "en").replace(/_/g, "-");
  }

  function info() {
    try { return AB ? JSON.parse(AB.getInfo()) : {}; } catch (e) { return {}; }
  }

  // ---- theme (respect the user's stored dark/light + custom colors) ---------
  // Uses the shared FitShieldTheme (theme.js) — same application as the dashboard.
  async function applyTheme() {
    if (self.FitShieldTheme) { try { await self.FitShieldTheme.applyStored(fs.storage); } catch (e) {} }
  }

  // ---- category-aware messaging --------------------------------------------
  const COPY = {
    delivery: {
      label: "Food delivery",
      title: (n) => `Skip the ${n} order?`,
      message: "Delivery fees, tips, and the wait add up fast. A quick homemade option is minutes away — and the numbers below are proof it's working."
    },
    fast_food: {
      label: "Fast food",
      title: (n) => `Pause before ${n}`,
      message: "The craving passes fast. Something lighter you make yourself will feel better in twenty minutes. Here's an idea to get you started."
    },
    restaurant: {
      label: "Restaurant",
      title: (n) => `Pause before ${n}`,
      message: "A mindful minute now. You've already saved plenty by cooking in — keep the streak going."
    },
    grocery: {
      label: "Groceries",
      title: (n) => `Opening ${n}?`,
      message: "A quick pause before you shop. Stick to what you planned — your stats below show it pays off."
    },
    coffee: {
      label: "Coffee",
      title: (n) => `Skip the ${n} run?`,
      message: "A cup made at home costs pennies and skips the queue. The numbers below show how fast it adds up."
    },
    dessert: {
      label: "Dessert",
      title: (n) => `Pause before ${n}`,
      message: "Sweet cravings pass quickly. A moment now beats the sugar dip later — here's a lighter idea."
    },
    meal_kit: {
      label: "Meal kit",
      title: (n) => `Opening ${n}?`,
      message: "You likely have what you need already. Something simple from your own kitchen wins — your stats prove it."
    },
    convenience: {
      label: "Convenience",
      title: (n) => `Quick stop at ${n}?`,
      message: "A quick pause. Small impulse buys add up fast — stick to your plan."
    }
  };
  const copyFor = (cat) => COPY[cat] || COPY.fast_food;

  // ---- stats (currency-aware, same math as the dashboard) ------------------
  const cur = self.FitShieldCurrency;
  function resolvedCurrency(choice) { return cur ? cur.resolveCurrency(choice || "", locale()) : "USD"; }
  function formatSavings(amount, choice) {
    if (cur) { try { return cur.formatMoney(Math.round(amount), resolvedCurrency(choice), locale()); } catch (e) {} }
    return String(Math.round(amount));
  }
  async function renderStats() {
    const d = await fs.stats.get();
    const choice = typeof d.currency === "string" ? d.currency : "";
    const code = resolvedCurrency(choice);
    const visits = Number(d.blockedVisits) || 0;
    const customized = !!d.mealStatsCustomized;
    const mealCost = customized ? (Number(d.avgMealCost) || (cur ? cur.defaultCost(code) : 15)) : (cur ? cur.defaultCost(code) : 15);
    $("visits").textContent = visits.toLocaleString();
    $("calories").textContent = (Number(d.caloriesAvoided) || 0).toLocaleString();
    $("savings").textContent = formatSavings(visits * mealCost, choice);
  }

  // ---- one quick recipe alternative ----------------------------------------
  // ---- block reason + schedule status --------------------------------------
  function renderReason(copy) {
    $("reason").textContent = `Blocked because app blocking is on for ${copy.label.toLowerCase()} apps.`;
  }
  async function renderSchedule() {
    const el = $("sched");
    if (!el) return;
    const s = await fs.storage.get(["scheduleEnabled", "scheduleStart", "scheduleEnd"]);
    el.hidden = false;
    el.textContent = s.scheduleEnabled
      ? `On your schedule · ${s.scheduleStart || "18:00"}–${s.scheduleEnd || "23:00"}`
      : "Blocking is on whenever app blocking is enabled.";
  }

  async function renderRecipe() {
    let recipes = [];
    try { recipes = await fs.recipes.load(); } catch (e) {}
    if (!recipes.length) return;
    // deterministic pick so it doesn't flicker on reload
    const r = recipes[(recipes.length && Number((info().brandId || "").length)) % recipes.length] || recipes[0];
    const wrap = $("recipeList");
    const card = el("div", "recipe");
    card.appendChild(el("h4", null, r.title));
    const meta = [t("recipeTimeLabel", [String(r.timeMinutes)])];
    if (Number.isFinite(Number(r.calories))) meta.push(t("recipeCaloriesLabel", [String(r.calories)]));
    card.appendChild(el("div", "m", meta.join(" · ")));
    if (r.description) card.appendChild(el("div", "note", r.description));
    wrap.replaceChildren(card);
    $("recipeWrap").hidden = false;
  }

  // ---- timer + actions ------------------------------------------------------
  function startTimer(seconds, unlockMinutes, appName) {
    const btn = $("openAnyway");
    const enable = () => {
      btn.disabled = false;
      btn.textContent = `Open ${appName} for ${unlockMinutes} min`;
    };
    if (reduceMotion || !seconds || seconds <= 0) { enable(); return; }
    let left = seconds;
    btn.disabled = true;
    const tick = () => {
      if (left <= 0) { enable(); return; }
      btn.textContent = `Open ${appName} in ${left}s`;
      left -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }

  function start() {
    const meta = info();
    const name = meta.displayName || "this app";
    const copy = copyFor(meta.category);
    $("catLabel").textContent = copy.label;
    $("title").textContent = copy.title(name);
    $("message").textContent = copy.message;
    renderReason(copy);
    document.documentElement.classList.add("on"); // warm accent bloom

    applyTheme();
    renderStats();
    renderSchedule();
    renderRecipe();
    startTimer(Number(meta.timerSeconds), Number(meta.unlockMinutes) || 5, name);

    $("notNow").addEventListener("click", () => { if (AB) AB.leave(); });
    $("openAnyway").addEventListener("click", () => { if (AB && !$("openAnyway").disabled) AB.unlock(Number(meta.unlockMinutes) || 5); });
    $("openFs").addEventListener("click", () => { if (AB) AB.openFitShield(); });
    const lm = $("learnMore");
    if (lm) lm.addEventListener("click", (e) => { e.preventDefault(); if (fs.tabs && fs.tabs.create) fs.tabs.create("https://fitshield.net"); });
  }

  if (!fs) { start(); return; }
  if (self.FitShieldI18n && self.FitShieldI18n.ready) self.FitShieldI18n.ready.then(start, start);
  else start();
})();
