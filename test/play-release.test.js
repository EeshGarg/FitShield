"use strict";
/**
 * Google Play release claims — every line of the checklist that a machine can
 * check, checked.
 *
 * CLAUDE.md §5: "no claim in the product or its docs that the code does not
 * honour." `docs/PLAY_STORE_RELEASE_CHECKLIST.md` was the clearest counterexample
 * in the repository. It was prose with ✅ marks: it asserted that things were
 * true rather than recording how anyone could tell, and it rotted exactly the way
 * prose rots.
 *
 * What it was saying when this file was written:
 *
 *   - "1,545 verified packages covering 1,474 brands; 777 no_app; 283
 *     shared_app; only 38 needs_review" against a catalog holding 1,511 packages
 *     over 1,445 brands, 757, 266 and 36. Five numbers, five wrong, and the
 *     sentence around them claimed coverage was "fully researched".
 *   - a target API level Play stops accepting five days after the rewrite.
 *   - two defects filed under "Known non-blockers": IPv6-only networks losing
 *     all connectivity while the filter ran, and protection not surviving a
 *     reboot. Both were fixed the same week — which is the proof they were never
 *     non-blockers, only unowned.
 *
 * So the checklist now carries evidence, and this is the evidence. The rules:
 *
 *   1. Numbers are asserted against the DATA and the BUILD FILES, never against
 *      another document. A data change is a documentation change.
 *   2. Claims about behaviour are asserted BIDIRECTIONALLY wherever a defect is
 *      described. A document may not claim a limitation the code no longer has,
 *      and may not drop one that comes back. Both halves fail here.
 *   3. Every checkbox must carry either machine evidence or the word HUMAN. A
 *      line that carries neither is prose again, and prose is what failed.
 *
 * Deliberately not asserted: anything about Google's policy that only Google
 * knows. Policy dates and requirements are quoted with their source and a
 * verification date; what IS asserted is that the repository agrees with what the
 * checklist says about the repository.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const readJson = (...parts) => JSON.parse(read(...parts));
const exists = (...parts) => fs.existsSync(path.join(ROOT, ...parts));

// --- documents -------------------------------------------------------------

const CHECKLIST = read("docs", "PLAY_STORE_RELEASE_CHECKLIST.md");
const PRIVACY = read("docs", "PRIVACY_POLICY_ANDROID_NOTES.md");
const LISTING = read("docs", "STORE_LISTING_DRAFT.md");
const ANDROID_DOC = read("docs", "ANDROID.md");

// --- the build, the manifest, the code -------------------------------------

const APP_GRADLE = read("android", "app", "build.gradle");
const ROOT_GRADLE = read("android", "build.gradle");
const WRAPPER = read("android", "gradle", "wrapper", "gradle-wrapper.properties");
const MANIFEST_XML = read("android", "app", "src", "main", "AndroidManifest.xml");
const A11Y_CONFIG = read("android", "app", "src", "main", "res", "xml", "accessibility_service_config.xml");
const BUILD_ANDROID = read("tools", "build-android.js");
const ANDROID_AUDIT = read("tools", "android-audit.js");
const GITIGNORE = read(".gitignore");

const ANDROID_INDEX = read("android", "app", "src", "main", "assets", "web", "index.html");
const ANDROID_APP_JS = read("android", "app", "src", "main", "assets", "web", "app.js");
const ANDROID_BLOCK_JS = read("android", "app", "src", "main", "assets", "web", "block.js");
const TUN2FILTER = read("android", "app", "src", "main", "java", "com", "usha", "fitshield", "Tun2Filter.kt");

/**
 * XML comments in this manifest deliberately NAME permissions the app refuses to
 * request ("Deliberately NOT requested: PACKAGE_USAGE_STATS, QUERY_ALL_PACKAGES…").
 * Every check below runs against the comment-stripped form, or that documentation
 * would read as a declaration — the same trap `tools/android-audit.js` avoids.
 */
const MANIFEST = MANIFEST_XML.replace(/<!--[\s\S]*?-->/g, "");

const manifestJson = readJson("extension", "manifest.json");
const bundle = readJson("data", "generated", "android-packages.json");
const recipes = readJson("data", "recipes.json");
const delivery = readJson("data", "blocklists", "delivery.json");
const fastFood = readJson("data", "blocklists", "fast-food.json");

const brandEntries = [...delivery.entries, ...fastFood.entries];

// --- helpers ---------------------------------------------------------------

/** Prose writes 2,505; data holds 2505. Accept the way a human would write it. */
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Markdown hard-wraps, so a quoted string is routinely split across lines — and
 * inside a blockquote each of those lines starts with "> ". Strip the markers
 * before collapsing, or a phrase that wraps mid-sentence reads as absent and the
 * assertion passes on the wrong evidence.
 */
const flat = (text) => text.replace(/^[ \t]*>[ \t]?/gm, "").replace(/\s+/g, " ");

function assertQuotes(where, document, value, what) {
  assert.ok(
    flat(document).includes(flat(value)),
    `${where} does not quote the ${what} the repository actually holds:\n  ${value}\n` +
      "Update the document — the code changed, so the documentation must."
  );
}

/**
 * One checklist item: the `- [ ]` line plus every continuation line beneath it.
 * A continuation is indented or blank; anything starting at column 0 ends it.
 */
function checklistItems(markdown) {
  const items = [];
  let current = null;

  for (const line of markdown.split("\n")) {
    if (/^\s*- \[[ x]\]/.test(line)) {
      if (current) items.push(current);
      current = [line];
    } else if (current) {
      if (/^\s+\S/.test(line) || line.trim() === "") {
        current.push(line);
      } else {
        items.push(current);
        current = null;
      }
    }
  }

  if (current) items.push(current);
  return items.map((lines) => ({ head: lines[0].trim(), text: lines.join("\n") }));
}

/** The rows of the markdown table that starts with `header`, as raw lines. */
function tableRows(document, header) {
  const start = document.indexOf(header);
  assert.ok(start >= 0, `no table found with the header row: ${header}`);

  const rows = [];
  // slice(2): skip the header row and the |---|---| separator beneath it.
  for (const line of document.slice(start).split("\n").slice(2)) {
    if (!line.trimStart().startsWith("|")) break;
    rows.push(line.trim());
  }
  return rows;
}

/**
 * A document with its blockquotes removed.
 *
 * Used ONLY for "this wording must no longer appear" checks. The checklist
 * deliberately quotes the two sentences it used to get wrong — "the connection
 * filter currently drops IPv6", "Reboot VPN auto-restart is intentionally
 * manual" — so that nobody re-derives them as tradeoffs. Quoting a past mistake
 * is not making the claim, and a negative check that cannot tell the difference
 * would force the history to be deleted to stay green.
 */
const withoutQuotes = (document) =>
  document
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");

// --- derived truth ---------------------------------------------------------

const COMPILE_SDK = Number(APP_GRADLE.match(/compileSdk\s+(\d+)/)[1]);
const TARGET_SDK = Number(APP_GRADLE.match(/targetSdk\s+(\d+)/)[1]);
const MIN_SDK = Number(APP_GRADLE.match(/minSdk\s+(\d+)/)[1]);
const APPLICATION_ID = APP_GRADLE.match(/applicationId\s+'([^']+)'/)[1];
const JDK = APP_GRADLE.match(/sourceCompatibility\s+JavaVersion\.VERSION_(\d+)/)[1];
const AGP = ROOT_GRADLE.match(/id\s+'com\.android\.application'\s+version\s+'([\d.]+)'/)[1];
const KOTLIN = ROOT_GRADLE.match(/id\s+'org\.jetbrains\.kotlin\.android'\s+version\s+'([\d.]+)'/)[1];
const GRADLE = WRAPPER.match(/gradle-([\d.]+)-bin\.zip/)[1];

const DECLARED_PERMISSIONS = [
  ...new Set(
    [...MANIFEST.matchAll(/<uses-permission[^>]*android:name="android\.permission\.([A-Z_0-9]+)"/g)].map((m) => m[1])
  )
].sort();

const BRANDS = brandEntries.length;
const PORTED = bundle.brands.length;
const WITH_PACKAGE = bundle.brands.filter((b) => (b.packageIds || []).length > 0).length;
const PACKAGES = Object.keys(bundle.packages).length;
const NO_APP = bundle.brands.filter((b) => b.packageStatus === "no_app").length;
const SHARED_APP = bundle.brands.filter((b) => b.packageStatus === "shared_app").length;
const NEEDS_REVIEW = bundle.brands.filter((b) => b.packageStatus === "needs_review").length;

const PORTED_IDS = new Set(bundle.brands.map((b) => b.brandId));
const UNPORTED = brandEntries.filter((e) => !PORTED_IDS.has(e.domain)).sort((a, b) => a.domain.localeCompare(b.domain));

const ALTERNATIVES = recipes.recipes.length + recipes.quickAlternatives.length;

// ---------------------------------------------------------------------------
// The format itself — this is what stops the file becoming prose again
// ---------------------------------------------------------------------------

test("every checklist line carries evidence or is marked HUMAN", () => {
  const items = checklistItems(CHECKLIST);
  assert.ok(items.length > 40, `only ${items.length} checklist items parsed; the format must have changed`);

  const bare = items
    .filter((item) => !/HUMAN/.test(item.text) && !/_Evidence:/.test(item.text))
    .map((item) => item.head);

  assert.deepEqual(
    bare,
    [],
    "these checklist lines assert something with nothing behind them. Either name the test or " +
      "tool that proves it, or mark it HUMAN with the exact action:\n  " +
      bare.join("\n  ")
  );
});

test("every test the checklist cites as evidence exists", () => {
  /*
   * The other half of the format rule. Requiring the word "_Evidence:" only
   * buys something if the thing it names is real — and one inherited line
   * credited `tools/android-audit.js` with a dev-URL check that audit has never
   * performed. A citation to a test that does not exist is worse than no
   * citation, because it reads as verified.
   */
  const testNames = new Set();
  for (const file of ["play-release.test.js", "docs-claims.test.js"]) {
    const source = read("test", file);
    for (const match of source.matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)) {
      testNames.add(match[1]);
    }
  }
  assert.ok(testNames.size > 50, `only ${testNames.size} test names parsed; the parsing must have broken`);

  const cited = new Set();
  // Each evidence note runs from "_Evidence:" to its closing "._"; a note may
  // cite more than one test ("… › \"a\" and \"b\"").
  for (const chunk of flat(CHECKLIST).split("_Evidence:").slice(1)) {
    const note = chunk.slice(0, chunk.indexOf("._") + 1 || 400);
    for (const match of note.matchAll(/"([^"]+)"/g)) cited.add(match[1]);
  }
  assert.ok(cited.size > 15, `only ${cited.size} evidence citations parsed; the format must have changed`);

  const phantom = [...cited].filter((name) => !testNames.has(name)).sort();
  assert.deepEqual(
    phantom,
    [],
    "the checklist cites these as evidence, and no test by that name exists:\n  " +
      phantom.join("\n  ") +
      "\nEither the test was renamed and the citation was not, or the citation was never real."
  );
});

test("the checklist still carries its sources and the date they were read", () => {
  // A policy claim with no source is a rumour, and Play policy moves. Deleting
  // the sourcing is the cheapest way for this file to quietly become prose again.
  assert.ok(
    CHECKLIST.includes("2026-08-26"),
    "the checklist no longer records when its Play policy statements were verified"
  );

  const sources = CHECKLIST.match(/https:\/\/support\.google\.com\/googleplay\/android-developer\/answer\/\d+/g) || [];
  assert.ok(
    new Set(sources).size >= 5,
    `only ${new Set(sources).size} distinct Play policy sources are cited; the checklist had 6 when written`
  );
});

// ---------------------------------------------------------------------------
// Build configuration — the doc may not state one thing while gradle sets another
// ---------------------------------------------------------------------------

test("the applicationId the checklist names is the one the build sets", () => {
  // Play identity. It can never change after first publish, so a doc naming a
  // different one is not a typo, it is a different app.
  assert.ok(
    CHECKLIST.includes(`\`applicationId ${APPLICATION_ID}\``),
    `docs/PLAY_STORE_RELEASE_CHECKLIST.md does not name the applicationId the build sets (${APPLICATION_ID})`
  );
  assert.ok(
    CHECKLIST.includes(`\`${APPLICATION_ID}\``),
    `the checklist header no longer names ${APPLICATION_ID}`
  );
});

test("the checklist states the SDK level the build actually sets", () => {
  assert.equal(
    COMPILE_SDK,
    TARGET_SDK,
    `compileSdk ${COMPILE_SDK} and targetSdk ${TARGET_SDK} disagree; the checklist claims they match`
  );

  assert.ok(
    CHECKLIST.includes(`\`compileSdk ${COMPILE_SDK}\` / \`targetSdk ${TARGET_SDK}\``),
    `docs/PLAY_STORE_RELEASE_CHECKLIST.md does not state the SDK level android/app/build.gradle sets ` +
      `(compileSdk ${COMPILE_SDK} / targetSdk ${TARGET_SDK}). This is the single number a Play submission is ` +
      "rejected over; it may not drift."
  );

  // The API-36 bump table's "From" column has to describe where the build IS,
  // or the instructions are for somebody else's repository.
  assertQuotes(
    "the checklist's API-36 bump table",
    CHECKLIST,
    `\`compileSdk ${COMPILE_SDK}\`, \`targetSdk ${TARGET_SDK}\``,
    "current SDK level"
  );
});

test("the checklist names the target-API deadline in force", () => {
  // Verified against Google's own page on 2026-08-26. Pinned because losing it
  // is how a submission gets planned around a level Play no longer accepts.
  for (const claim of ["31 August 2026", "API 36", "1 November 2026"]) {
    assert.ok(
      CHECKLIST.includes(claim),
      `docs/PLAY_STORE_RELEASE_CHECKLIST.md no longer states "${claim}" — the target-API gate is the ` +
        "reason this checklist exists at all"
    );
  }
});

test("the checklist states the minSdk the build sets", () => {
  assert.ok(
    CHECKLIST.includes(`\`minSdk ${MIN_SDK}\``),
    `the checklist does not state the minSdk android/app/build.gradle sets (${MIN_SDK})`
  );
});

test("the checklist states the toolchain versions the repository pins", () => {
  assert.ok(
    CHECKLIST.includes(`AGP ${AGP} / Gradle ${GRADLE} / Kotlin ${KOTLIN} / JDK ${JDK}`),
    `the checklist claims a toolchain the repository does not pin. It pins AGP ${AGP}, Gradle ${GRADLE}, ` +
      `Kotlin ${KOTLIN}, JDK ${JDK}.`
  );

  // The bump table tells the build lane what to change FROM.
  assertQuotes("the checklist's API-36 bump table", CHECKLIST, `AGP \`${AGP}\``, "current AGP version");
  assertQuotes("the checklist's API-36 bump table", CHECKLIST, `Gradle \`${GRADLE}\``, "current Gradle version");
});

test("the app carries no native code, so the 16 KB page-size rule is satisfied by construction", () => {
  /*
   * Play's 16 KB requirement bites from 1 February 2027, and only on apps that
   * ship native libraries. Google's wording: an app written only in Java/Kotlin
   * "already supports 16 KB devices".
   *
   * That is a claim about THIS app, so it is checked rather than quoted: the
   * moment an NDK dependency arrives, this fails and the checklist stops being
   * allowed to say the rule is free.
   */
  const nativeFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (["build", ".gradle", ".idea"].includes(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (/\.(so|a)$/.test(entry.name)) {
        nativeFiles.push(path.relative(ROOT, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(ROOT, "android"));

  assert.deepEqual(
    nativeFiles,
    [],
    `the Android app now ships native libraries: ${nativeFiles.join(", ")}. The 16 KB page-size rule is no ` +
      "longer free — re-check the checklist's claim and align them to 16 KB."
  );

  for (const marker of ["externalNativeBuild", "ndkVersion", "jniLibs", "CMakeLists"]) {
    assert.ok(
      !APP_GRADLE.includes(marker),
      `android/app/build.gradle now configures ${marker}; the 16 KB claim in the checklist needs re-checking`
    );
  }

  assert.ok(CHECKLIST.includes("16 KB"), "the checklist no longer covers the 16 KB page-size requirement");
});

// ---------------------------------------------------------------------------
// Versioning and the artefact Play actually takes
// ---------------------------------------------------------------------------

test("the Android build takes its versionName from the canonical manifest", () => {
  assert.ok(
    /-PfitshieldVersionName=\$\{version\}/.test(BUILD_ANDROID),
    "tools/build-android.js no longer injects the version, so Android can drift from the extension"
  );
  assert.ok(
    /load\.manifest\(\)\.version/.test(BUILD_ANDROID),
    "tools/build-android.js no longer reads the canonical extension manifest for the version"
  );
  assert.ok(
    /findProperty\('fitshieldVersionName'\)/.test(APP_GRADLE),
    "android/app/build.gradle no longer reads the injected fitshieldVersionName"
  );

  // The hand-run bundle command in §3 hardcodes a version. It has to be THIS one.
  assert.ok(
    CHECKLIST.includes(`-PfitshieldVersionName=${manifestJson.version}`),
    `the checklist's release-bundle command names a version other than the shipped ${manifestJson.version}`
  );
});

test("the checklist does not claim a release-bundle command the tooling does not have", () => {
  /*
   * Play takes an AAB. `npm run build:android` builds a DEBUG APK — the word
   * "release" appears nowhere in its Gradle invocation. The checklist therefore
   * spells the bundle out as a hand-run command and marks it HUMAN.
   *
   * Bidirectional on purpose: when a bundle task is added to the tooling, this
   * fails, and the checklist has to stop telling the operator to do it by hand.
   */
  const toolingBuildsBundle = /bundleRelease/.test(BUILD_ANDROID);
  const checklistSaysManual = CHECKLIST.includes("no repository command does this");

  assert.ok(
    /assembleDebug/.test(BUILD_ANDROID),
    "tools/build-android.js no longer builds the debug APK the checklist describes"
  );

  if (toolingBuildsBundle) {
    assert.ok(
      !checklistSaysManual,
      "tools/build-android.js can now produce a release bundle — the checklist still tells the operator " +
        "there is no repository command for it. Replace the manual §3 steps with the command."
    );
  } else {
    assert.ok(
      checklistSaysManual,
      "nothing in the tooling produces a release bundle, but the checklist no longer says so. A reader " +
        "will run `npm run build:android` and upload a debug APK."
    );
  }
});

// ---------------------------------------------------------------------------
// Permissions — the table is a promise, and Play reads it
// ---------------------------------------------------------------------------

test("the permission table names exactly the permissions the manifest declares", () => {
  const rows = tableRows(CHECKLIST, "| Permission | Why | What the user sees |");
  const named = rows.map((row) => {
    const match = row.match(/^\|\s*`([A-Z_0-9]+)`\s*\|/);
    assert.ok(match, `a permission table row does not start with a backticked permission name: ${row}`);
    return match[1];
  });

  assert.deepEqual(
    [...named].sort(),
    DECLARED_PERMISSIONS,
    "the checklist's permission table and AndroidManifest.xml disagree. Adding a permission without a row " +
      "hides it from the reviewer notes; leaving a row behind claims one the app no longer needs."
  );

  assert.ok(
    /<queries>/.test(MANIFEST),
    "the manifest no longer uses a scoped <queries>; the checklist claims it does instead of QUERY_ALL_PACKAGES"
  );
});

test("the audit allowlist and the manifest agree on the permission set", () => {
  // Two independent statements of the same fact. When they disagree, one of them
  // is stopping `npm run validate` from meaning anything.
  const block = ANDROID_AUDIT.match(/const APPROVED_PERMISSIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, "tools/android-audit.js no longer declares an APPROVED_PERMISSIONS set");

  const approved = [...block[1].matchAll(/"android\.permission\.([A-Z_0-9]+)"/g)].map((m) => m[1]).sort();

  assert.deepEqual(
    approved,
    DECLARED_PERMISSIONS,
    "tools/android-audit.js's allowlist and AndroidManifest.xml disagree. Whichever moved first, the other " +
      "has to follow in the same change — otherwise `npm run validate` either fails on a legitimate " +
      "permission or waves through one nobody approved."
  );
});

test("no permission is present that would pull in a further Play declaration form", () => {
  /*
   * Each of these triggers its own Play Console declaration and review. Their
   * absence is what makes the checklist's declaration list as short as it is —
   * so their absence is the thing to assert, not the list's length.
   */
  const triggers = [
    "QUERY_ALL_PACKAGES",
    "READ_SMS",
    "SEND_SMS",
    "RECEIVE_SMS",
    "READ_CALL_LOG",
    "WRITE_CALL_LOG",
    "PROCESS_OUTGOING_CALLS",
    "MANAGE_EXTERNAL_STORAGE",
    "ACCESS_BACKGROUND_LOCATION",
    "READ_MEDIA_IMAGES",
    "READ_MEDIA_VIDEO",
    "SCHEDULE_EXACT_ALARM",
    "USE_EXACT_ALARM",
    "USE_FULL_SCREEN_INTENT",
    "BODY_SENSORS",
    "PACKAGE_USAGE_STATS",
    "AD_ID"
  ];

  const present = triggers.filter((name) => MANIFEST.includes(name));

  assert.deepEqual(
    present,
    [],
    `the manifest now requests ${present.join(", ")}. Each of these needs its own Play Console declaration ` +
      "and review — add it to the checklist §7 before it is discovered at submission time."
  );
});

test("the docs say whether the app can actually post a notification", () => {
  /*
   * `POST_NOTIFICATIONS` is declared in the manifest and requested nowhere. On
   * Android 13+ a runtime permission that is never requested is denied, so
   * `notify()` is a no-op — which the app's own `RestoreNotice` comment admits.
   *
   * The foreground-service notification going missing is cosmetic (the OS still
   * shows the VPN key and a Task Manager entry). The boot-restore notice going
   * missing is not: it is the whole fallback for "the device restarted but VPN
   * consent has lapsed", and without it the user is silently unprotected again.
   *
   * Bidirectional, so the docs cannot describe a prompt that does not exist —
   * and cannot keep warning about one once the request lands.
   */
  const javaDir = path.join(ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield");
  const sources = fs
    .readdirSync(javaDir)
    .filter((f) => /\.(kt|java)$/.test(f))
    .map((f) => fs.readFileSync(path.join(javaDir, f), "utf8"))
    .concat(ANDROID_APP_JS, read("android", "app", "src", "main", "assets", "web", "block.js"))
    .join("\n")
    // A comment explaining that the permission is NOT requested must not read as
    // a request.
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

  const requestsIt =
    /requestPermissions\s*\(/.test(sources) ||
    /RequestPermission\s*\(\s*\)/.test(sources) ||
    /POST_NOTIFICATIONS/.test(sources);

  const declaresIt = DECLARED_PERMISSIONS.includes("POST_NOTIFICATIONS");
  assert.ok(declaresIt, "POST_NOTIFICATIONS is no longer declared; the permission table and this test must follow");

  const docsWarn = /declared and never requested/.test(CHECKLIST);

  if (requestsIt) {
    assert.ok(
      !docsWarn,
      "the app now requests notification permission at runtime — delete the warning from the checklist §5 and " +
        "put the runtime prompt back in the permission table"
    );
  } else {
    assert.ok(
      docsWarn,
      "nothing in the app requests POST_NOTIFICATIONS, so on Android 13+ it is denied and every notification " +
        "the app posts is a no-op — including the boot-restore notice that is the only fallback when VPN " +
        "consent has lapsed. The checklist no longer says so."
    );
    assert.ok(
      !/\|\s*`POST_NOTIFICATIONS`\s*\|[^|]*\|\s*runtime prompt\s*\|/.test(CHECKLIST),
      "the permission table still promises a runtime prompt for POST_NOTIFICATIONS. There is none."
    );
  }
});

test("the overlay permission draws nothing, which is the strongest thing to tell a reviewer", () => {
  /*
   * `SYSTEM_ALERT_WINDOW` is held for one reason: on Android 10+ an app that has
   * it may start an activity from the background, which is what lets the pause
   * screen appear over a blocked app. FitShield never draws over anything.
   *
   * That is a much better answer to a reviewer than a justification for an
   * overlay would be — but only while it stays true, so it is checked. The day
   * something calls WindowManager.addView, the claim has to change with it.
   */
  const javaDir = path.join(ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield");
  const offenders = [];

  for (const file of fs.readdirSync(javaDir).filter((f) => /\.(kt|java)$/.test(f))) {
    const source = fs.readFileSync(path.join(javaDir, file), "utf8");
    source.split("\n").forEach((line, index) => {
      if (/TYPE_APPLICATION_OVERLAY|TYPE_SYSTEM_ALERT|WindowManager[^.]*\.addView|\.addView\(/.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `the app now creates an overlay window (${offenders.join(", ")}). Every document says it never draws over ` +
      "another app and holds the permission only for the background-activity-launch exemption. Rewrite the " +
      "reviewer-facing justification before this ships."
  );

  assert.ok(
    /Settings\.canDrawOverlays/.test(read("android", "app", "src", "main", "java", "com", "usha", "fitshield", "WebAppBridge.kt")),
    "nothing checks canDrawOverlays any more; the app-blocking panel's overlay status indicator must have moved"
  );
});

test("every specialUse foreground service declares the subtype the checklist quotes", () => {
  /*
   * `specialUse` is the only foreground-service type reviewed by hand, and the
   * reviewer reads the free-form subtype string out of the manifest. The
   * checklist tells the operator to paste those strings into the Console — so
   * they have to be the strings the manifest actually holds.
   */
  const services = MANIFEST.split(/<service\b/)
    .slice(1)
    .map((chunk) => chunk.split(/<\/service>/)[0]);

  const specialUse = services.filter((s) => /foregroundServiceType="specialUse"/.test(s));
  assert.ok(specialUse.length > 0, "no specialUse foreground service found; the checklist declares two");

  const subtypes = [];
  for (const service of specialUse) {
    const name = (service.match(/android:name="\.([A-Za-z]+)"/) || [])[1] || "(unnamed)";
    const property = service.match(/PROPERTY_SPECIAL_USE_FGS_SUBTYPE"[\s\S]{0,300}?android:value="([^"]+)"/);

    assert.ok(
      property,
      `${name} declares foregroundServiceType="specialUse" with no PROPERTY_SPECIAL_USE_FGS_SUBTYPE. ` +
        "Play reviews specialUse by hand and rejects it without a justification."
    );

    subtypes.push([name, property[1]]);
  }

  for (const [name, value] of subtypes) {
    assertQuotes(
      "docs/PLAY_STORE_RELEASE_CHECKLIST.md",
      CHECKLIST,
      value,
      `specialUse justification for ${name}`
    );
  }
});

// ---------------------------------------------------------------------------
// The two most scrutinised declarations on the store
// ---------------------------------------------------------------------------

test("the accessibility service reads only what the disclosure says it reads", () => {
  assert.ok(
    /canRetrieveWindowContent="false"/.test(A11Y_CONFIG),
    "the AccessibilityService can now retrieve window content. Every disclosure in every document says it " +
      "cannot — that is a promise about screen content, messages and passwords."
  );

  assert.ok(
    !/isAccessibilityTool\s*=\s*"true"/.test(A11Y_CONFIG),
    "the service now claims isAccessibilityTool=\"true\". That flag is only for apps whose core function is " +
      "directly supporting people with disabilities; FitShield is not one, and claiming it is a policy violation."
  );

  assert.ok(
    /android:description=/.test(A11Y_CONFIG),
    "the AccessibilityService has no description, so system Accessibility settings show the user nothing"
  );

  for (const [where, document] of [
    ["docs/PLAY_STORE_RELEASE_CHECKLIST.md", CHECKLIST],
    ["docs/PRIVACY_POLICY_ANDROID_NOTES.md", PRIVACY]
  ]) {
    assert.ok(
      document.includes('canRetrieveWindowContent="false"'),
      `${where} no longer cites the configuration that backs its "reads no screen content" claim`
    );
    assert.ok(
      document.includes("isAccessibilityTool"),
      `${where} no longer explains that isAccessibilityTool is deliberately not claimed — a reviewer will ask`
    );
  }
});

test("the accessibility disclosure the docs quote is the text the app shows", () => {
  /*
   * Google requires the prominent disclosure to be inside the app. The checklist
   * quotes it to a reviewer, so the quote has to be real: a disclosure that
   * exists only in the release paperwork is exactly the failure the policy is
   * written against.
   */
  const disclosure = "It only reads which app comes to the front — never screen content";

  assert.ok(
    ANDROID_APP_JS.includes(disclosure),
    "the app-blocking panel no longer shows the disclosure sentence the checklist quotes to Play. " +
      "If the wording moved, move the quote with it — do not delete the assertion."
  );

  assertQuotes("docs/PLAY_STORE_RELEASE_CHECKLIST.md", CHECKLIST, disclosure, "in-app accessibility disclosure");

  // The system-settings description is the second place a user meets it.
  const strings = read("android", "app", "src", "main", "res", "values", "strings.xml");
  assert.ok(
    /never screen content/.test(strings),
    "accessibility_description no longer tells the user, inside system Accessibility settings, that " +
      "FitShield reads no screen content"
  );
});

test("the accessibility disclosure is available in the languages the app ships", () => {
  /*
   * `accessibility_description` is the text Android shows on the screen where a
   * user grants the service — the single moment Google's prominent-disclosure
   * rule is actually being tested against a real person. It lives in
   * res/values/strings.xml, and there is no res/values-<lang>/ directory, while
   * the APK bundles 83 translated locales for its own UI.
   *
   * Bidirectional: while the gap exists the checklist must name it; once the
   * strings are translated the line has to go.
   */
  const resDir = path.join(ROOT, "android", "app", "src", "main", "res");
  const translated = fs
    .readdirSync(resDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^values-[a-z]{2}/.test(entry.name)).length;

  const bundledLocales = fs
    .readdirSync(path.join(ROOT, "android", "app", "src", "main", "assets", "web", "_locales"), {
      withFileTypes: true
    })
    .filter((entry) => entry.isDirectory()).length;

  assert.ok(bundledLocales > 1, "the APK no longer bundles multiple locales; this comparison has lost its point");

  const checklistNamesGap = /English-only/.test(CHECKLIST);

  if (translated > 0) {
    assert.ok(
      checklistNamesGap === false,
      `res/ now carries ${translated} translated string set(s) — drop the English-only disclosure line from ` +
        "the checklist §7.2"
    );
  } else {
    assert.ok(
      checklistNamesGap,
      `the APK ships ${bundledLocales} UI locales but res/ has no translated strings at all, so the system ` +
        "Accessibility settings disclosure is English-only for every one of them. The checklist no longer says so."
    );
    // The gap is only persuasive because of how wide it is, so the width is a
    // number, and a number in a document is a number this file checks.
    assert.ok(
      flat(CHECKLIST).includes(`bundles **${bundledLocales}** translated locales`),
      `the checklist states a different locale count than the APK bundles (${bundledLocales})`
    );
  }
});

test("the checklist carries the organization-account requirement VpnService forces", () => {
  const usesVpnService = /BIND_VPN_SERVICE/.test(MANIFEST);

  if (usesVpnService) {
    assert.ok(
      /organization/i.test(CHECKLIST),
      "the app declares a VpnService, which Google requires an ORGANIZATION developer account for. The " +
        "checklist no longer says so, and a personal account cannot be converted later."
    );
    assert.ok(
      CHECKLIST.includes("D-U-N-S"),
      "the checklist no longer mentions the D-U-N-S number an organization account needs"
    );
    assert.ok(
      /VpnService/.test(CHECKLIST),
      "the checklist no longer covers the mandatory VpnService declaration form"
    );
  } else {
    assert.ok(
      !/D-U-N-S/.test(CHECKLIST),
      "the app no longer uses VpnService — the organization-account requirement no longer applies and the " +
        "checklist should stop demanding it"
    );
  }
});

// ---------------------------------------------------------------------------
// Data safety — the form must match what the app keeps
// ---------------------------------------------------------------------------

test("the Data safety answers match the statistics the app actually keeps", () => {
  const statIds = [...ANDROID_INDEX.matchAll(/<div class="v" id="([A-Za-z]+)">/g)].map((m) => m[1]);

  assert.deepEqual(
    statIds,
    ["visits"],
    `the Android dashboard renders ${statIds.length} statistic tile(s): ${statIds.join(", ")}. Every document ` +
      "says it keeps one counter. 0.55 deleted the savings and calorie tiles for a stated reason — an " +
      "interruption says nothing about whether an order would have happened — so a new tile is a claim to justify."
  );

  for (const dead of ["calories", "savings", "estimate"]) {
    assert.ok(
      !new RegExp(`id="${dead}"`).test(ANDROID_INDEX),
      `the Android dashboard renders an id="${dead}" element again; the Data safety notes say no such figure ` +
        "is computed or stored"
    );
  }

  assert.ok(
    /Does your app collect or share any of the required user data types\? \| \*\*No\*\*/.test(PRIVACY),
    "docs/PRIVACY_POLICY_ANDROID_NOTES.md no longer gives an unambiguous No to Play's collection question"
  );

  assert.ok(
    /ordering pages interrupted/i.test(PRIVACY),
    "the Data safety notes no longer name the one counter the app keeps"
  );
});

test("nothing the app stores can leave the device through Android's own backup", () => {
  /*
   * This is the fact that makes "nothing leaves the device" survive contact with
   * a skeptic. Without allowBackup="false", Android's automatic cloud backup
   * copies the app's SharedPreferences — settings and statistics — to the user's
   * Google Drive, and a Data safety form answering "no data collected" would be
   * wrong through no fault of the app's own code.
   */
  assert.ok(
    /android:allowBackup="false"/.test(MANIFEST),
    "the manifest no longer sets allowBackup=\"false\", so Android will back the app's private preferences up " +
      "to Google Drive. Every no-data-leaves-the-device claim in the docs and the Data safety form depends on this."
  );

  assert.ok(
    PRIVACY.includes('allowBackup="false"'),
    "docs/PRIVACY_POLICY_ANDROID_NOTES.md no longer cites allowBackup=\"false\" as the reason its Data safety " +
      "answer holds"
  );
});

test("no analytics, telemetry or advertising dependency has appeared", () => {
  const deps = [...APP_GRADLE.matchAll(/(?:implementation|api)\s+'([^']+)'/g)].map((m) => m[1]);
  const suspicious = deps.filter((d) =>
    /firebase|crashlytics|analytics|appcenter|sentry|bugsnag|amplitude|mixpanel|admob|play-services-ads|facebook/i.test(
      d
    )
  );

  assert.deepEqual(
    suspicious,
    [],
    `the Android app now depends on ${suspicious.join(", ")}. The Data safety answer is "no data collected"; ` +
      "these libraries collect data by existing."
  );
});

// ---------------------------------------------------------------------------
// Release hygiene
// ---------------------------------------------------------------------------

test("release hygiene: no debug artefacts, minification stated honestly", () => {
  assert.ok(
    /minifyEnabled false/.test(APP_GRADLE),
    "the release build now minifies; the checklist tells the operator to explain to a reviewer that it does not"
  );
  assert.ok(
    CHECKLIST.includes("`minifyEnabled false`"),
    "the checklist no longer states the minification setting a reviewer will notice"
  );

  assert.ok(
    !/android:debuggable\s*=\s*"true"/.test(MANIFEST_XML),
    'the manifest forces android:debuggable="true" — that must never reach a release build'
  );

  const javaDir = path.join(ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield");
  for (const file of fs.readdirSync(javaDir).filter((f) => f.endsWith(".kt"))) {
    const source = fs.readFileSync(path.join(javaDir, file), "utf8");

    source.split("\n").forEach((line, index) => {
      if (/setWebContentsDebuggingEnabled\s*\(\s*true\s*\)/.test(line)) {
        assert.ok(
          /BuildConfig\.DEBUG/.test(line),
          `${file}:${index + 1} enables WebView remote debugging without a BuildConfig.DEBUG guard`
        );
      }
      // The per-connection RST log names the blocked host. In a release build
      // that would put a user's browsing into logcat for any app with READ_LOGS.
      if (/Log\.[dv]\(TAG, "RST/.test(line)) {
        assert.ok(
          /BuildConfig\.DEBUG/.test(line),
          `${file}:${index + 1} logs a blocked host without a BuildConfig.DEBUG guard — release logcat would ` +
            "carry filtering decisions, which every privacy claim in the docs denies"
        );
      }
    });
  }
});

test("no development endpoint is reachable from the shipped source set", () => {
  /*
   * The checklist claimed this and credited `tools/android-audit.js` for it. The
   * audit checks permissions, SDK level and debug guards — it has never looked
   * for a dev URL, so the line was an assertion with a citation to nothing,
   * which is precisely the failure the rewrite was for. Here is the check.
   *
   * `_locales/` is excluded: 83 translation files are copied in verbatim from
   * the extension, and a translated string that happens to contain one of these
   * words is not an endpoint.
   */
  const mainDir = path.join(ROOT, "android", "app", "src", "main");
  const offenders = [];
  const suspicious = /localhost|\b10\.0\.2\.2\b|\b127\.0\.0\.1\b|https?:\/\/[a-z0-9.-]*\.(?:ngrok|local|test|dev)\b/i;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_locales") continue;
        walk(full);
      } else if (/\.(kt|java|js|html|xml|json|css)$/.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        source.split("\n").forEach((line, index) => {
          if (suspicious.test(line)) {
            offenders.push(`${path.relative(ROOT, full).split(path.sep).join("/")}:${index + 1}`);
          }
        });
      }
    }
  };
  walk(mainDir);

  assert.deepEqual(
    offenders,
    [],
    `the shipped Android source points at a development endpoint: ${offenders.join(", ")}. A release build ` +
      "must reach nothing but the destinations the user's own traffic already chose."
  );
});

test("the app ships a launcher icon, or the checklist says it does not", () => {
  /*
   * The most visible thing on this list, and the easiest to miss from inside a
   * repository: `res/` holds only `values/` and `xml/`, and `<application>`
   * declares no `android:icon`. Android falls back to its default grey
   * placeholder — on the home screen, in the drawer, in the share sheet, in
   * Settings — and the 512x512 uploaded to Play is the store listing icon, which
   * changes none of that.
   *
   * Bidirectional, like the other behaviour claims: once an icon lands, the
   * checklist has to stop saying there is none.
   */
  const resDir = path.join(ROOT, "android", "app", "src", "main", "res");
  const hasMipmap = fs
    .readdirSync(resDir, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && entry.name.startsWith("mipmap"));
  const declaresIcon = /<application[^>]*android:icon=/s.test(MANIFEST);

  const hasIcon = hasMipmap && declaresIcon;
  const checklistSaysMissing = /The app has no launcher icon/.test(CHECKLIST);

  if (hasIcon) {
    assert.ok(
      !checklistSaysMissing,
      "the app now declares a launcher icon and ships mipmap resources — delete the missing-icon line from " +
        "the checklist §8"
    );
  } else {
    assert.ok(
      checklistSaysMissing,
      `the app has no launcher icon (mipmap resources: ${hasMipmap}, android:icon declared: ${declaresIcon}) ` +
        "and the checklist no longer says so. It would install on every device with Android's default grey " +
        "placeholder, which no amount of store-listing artwork fixes."
    );
  }
});

test("instrumented tests stay out of the shipped source set", () => {
  assert.ok(
    exists("android", "app", "src", "androidTest"),
    "android/app/src/androidTest is gone; the checklist claims the instrumented tests live there"
  );

  const mainDir = path.join(ROOT, "android", "app", "src", "main");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(kt|java)$/.test(entry.name) && /androidx\.test|org\.junit/.test(fs.readFileSync(full, "utf8"))) {
        offenders.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(mainDir);

  assert.deepEqual(
    offenders,
    [],
    `test code has leaked into the shipped source set: ${offenders.join(", ")}`
  );

  assert.ok(CHECKLIST.includes("`src/androidTest/`"), "the checklist no longer states where instrumented tests live");
});

// ---------------------------------------------------------------------------
// Signing — the one mistake with no recovery
// ---------------------------------------------------------------------------

test("no signing material is tracked, and the ignore rules that keep it out are present", () => {
  for (const rule of ["keystore.properties", "android/keystore.properties", "*.jks", "*.keystore", "*.apk", "*.aab"]) {
    assert.ok(
      GITIGNORE.split("\n").some((line) => line.trim() === rule),
      `.gitignore no longer ignores "${rule}". A committed upload key cannot be un-committed in any way that ` +
        "matters — the key is compromised the moment it is pushed."
    );
  }

  /*
   * The question is what is COMMITTED, not what is on this disk. An operator
   * following §3 has android/keystore.properties sitting in their working tree
   * on purpose — that is the documented setup, and a test that failed on it
   * would be telling them their own key is a defect. Only git can tell the two
   * apart, so git is asked.
   */
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

  const committed = tracked.filter(
    (file) => /\.(jks|keystore)$/i.test(file) || path.basename(file) === "keystore.properties"
  );

  assert.deepEqual(
    committed,
    [],
    `signing material is COMMITTED to the repository: ${committed.join(", ")}. An upload key cannot be ` +
      "un-pushed in any way that matters — it is compromised the moment it lands, and without Play App " +
      "Signing a compromised upload key ends the app's ability to be updated."
  );
});

test("the four signing property names the checklist gives are the four the build reads", () => {
  const fileKeys = [...new Set([...APP_GRADLE.matchAll(/keystoreProps\['([A-Za-z]+)'\]/g)].map((m) => m[1]))].sort();
  const propertyKeys = [
    ...new Set([...APP_GRADLE.matchAll(/findProperty\('(FITSHIELD_[A-Z_]+)'\)/g)].map((m) => m[1]))
  ].sort();

  assert.deepEqual(
    fileKeys,
    ["keyAlias", "keyPassword", "storeFile", "storePassword"],
    "android/app/build.gradle reads a different set of keystore.properties keys than the checklist documents"
  );

  for (const key of [...fileKeys, ...propertyKeys]) {
    assert.ok(
      CHECKLIST.includes(key),
      `the checklist does not document the "${key}" signing property the build reads. A missing key is a ` +
        "silently unsigned bundle, and Play's error message for that is not obvious."
    );
  }

  // The safe default: no key supplied means an UNSIGNED release, never a
  // silently self-signed one.
  assert.ok(
    /hasReleaseSigning \? signingConfigs\.release : null/.test(APP_GRADLE),
    "the release build no longer falls back to unsigned when no keystore is supplied; the checklist promises it does"
  );
  assert.ok(/unsigned/i.test(CHECKLIST), "the checklist no longer explains the unsigned-by-default behaviour");
});

// ---------------------------------------------------------------------------
// Coverage numbers — re-derived, never copied
// ---------------------------------------------------------------------------

test("the coverage table states the counts the generated Android bundle holds", () => {
  const rows = [
    ["Curated brands in the blocklists", BRANDS],
    ["Brands with an Android port record", PORTED],
    ["Brands that carry at least one app package", WITH_PACKAGE],
    ["Unique Android package IDs bundled", PACKAGES],
    ["Brands verified as having no app (`no_app`)", NO_APP],
    ["Brands whose only app is a shared platform storefront (`shared_app`)", SHARED_APP],
    ["Brands still `needs_review`", NEEDS_REVIEW]
  ];

  for (const [label, value] of rows) {
    const row = `| ${label} | ${grouped(value)} |`;
    assert.ok(
      CHECKLIST.includes(row),
      `the coverage table's "${label}" row does not state the real count (${grouped(value)}).\n` +
        `Expected the row: ${row}\n` +
        "The previous checklist quoted 1,545 / 1,474 / 777 / 283 / 38 against a catalog that had moved past " +
        "every one of them. A data change is a documentation change."
    );
  }

  // Every ported record accounts for a real brand, so the two counts are
  // comparable at all. An orphan record would inflate PORTED past BRANDS.
  const orphans = bundle.brands.filter((b) => !b.displayName).map((b) => b.brandId);
  assert.deepEqual(orphans, [], `these Android port records name no brand in the blocklists: ${orphans.join(", ")}`);

  assert.ok(
    PORTED <= BRANDS,
    `the Android bundle holds ${PORTED} records for ${BRANDS} curated brands, which cannot be right`
  );
});

test("ANDROID.md states the same coverage split the data holds", () => {
  /*
   * The checklist is not the only place these five numbers are written down.
   * ANDROID.md carried "As of 0.55: 1,545 packages across 1,474 brands; 777
   * no_app; 283 shared_app; 38 needs_review" for a whole release after the
   * catalog had moved past every one of them — a second copy of the same claim,
   * decaying independently, with nothing watching it.
   */
  const claim = flat(ANDROID_DOC);

  for (const [what, value] of [
    ["package count", PACKAGES],
    ["brands-with-an-app count", WITH_PACKAGE],
    ["no_app count", NO_APP],
    ["shared_app count", SHARED_APP],
    ["needs_review count", NEEDS_REVIEW]
  ]) {
    assert.ok(
      claim.includes(grouped(value)),
      `docs/ANDROID.md no longer states the real ${what} (${grouped(value)}). It is the second place this ` +
        "split is written down, and the first time it drifted nothing noticed for a release."
    );
  }
});

test("the checklist names every curated brand missing an Android port record", () => {
  /*
   * "App-blocking package coverage is fully researched" was the previous
   * checklist's claim, and one brand had no record of any kind — not mapped, not
   * `no_app`, not `needs_review`, simply absent from data/android/. So the count
   * read 2,504 against 2,505 curated brands and nothing said why.
   *
   * Bidirectional: while a gap exists the checklist must name it by brand, and
   * once the gap is closed the checklist must stop describing one.
   */
  if (UNPORTED.length === 0) {
    assert.ok(
      !/no Android port record at all/.test(CHECKLIST),
      "every curated brand now has an Android port record — delete the gap line from the checklist §9 and " +
        "let the coverage claim stand unqualified"
    );
    return;
  }

  const missing = [];
  for (const entry of UNPORTED) {
    if (!flat(CHECKLIST).includes(entry.domain) || !flat(CHECKLIST).includes(entry.name)) {
      missing.push(`${entry.name} (${entry.domain})`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `these curated brands have no Android port record and the checklist does not name them: ${missing.join(", ")}. ` +
      "An unnamed gap is how 'fully researched' got written about a catalog with a hole in it."
  );
});

// ---------------------------------------------------------------------------
// The store listing may promise only what the phone does
// ---------------------------------------------------------------------------

/** The quoted full-description block, and nothing around it. */
function fullDescription() {
  const lines = LISTING.split("\n");
  const start = lines.findIndex((line) => line.includes("**Make food ordering a choice, not a reflex.**"));
  assert.ok(start >= 0, "docs/STORE_LISTING_DRAFT.md no longer contains the full description's opening line");

  const block = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith(">")) break;
    block.push(line);
  }
  return block.join("\n");
}

test("the store listing promises only statistics the Android app renders", () => {
  /*
   * The listing sells the PHONE. It described the extension's four-part
   * statistics row — "times you left, times you continued, passes used, and
   * alternatives shown, chosen and marked as made" — on a page for an app that
   * renders a single counter. A Play listing is a claim to strangers, and a
   * reviewer with the app open can check this one in five seconds.
   */
  const description = fullDescription();

  const forbidden = [
    "times you left",
    "times you continued",
    "passes used",
    "alternatives shown",
    "calories avoided",
    "money saved",
    "estimated savings",
    "allergen labelling",
    "how long for"
  ];

  const claimed = forbidden.filter((phrase) => new RegExp(phrase, "i").test(description));
  assert.deepEqual(
    claimed,
    [],
    `the Play full description promises ${claimed.join(", ")}, which the Android app does not do. Nothing on ` +
      "this page may borrow the extension's behaviour."
  );

  assert.ok(
    /ordering pages interrupted/i.test(description),
    "the Play full description no longer names the one statistic the app keeps"
  );
});

test("the store listing's pause-screen claims match what the pause screen renders", () => {
  /*
   * The Android pause screen builds a card from three fields — title, total
   * time, description. The extension's block page builds the whole recipe. The
   * listing may describe the first and must not describe the second, so the
   * prohibition and the code are held together.
   */
  const card = ANDROID_BLOCK_JS.match(/function recipeCard\(r\) \{[\s\S]*?\n  \}/);
  assert.ok(card, "android block.js no longer defines recipeCard; the listing describes what it renders");

  const rendersDetail = /\br\.(ingredients|allergens|equipment|steps|servings)\b/.test(card[0]);
  const prohibited = flat(LISTING).includes("ingredient quantities, equipment or allergen labelling");

  if (rendersDetail) {
    assert.ok(
      !prohibited,
      "the Android pause screen now renders recipe detail — the listing's prohibition on claiming ingredient " +
        "quantities, equipment and allergen labelling is out of date and the bullet can be widened"
    );
  } else {
    assert.ok(
      prohibited,
      "the pause screen renders only a title, a duration and a description, but the listing no longer forbids " +
        "claiming quantities, equipment or allergen labelling. That prohibition is the only thing keeping an " +
        "allergen promise off a store page."
    );
  }
});

test("the alternatives-browser claim stays off the listing while its rendering is broken", () => {
  /*
   * The catalog stores ingredients as objects — {quantity, unit, item} — and
   * `extension/warning.js` has a formatIngredient() for exactly that. The Android
   * browser has no formatter: it calls .join(", ") on the array, so String()
   * runs on each object and a real device prints "[object Object]".
   *
   * The data shape is asserted first, so this cannot pass vacuously if the
   * catalog ever flattens to strings — at which point the join would be correct
   * and the listing could claim the feature again.
   */
  const ingredient = recipes.recipes[0].ingredients[0];
  assert.equal(
    typeof ingredient,
    "object",
    "catalog ingredients are no longer structured objects; re-check every renderer that formats them"
  );
  assert.equal(
    String(ingredient),
    "[object Object]",
    "a structured ingredient no longer stringifies to [object Object]; this assertion's premise is gone"
  );

  const joinsRaw = ANDROID_APP_JS.includes('(r.ingredients || []).join(", ")');
  const disclaimed = flat(LISTING).includes("[object Object]");

  if (joinsRaw) {
    assert.ok(
      disclaimed,
      "android app.js still stringifies ingredient OBJECTS straight into the Alternatives panel, so a device " +
        'renders "[object Object]". The listing must keep saying so until it is fixed — otherwise a ' +
        "screenshot instruction points at a broken screen."
    );

    // The same panel shows only a slice of the catalog. The listing quotes both
    // numbers, so both are checked.
    // Anchored to the Alternatives renderer. A bare .slice() search finds the
    // most-blocked lists first and would check the listing against the wrong
    // number.
    const slice = ANDROID_APP_JS.match(/\$\("recipeList"\)[\s\S]{0,300}?\.slice\(0,\s*(\d+)\)/);
    assert.ok(slice, "the Alternatives panel no longer slices the catalog; the listing quotes the limit");
    assert.ok(
      flat(LISTING).includes(`first ${slice[1]} of the ${ALTERNATIVES} entries`),
      `the listing states a different cap than the panel applies (it renders the first ${slice[1]} of ` +
        `${ALTERNATIVES})`
    );
  } else {
    assert.ok(
      !disclaimed,
      "the Alternatives panel no longer stringifies raw ingredient objects — remove the [object Object] " +
        "caveat from the listing and put the browse bullet back"
    );
  }
});

test("the temporary pass is scoped the way the listing says it is", () => {
  // "Scoped to the one brand you opened" is a promise about what stays blocked
  // while a pass is live. It is the signature that proves it.
  const policy = read("android", "app", "src", "main", "java", "com", "usha", "fitshield", "AppBlockPolicy.kt");

  assert.ok(
    /fun unlock\(\s*context: Context,\s*brandId: String,\s*minutes: Int\s*\)/.test(policy),
    "AppBlockPolicy.unlock no longer takes a brandId, so a pass may no longer be scoped to one brand. The " +
      "Play listing says it is."
  );

  assert.ok(
    /scoped to the one/i.test(fullDescription()),
    "the Play full description no longer states that a pass is scoped to a single app"
  );
});

// ---------------------------------------------------------------------------
// Behaviour the documentation is bound to, in both directions
// ---------------------------------------------------------------------------

test("the docs describe IPv6 exactly as the filter handles it", () => {
  /*
   * This one was filed as a "known non-blocker" while it meant an IPv6-only
   * carrier had NO working internet for as long as FitShield was on. It is fixed,
   * and this assertion exists so that neither the fix nor the honesty can rot:
   * the documentation may not keep claiming a limitation the code dropped, and
   * may not go quiet if the drop comes back.
   */
  const dropsIpv6 = /if\s*\(\s*version\s*!=\s*4\s*\)\s*return/.test(TUN2FILTER);

  const documents = [
    ["docs/ANDROID.md", ANDROID_DOC],
    ["docs/PLAY_STORE_RELEASE_CHECKLIST.md", CHECKLIST]
  ];

  for (const [where, document] of documents) {
    const claims = withoutQuotes(document);

    if (dropsIpv6) {
      assert.ok(
        /IPv6[^.]{0,40}(dropped|not yet supported)/i.test(claims),
        `${where} no longer records that the filter drops IPv6, and Tun2Filter still does. On an IPv6-only ` +
          "network that is a total loss of connectivity, not a degraded one."
      );
    } else {
      assert.ok(
        /IPv6 is (parsed and )?filtered/i.test(claims),
        `${where} does not state that IPv6 is filtered, and Tun2Filter now filters it`
      );
      assert.ok(
        !/IPv6 is currently[^.]{0,40}dropped/i.test(claims),
        `${where} still describes IPv6 as currently dropped. Tun2Filter parses it — the sentence is now false.`
      );
      assert.ok(
        !/IPv6-only networks are not yet supported/i.test(claims),
        `${where} still lists IPv6-only networks as unsupported; they are filtered like any other`
      );
    }
  }
});

test("the docs describe the reboot behaviour the app actually has", () => {
  /*
   * The mirror of the above. "Reboot VPN auto-restart is intentionally manual"
   * described a user turning protection on, restarting overnight, and waking up
   * unprotected with nothing said. Calling that intentional is what let it sit.
   */
  const restoresOnBoot =
    /android\.intent\.action\.BOOT_COMPLETED/.test(MANIFEST) && exists("android", "app", "src", "main", "java", "com", "usha", "fitshield", "BootReceiver.kt");

  const documents = [
    ["docs/ANDROID.md", ANDROID_DOC],
    ["docs/PLAY_STORE_RELEASE_CHECKLIST.md", CHECKLIST]
  ];

  for (const [where, document] of documents) {
    const claims = withoutQuotes(document);

    if (restoresOnBoot) {
      assert.ok(
        /comes back after a restart/i.test(claims),
        `${where} does not state that protection returns after a restart, and BootReceiver now restores it`
      );
      assert.ok(
        !/(VPN re-enable is manual by design|does not come back after a (restart|reboot))/i.test(claims),
        `${where} still says protection has to be re-enabled by hand after a restart. It does not.`
      );
    } else {
      assert.ok(
        /does not come back after a (restart|reboot)/i.test(claims),
        `${where} claims protection survives a restart, but nothing handles BOOT_COMPLETED. A blocker that ` +
          "silently stops overnight is worse than one that was never on."
      );
    }
  }

  if (restoresOnBoot) {
    // The rule that makes the restore safe rather than presumptuous.
    const policy = read("android", "app", "src", "main", "java", "com", "usha", "fitshield", "RestorePolicy.kt");
    assert.ok(
      /Event\.USER_DISABLED\s*->\s*false/.test(policy),
      "the boot-restore policy no longer records an explicit user disable as off, so a restart could turn " +
        "protection on for someone who turned it off"
    );
    assert.ok(
      /Event\.SERVICE_DESTROYED\s*->\s*null/.test(policy),
      "a destroyed service now overwrites the user's stored instruction; a reboot or a low-memory kill would " +
        "then leave protection off forever with nobody having asked"
    );
  }
});
