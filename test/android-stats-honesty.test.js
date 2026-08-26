"use strict";
/**
 * What the Android screens actually say.
 *
 * 0.55 deleted three statistics from the browser extension for being dishonest,
 * and `extension/fitshield-core.js` states the reason where the migration lives:
 * an interruption tells FitShield nothing about whether an order would have
 * happened, so multiplying interruptions by a meal price "would invent a saving
 * out of a page load", and a displayed recipe card is not a calorie anyone
 * avoided. `caloriesAvoided` is kept verbatim — "it is no longer a headline
 * number, but it is their data" — and the one surviving estimate is opt-in and
 * labelled as an assumption.
 *
 * Android shipped all three anyway. Driven through test/helpers/android-webview.js
 * — the real i18n, the real currency module, the real page scripts, over the
 * real markup — the dashboard rendered this:
 *
 *     137                   $3,425              42,000
 *     statusBlockedVisits   Estimated savings   statusCaloriesAvoided
 *
 * Three separate defects in one row, and only the middle column was ever
 * reported. The money was 137 page interruptions times an assumed $25. The
 * calories were an assumed per-meal figure added on every block by
 * FitShieldVpnService.kt and BlockActivity.kt. And the outer two labels printed
 * their own key names, on every device in every language including English,
 * because `statusBlockedVisits` and `statusCaloriesAvoided` stopped existing
 * when the extension's vocabulary was rebuilt — and FitShieldI18n.t() returns
 * the raw key when it cannot resolve one, deliberately, "so a gap stays visible
 * rather than rendering blank". The gap was visible only on a phone.
 *
 * Every assertion below therefore reads rendered output, not source text. A grep
 * for "statusBlockedVisits" finds a correctly-spelled attribute and concludes
 * the label is fine.
 *
 * Runs under `node --test`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadPage } = require("./helpers/android-webview.js");

const ROOT = path.join(__dirname, "..");
const KOTLIN_DIR = path.join(ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield");
const WEB_DIR = path.join(ROOT, "android", "app", "src", "main", "assets", "web");

const read = (file) => fs.readFileSync(file, "utf8");

// CRLF-safe comment stripping. The line pattern carries no end anchor because
// these files use CRLF endings and "." stops at the carriage return, so an
// anchored match never fires and every comment survives the strip — the same
// trap test/android-block.test.js documents.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, " ");

// A device that has been used for a while, with a legacy calorie figure already
// on it. The numbers are deliberately unmistakable: 424,242 appears nowhere by
// accident, and 137 x 37 = 5,069 is the money the old savings tile would show.
const SEEDED = Object.freeze({
  blockedVisits: "137",
  caloriesAvoided: "424242",
  avgMealCost: 37,
  avgMealCalories: 1000,
  mealStatsCustomized: true,
  currency: "USD",
  androidWelcomed: true,
  blockedByDomain: JSON.stringify({ "doordash.com": 9 })
});

const INVENTED = [
  ["the calorie figure", /424[,. ]?242/],
  ["a money total built from interruptions", /5[,. ]?069/]
];

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

test("the Android dashboard presents no number nobody measured", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });
  const screen = page.allText();

  // The observed count is the thing that belongs there, so it must survive.
  assert.match(screen, /\b137\b/, "the dashboard stopped showing the count of interruptions it actually observed");

  for (const [what, pattern] of INVENTED) {
    assert.ok(
      !pattern.test(screen),
      `the Android dashboard still shows ${what}: ${JSON.stringify(screen.slice(0, 400))}`
    );
  }

  // The tiles themselves are gone, not merely blanked. A hidden tile is a tile
  // the next edit turns back on.
  for (const id of ["savings", "calories", "mealCalories"]) {
    assert.equal(
      page.document.getElementById(id),
      null,
      `index.html still declares #${id} — the estimate row was hidden rather than removed`
    );
  }
});

test("the Android pause screen presents no number nobody measured", async () => {
  const page = await loadPage({
    page: "block.html",
    script: "block.js",
    store: { ...SEEDED },
    bridge: {
      getInfo: () =>
        JSON.stringify({
          brandId: "mcdonalds",
          displayName: "McDonald's",
          category: "fast_food",
          foodCategory: "burger",
          foodType: "fast_food",
          specialties: ["burgers"],
          packageId: "com.mcdonalds.app",
          unlockMinutes: 5,
          timerSeconds: 60
        }),
      unlock: () => {},
      openFitShield: () => {}
    }
  });

  const screen = page.allText();

  for (const [what, pattern] of INVENTED) {
    assert.ok(
      !pattern.test(screen),
      `the Android pause screen still shows ${what}: ${JSON.stringify(screen.slice(0, 400))}`
    );
  }

  for (const id of ["savings", "calories"]) {
    assert.equal(
      page.document.getElementById(id),
      null,
      `block.html still declares #${id} — the estimate tiles were hidden rather than removed`
    );
  }
});

// ---------------------------------------------------------------------------
// The user's data
// ---------------------------------------------------------------------------

test("a calorie total already on the phone is left exactly where it is", async () => {
  /*
   * CLAUDE.md §6: never silently reset user data. The extension keeps
   * `caloriesAvoided` verbatim through its migration for precisely this reason,
   * and Android has no migration at all — the value simply sits in
   * SharedPreferences. Rendering the dashboard must not disturb it.
   */
  const store = { ...SEEDED };
  await loadPage({ page: "index.html", script: "app.js", store });

  assert.equal(store.caloriesAvoided, "424242", "opening the Android dashboard changed the stored calorie total");
  assert.equal(store.blockedVisits, "137", "opening the Android dashboard changed the stored interruption count");

  // It must still be reachable by the user's own "Reset stats", or the value is
  // orphaned on the device with no control that can clear it.
  const appJs = stripComments(read(path.join(WEB_DIR, "app.js")));
  const statsList = /const STATS = \[([\s\S]*?)\];/.exec(appJs);
  assert.ok(statsList, "the STATS reset list in app.js is no longer readable by this guard");
  assert.match(
    statsList[1],
    /"caloriesAvoided"/,
    "caloriesAvoided dropped out of the Android reset sweep — a stored value the user can no longer clear"
  );
});

test("neither Android service manufactures a calorie figure any more", () => {
  /*
   * Keeping a number the user can no longer see is not the same as continuing to
   * compute one nobody measured. The stored total stays; the multiplication
   * stops. Both writers have to stop, because either one alone keeps the figure
   * growing invisibly for any future export or migration to present as data.
   */
  for (const file of ["FitShieldVpnService.kt", "BlockActivity.kt"]) {
    const source = stripComments(read(path.join(KOTLIN_DIR, file)));

    assert.ok(
      !/putString\(\s*"caloriesAvoided"/.test(source),
      `${file} still writes caloriesAvoided — an assumed per-meal figure added on every block`
    );
    assert.ok(
      !/"avgMealCalories"/.test(source),
      `${file} still reads avgMealCalories; nothing on Android estimates calories any more`
    );
    assert.ok(
      /putString\(\s*"blockedVisits"/.test(source),
      `${file} stopped recording interruptions, which are an observed event and must still be counted`
    );
  }
});

test("an interrupted app open is counted whether or not the user pushes through", () => {
  /*
   * The pause screen's counter is labelled "Ordering pages interrupted", so it
   * has to count interruptions. It used to increment only inside the skip path,
   * which meant tapping "Open anyway" made the interruption vanish from the
   * user's own record of what happened — the one number on the screen quietly
   * under-reported, in the flattering direction.
   */
  const source = stripComments(read(path.join(KOTLIN_DIR, "BlockActivity.kt")));

  assert.ok(
    /private fun recordInterruption\(\)/.test(source),
    "BlockActivity no longer has a single recordInterruption() writer for the counter"
  );
  assert.ok(
    !/private fun recordSkip\(\)/.test(source),
    "BlockActivity still records only skips, so 'Open anyway' escapes the interruption count"
  );

  // It must be recorded when the pause is PRESENTED, not on the way out of one
  // particular exit.
  const onCreate = /override fun onCreate\([\s\S]*?\n    \}/.exec(source);
  assert.ok(onCreate, "BlockActivity.onCreate is no longer readable by this guard");
  assert.match(
    onCreate[0],
    /recordInterruption\(\)/,
    "the interruption is still recorded on an exit path rather than when the pause is shown"
  );
});

// ---------------------------------------------------------------------------
// Every string the Android UI asks for
// ---------------------------------------------------------------------------

test("no Android label prints its own locale key at the user", async () => {
  /*
   * This is the assertion a source grep cannot make. `data-i18n="statusBlockedVisits"`
   * is spelled perfectly; the key just does not exist, so localizeDocument()
   * writes the key name into the tile and overwrites the English fallback that
   * was sitting there. Four keys in index.html and three more in block.html were
   * in that state, unnoticed, in a shipped preview build.
   */
  const pages = [
    await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } }),
    await loadPage({
      page: "block.html",
      script: "block.js",
      store: { ...SEEDED },
      bridge: {
        getInfo: () =>
          JSON.stringify({
            brandId: "mcdonalds",
            displayName: "McDonald's",
            category: "fast_food",
            foodCategory: "burger",
            foodType: "fast_food",
            specialties: ["burgers"],
            packageId: "com.mcdonalds.app",
            unlockMinutes: 5,
            timerSeconds: 60
          }),
        unlock: () => {},
        openFitShield: () => {}
      }
    })
  ];

  const printed = [];

  for (const page of pages) {
    for (const element of page.document.elements) {
      for (const [dataset, key] of Object.entries(element.dataset)) {
        if (!dataset.startsWith("i18n")) continue;

        // The resolver is the real one, over the real bundled locale files.
        const resolved = page.context.FitShieldI18n.t(key);

        if (resolved === key) {
          printed.push(key);
        }
      }
    }
  }

  assert.deepEqual(
    [...new Set(printed)].sort(),
    [],
    "these keys have no string in any bundled locale, so the Android UI renders their names verbatim"
  );
});

test("every string the Android page scripts ask for resolves", async () => {
  /*
   * The markup half of the same defect's other half: `t("recipeTimeLabel", …)`
   * and `t("recipeCaloriesLabel", …)` in app.js and block.js resolved to
   * nothing, so each alternative card's meta line read
   * "recipeTimeLabel · recipeCaloriesLabel" on a device.
   */
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });
  const unresolved = new Set();

  for (const file of ["app.js", "block.js"]) {
    const source = stripComments(read(path.join(WEB_DIR, file)));

    for (const match of source.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) {
      const key = match[1];
      if (page.context.FitShieldI18n.t(key) === key) unresolved.add(`${file}: ${key}`);
    }
  }

  assert.deepEqual([...unresolved].sort(), [], "these t() calls render their own key name on a device");
});

// ---------------------------------------------------------------------------
// The surface that was empty for a different reason
// ---------------------------------------------------------------------------

test("the Android alternatives browser lists the canonical catalog", async () => {
  /*
   * Found while proving the statistics defect, and the same shape of bug: the
   * dashboard called `fitshield.recipes.load()`, which resolves the WHOLE
   * catalog document, and then called `.slice(0, 24)` on it. An object has no
   * `.slice`, so renderRecipes() rejected — inside an async function nobody
   * awaited, so there was no crash and no log, just a permanently empty panel.
   * `loadEntries()` is the accessor that returns the flat array.
   */
  const page = await loadPage({ page: "index.html", script: "app.js", store: { ...SEEDED } });
  const list = page.document.getElementById("recipeList");

  assert.ok(list, "index.html no longer has a #recipeList for the alternatives browser");
  assert.ok(
    list.childNodes.length > 0,
    "the Android alternatives browser rendered nothing — check which recipes accessor app.js calls"
  );

  const catalog = JSON.parse(read(path.join(ROOT, "data", "recipes.json")));
  const first = (catalog.recipes || [])[0];
  assert.ok(first && first.title, "data/recipes.json has no first recipe to check the browser against");
  assert.ok(
    page.text("recipeList").includes(first.title),
    `the alternatives browser does not list ${JSON.stringify(first.title)} from the canonical catalog`
  );
});
