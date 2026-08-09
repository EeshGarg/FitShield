"use strict";
/**
 * Locale tests.
 *
 * The invariant enforced here is "nothing renders blank or broken", NOT "every
 * locale has every key". Those are different things, and only the first one is
 * true of the runtime:
 *
 *   - a key missing from a locale falls back to English — chrome.i18n falls back
 *     to default_locale, and i18n.js falls back to its cached English map, so
 *     the string renders in English rather than blank;
 *   - a key present in a locale but NOT in English can never be displayed, and
 *     is a bug (usually a half-applied rename), so it is still a failure;
 *   - a message that IS translated must be non-empty, must not use Chrome's
 *     named-placeholder syntax, and must take the same positional arguments as
 *     English, or it will render with holes in it;
 *   - a message that IS translated must correspond to the English text that is
 *     in the tree TODAY. A translation of retired English is the one state the
 *     fallback cannot rescue — the key is defined, so nothing can substitute the
 *     current English, and the locale renders a sentence the product no longer
 *     says. `learnMoreLink` shipped that way in all 82 locales;
 *   - an English sentence copied into a locale file is not a translation. It
 *     renders exactly like the fallback, but it counts as translated and so is
 *     never offered to a translator again.
 *
 * `npm run validate:locales` reports the untranslated-key debt per locale.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// _locales lives in the browser-extension source tree (packaged at the zip root).
const localesDir = path.join(__dirname, "..", "extension", "_locales");
const readLocale = (code) => JSON.parse(fs.readFileSync(path.join(localesDir, code, "messages.json"), "utf8"));
const en = readLocale("en");
const enKeys = Object.keys(en).sort();
const enSet = new Set(enKeys);
const dirs = fs.readdirSync(localesDir).filter((d) => fs.existsSync(path.join(localesDir, d, "messages.json")));

// Chrome treats $name$ as a named placeholder that must be declared. Positional
// $1..$9 are fine. Any $name$ (including accidental $1$2 adjacency) fails to load.
const NAMED_PLACEHOLDER = /\$[A-Za-z0-9_@]+\$/;

test("there is at least the English base locale", () => {
  assert.ok(dirs.includes("en"));
  assert.ok(enKeys.length > 0);
});

test("no locale defines a key English does not have", () => {
  for (const loc of dirs) {
    const extra = Object.keys(readLocale(loc)).filter((key) => !enSet.has(key));
    assert.deepEqual(extra, [], `${loc} defines keys that can never be shown: ${extra.join(", ")}`);
  }
});

test("every message present in a locale is usable", () => {
  for (const loc of dirs) {
    const data = readLocale(loc);
    for (const [key, entry] of Object.entries(data)) {
      assert.equal(typeof entry.message, "string", `${loc}.${key} message is a string`);
      assert.ok(entry.message.length > 0, `${loc}.${key} is non-empty`);
      assert.ok(!NAMED_PLACEHOLDER.test(entry.message), `${loc}.${key} has no $name$ placeholder ("${entry.message}")`);
    }
  }
});

test("placeholder sets match English for every key a locale does define", () => {
  const positional = (s) => (s.match(/\$[1-9]/g) || []).sort().join(",");

  for (const loc of dirs) {
    if (loc === "en") continue;
    const data = readLocale(loc);
    for (const key of Object.keys(data)) {
      if (!enSet.has(key)) continue;
      assert.equal(positional(data[key].message), positional(en[key].message), `${loc}.${key} placeholder set`);
    }
  }
});

test("no locale ships an English wording the product has retired", () => {
  // The specific regression. Each of these was found live in the corpus: English
  // had moved on, the locales had not, and because the key WAS defined neither
  // fallback path could correct it. `learnMoreLink` is the worst of them — every
  // non-English block page ended with "Visit fitshield.net" while English said
  // "About FitShield". Pinned by exact string so no future edit can reintroduce
  // the wording, whatever the digest baseline says.
  const localeParity = require("../tools/locale-parity.js");
  const retired = localeParity.RETIRED_ENGLISH;

  assert.ok(Object.keys(retired).length > 0, "the retired-wording list must not be empty");

  const offenders = [];
  for (const loc of dirs) {
    if (loc === "en") continue;
    const data = readLocale(loc);
    for (const [key, wordings] of Object.entries(retired)) {
      if (data[key] && wordings.includes(data[key].message)) {
        offenders.push(`${loc}.${key} = ${JSON.stringify(data[key].message)}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `retired English wording still shipping:\n  ${offenders.join("\n  ")}`);

  // And the English side really has moved on, so the pins stay meaningful rather
  // than quietly pinning the current text.
  for (const [key, wordings] of Object.entries(retired)) {
    if (en[key]) {
      assert.ok(
        !wordings.includes(en[key].message),
        `${key} is pinned as retired but English still says it — remove the pin or the pin is wrong`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The canonical vocabulary
// ---------------------------------------------------------------------------
//
// One name per concept, decided once and recorded in docs/LOCALIZATION.md. The
// tests below are the guard that keeps the decision, because the failure mode is
// not a bug report — it is a second writer reaching for a reasonable synonym a
// year later, and nobody noticing until a buyer reads two words for one thing on
// one screen. Every rule here corresponds to a row of the table in that document.

test("a retired synonym never reappears anywhere in English", () => {
  // RETIRED_ENGLISH pins each wording the product has dropped. The existing
  // check asks whether a LOCALE still ships one. This asks the other question:
  // whether English itself has drifted back — a rename half-applied, or a new
  // key written with the old vocabulary because that is what the neighbouring
  // screen still said when it was copied.
  const retired = new Map();
  for (const [key, wordings] of Object.entries(require("../tools/locale-parity.js").RETIRED_ENGLISH)) {
    wordings.forEach((wording) => retired.set(wording, key));
  }

  const offenders = [];
  for (const [key, entry] of Object.entries(en)) {
    if (retired.has(entry.message)) {
      offenders.push(`${key} = ${JSON.stringify(entry.message)} (retired as ${retired.get(entry.message)})`);
    }
  }

  assert.deepEqual(offenders, [], `English has reintroduced retired wording:\n  ${offenders.join("\n  ")}`);

  // The same rule one level up, for the synonyms that were never a whole string
  // — the ones a new writer reaches for because they are ordinary English and
  // nothing on screen says which word this product chose. Each maps to a row of
  // the table in docs/LOCALIZATION.md. Key NAMES are exempt: `statusBypassActive`
  // is an identifier, and renaming identifiers is not a copy decision.
  // Inflected deliberately: "Bypasses used" slipped straight past a `\bbypass\b`
  // when this rule was mutation-tested, which is exactly how a synonym gets in.
  const BANNED = [
    [/\btemporary access\b/i, 'say "temporary pass"'],
    [/\bby-?passe?(s|d|ing)?\b/i, 'say "temporary pass"'],
    [/\bexceptions?\b/i, 'say "temporary pass"'],
    [/\b(white|allow|black)[- ]?lists?\b/i, 'say "blocklist", or name what is blocked'],
    [/\bsnooze?(s|d|ing)?\b/i, 'say "turn off all blocking"']
  ];

  const banned = [];
  for (const [key, entry] of Object.entries(en)) {
    for (const [pattern, advice] of BANNED) {
      if (pattern.test(entry.message)) {
        banned.push(`${key} = ${JSON.stringify(entry.message)} — ${advice}`);
      }
    }
  }

  assert.deepEqual(banned, [], `synonym for a concept that already has a name:\n  ${banned.join("\n  ")}`);
});

test('"pause" means the block-page countdown and nothing else', () => {
  // It used to mean three things at once: the countdown, switching ALL blocking
  // off ("Pause everything for 30 minutes"), and un-blocking a single country
  // ("Blocking — click to pause"). A user could not tell which was which, and
  // two of the three were reachable from the same screen.
  const COUNTDOWN_KEYS = new Set([
    "statusShieldUp",
    "welcomeDeliveryBody",
    "timerRemainingAnnounce",
    "timerDoneAnnounce",
    "warningLockedHint",
    "repeatFrictionNote",
    "frictionSummary",
    "frictionCustomSummary",
    "repeatFrictionLabel",
    "repeatFrictionHint",
    "onboardingPreviewBody"
  ]);

  const offenders = Object.entries(en)
    .filter(([key, entry]) => /\bpaus(e|ed|es|ing)\b/i.test(entry.message) && !COUNTDOWN_KEYS.has(key))
    .map(([key, entry]) => `${key} = ${JSON.stringify(entry.message)}`);

  assert.deepEqual(
    offenders,
    [],
    `"pause" is reserved for the block-page countdown. Use "turn off all blocking" for the global override ` +
      `and "not blocking" for a country/category:\n  ${offenders.join("\n  ")}`
  );

  // And the reservation is only meaningful while the countdown really does use
  // the word, so the allowlist cannot quietly empty out.
  assert.ok(/\bpause\b/i.test(en.timerRemainingAnnounce.message), "the countdown announcement still says 'pause'");
});

test("blocking a country or category has exactly one pair of words", () => {
  // Two widgets sit on the same Settings screen for the same data: the search
  // result rows and the pinned quick-access chips. They had four labels between
  // them — "Blocking"/"Block" and "On"/"Off" — with tooltips introducing a fifth
  // and sixth ("Blocking — click to pause", "Paused — click to block").
  assert.equal(en.mbOn.message, en.mbBlocking.message, "the chip's ON word must be the result row's ON word");
  assert.equal(en.mbOff.message, en.mbBlock.message, "the chip's OFF word must be the result row's OFF word");

  assert.ok(en.mbChipToggleOnTitle.message.startsWith(en.mbBlocking.message), "the ON tooltip opens with the ON word");
  assert.ok(en.mbChipToggleOffTitle.message.startsWith(en.mbBlock.message), "the OFF tooltip opens with the OFF word");

  // "On"/"Off" alone never said what was on, which is why the pair moved to
  // words that name the thing being switched.
  assert.match(en.mbBlocking.message, /block/i);
  assert.match(en.mbBlock.message, /block/i);
});

test("the product calls itself FitShield in every status sentence", () => {
  // One popup line, four subjects: "Inactive.", "Blocker is on", "Blocker is
  // armed", and "Shield up." They are four branches of the same sentence, so a
  // user switching states saw the product rename itself.
  const offenders = Object.entries(en)
    .filter(([, entry]) => /\bblocker is\b|\bshield up\b|\barmed\b/i.test(entry.message))
    .map(([key, entry]) => `${key} = ${JSON.stringify(entry.message)}`);

  assert.deepEqual(offenders, [], `the subject is always "FitShield":\n  ${offenders.join("\n  ")}`);

  for (const key of ["statusInactive", "statusAllDisabled", "statusOutsideSchedule", "statusShieldUp"]) {
    assert.match(en[key].message, /^FitShield is (on|off)\b/, `${key} states FitShield's state in its own name`);
  }
});

test("the rolling seven-day window has one name on both surfaces", () => {
  // Settings said "This week", the popup said "Last 7 days", and the empty state
  // said "the last seven days" — three names for one call to weeklyRecap. The
  // first of them also implied a calendar week that resets on Monday.
  assert.equal(en.recapHeading.message, en.popupRecapTitle.message, "Settings and the popup name the same window");

  const offenders = Object.entries(en)
    .filter(([, entry]) => /\bthis week\b|\blast seven days\b|\bweekly\b/i.test(entry.message))
    .map(([key, entry]) => `${key} = ${JSON.stringify(entry.message)}`);

  assert.deepEqual(offenders, [], `the window is "${en.recapHeading.message}":\n  ${offenders.join("\n  ")}`);
});

test("the statistic verbs stay distinct: interrupted, continued, selected, made", () => {
  // "Made" is the only event in the whole vocabulary the user personally
  // confirmed, and the optional savings estimate is built on it alone. So the
  // button that merely SELECTS an alternative may not use that verb — it used to
  // read "I'll make this", which put the confirmed-event word on an unconfirmed
  // action one screen before the confirmation was asked for.
  for (const key of ["alternativeChooseButton", "alternativeChosenButton", "recapSelected"]) {
    assert.doesNotMatch(en[key].message, /\bmade\b|\bmake\b/i, `${key} names selection, not the confirmed event`);
  }

  for (const key of ["recapMade", "popupMarkMade", "popupMarkMadeButton", "estimateBasis", "estimateBasisOne"]) {
    assert.match(en[key].message, /\bmade\b|\bmake\b/i, `${key} names the event the user confirmed`);
  }

  // The other three verbs each keep their own surface.
  assert.match(en.recapInterrupted.message, /interrupted/i);
  assert.match(en.recapContinued.message, /continued/i);
  assert.match(en.recapLeft.message, /left/i);
});

test("English is spelled American, and blocklist is one word", () => {
  // The file mixed both: "Save as a favourite" on the block page, "Theme colors"
  // in Settings, and "favorites" on the What's New page rendered from
  // changelog.json — three registers a buyer reads in one sitting.
  const BRITISH = /\b\w*(favourite|summaris|cancelled|colour|behaviour|organis|recognis|analys|centre|licence)\w*\b/i;
  const british = Object.entries(en)
    .filter(([, entry]) => BRITISH.test(entry.message))
    .map(([key, entry]) => `${key} = ${JSON.stringify(entry.message)}`);

  assert.deepEqual(british, [], `American spelling, please:\n  ${british.join("\n  ")}`);

  const twoWords = Object.entries(en)
    .filter(([, entry]) => /\bblock lists?\b/i.test(entry.message))
    .map(([key]) => key);

  assert.deepEqual(twoWords, [], `"blocklist" is one word: ${twoWords.join(", ")}`);
});

test("headings and buttons are sentence case", () => {
  // They alternated down a single page — "Your Stats", then "How much friction",
  // then "Customize Blocklist" — and the split mapped exactly onto old versus
  // newly written sections, so the page advertised which parts were bolted on.
  const PROPER = new Set([
    "FitShield",
    "URL",
    "URLs",
    "JSON",
    "KB",
    "Chrome",
    "FS",
    "Engine",
    "Settings",
    "I",
    "Buy",
    "Me",
    "Coffee",
    "B2B"
  ]);

  // Names are not headings: a category and a language are Title Case because
  // that is how a name is written.
  const isPageChrome = (key) => /(Heading|Button|Title)$/.test(key) && !/^catLabel|^language/.test(key);

  const offenders = [];
  for (const [key, entry] of Object.entries(en)) {
    if (!isPageChrome(key)) continue;
    entry.message
      .split(/[\s—–/&(),.:?!"']+/)
      .filter(Boolean)
      .slice(1)
      .forEach((word) => {
        if (/^[A-Z]/.test(word) && !PROPER.has(word)) {
          offenders.push(`${key} = ${JSON.stringify(entry.message)} — "${word}"`);
        }
      });
  }

  assert.deepEqual(offenders, [], `sentence case, not Title Case:\n  ${offenders.join("\n  ")}`);
});

test("no generated string papers over grammar with a (s) suffix", () => {
  // "1 time window(s) set." is programmer shorthand a user can see, and it is
  // untranslatable: most languages cannot express an optional plural that way,
  // so all 82 locale files inherited a construct they could not render.
  const offenders = Object.entries(en)
    .filter(([, entry]) => /\(s\)|\(es\)/i.test(entry.message))
    .map(([key, entry]) => `${key} = ${JSON.stringify(entry.message)}`);

  assert.deepEqual(
    offenders,
    [],
    `use a singular/plural key pair like unitMinute/unitMinutes:\n  ${offenders.join("\n  ")}`
  );

  // The pairs this replaced really are pairs, and the singular arm writes the
  // number out rather than taking it as a placeholder.
  for (const [one, many] of [
    ["scheduleWindowsSummaryOne", "scheduleWindowsSummary"],
    ["estimateBasisOne", "estimateBasis"],
    ["searchMatchSuffixOne", "searchMatchSuffix"]
  ]) {
    assert.ok(en[one], `${one} exists`);
    assert.ok(en[many], `${many} exists`);
    assert.match(en[one].message, /\b1\b/, `${one} states the count in words rather than substituting it`);
  }
});

test("the continue panel never promises something its own buttons undo", () => {
  // The subtitle read "FitShield stays on for everything else" directly above
  // two buttons that switch it off for everything.
  assert.doesNotMatch(
    en.passSubtitle.message,
    /stays on for everything else/i,
    "two of the six options are scope 'all', so this claim was false for them"
  );

  // Both scope tags are named, so the panel points at the distinction rather
  // than asserting one side of it.
  for (const key of ["passScopeSite", "passScopeAll"]) {
    assert.ok(en[key], `${key} exists`);
  }

  for (const key of ["passAllThirtyMinutes", "passAllUntilTomorrow"]) {
    assert.match(en[key].message, /all blocking/i, `${key} says it covers all blocking, not just this site`);
  }
});

test("the block page's tab title and its heading are the same headline", () => {
  // A user who tabs away and back read "Take a Breath" on the tab and "Take a
  // moment." on the page.
  const stripped = en.warningTitle.message.replace(/[.!?]+$/, "");
  assert.equal(
    en.warningPageTitle.message,
    stripped,
    "the tab title is the heading without its terminal punctuation"
  );
});

test("every category the shipped blocklists carry has a display name", () => {
  // Settings and the block page both render category ids. Without a label,
  // `prettifyCategory` title-cases the id — which is right for "fast_casual" and
  // wrong for "b2b_marketplace", and is English in every locale either way.
  const dir = path.join(__dirname, "..", "extension", "blocklists");
  const found = new Set();

  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const entries = Array.isArray(parsed) ? parsed : parsed.entries || parsed.sites || parsed.brands || [];
    entries.forEach((entry) => {
      if (entry && entry.category) found.add(entry.category);
    });
  }

  assert.ok(found.size > 10, `expected many categories in the blocklists, found ${found.size}`);

  const pascal = (id) =>
    String(id)
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");

  const missing = [...found].filter((id) => !enSet.has(`catLabel${pascal(id)}`)).sort();

  assert.deepEqual(missing, [], `categories with no catLabel key: ${missing.join(", ")}`);
});

test("no translation outlives the English text it was made from", () => {
  // The general form of the same bug. tools/locale-source-baseline.json records
  // the English each surviving translation was cut against; when an English
  // string changes, its digest changes and every locale still translating the
  // old wording is reported. This is what `learnMoreLink` needed and did not have.
  const prune = require("../tools/locale-prune.js");
  const baseline = prune.readBaseline();

  assert.ok(Object.keys(baseline).length > 0, "no English source baseline recorded — the guard is inert");

  // A key nobody translates needs no baseline entry (nothing can be stale). A key
  // somebody DOES translate must be watched, or the guard has a hole exactly
  // where the translations are.
  const anyLocaleHas = new Set();
  dirs.filter((loc) => loc !== "en").forEach((loc) => Object.keys(readLocale(loc)).forEach((key) => anyLocaleHas.add(key)));

  const translated = enKeys.filter((key) => anyLocaleHas.has(key));
  const unwatched = translated.filter((key) => !Object.prototype.hasOwnProperty.call(baseline, key));

  assert.deepEqual(
    unwatched,
    [],
    `translated keys with no recorded English source (run \`node tools/locale-prune.js --baseline\`): ${unwatched.join(", ")}`
  );

  const stale = prune.staleTranslations();
  const summary = [...stale.entries()].map(([key, codes]) => `${key} (${codes.length} locales)`);

  assert.deepEqual(
    summary,
    [],
    `English changed after these were translated; re-translate or run \`node tools/locale-prune.js --apply\`:\n  ${summary.join("\n  ")}`
  );
});

test("restyling English capitalisation does not throw away its translations", () => {
  // The stale-translation guard asks "does the English still SAY what it said?".
  // Letter case is not part of what a sentence says: every language capitalises
  // by its own rules regardless of ours, so "Your Stats" -> "Your stats"
  // invalidates nothing. Treating it as a rewrite would have deleted roughly
  // 1,400 real translations across the eighteen keys this repository restyled in
  // one pass — human work destroyed to record a change of capital letter.
  const prune = require("../tools/locale-prune.js");

  assert.equal(
    prune.digest("Backup & Restore"),
    prune.digest("Backup & restore"),
    "a case-only edit must not mark translations stale"
  );

  // And nothing looser than that. A changed word, a dropped clause, moved
  // punctuation — each of those is the failure `learnMoreLink` shipped without.
  assert.notEqual(prune.digest("About FitShield"), prune.digest("Visit fitshield.net"));
  assert.notEqual(prune.digest("Take a moment"), prune.digest("Take a breath"));
  assert.notEqual(prune.digest("$1 time windows set."), prune.digest("$1 time window set."));
  assert.notEqual(prune.digest("You can continue."), prune.digest("You can continue"));
});

test("a key written ahead of its page script is declared, not hidden", () => {
  // Locale files and page scripts have different owners, so a string cannot land
  // in both at once. Without a way to say "this has no reader YET", the two
  // halves deadlock — which is how sixteen customer-visible diagnostics
  // sentences stayed hardcoded in English inside diagnostics.js, unreachable by
  // any locale. An English entry may therefore name its consumer in its own
  // description, and that marker is the ONLY thing it excuses.
  const prune = require("../tools/locale-prune.js");
  const staged = prune.stagedKeys();

  // Every marker names a real file, or it would exempt its key forever.
  assert.deepEqual(
    prune.stagedInvalid(),
    [],
    "a [staged: …] marker names a file that does not exist in extension/"
  );

  for (const [key, file] of staged) {
    assert.ok(enSet.has(key), `${key} is staged but not defined in English`);
    assert.match(
      en[key].description || "",
      prune.STAGED_MARKER,
      `${key}'s marker must live in its English description, where a reviewer reads it`
    );
  }

  // Staging suppresses the unused-key scan and nothing else: a staged key is
  // still parity-checked, still placeholder-checked, and still offered to
  // translators, so it cannot be used to smuggle a string past review.
  const parity = require("../tools/locale-parity.js")();
  assert.deepEqual(parity.errors, [], `staged keys must not silence any error:\n  ${parity.errors.join("\n  ")}`);

  for (const [key] of staged) {
    assert.ok(
      parity.warnings.some((warning) => warning.includes(`"${key}" is staged`)),
      `${key} must be reported on every validation run until its consumer catches up`
    );
  }
});

test("an English sentence copied into a locale is not filed as a translation", () => {
  // Including the Chrome Web Store description, which is the first thing a
  // shopper in that language sees. English-in-place renders identically to the
  // fallback, so removing it costs nothing and stops the coverage figure — and
  // the store listing — claiming a translation that was never made.
  const prune = require("../tools/locale-prune.js");
  const copies = prune.englishCopies();
  const summary = [...copies.entries()].map(([key, codes]) => `${key} (${codes.length} locales)`);

  assert.deepEqual(summary, [], `English filed as translation:\n  ${summary.join("\n  ")}`);

  const storeKeys = ["appDescription", "appName", "actionTitle"];
  for (const loc of dirs) {
    if (loc === "en") continue;
    const data = readLocale(loc);
    for (const key of storeKeys) {
      if (data[key] && en[key]) {
        const { isEnglishPhrase } = require("../tools/locale-hybrid-audit.js");
        assert.ok(
          !(data[key].message === en[key].message && isEnglishPhrase(en[key].message)),
          `${loc}.${key} is the English sentence verbatim — the store would list ${loc} as translated`
        );
      }
    }
  }
});

test("a copied English sentence is refused, a real translation that matches is not", () => {
  // The rule has to tell prose from a name, or it would demand that translators
  // invent differences: Italian really does call it "Pizza".
  const { isEnglishPhrase } = require("../tools/locale-hybrid-audit.js");

  for (const prose of [
    "Turn every built-in group on or off at once.",
    "FitShield browser extension that helps you stay mindful of food delivery and fast-food ordering.",
    "That file isn't a valid FitShield backup.",
    "About FitShield"
  ]) {
    assert.ok(isEnglishPhrase(prose), `should be treated as English prose: ${prose}`);
  }

  for (const name of ["FitShield", "Pizza", "Buy Me a Coffee", "Fast Casual", "Filipino / Tagalog", "System default"]) {
    assert.ok(!isEnglishPhrase(name), `should be allowed to match English: ${name}`);
  }
});

test("a rename cannot leave the old key alive behind a longer one", () => {
  // How the dead key hid: the unused-key scan asked whether the source text
  // CONTAINS "warningTriggeredBy", and it did — inside "warningTriggeredByPrefix",
  // the key that replaced it. 82 translations of a sentence nothing could render
  // survived a release that way.
  const prune = require("../tools/locale-prune.js");

  assert.equal(prune.referenced('t("warningTriggeredByPrefix")', "warningTriggeredBy"), false);
  assert.equal(prune.referenced('t("warningTriggeredByPrefix")', "warningTriggeredByPrefix"), true);
  assert.equal(prune.referenced('data-i18n="learnMoreLink"', "learnMoreLink"), true);

  const unused = prune.unusedKeys();
  assert.deepEqual(unused, [], `English keys no source references (node tools/locale-prune.js --apply): ${unused.join(", ")}`);
});

test("the block page's own strings all exist in English", () => {
  // The runtime falls back to English, so English is the one locale that must be
  // complete. This proves every key the redesigned block page asks for is there.
  const warningJs = fs.readFileSync(path.join(__dirname, "..", "extension", "warning.js"), "utf8");
  const used = new Set();

  for (const match of warningJs.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) {
    used.add(match[1]);
  }
  for (const match of warningJs.matchAll(/labelKey:\s*"([A-Za-z0-9_]+)"/g)) {
    used.add(match[1]);
  }
  for (const match of warningJs.matchAll(/(?:scopeKey|Key):\s*"([A-Za-z0-9_]+)"/g)) {
    used.add(match[1]);
  }

  assert.ok(used.size > 20, `expected the block page to use many strings, found ${used.size}`);

  const missing = [...used].filter((key) => !enSet.has(key));
  assert.deepEqual(missing, [], `block page uses English strings that do not exist: ${missing.join(", ")}`);
});

test("every message key a page script names by hand exists in English", () => {
  // The gap this closes, twice over. backup.js shipped seven actionable import
  // failures — "that backup was written by a newer version of FitShield", "that
  // file is empty" — under keys that existed in NO locale, English included. `t`
  // returns the key when a message is missing, so the settings page rendered
  // "backupErrorNewerFormat" at a user who had just tried to restore their only
  // copy of their settings. settings.js had three more (confirmImportBackup,
  // importCancelledNotice, exportErrorNotice) and had to carry hand-written
  // English fallbacks through `tOr` to stay readable.
  //
  // English is the one locale that must be complete, because every other locale
  // falls back to it. So the check is: every key a script names as a literal is
  // in en/messages.json. Keys the code COMPOSES (`catLabel${pascal}`,
  // `diet_${...}`) are template literals, not double-quoted strings, and are
  // deliberately out of scope here — tools/locale-prune.js exempts them by
  // prefix and re-verifies each construction site instead.
  const scripts = [
    "backup.js",
    "settings.js",
    "preferences.js",
    "popup.js",
    "welcome.js",
    "warning.js",
    "whats-new.js",
    "diagnostics.js"
  ];

  const patterns = [
    // t("key") and t("key", [subs])
    /\bt\(\s*"([A-Za-z0-9_]+)"/g,
    // t(count === 1 ? "unitSite" : "unitSites") — both arms are real keys
    /\bt\(\s*[^()]*?\?\s*"([A-Za-z0-9_]+)"\s*:\s*"([A-Za-z0-9_]+)"/g,
    // tOr("key", "English fallback") — settings.js, often across two lines
    /\btOr\(\s*"([A-Za-z0-9_]+)"/g,
    // backupError("key", "English sentence", [subs]) — backup.js
    /\bbackupError\(\s*"([A-Za-z0-9_]+)"/g,
    // Keys carried in data tables rather than passed straight to `t`
    /\b(?:labelKey|titleKey|scopeKey|noticeKey|messageKey)\s*:\s*"([A-Za-z0-9_]+)"/g
  ];

  const missing = [];
  let total = 0;

  for (const script of scripts) {
    const source = fs.readFileSync(path.join(__dirname, "..", "extension", script), "utf8");
    const used = new Set();

    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        match.slice(1).filter(Boolean).forEach((key) => used.add(key));
      }
    }

    total += used.size;
    [...used].filter((key) => !enSet.has(key)).forEach((key) => missing.push(`${script}: ${key}`));
  }

  // A floor, so a refactor that breaks the patterns fails loudly instead of
  // passing vacuously with nothing to check.
  assert.ok(total > 150, `expected the page scripts to name many strings, found ${total}`);
  assert.deepEqual(missing, [], `scripts name English strings that do not exist:\n  ${missing.join("\n  ")}`);
});

test("every backup and import failure reason is a real English string", () => {
  // The specific regression, pinned by key rather than by scan, so a rewrite of
  // the scan above cannot quietly stop covering them. Each of these was rendered
  // to a user as its own key. The placeholder counts are pinned too: backup.js
  // passes the substitutions positionally, so a message that drops or adds a
  // placeholder renders with a hole in it or leaks an unfilled $2.
  const expected = {
    backupErrorNotBackup: 0,
    backupErrorNewerFormat: 1,
    backupErrorNoSettings: 0,
    backupErrorEmptyFile: 0,
    backupErrorTooLarge: 2,
    backupErrorInvalidJson: 0,
    backupErrorValidatorMissing: 0,
    confirmImportBackup: 1,
    importCancelledNotice: 0,
    exportErrorNotice: 0
  };

  const highest = (message) =>
    (message.match(/\$[1-9]/g) || []).reduce((max, token) => Math.max(max, Number(token.slice(1))), 0);

  for (const [key, placeholders] of Object.entries(expected)) {
    assert.ok(en[key], `${key} is missing from English — it would render as its own key`);
    assert.equal(highest(en[key].message), placeholders, `${key} takes ${placeholders} placeholder(s)`);
  }

  // And the sources really do still ask for them, so the pins cannot outlive the
  // code — a key removed from backup.js should be removed here, not left frozen.
  const backupJs = fs.readFileSync(path.join(__dirname, "..", "extension", "backup.js"), "utf8");
  const settingsJs = fs.readFileSync(path.join(__dirname, "..", "extension", "settings.js"), "utf8");
  const sources = `${backupJs}\n${settingsJs}`;

  for (const key of Object.keys(expected)) {
    assert.ok(new RegExp(`\\b${key}\\b`).test(sources), `${key} is pinned but no source asks for it`);
  }

  // The confirmation names what an import destroys beyond the settings it
  // replaces. Those two clauses are the whole reason the prompt exists.
  assert.match(en.confirmImportBackup.message, /temporary pass/i);
  assert.match(en.confirmImportBackup.message, /did you make it/i);
});

test("HTML data-i18n attributes all resolve in English", () => {
  // Enumerated, not listed: diagnostics.html was localized after this test was
  // written and a hardcoded page list would not have covered it.
  const extensionDir = path.join(__dirname, "..", "extension");
  const pages = fs.readdirSync(extensionDir).filter((name) => name.endsWith(".html")).sort();
  const missing = [];

  assert.ok(pages.length >= 5, `expected several extension pages, found ${pages.length}`);

  for (const page of pages) {
    const html = fs.readFileSync(path.join(extensionDir, page), "utf8");
    for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) {
      if (!enSet.has(match[1])) {
        missing.push(`${page}: ${match[1]}`);
      }
    }
  }

  assert.deepEqual(missing, [], `pages reference missing English strings:\n  ${missing.join("\n  ")}`);
});

test("inline HTML fallback text is compared against English, not just the key", () => {
  // `data-i18n` makes the inline text a FALLBACK: it is what the page paints
  // before i18n.js runs, and what anyone reading the markup believes the product
  // says. When English moves and the markup does not, the two disagree — and
  // every other check here passes, because the KEY still resolves. The audit
  // reports the gap as debt (the fix is a markup edit, not a locale edit); this
  // proves the comparison is real in both directions.
  const localeParity = require("../tools/locale-parity.js");
  const drift = localeParity.htmlFallbackDrift(en);

  drift.forEach((entry) => {
    assert.ok(enSet.has(entry.key), `${entry.key} is reported but is not an English key`);
    assert.notEqual(entry.text, entry.english, `${entry.page}:${entry.line} was reported despite matching`);
    assert.equal(entry.english, en[entry.key].message, "the English quoted is the English in the tree");
  });

  // Nothing that DOES match may be reported, or the signal is noise. Checked
  // against the markup itself rather than a fixture, so it stays true as pages
  // are edited.
  const reported = new Set(drift.map((entry) => `${entry.page}:${entry.line}:${entry.key}`));
  const extensionDir = path.join(__dirname, "..", "extension");
  const decode = (text) =>
    text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");

  let agreements = 0;

  for (const page of fs.readdirSync(extensionDir).filter((name) => name.endsWith(".html"))) {
    fs.readFileSync(path.join(extensionDir, page), "utf8")
      .split("\n")
      .forEach((line, index) => {
        const pattern = /<([a-z0-9]+)\b[^>]*\bdata-i18n="([A-Za-z0-9_]+)"[^>]*>([^<]*)<\/\1>/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const key = match[2];
          const text = decode(match[3]).trim();
          if (!text || !en[key] || text !== en[key].message) continue;
          agreements += 1;
          assert.ok(
            !reported.has(`${page}:${index + 1}:${key}`),
            `${page}:${index + 1} ${key} matches English but was reported as drift`
          );
        }
      });
  }

  assert.ok(agreements > 50, `expected many pages to agree with English already, found ${agreements}`);
});

test("a missing translation falls back to English rather than rendering blank", () => {
  // Exercise the real i18n module the pages load, with a locale that is missing
  // a key, and prove the English string comes back.
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "i18n.js"), "utf8");
  const sandbox = { console, fetch: () => Promise.reject(new Error("no network in tests")) };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = { querySelectorAll: () => [] };
  sandbox.fitshield = {
    storage: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    runtime: { getURL: (p) => p },
    i18n: { getMessage: () => "", getUILanguage: () => "en" }
  };

  vm.runInContext(source, vm.createContext(sandbox), { filename: "i18n.js" });

  const i18n = sandbox.FitShieldI18n;
  assert.ok(i18n, "i18n.js must define FitShieldI18n");

  // With no host getMessage and no fetched locale, a key resolves to itself
  // rather than an empty string — a gap stays visible instead of blank.
  assert.equal(i18n.t("someMissingKey"), "someMissingKey");
  assert.equal(i18n.t(""), "");
});

test("the translator worklist tool reports the real gap", () => {
  const localeStatus = require("../tools/locale-status.js");
  const { enKeys, rows } = localeStatus.status();

  assert.equal(enKeys.length, Object.keys(en).length);
  assert.equal(rows.length, dirs.length - 1, "every non-English locale is reported");

  rows.forEach((row) => {
    assert.equal(row.translated + row.missing, enKeys.length, `${row.code} accounting does not add up`);
    assert.ok(row.percent >= 0 && row.percent <= 100);
  });
});

test("a merged translation cannot drop or invent a placeholder", () => {
  // This is the failure that renders a string with a hole in it, so the merge
  // refuses it rather than writing it. Exercised against a temp copy so the real
  // locale files are untouched.
  const os = require("node:os");
  const localeStatus = require("../tools/locale-status.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-locale-"));
  const file = path.join(dir, "worklist.json");

  // Pick a real English key that takes a placeholder.
  const key = Object.keys(en).find((name) => /\$1/.test(en[name].message));
  assert.ok(key, "the English locale should have at least one placeholder string");

  // And a worklist handed back with the English sentence pasted into the box —
  // the way `appDescription` became "translated" in 33 locales.
  const phrase = Object.keys(en).find((name) => {
    const { isEnglishPhrase } = require("../tools/locale-hybrid-audit.js");
    return isEnglishPhrase(en[name].message) && !/\$[1-9]/.test(en[name].message);
  });
  assert.ok(phrase, "the English locale should have at least one prose string");

  fs.writeFileSync(
    file,
    JSON.stringify({
      locale: "de",
      strings: {
        [key]: { english: en[key].message, translation: "no placeholder here" },
        [phrase]: { english: en[phrase].message, translation: en[phrase].message },
        notARealKey: { english: "x", translation: "y" }
      }
    })
  );

  const before = fs.readFileSync(path.join(localesDir, "de", "messages.json"), "utf8");
  const errors = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => errors.push(args.join(" "));
  console.log = () => {};

  try {
    localeStatus.merge("de", file);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }

  const after = fs.readFileSync(path.join(localesDir, "de", "messages.json"), "utf8");
  assert.equal(after, before, "a rejected worklist must not modify the locale file");
  assert.ok(errors.some((line) => /placeholders differ/.test(line)), "the placeholder loss is reported");
  assert.ok(errors.some((line) => /not an English key/.test(line)), "an unknown key is reported");
  assert.ok(
    errors.some((line) => /identical to the English sentence/.test(line)),
    "English handed back as its own translation is reported"
  );
});

test("locale coverage is reported, not silently ignored", () => {
  // The audit must surface untranslated keys as warnings so the debt is visible.
  const localeParity = require("../tools/locale-parity.js");
  const reporter = localeParity();

  assert.deepEqual(reporter.errors, [], `locale audit errors:\n  ${reporter.errors.join("\n  ")}`);
  assert.ok(
    reporter.notes.some((note) => /translated/.test(note)),
    "the audit must report translation coverage"
  );
});
