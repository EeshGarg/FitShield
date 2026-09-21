#!/usr/bin/env node
"use strict";
/**
 * Android adapter audit. Proves the native Android target is a thin adapter on
 * the SAME canonical data as the browser — not a fork.
 *
 * Errors:
 *  - generated rules asset missing, unmarked, or DRIFTED from the engine output
 *  - a hand-maintained Android blocklist exists (any rules JSON not marked generated)
 *  - AndroidManifest uses a non-approved permission, a boot receiver,
 *    usage-access, or package-visibility
 *  - the bundled app-package dataset drifts from the generated output
 *  - analytics/telemetry dependency in the Android build
 *
 * NOTE: an AccessibilityService IS allowed (the opt-in app-blocking feature).
 * It is configured read-only for the foreground package name
 * (canRetrieveWindowContent="false") — see res/xml/accessibility_service_config.xml.
 * Notes: host count, hash, dataset versions.
 */

const fs = require("fs");
const path = require("path");
const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");
const gen = require("./generate-android-rules");
const genPackages = require("./generate-android-packages");

const ANDROID_DIR = path.join(load.ROOT, "android");
const MANIFEST = path.join(ANDROID_DIR, "app", "src", "main", "AndroidManifest.xml");
const APP_GRADLE = path.join(ANDROID_DIR, "app", "build.gradle");

// The ONLY permissions the Android adapter is allowed to declare.
const APPROVED_PERMISSIONS = new Set([
  "android.permission.INTERNET",                       // open the protected sockets that relay ALLOWED traffic (including plain DNS datagrams, byte-for-byte and unread) to the destination the client chose
  "android.permission.FOREGROUND_SERVICE",             // run the VpnService as a foreground service
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE", // required for the specialUse FGS type (Android 14+)
  "android.permission.POST_NOTIFICATIONS",             // the required ongoing VPN notification (Android 13+)
  "android.permission.SYSTEM_ALERT_WINDOW",            // "display over other apps": reliably show the block screen over a blocked app (user-granted, optional)
  "android.permission.RECEIVE_BOOT_COMPLETED"          // restore the user's OWN setting after a restart — constrained by bootRestoreAudit() below
]);

// Permissions/components that must NEVER appear (checked against the manifest
// with XML comments stripped, so documentation that names them does not trip it).
//
// RECEIVE_BOOT_COMPLETED used to sit in this list, and the product paid for it:
// a reboot killed the VpnService, nothing restarted it, and nothing told the
// user, so a blocker whose promise is being there while you are not thinking
// about it simply stopped. The permission is now allowed and *constrained*
// instead — see bootRestoreAudit(), which is stricter than the ban was: it
// requires the boot path to be gated on the user's own stored instruction,
// forbids the receiver from starting anything before that gate, forbids it from
// launching an Activity at all, forbids any other broadcast being smuggled into
// the same receiver, and forbids the service from erasing the instruction when
// the OS ends it.
const FORBIDDEN = [
  ["usage access", /PACKAGE_USAGE_STATS/],
  ["package visibility", /QUERY_ALL_PACKAGES/],
  ["device admin", /BIND_DEVICE_ADMIN|device_admin/i],
  ["location permission", /ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION/],
  ["contacts permission", /READ_CONTACTS|WRITE_CONTACTS|GET_ACCOUNTS/],
  ["phone permission", /READ_PHONE_STATE|READ_PHONE_NUMBERS|CALL_PHONE|READ_CALL_LOG|WRITE_CALL_LOG/],
  ["SMS permission", /SEND_SMS|RECEIVE_SMS|READ_SMS|RECEIVE_MMS|RECEIVE_WAP_PUSH/],
  ["broad storage permission", /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/],
  ["notification listener", /BIND_NOTIFICATION_LISTENER_SERVICE|NotificationListenerService/]
];

// The target API level Play accepts for a new submission. See
// docs/PLAY_STORE_RELEASE_CHECKLIST.md §1 for the deadline this tracks.
const PLAY_MIN_SDK = 36;

const ANALYTICS = /firebase|crashlytics|com\.google\.android\.gms\.(analytics|measurement)|google-analytics|appcenter|segment|amplitude|mixpanel|sentry/i;

function androidAudit() {
  const reporter = new Reporter("Android adapter — engine reuse, no fork, permissions");

  if (!fs.existsSync(ANDROID_DIR)) {
    reporter.fail("android/ directory is missing");
    return reporter;
  }

  // 1. Generated asset exists, is marked generated, and MATCHES the engine.
  if (!fs.existsSync(gen.ASSET_PATH)) {
    reporter.fail(`generated rules asset missing: ${path.relative(load.ROOT, gen.ASSET_PATH)} (run npm run generate:android)`);
  } else {
    let asset;
    try {
      asset = JSON.parse(fs.readFileSync(gen.ASSET_PATH, "utf8"));
    } catch (error) {
      reporter.fail(`rules asset invalid JSON: ${error.message}`);
    }

    if (asset) {
      if (asset._generated !== true) {
        reporter.fail("rules asset is not marked _generated:true (looks hand-maintained)");
      }
      // Re-derive from canonical data via the separated engine and compare.
      // This is the core anti-divergence proof.
      // (deasync-free: caller wraps in the async runner below.)
      reporter._assetForDrift = asset;
    }
  }

  // 2. No OTHER blocklist-like JSON in android/ (no Android-only data fork).
  walkJson(ANDROID_DIR).forEach((file) => {
    if (path.resolve(file) === path.resolve(gen.ASSET_PATH)) {
      return;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return; // non-JSON-ish; ignore
    }
    const looksLikeRules = data && typeof data === "object" &&
      (Array.isArray(data.hosts) || Array.isArray(data.domains) || Array.isArray(data.entries) || Array.isArray(data.blocklist));
    if (looksLikeRules && data._generated !== true) {
      reporter.fail(`hand-maintained blocklist found: ${path.relative(load.ROOT, file)} (Android must use only the generated asset)`);
    }
  });

  // 3. Manifest permissions / forbidden components.
  if (!fs.existsSync(MANIFEST)) {
    reporter.fail("android/app/src/main/AndroidManifest.xml is missing");
  } else {
    // Strip XML comments first so documentation that *mentions* forbidden
    // permissions (e.g. "Deliberately NOT requested: …") never trips the checks.
    const xml = fs.readFileSync(MANIFEST, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const declared = [...xml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
    declared.forEach((perm) => {
      if (!APPROVED_PERMISSIONS.has(perm)) {
        reporter.fail(`manifest declares non-approved permission: ${perm}`);
      }
    });
    FORBIDDEN.forEach(([label, re]) => {
      if (re.test(xml)) {
        reporter.fail(`manifest contains forbidden ${label}`);
      }
    });
    // The VpnService must be guarded by BIND_VPN_SERVICE (how Android enforces it).
    if (!/android:permission="android\.permission\.BIND_VPN_SERVICE"/.test(xml)) {
      reporter.warn("VpnService should declare android:permission=\"android.permission.BIND_VPN_SERVICE\"");
    }
    bootRestoreAudit(reporter, xml, declared);
    ipFamilyAudit(reporter);
    launcherIconAudit(reporter, xml);
    runtimePermissionAudit(reporter, declared);
    disclosureAudit(reporter, xml);
    reporter.note(`manifest permissions: ${declared.join(", ") || "(none)"}`);
  }

  // 3b. Reused web bundle: authored entries present + copied files match
  // canonical (no fork/drift). Mirrors the rules-asset drift guarantee.
  const webDir = path.join(ANDROID_DIR, "app", "src", "main", "assets", "web");
  ["index.html", "app.js"].forEach((f) => {
    if (!fs.existsSync(path.join(webDir, f))) {
      reporter.fail(`web entry missing: android/app/src/main/assets/web/${f}`);
    }
  });
  // Canonical sources: extension/ (shared web UI modules), data/ (canonical
  // data), android/web-src/ (the Android-authored shim). KEEP IN SYNC with the
  // WEB_COPIES list in tools/build-android.js.
  const WEB_COPIES = [
    [path.join("android", "web-src", "android-shim.js"), "android-shim.js"],
    [path.join("extension", "i18n.js"), "i18n.js"],
    [path.join("extension", "languages.js"), "languages.js"],
    [path.join("extension", "ambient.js"), "ambient.js"],
    [path.join("extension", "recipes.js"), "recipes.js"],
    [path.join("extension", "icons", "icon-128.png"), "icon-128.png"],
    [path.join("data", "recipes.json"), path.join("data", "recipes.json")]
  ];
  WEB_COPIES.forEach(([src, dest]) => {
    const canonical = path.join(load.ROOT, src);
    const bundled = path.join(webDir, dest);
    if (!fs.existsSync(bundled)) {
      reporter.fail(`web bundle missing ${dest} (run npm run build:android)`);
    } else if (!fs.readFileSync(canonical).equals(fs.readFileSync(bundled))) {
      reporter.fail(`web bundle ${dest} drifted from canonical (run npm run build:android)`);
    }
  });

  // All locales are reused (copied) — verify the bundled tree matches canonical
  // exactly, so there is no Android-only locale fork.
  const localeDrift = compareTree(load.LOCALES_DIR, path.join(webDir, "_locales"));
  if (localeDrift === null) {
    reporter.fail("web bundle missing _locales (run npm run build:android)");
  } else if (localeDrift > 0) {
    reporter.fail(`web bundle _locales drifted from canonical in ${localeDrift} file(s) (run npm run build:android)`);
  } else {
    reporter.note(`reused web assets: i18n, recipes, icon + ${load.localeDirs().length} locales (copied from canonical, no fork)`);
  }

  // 3b-ii. Every locale key the Android UI asks for must be a key that EXISTS.
  //
  // `tools/locale-prune.js` already scans this directory — but only in the other
  // direction, to keep a key Android alone renders from being pruned as dead.
  // Nothing checked the reverse, and the reverse is the half that reaches a
  // user: FitShieldI18n.t() returns the RAW KEY when it cannot resolve one
  // ("so a gap stays visible rather than rendering blank"), and
  // localizeDocument() then writes that key over the English fallback sitting in
  // the markup. So a mistyped or retired key does not fall back to English — it
  // prints its own name on the screen, in every language including English.
  //
  // Ten of them were shipping at once. The statistics row read
  // "statusBlockedVisits / Estimated savings / statusCaloriesAvoided", and every
  // alternative card's meta line read "recipeTimeLabel · recipeCaloriesLabel".
  // A source grep could not see it: the attributes were spelled perfectly, the
  // keys simply no longer existed. Only resolving them can tell.
  const englishMessages = JSON.parse(fs.readFileSync(path.join(load.LOCALES_DIR, "en", "messages.json"), "utf8"));
  const dangling = [];

  fs.readdirSync(webDir)
    .filter((name) => /\.(js|html)$/.test(name))
    .sort()
    .forEach((name) => {
      const raw = fs.readFileSync(path.join(webDir, name), "utf8");
      // Comments name retired keys while explaining why they are retired, so
      // they are stripped first. The line pattern carries no end anchor because
      // these files use CRLF and "." stops at the carriage return.
      const source = (name.endsWith(".html") ? raw.replace(/<!--[\s\S]*?-->/g, " ") : raw)
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\r\n]*/g, " ");

      const requested = new Set();
      // Markup: data-i18n, data-i18n-title, data-i18n-aria-label, …
      for (const match of source.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) requested.add(match[1]);
      // Script: t("key"). A template literal key is dynamic and cannot be
      // resolved statically, so it is deliberately not matched here.
      for (const match of source.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) requested.add(match[1]);

      [...requested]
        .filter((key) => !englishMessages[key])
        .sort()
        .forEach((key) => dangling.push(`${name} -> ${key}`));
    });

  if (dangling.length > 0) {
    reporter.fail(
      `Android UI requests ${dangling.length} locale key(s) that no locale defines; each renders its own name ` +
        `on the screen: ${dangling.join(", ")}`
    );
  } else {
    reporter.note("every locale key the Android UI requests resolves to a real string");
  }

  // 3c. App-package dataset: the bundled asset must match the generated output
  // (which is compiled from data/android/*-apps.json + data/blocklists). No fork.
  const pkgAsset = path.join(ANDROID_DIR, "app", "src", "main", "assets", "android-packages.json");
  if (!fs.existsSync(pkgAsset)) {
    reporter.fail("bundled android-packages.json missing (run npm run build:android)");
  } else {
    let bundled;
    try {
      bundled = JSON.parse(fs.readFileSync(pkgAsset, "utf8"));
    } catch (error) {
      reporter.fail(`android-packages.json invalid JSON: ${error.message}`);
    }
    if (bundled) {
      // The bundled asset is the SLIM subset (package map only); the full ported
      // record is data/generated/android-packages.json. Compare the package maps.
      const fresh = genPackages.derive();
      if (bundled._generated !== true) {
        reporter.fail("android-packages.json is not marked _generated:true");
      } else if (JSON.stringify(bundled.packages) !== JSON.stringify(fresh.packages)) {
        reporter.fail("bundled android-packages.json DRIFTED from the generated dataset (run npm run build:android)");
      } else {
        reporter.note(`${fresh.counts.packages} app packages bundled; ${fresh.counts.brands} brands ported (${fresh.counts.needsReview} needs_review, ${fresh.counts.noApp} no_app, ${fresh.counts.sharedApp} shared_app)`);
      }
    }
  }

  // 4. No analytics/telemetry dependency.
  if (fs.existsSync(APP_GRADLE)) {
    const gradle = fs.readFileSync(APP_GRADLE, "utf8");
    if (ANALYTICS.test(gradle)) {
      reporter.fail("Android build references an analytics/telemetry library");
    }
  }

  // 5. Play-release readiness: API level + no dev-only flags in a release build.
  if (fs.existsSync(APP_GRADLE)) {
    const gradle = fs.readFileSync(APP_GRADLE, "utf8");
    const compileSdk = Number((gradle.match(/compileSdk\s+(\d+)/) || [])[1] || 0);
    const targetSdk = Number((gradle.match(/targetSdk\s+(\d+)/) || [])[1] || 0);
    // Play requires API 36 for new apps and updates submitted from 31 August
    // 2026 (an extension runs to 1 November 2026). A build below that is not a
    // build with a smaller audience — it is one Play refuses to accept.
    if (compileSdk < PLAY_MIN_SDK) reporter.fail(`compileSdk must be >= ${PLAY_MIN_SDK} for Google Play (found ${compileSdk || "none"})`);
    if (targetSdk < PLAY_MIN_SDK) reporter.fail(`targetSdk must be >= ${PLAY_MIN_SDK} for Google Play (found ${targetSdk || "none"})`);
    if (compileSdk >= PLAY_MIN_SDK && targetSdk >= PLAY_MIN_SDK) reporter.note(`Play API level: compileSdk ${compileSdk}, targetSdk ${targetSdk}`);
  }
  // WebView remote debugging (setWebContentsDebuggingEnabled) must be gated to
  // debug builds — never unconditional, or it ships in release.
  kotlinSources().forEach((file) => {
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line) => {
      if (/setWebContentsDebuggingEnabled\s*\(\s*true\s*\)/.test(line) && !/BuildConfig\.DEBUG/.test(line)) {
        reporter.fail(`${path.basename(file)}: setWebContentsDebuggingEnabled(true) must be guarded by BuildConfig.DEBUG`);
      }
    });
  });
  // Verbose logging must be gated too, and this used to be asserted by nothing
  // while the note below reported it as checked. Two kinds ship in this app and
  // neither belongs in a release: the WebView console bridge, which copies every
  // console.* line out of the page, and the per-connection RST line in
  // Tun2Filter, which names a host for every connection the filter refuses —
  // logcat is readable by the user and by anything with an adb shell, so that
  // one is a record of where they browse.
  let gatedLogs = 0;
  kotlinSources().forEach((file) => {
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      const isConsoleBridge = /Log\.[a-z]+\(\s*"FitShieldWeb"\s*,[\s\S]*m\.message\(\)/.test(line);
      const isPerConnection = /Log\.[a-z]+\(\s*TAG\s*,\s*"RST /.test(line);

      if (!isConsoleBridge && !isPerConnection) return;

      if (/BuildConfig\.DEBUG/.test(line)) {
        gatedLogs++;
        return;
      }

      reporter.fail(
        `${path.basename(file)}:${i + 1}: ${isConsoleBridge ? "WebView console" : "per-connection RST"} ` +
          "logging must be guarded by BuildConfig.DEBUG — it ships in release otherwise"
      );
    });
  });

  // The note said this was checked when nothing looked. If the lines are ever
  // renamed out from under the patterns above, saying "0 gated" is the honest
  // answer, not repeating the claim.
  if (gatedLogs === 0) {
    reporter.warn("no verbose-logging call sites matched — the release-logging check examined nothing");
  }

  // The manifest must never force debuggable on (AGP sets it per build type).
  if (fs.existsSync(MANIFEST) && /android:debuggable\s*=\s*"true"/.test(fs.readFileSync(MANIFEST, "utf8"))) {
    reporter.fail("manifest forces android:debuggable=\"true\" — must not ship in a release build");
  }
  reporter.note(
    `release readiness: API ${PLAY_MIN_SDK}+, WebView debugging + ${gatedLogs} verbose log site(s) gated to debug, not force-debuggable`
  );

  return reporter;
}

/**
 * Boot restart, constrained.
 *
 * Starting at boot is the right behaviour and a real risk at the same time: it
 * is exactly the capability a user would resent being used for anything other
 * than restoring what they themselves switched on. So the permission is allowed
 * only alongside every structural guarantee that keeps it honest:
 *
 *  1. permission and receiver come as a pair — no orphan permission, no
 *     unpermissioned receiver;
 *  2. the receiver listens to nothing but the two protected system broadcasts
 *     that actually end the VpnService without the user asking;
 *  3. the decision is delegated to BootRestore.decide, whose truth table the
 *     test suite executes;
 *  4. nothing is started before that decision is taken;
 *  5. the receiver never launches an Activity (a background app that throws a
 *     screen at you after a reboot is malware behaviour);
 *  6. the service never erases the user's instruction from onDestroy — which
 *     fires on reboot, on a low-memory kill and on an app update, and would
 *     otherwise silently convert "the OS stopped us" into "the user said no".
 */
function bootRestoreAudit(reporter, xml, declared) {
  const hasPermission = declared.includes("android.permission.RECEIVE_BOOT_COMPLETED");
  const receivers = [...xml.matchAll(/<receiver[\s\S]*?<\/receiver>/g)].map((m) => m[0]);
  const bootReceivers = receivers.filter((r) => /android\.intent\.action\.BOOT_COMPLETED/.test(r));

  if (!hasPermission && bootReceivers.length === 0) {
    return; // no boot path at all — nothing to constrain
  }
  if (hasPermission && bootReceivers.length === 0) {
    reporter.fail("manifest declares RECEIVE_BOOT_COMPLETED but registers no BOOT_COMPLETED receiver (unused permission)");
    return;
  }
  if (!hasPermission) {
    reporter.fail("manifest registers a BOOT_COMPLETED receiver without declaring RECEIVE_BOOT_COMPLETED (it will never fire)");
    return;
  }
  if (bootReceivers.length > 1) {
    reporter.fail(`manifest registers ${bootReceivers.length} BOOT_COMPLETED receivers; exactly one boot path is allowed`);
    return;
  }

  // 2. Only the two protected broadcasts that end the VpnService unasked.
  const ALLOWED_BOOT_ACTIONS = new Set([
    "android.intent.action.BOOT_COMPLETED",
    "android.intent.action.MY_PACKAGE_REPLACED"
  ]);
  const actions = [...bootReceivers[0].matchAll(/<action[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
  const smuggled = actions.filter((a) => !ALLOWED_BOOT_ACTIONS.has(a));
  if (smuggled.length > 0) {
    reporter.fail(`boot receiver also listens for: ${smuggled.join(", ")} — it may only handle ${[...ALLOWED_BOOT_ACTIONS].join(" and ")}`);
  }

  const receiverName = (bootReceivers[0].match(/android:name="\.?([A-Za-z0-9_.]+)"/) || [])[1];
  const receiverFile = receiverName
    ? kotlinSources().find((f) => path.basename(f) === `${receiverName.split(".").pop()}.kt`)
    : null;
  if (!receiverFile) {
    reporter.fail(`boot receiver ${receiverName || "(unnamed)"} has no Kotlin source in the main source set`);
    return;
  }

  const receiverSource = stripKotlinComments(fs.readFileSync(receiverFile, "utf8"));
  const decideAt = receiverSource.indexOf("BootRestore.decide");
  if (decideAt < 0) {
    reporter.fail(`${path.basename(receiverFile)}: boot restart must go through BootRestore.decide (the gate the suite executes)`);
  }
  [...receiverSource.matchAll(/\bstart(?:Foreground)?Service\s*\(/g)].forEach((m) => {
    if (decideAt < 0 || m.index < decideAt) {
      reporter.fail(`${path.basename(receiverFile)}: starts a service before consulting BootRestore.decide — boot restart must be gated on the user's own setting`);
    }
  });
  if (/\bstartActivity\s*\(/.test(receiverSource)) {
    reporter.fail(`${path.basename(receiverFile)}: a boot receiver must never launch an Activity`);
  }

  // 6. onDestroy must not touch the stored instruction.
  const serviceFile = kotlinSources().find((f) => path.basename(f) === "FitShieldVpnService.kt");
  if (serviceFile) {
    const service = stripKotlinComments(fs.readFileSync(serviceFile, "utf8"));
    if (!/VpnIntent\.KEY/.test(service)) {
      reporter.fail("FitShieldVpnService.kt: nothing records the user's on/off instruction, so a restart has nothing safe to restore from");
    }
    const onDestroy = functionBody(service, "onDestroy");
    if (onDestroy && /(recordIntent|VpnIntent)/.test(onDestroy)) {
      reporter.fail("FitShieldVpnService.kt: onDestroy writes the stored instruction — a reboot or low-memory kill would be recorded as the user turning FitShield off");
    }
  }

  reporter.note(`boot restart: gated on the user's stored setting via BootRestore.decide, ${actions.length} protected broadcast(s), no Activity launch`);
}

/**
 * A routed address family the filter cannot parse is worse than not routing it:
 * the packets are captured and then dropped, so a dual-stack network degrades
 * and an IPv6-only carrier loses the internet entirely. If the tunnel claims
 * ::/0, the filter has to mean it.
 */
function ipFamilyAudit(reporter) {
  const sources = kotlinSources();
  const serviceFile = sources.find((f) => path.basename(f) === "FitShieldVpnService.kt");
  if (!serviceFile) return;
  const service = stripKotlinComments(fs.readFileSync(serviceFile, "utf8"));
  const routesV6 = /addRoute\s*\(\s*"::"/.test(service);
  if (!routesV6) return;

  const parser = sources.find((f) => path.basename(f) === "IpPacket.kt");
  if (!parser) {
    reporter.fail("the tunnel routes ::/0 but there is no IpPacket.kt to parse IPv6 — captured IPv6 would be dropped, which is no internet on an IPv6-only network");
    return;
  }
  const parserSource = stripKotlinComments(fs.readFileSync(parser, "utf8"));
  if (!/\b6\s*->\s*parseV6/.test(parserSource)) {
    reporter.fail("IpPacket.parse does not dispatch version 6 — routed IPv6 would be captured and dropped");
    return;
  }
  const filterFile = sources.find((f) => path.basename(f) === "Tun2Filter.kt");
  if (filterFile) {
    const filter = stripKotlinComments(fs.readFileSync(filterFile, "utf8"));
    if (/version\s*!=\s*4/.test(filter)) {
      reporter.fail("Tun2Filter still drops by IP version — the ::/0 route would be captured and discarded");
    }
  }
  reporter.note("IPv6 is routed AND parsed (extension-header chain walked to the transport header), not captured and dropped");
}

/**
 * The app must ship a launcher icon it actually owns.
 *
 * It did not. `<application>` declared no `android:icon` and there were no
 * mipmap resources at all, so FitShield installed as Android's grey placeholder
 * — the first thing a user sees after downloading, and something the 512x512
 * Play listing icon does nothing about.
 */
function launcherIconAudit(reporter, xml) {
  const RES = path.join(ANDROID_DIR, "app", "src", "main", "res");
  const icon = (xml.match(/<application[^>]*android:icon="@([a-z]+)\/([A-Za-z0-9_]+)"/) || []).slice(1);
  if (icon.length !== 2) {
    reporter.fail("<application> declares no android:icon — the app would install with Android's grey placeholder icon");
    return;
  }
  const [type, name] = icon;
  const buckets = fs.existsSync(RES)
    ? fs.readdirSync(RES).filter((d) => d === type || d.startsWith(`${type}-`))
    : [];
  const found = buckets.some((bucket) =>
    fs.readdirSync(path.join(RES, bucket)).some((file) => file.replace(/\.[^.]+$/, "") === name)
  );
  if (!found) {
    reporter.fail(`android:icon points at @${type}/${name}, which no res/${type}* directory provides`);
    return;
  }
  reporter.note(`launcher icon: @${type}/${name} (${buckets.join(", ")})`);
}

/**
 * A runtime permission that is declared and never requested is denied.
 *
 * POST_NOTIFICATIONS was exactly that: declared in the manifest, asked for
 * nowhere, therefore refused on every Android 13+ device. The ongoing
 * foreground notice going missing is cosmetic. The "protection is off after your
 * restart" notice going missing is the whole point of having built it.
 */
function runtimePermissionAudit(reporter, declared) {
  const RUNTIME_PERMISSIONS = ["android.permission.POST_NOTIFICATIONS"];
  const sources = kotlinSources().map((f) => stripKotlinComments(fs.readFileSync(f, "utf8"))).join("\n");

  RUNTIME_PERMISSIONS.filter((perm) => declared.includes(perm)).forEach((perm) => {
    const short = perm.split(".").pop();
    const requested = new RegExp(`requestPermissions\\s*\\(`).test(sources) && sources.includes(short);
    if (!requested) {
      reporter.fail(
        `${short} is declared but never requested at runtime, so Android 13+ denies it and every ` +
        "notification this app posts goes nowhere"
      );
    } else {
      reporter.note(`${short}: declared AND requested at runtime`);
    }
  });
}

/**
 * An AccessibilityService needs a prominent disclosure the user affirmatively
 * accepts, in the app, before the request — Google's fifth condition, and the
 * one a button that opens the system screen on tap fails outright.
 *
 * Checked at the NATIVE boundary rather than in the page: the bridge method that
 * opens the settings screen has to consult the recorded consent, so no change to
 * the WebView can route around the disclosure.
 */
function disclosureAudit(reporter, xml) {
  if (!/android\.accessibilityservice\.AccessibilityService/.test(xml)) return;

  const bridge = kotlinSources().find((f) => path.basename(f) === "WebAppBridge.kt");
  if (!bridge) {
    reporter.fail("an AccessibilityService is declared but WebAppBridge.kt is missing; nothing gates the request");
    return;
  }
  const source = stripKotlinComments(fs.readFileSync(bridge, "utf8"));
  const opener = functionBody(source, "openAccessibilitySettings");
  if (!opener) {
    reporter.fail("WebAppBridge.kt no longer exposes openAccessibilitySettings; the disclosure gate cannot be checked");
    return;
  }
  if (!/accessibilityConsentGiven\s*\(\)/.test(opener)) {
    reporter.fail(
      "WebAppBridge.openAccessibilitySettings opens the system Accessibility screen without checking the " +
      "recorded in-app consent — Google requires an affirmative acceptance of the disclosure BEFORE the request"
    );
    return;
  }
  const dashboard = path.join(ANDROID_DIR, "app", "src", "main", "assets", "web", "index.html");
  const page = fs.existsSync(dashboard)
    ? fs.readFileSync(dashboard, "utf8").replace(/<!--[\s\S]*?-->/g, " ")
    : "";
  if (!/role="dialog"[^>]*aria-modal="true"/.test(page) || !/canRetrieveWindowContent/.test(page)) {
    reporter.fail(
      "the dashboard has no in-app disclosure dialog naming what the accessibility service reads; " +
      "a privacy-policy line does not satisfy Google's prominent disclosure"
    );
    return;
  }
  reporter.note("accessibility: in-app prominent disclosure, affirmative consent recorded, gate enforced natively");
}

/** Kotlin source with comments removed, so documentation naming a forbidden
 *  call is never mistaken for the call itself. */
function stripKotlinComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, " ");
}

/** The body of `fun <name>(...) { … }`, brace-matched. Null when absent. */
function functionBody(source, name) {
  const start = source.search(new RegExp(`\\bfun\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

// All Kotlin sources under the app's main source set.
function kotlinSources() {
  const root = path.join(ANDROID_DIR, "app", "src", "main", "java");
  const out = [];
  if (!fs.existsSync(root)) return out;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith(".kt")) out.push(p);
    }
  })(root);
  return out;
}

// Compare a canonical dir against a bundled copy. Returns the count of
// differing/missing files, or null if the bundled dir is absent entirely.
function compareTree(canonicalDir, bundledDir) {
  if (!fs.existsSync(bundledDir)) {
    return null;
  }
  let diffs = 0;
  (function walk(rel) {
    const here = path.join(canonicalDir, rel);
    for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(childRel);
      } else if (entry.isFile()) {
        const bundled = path.join(bundledDir, childRel);
        if (!fs.existsSync(bundled) || !fs.readFileSync(path.join(canonicalDir, childRel)).equals(fs.readFileSync(bundled))) {
          diffs += 1;
        }
      }
    }
  })("");
  return diffs;
}

function walkJson(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["build", ".gradle", ".idea"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJson(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

// Async wrapper so the engine re-derivation (drift proof) can be awaited.
async function audit() {
  const reporter = androidAudit();
  const asset = reporter._assetForDrift;
  delete reporter._assetForDrift;

  if (asset) {
    const derived = await gen.derive();
    if (asset.sha256 !== derived.sha256) {
      reporter.fail(`rules asset DRIFTED from engine output (asset ${String(asset.sha256).slice(0, 12)}… vs engine ${derived.sha256.slice(0, 12)}…) — run npm run generate:android`);
    } else if (JSON.stringify(asset.hosts) !== JSON.stringify(derived.hosts)) {
      reporter.fail("rules asset host list does not match the engine output");
    } else {
      reporter.note(`${derived.count} hosts match the separated engine (sha256 ${derived.sha256.slice(0, 12)}…)`);
      reporter.note(`derived from canonical data v${Object.values(derived.datasetVersions).join("/")} via ${derived.engine}`);
    }
  }
  return reporter;
}

if (require.main === module) {
  audit().then((reporter) => {
    reporter.print();
    process.exit(reporter.ok ? 0 : 1);
  });
}

module.exports = audit;
module.exports.sync = androidAudit;
// Exported so the suite can drive the boot-permission gate with a synthetic
// manifest and prove it actually refuses the shapes it claims to refuse.
module.exports.bootRestoreAudit = bootRestoreAudit;
module.exports.APPROVED_PERMISSIONS = APPROVED_PERMISSIONS;
