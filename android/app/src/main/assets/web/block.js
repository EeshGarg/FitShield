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

  // What was blocked, in CURATED terms — the same vocabulary the extension's
  // block page and the recipe selector speak.
  //
  // `meta.category` is the APP GROUPING (delivery / fast_food / restaurant /
  // grocery / coffee / dessert / meal_kit). It decides whether to interrupt at
  // all, and it is coarse by design: roughly two thirds of all shipped packages
  // are `fast_food`. It is not a food category and must never be used as one — a
  // bubble-tea shop, a pizza chain and a burger chain are all `fast_food`.
  const foodCategory = (meta) => meta.foodCategory || meta.category || "";

  // Same namer the extension's block page and Settings use, from the i18n.js
  // this page loads above. The COPY table below is TONE — a title and a nudge
  // for eight categories — and it was doing double duty as the category NAME,
  // which it is not equipped for: the curated data carries 37 categories, so
  // `copyFor` answered the other 29 with COPY.fast_food and a blocked tea shop
  // was labelled "Fast food", in English, in all 83 locales.
  function categoryName(id) {
    return (self.FitShieldI18n && self.FitShieldI18n.categoryName)
      ? self.FitShieldI18n.categoryName(id)
      : String(id || "");
  }

  // ---- theme (respect the user's stored dark/light + custom colors) ---------
  // Uses the shared FitShieldTheme (theme.js) — same application as the dashboard.
  async function applyTheme() {
    if (self.FitShieldTheme) { try { await self.FitShieldTheme.applyStored(fs.storage); } catch (e) {} }
  }

  // ---- category-aware messaging --------------------------------------------
  // One entry per APP GROUPING (= one per Settings pill). Kept exactly in step
  // with tools/generate-android-packages.js APP_CATEGORIES by
  // test/android-controls.test.js — a missing entry silently borrows fast_food's
  // tone, and a surplus entry is copy no blocked app can ever reach.
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
    }
  };
  const copyFor = (cat) => COPY[cat] || COPY.fast_food;

  // ---- stats (one observed count, same as the dashboard) -------------------
  //
  // This screen used to show the interruption count, that count multiplied by an
  // assumed meal price as "Estimated savings", and a running total of an assumed
  // per-meal calorie figure. Two of the three were arithmetic on an assumption
  // presented as an outcome; the extension deleted both in 0.55 and said why.
  // What is left is the number the app actually observed. By the time this
  // renders, BlockActivity has already recorded the pause the user is looking
  // at, so the figure includes this one.
  async function renderStats() {
    const d = await fs.stats.get();
    $("visits").textContent = (Number(d.blockedVisits) || 0).toLocaleString(locale());
  }

  // ---- one quick recipe alternative ----------------------------------------
  // ---- block reason + schedule status --------------------------------------
  // The reason line was an English template literal, so it stayed English on a
  // Japanese phone however well the rest of the screen was translated — and it
  // lower-cased an English label to build it, which no other language can be
  // asked to do. One key, one placeholder, the localized category name in it.
  function renderReason(category) {
    const name = categoryName(category);
    $("reason").textContent = name ? t("blockReasonAppCategory", [name]) : "";
  }
  async function renderSchedule() {
    const el = $("sched");
    if (!el) return;
    const s = await fs.storage.get(["scheduleEnabled", "scheduleStart", "scheduleEnd"]);
    el.hidden = false;
    // The no-schedule branch said "Blocking is on whenever app blocking is
    // enabled" — true by definition, and therefore telling the reader nothing
    // about the one thing this line exists for: WHEN blocking applies. It was
    // also hardcoded English on a screen that is otherwise fully localized, the
    // exact fault renderReason above was rewritten to stop committing.
    // scheduleAlwaysSummary already says it, and already ships in all 83 locales.
    el.textContent = s.scheduleEnabled
      ? `On your schedule · ${s.scheduleStart || "18:00"}–${s.scheduleEnd || "23:00"}`
      : t("scheduleAlwaysSummary", []);
  }

  // The SAME formatter and keys warning.js uses, so one duration reads the same
  // on both platforms.
  function formatTime(minutes) {
    const value = Number(minutes) || 0;
    if (value < 60) return t("timeMinutes", [String(value)]);
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest === 0 ? t("timeHours", [String(hours)]) : t("timeHoursMinutes", [String(hours), String(rest)]);
  }
  function recipeCard(r) {
    const card = el("div", "recipe");
    card.appendChild(el("h4", null, r.title));
    // Named `metaLine`, not `meta`: `meta` is the bridge payload everywhere else
    // in this file, and a second thing wearing that name here is how a reader —
    // and the guard in test/android-block.test.js that checks every `meta.*`
    // block.js reads against the keys getInfo() sends — loses the thread.
    // Two dead references in one line. `recipeTimeLabel` / `recipeCaloriesLabel`
    // are not keys any locale defines, so this rendered those names verbatim on
    // a device; and `r.timeMinutes` / `r.calories` are not fields any catalog
    // entry has (they are `totalMinutes` and `calorieRange`), so both were
    // undefined regardless. Duration now uses warning.js's formatter and keys.
    // The calorie chip is gone: the extension shows none, and this is not a
    // calorie app.
    const metaLine = [formatTime(r.totalMinutes)];
    card.appendChild(el("div", "m", metaLine.join(" · ")));
    if (r.description) card.appendChild(el("div", "note", r.description));
    return card;
  }

  async function renderRecipe() {
    const R = self.FitShieldRecipes;

    if (!R || !R.primeCatalog || !R.selectAlternative) {
      return;
    }

    let doc = null;
    try { doc = await fs.recipes.load(); } catch (e) {}
    if (!doc) return;

    // The SAME shared module and the SAME entry point as the extension block
    // page — extension/warning.js calls selectAlternative with exactly this
    // shape. It used to call R.selectRecipes, which had been deleted from the
    // module; the truthy guard around it meant nothing failed, it just fell
    // through to a fallback that picked by the LENGTH of the brand id. So
    // McDonald's and Starbucks were answered with the same dish, and Domino's
    // with a chicken sandwich, under a comment claiming this was category-aware.
    //
    // Restoring the call was necessary and not sufficient. It was fed
    // `meta.category` — the app GROUPING — plus `meta.type` and
    // `meta.specialties`, neither of which getInfo() returned, so on a real
    // device the selector was asked `fast_food, undefined, undefined` for most of
    // the catalog. Measured at the time: 963 of 1,511 packages received the
    // identical two answers — a bubble-tea shop, a sandwich chain and a burger chain were all
    // answered with microwave nachos and a microwave mug pizza. The only reason
    // that survived review is that the test drove the selector with blocklist
    // entries — a shape the bridge has never produced.
    //
    // The catalog is primed rather than loaded, because the module's own loader
    // needs chrome.runtime or Node's fs and a WebView has neither.
    R.primeCatalog(doc);

    const meta = info();
    const picks = [];
    const seen = new Set();

    // Two ideas, as before — stepped through the same ranking the extension
    // uses rather than pulled from two hardcoded diet buckets.
    for (let rotation = 0; rotation < 6 && picks.length < 2; rotation++) {
      const selection = R.selectAlternative(
        {
          key: meta.brandId,
          category: foodCategory(meta),
          type: meta.foodType,
          specialties: meta.specialties
        },
        {},
        { rotation, seed: meta.brandId }
      );

      if (!selection || !selection.entry || seen.has(selection.entry.id)) {
        continue;
      }

      seen.add(selection.entry.id);
      picks.push(selection.entry);
    }

    if (!picks.length) return;

    $("recipeList").replaceChildren(...picks.map(recipeCard));
    $("recipeWrap").hidden = false;
  }

  // ---- timer + actions ------------------------------------------------------
  function startTimer(seconds, unlockMinutes, appName) {
    const btn = $("openAnyway");
    const open = t("openButton");   // reuse the extension's already-translated "Open"
    const enable = () => {
      btn.disabled = false;
      btn.textContent = `${open} ${appName}`;
    };
    if (reduceMotion || !seconds || seconds <= 0) { enable(); return; }
    let left = seconds;
    btn.disabled = true;
    const tick = () => {
      if (left <= 0) { enable(); return; }
      // Countdown lives in the button label (there is no separate ring); the
      // verb is localized and the app name / seconds stay verbatim.
      btn.textContent = `${open} ${appName} · ${left}s`;
      left -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }

  function start() {
    const meta = info();
    const name = meta.displayName || "this app";
    // TONE is keyed on the app grouping — COPY has one entry per Settings pill,
    // and the grouping is the thing that always resolves to one of them.
    const copy = copyFor(meta.category);
    // The BADGE names what the place is, so it takes the curated category: a
    // bubble-tea shop reads "Tea", not "Fast food". Swapping the COPY table for
    // FitShieldI18n.categoryName fixed the mechanism but kept feeding it the
    // grouping, so on a device that tea shop was still labelled "Fast food".
    $("catLabel").textContent = categoryName(foodCategory(meta)) || copy.label;
    $("title").textContent = copy.title(name);
    $("message").textContent = copy.message;
    // The REASON names the switch that caused the interruption, so it stays on
    // the grouping — AppBlockPolicy.categoryEnabled switches on exactly that, and
    // "Tea apps are blocked" would send the user hunting for a Tea pill that
    // Settings does not offer.
    renderReason(meta.category);
    document.documentElement.classList.add("on"); // warm accent bloom

    applyTheme();
    renderStats();
    renderSchedule();
    renderRecipe();
    startTimer(Number(meta.timerSeconds), Number(meta.unlockMinutes) || 5, name);

    // Localized button labels — reuse the extension's already-translated keys, so
    // non-English users get real translations with no Android-only locale strings.
    $("notNow").textContent = t("warningBackButton");
    $("openFs").textContent = `${t("openButton")} FitShield`;

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
