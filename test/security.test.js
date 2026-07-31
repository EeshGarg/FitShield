"use strict";
/**
 * Security and privacy invariants of the shipped runtime.
 *
 * These are the promises the README, the store listing, and docs/STORAGE.md all
 * make. They are asserted against the actual files build.js packages, so a
 * regression fails here rather than in a store review or a user's browser.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const build = require("../build.js");
const core = require("../extension/fitshield-core.js");

// Every hand-authored .js the build ships, as [name, source].
const shipped = build.FILES.map(([src, dest]) => [String(dest), src])
  .filter(([dest]) => dest.endsWith(".js"))
  .map(([dest, src]) => [dest, fs.readFileSync(src, "utf8")]);

const shippedHtml = build.FILES.map(([src, dest]) => [String(dest), src])
  .filter(([dest]) => dest.endsWith(".html"))
  .map(([dest, src]) => [dest, fs.readFileSync(src, "utf8")]);

test("the runtime ships the files we think it does", () => {
  assert.ok(shipped.length >= 12, `expected the full runtime, found ${shipped.length} scripts`);
  assert.ok(shipped.some(([name]) => name === "background.js"));
  assert.ok(shipped.some(([name]) => name === "fitshield-core.js"));
  assert.ok(shipped.some(([name]) => name === "warning.js"));
});

// ---------------------------------------------------------------------------
// No network
// ---------------------------------------------------------------------------

test("every fetch in the runtime targets a packaged file, never a remote host", () => {
  const offenders = [];

  shipped.forEach(([name, source]) => {
    for (const match of source.matchAll(/fetch\s*\(([^)]*)\)/g)) {
      const argument = match[1];
      const localised = /runtime\.getURL|getURL\(/.test(argument);

      if (!localised) {
        offenders.push(`${name}: fetch(${argument.trim().slice(0, 60)})`);
      }
    }
  });

  assert.deepEqual(offenders, [], `non-local fetch:\n  ${offenders.join("\n  ")}`);
});

test("no other network transport is used at all", () => {
  const BANNED = /XMLHttpRequest|navigator\.sendBeacon|new WebSocket|new EventSource|navigator\.connection/;
  const offenders = shipped.filter(([, source]) => BANNED.test(source)).map(([name]) => name);

  assert.deepEqual(offenders, [], `network transport found in: ${offenders.join(", ")}`);
});

test("no analytics, telemetry, or third-party endpoint is referenced", () => {
  // Matched as service hostnames / credential names, not as ordinary words —
  // "amplitude" is a legitimate word in the decorative background's colour code.
  const BANNED = [
    /google-analytics\.com/i,
    /googletagmanager/i,
    /sentry\.io/i,
    /segment\.(com|io)/i,
    /mixpanel\.com/i,
    /amplitude\.com/i,
    /posthog\.com/i,
    /\bapi[_-]?key\b/i,
    /Authorization['"\s:]*Bearer/i
  ];

  const offenders = shipped
    .filter(([, source]) => BANNED.some((pattern) => pattern.test(source)))
    .map(([name]) => name);

  assert.deepEqual(offenders, [], `possible third-party service in: ${offenders.join(", ")}`);
});

test("the only external URLs are ones the user chooses to open", () => {
  const allowed = [
    "https://fitshield.net",           // the About link on the block page
    "mailto:reports@fitshield.net",    // the report draft, opened on click
    "https://buymeacoffee.com",        // the support link in settings
    "https://img.buymeacoffee.com",    // its button image
    "http://www.w3.org",               // SVG xmlns (not a request)
    "https://example.com",             // placeholder text in an input
    "https://addons.mozilla.org",      // documentation link
    "https://chromewebstore.google.com"
  ];

  const offenders = [];

  [...shipped, ...shippedHtml].forEach(([name, source]) => {
    for (const match of source.matchAll(/(?:https?:|mailto:)[^\s"'`)]+/g)) {
      const url = match[0];

      // A template literal is a URL being CONSTRUCTED from a blocklist domain
      // (e.g. `https://${site.domain}/`), which is the brand's own home page and
      // only ever used as a navigation target the user chose.
      if (url.includes("${")) {
        continue;
      }

      if (!allowed.some((prefix) => url.startsWith(prefix))) {
        offenders.push(`${name}: ${url}`);
      }
    }
  });

  assert.deepEqual(offenders, [], `unexpected external URL:\n  ${offenders.join("\n  ")}`);
});

// ---------------------------------------------------------------------------
// No dynamic code, no injected markup
// ---------------------------------------------------------------------------

test("no dynamic code evaluation anywhere in the runtime", () => {
  const BANNED = /\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*["'`]|setInterval\s*\(\s*["'`]/;
  const offenders = shipped.filter(([, source]) => BANNED.test(source)).map(([name]) => name);

  assert.deepEqual(offenders, [], `dynamic code evaluation in: ${offenders.join(", ")}`);
});

test("no page that renders user or catalog data uses innerHTML", () => {
  // ambient.js is the one exception and is asserted separately below: it is the
  // purely decorative background, and nothing it renders comes from outside the
  // file.
  const DATA_RENDERERS = [
    "warning.js",
    "preferences.js",
    "popup.js",
    "settings.js",
    "welcome.js",
    "whats-new.js",
    "diagnostics.js",
    "backup.js",
    "recipes.js",
    "background.js"
  ];

  const offenders = [];

  shipped.forEach(([name, source]) => {
    if (!DATA_RENDERERS.includes(name)) {
      return;
    }

    if (/\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|document\.write/.test(source)) {
      offenders.push(name);
    }
  });

  assert.deepEqual(offenders, [], `markup injection risk in: ${offenders.join(", ")}`);
});

test("the decorative background's innerHTML is built only from its own constants", () => {
  const source = shipped.find(([name]) => name === "ambient.js")[1];
  const assignment = /container\.innerHTML\s*=([\s\S]*?)\n\s*}/.exec(source);

  assert.ok(assignment, "ambient.js should still build its layers in one place");

  // Nothing from storage, the catalog, the URL, or the blocked page may reach it.
  const TAINTED = /storage|getURL|searchParams|location|sendMessage|catalog|recipe|customAlternatives|textContent/i;
  assert.ok(
    !TAINTED.test(assignment[1]),
    "ambient.js must not render anything that could originate outside the file"
  );
});

// ---------------------------------------------------------------------------
// Least privilege
// ---------------------------------------------------------------------------

test("the manifest asks for exactly the permissions the runtime uses", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

  assert.deepEqual(
    manifest.permissions.slice().sort(),
    ["alarms", "declarativeNetRequest", "storage"],
    "permission set changed — justify it before shipping"
  );

  // tabs.query / tabs.onRemoved / tabs.create are all usable WITHOUT the "tabs"
  // permission; that permission only gates reading a tab's URL, which FitShield
  // never does. Asserted here so nobody adds it "to be safe".
  assert.ok(!manifest.permissions.includes("tabs"), 'the "tabs" permission is not needed and must not be added');
  assert.ok(!manifest.permissions.includes("webRequest"));
  assert.ok(!manifest.permissions.includes("history"));
  assert.ok(!manifest.permissions.includes("cookies"));
  assert.ok(!manifest.permissions.includes("bookmarks"));
  assert.ok(!manifest.permissions.includes("downloads"));
});

test("no custom content security policy relaxes the MV3 default", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert.equal(manifest.content_security_policy, undefined);
});

test("no page carries an inline script", () => {
  const offenders = [];

  shippedHtml.forEach(([name, source]) => {
    for (const tag of source.match(/<script\b[^>]*>/g) || []) {
      if (!/\ssrc="/.test(tag)) {
        offenders.push(`${name}: ${tag}`);
      }
    }
  });

  assert.deepEqual(offenders, [], `inline script (blocked by the MV3 CSP anyway):\n  ${offenders.join("\n  ")}`);
});

test("external links cannot reach back into the opener", () => {
  const offenders = [];

  shippedHtml.forEach(([name, source]) => {
    for (const tag of source.match(/<a\b[^>]*target="_blank"[^>]*>/g) || []) {
      if (!/rel="[^"]*noopener/.test(tag)) {
        offenders.push(`${name}: ${tag}`);
      }
    }
  });

  assert.deepEqual(offenders, [], `target="_blank" without rel="noopener":\n  ${offenders.join("\n  ")}`);

  // window.open calls must pass noopener too.
  shipped.forEach(([name, source]) => {
    for (const match of source.matchAll(/window\.open\s*\(([^;]*)\)/g)) {
      if (/_blank/.test(match[1]) && !/noopener/.test(match[1])) {
        offenders.push(`${name}: window.open(${match[1].trim().slice(0, 60)})`);
      }
    }
  });

  assert.deepEqual(offenders, [], `window.open without noopener:\n  ${offenders.join("\n  ")}`);
});

// ---------------------------------------------------------------------------
// Untrusted input
// ---------------------------------------------------------------------------

test("prototype pollution is rejected everywhere untrusted data enters", () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"enabled":true}');

  core.migrateState(payload);
  core.readSettings(payload);
  core.safeObject(payload);
  core.normalizeCustomAlternatives([JSON.parse('{"__proto__":{"polluted":true},"name":"x","steps":["y"]}')]);
  core.activePasses([JSON.parse('{"__proto__":{"polluted":true},"createdAt":1,"expiresAt":2}')]);

  assert.equal({}.polluted, undefined, "Object.prototype was modified");
  assert.equal([].polluted, undefined);
});

test("a hostile domain string cannot escape hostname normalization", () => {
  const engine = require("../FS Engine");
  const hostile = [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://evil.example/../../doordash.com",
    "doordash.com.evil.example",
    "..doordash.com",
    " doordash.com"
  ];

  hostile.forEach((value) => {
    const host = engine.normalizeHostname(value);

    assert.ok(typeof host === "string", `${value} should normalize to a string`);
    // A normalized host is only ever compared against blocklist entries and put
    // into a declarativeNetRequest urlFilter. It is never navigated to and never
    // rendered, so the invariants that matter are: no markup, no scheme, no
    // path, and no way to smuggle a second URL through.
    assert.ok(!/[<>"'`]/.test(host), `${value} produced markup characters: ${host}`);
    assert.ok(!host.includes("/"), `${value} kept a path: ${host}`);
    assert.ok(!host.includes(":"), `${value} kept a scheme or port: ${host}`);
  });

  // A look-alike suffix must not be treated as the real brand — this is the
  // property that stops "doordash.com.evil.example" inheriting a pass.
  assert.equal(engine.domainMatches("doordash.com.evil.example", "doordash.com"), false);
  assert.equal(engine.domainMatches("notdoordash.com", "doordash.com"), false);
  assert.equal(engine.domainMatches("order.doordash.com", "doordash.com"), true);
});

test("imported backups are size-limited before they are parsed", () => {
  const backup = require("../extension/backup.js");
  const huge = JSON.stringify({ settings: { theme: "x".repeat(backup.MAX_BYTES) } });

  assert.throws(() => backup.parseBackup(huge), /too large/);
  assert.ok(backup.MAX_BYTES <= 4 * 1024 * 1024, "the import ceiling should stay small");
});

test("user-authored text is length-capped so storage cannot be filled", () => {
  const result = core.sanitizeCustomAlternative({
    name: "x".repeat(100000),
    steps: Array.from({ length: 10000 }, () => "y".repeat(10000))
  });

  assert.ok(result.value.title.length <= core.CUSTOM_LIMITS.name);
  assert.ok(result.value.steps.length <= core.CUSTOM_LIMITS.steps);
  result.value.steps.forEach((step) => assert.ok(step.length <= core.CUSTOM_LIMITS.step));
});

test("rotation and repeat history are bounded", () => {
  let recent = [];
  for (let i = 0; i < 1000; i += 1) {
    recent = core.pushRecent(recent, `id-${i}`);
  }
  assert.ok(recent.length <= core.MAX_RECENT_SHOWN);

  let history = {};
  for (let i = 0; i < 1000; i += 1) {
    history = core.recordContinue(history, `site${i}.example`, Date.now());
  }
  assert.ok(Object.keys(core.normalizeRepeatHistory(history)).length <= 60);
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test("a problem report cannot carry a path, query string, or credentials", () => {
  const redacted = core.redactReportSubject(
    "https://user:pw@www.doordash.com/store/9/checkout?cart=abc&email=me%40example.com#pay"
  );

  assert.equal(redacted, "doordash.com");
});

test("nothing in the runtime reads a tab URL or browsing history", () => {
  const BANNED = /chrome\.history|browser\.history|chrome\.topSites|chrome\.browsingData|tab\.url|\.pendingUrl/;
  const offenders = shipped.filter(([, source]) => BANNED.test(source)).map(([name]) => name);

  assert.deepEqual(offenders, [], `browsing-history access in: ${offenders.join(", ")}`);
});

test("nothing attempts geolocation", () => {
  const offenders = shipped
    .filter(([, source]) => /navigator\.geolocation|getCurrentPosition/.test(source))
    .map(([name]) => name);

  assert.deepEqual(offenders, [], `geolocation access in: ${offenders.join(", ")}`);
});

test("storage.sync is never used — everything stays on one device", () => {
  const offenders = shipped
    .filter(([, source]) => /storage\.sync/.test(source))
    .map(([name]) => name);

  assert.deepEqual(offenders, [], `storage.sync in: ${offenders.join(", ")}`);
});
