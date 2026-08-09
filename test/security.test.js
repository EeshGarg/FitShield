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

// An allowlist is only a guarantee about what is NOT here. Every entry that
// stays listed after its last real use is a hole: the test keeps passing while
// the thing it permits is quietly reintroduced.
//
// `https://img.buymeacoffee.com` was the worst of the four. It was the support
// button's IMAGE — a remote <img> on the settings page, which is a request the
// user never chooses to make. Merely opening Settings would have sent their IP
// address, User-Agent, and Referer to a third party, on a product whose central
// claim is that it makes no network requests at all. The image is gone; while
// its host stayed on this list, putting it back would not have failed a single
// test. `addons.mozilla.org` and `chromewebstore.google.com` were store links
// that no longer exist in any shipped file, and `mailto:reports@fitshield.net`
// was the mail-draft button removed when that domain turned out to publish no
// MX record (see the comment in preferences.js).
//
// Each of the four was verified absent from every file build.js ships before it
// was removed here, and "no entry outlives its use" is now itself asserted by
// the test below, so this list cannot rot again.
const EXTERNAL_URL_ALLOWLIST = [
  "https://fitshield.net",           // the About link on the block page
  "https://buymeacoffee.com",        // the support link in settings
  "http://www.w3.org",               // SVG xmlns (not a request)
  "https://example.com"              // placeholder text in an input
];

// The URLs a set of [name, source] files contains that the allowlist does not
// cover. Extracted so the scan itself can be tested against a file that is
// deliberately hostile — see the reintroduction test below.
function externalUrlOffenders(files, allowed) {
  const offenders = [];

  files.forEach(([name, source]) => {
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

  return offenders;
}

test("the only external URLs are ones the user chooses to open", () => {
  const offenders = externalUrlOffenders([...shipped, ...shippedHtml], EXTERNAL_URL_ALLOWLIST);

  assert.deepEqual(offenders, [], `unexpected external URL:\n  ${offenders.join("\n  ")}`);
});

// The rot check. An allowlist entry with no remaining use is not harmless
// housekeeping — it is a standing permission for something nobody is watching
// for any more, and the four removed above had been exactly that.
test("every allowlisted external URL is one the runtime actually uses", () => {
  const corpus = [...shipped, ...shippedHtml].map(([, source]) => source).join("\n");

  const dead = EXTERNAL_URL_ALLOWLIST.filter((prefix) => !corpus.includes(prefix));

  assert.deepEqual(
    dead,
    [],
    "these are permitted but appear in no shipped file — remove them, or the " +
      `test stops guarding against their return:\n  ${dead.join("\n  ")}`
  );
});

// The specific regression. Each of these was permitted while being used by
// nothing, so re-adding it — most damagingly the remote support-button image,
// which would have leaked every user's IP and User-Agent to a third party on
// each settings-page open — was a silent, passing change. Proved two ways: the
// hosts are gone from the shipped files AND the scan now flags them.
test("a removed third-party host cannot be reintroduced unnoticed", () => {
  const RETIRED = [
    "https://img.buymeacoffee.com",
    "https://addons.mozilla.org",
    "https://chromewebstore.google.com",
    "mailto:reports@fitshield.net"
  ];

  // 1. None of them is permitted any more.
  const stillAllowed = RETIRED.filter((url) => EXTERNAL_URL_ALLOWLIST.some((p) => url.startsWith(p)));
  assert.deepEqual(stillAllowed, [], `still allowlisted: ${stillAllowed.join(", ")}`);

  // 2. None of them is in a shipped file today.
  const present = [];
  [...shipped, ...shippedHtml].forEach(([name, source]) => {
    RETIRED.forEach((url) => {
      if (source.includes(url)) {
        present.push(`${name}: ${url}`);
      }
    });
  });
  assert.deepEqual(present, [], `retired host is back:\n  ${present.join("\n  ")}`);

  // 3. And the scan would CATCH each one — the property that was false before.
  //    The support-button image is spelled out as the real markup it would be.
  const hostile = [
    ["settings.html", '<img src="https://img.buymeacoffee.com/button-api/?slug=x" alt="">'],
    ["settings.html", '<a href="https://addons.mozilla.org/addon/fitshield">Rate us</a>'],
    ["settings.html", '<a href="https://chromewebstore.google.com/detail/fitshield">Rate us</a>'],
    ["preferences.js", 'const draft = "mailto:reports@fitshield.net?subject=" + subject;']
  ];

  hostile.forEach((file) => {
    const caught = externalUrlOffenders([file], EXTERNAL_URL_ALLOWLIST);
    assert.equal(caught.length, 1, `reintroducing ${file[1].slice(0, 48)}… was not caught`);
  });
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

// The MV3 default is `script-src 'self'; object-src 'self'` and NOTHING else —
// which means img-src, connect-src, font-src and media-src are unrestricted on
// every extension page. Measured in Chrome 149 against the built package with no
// declared policy: a remote <img> injected into settings.html LOADED. That is
// the exact shape of the beacon this product had once already (the removed
// buymeacoffee button image), and "we checked there is no remote image today" is
// a weaker guarantee than "a remote image cannot load".
//
// So the policy is declared, and it is declared TIGHTER. Every page was loaded
// under it in real Chrome — all six render, both <style> blocks apply, and the
// remote <img> and the remote fetch both became "blocked".
//
// `frame-ancestors 'none'` is deliberately NOT here. Chrome accepts it and does
// not apply it to a web_accessible_resource loaded by a website, so it would
// read as protection against the hidden-iframe attack while providing none. That
// attack is stopped in the worker, where it can actually be stopped.
const CSP_MUST_INCLUDE = {
  "script-src": "'self'",
  "object-src": "'self'",
  // The one that enforces "no telemetry" rather than asserting it.
  "connect-src": "'self'",
  "img-src": "'self' data:",
  "font-src": "'self'",
  "media-src": "'self'",
  "frame-src": "'none'",
  "child-src": "'none'",
  "form-action": "'none'",
  "base-uri": "'none'"
};

test("the declared CSP is strictly tighter than the MV3 default, never looser", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const policy = manifest.content_security_policy && manifest.content_security_policy.extension_pages;

  assert.ok(policy, "extension_pages CSP must be declared — the MV3 default leaves img-src and connect-src open");

  const directives = {};
  policy.split(";").map((part) => part.trim()).filter(Boolean).forEach((part) => {
    const [name, ...values] = part.split(/\s+/);
    directives[name] = values.join(" ");
  });

  Object.entries(CSP_MUST_INCLUDE).forEach(([name, expected]) => {
    assert.equal(directives[name], expected, `${name} must be exactly "${expected}"`);
  });

  // Nothing may loosen it. 'unsafe-inline' is permitted for STYLE only — the
  // pages carry <style> blocks — and never for script.
  assert.ok(!/unsafe-eval|wasm-unsafe-eval/.test(policy), "no eval may ever be permitted");
  assert.ok(!/https?:/.test(policy), "no remote origin may appear in the policy");
  assert.ok(
    !/script-src[^;]*unsafe-inline/.test(policy),
    "'unsafe-inline' must never reach script-src"
  );
  assert.equal(directives["style-src"], "'self' 'unsafe-inline'", "the pages' <style> blocks need exactly this");
});

test("the built packages all carry the same tightened CSP", () => {
  const source = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

  [build.chromeManifest, build.firefoxManifest].forEach((derive) => {
    const derived = derive(JSON.parse(JSON.stringify(source)));
    assert.deepEqual(
      derived.content_security_policy,
      source.content_security_policy,
      "a derived manifest dropped or changed the policy"
    );
  });
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
    "\u0000doordash.com"
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

// The note printed directly above the field is unconditional — "Query strings
// are stripped and only the domain is included" — and it is what persuades a
// cautious user to paste a URL at all. The redaction gated on a dotted-alpha
// hostname and fell through to the RAW TEXT when that failed, so an IP literal,
// a single-label host, and a trailing-dot FQDN all bypassed it entirely: a user
// reporting a false positive on an intranet or router-hosted ordering page got
// their session token copied verbatim into a mail draft addressed to the vendor.
test("no URL escapes redaction, whatever its host looks like", () => {
  const cases = [
    ["http://192.168.1.50/admin?token=SECRET123", "192.168.1.50"],
    ["https://localhost:3000/checkout?card=4111111111111111", "localhost"],
    ["https://ubereats.com./store?q=late+night+order", "ubereats.com"],
    ["http://[2001:db8::1]/order?session=abc", "2001:db8::1"],
    ["https://10.0.0.8:8443/cart#pay", "10.0.0.8"],
    // No scheme, but unmistakably a URL: a path, a query, or both.
    ["192.168.1.50/admin?token=SECRET123", "192.168.1.50"],
    ["intranet/order?id=99", "intranet"],
    ["www.doordash.com/store/9?cart=abc", "doordash.com"]
  ];

  cases.forEach(([input, expected]) => {
    const redacted = core.redactReportSubject(input);

    assert.equal(redacted, expected, `${input} was not reduced to its host`);
    assert.ok(!redacted.includes("?"), `${input} kept a query string`);
    assert.ok(!redacted.includes("/"), `${input} kept a path`);
    assert.ok(!/SECRET123|4111111111111111|session=|token=|cart=/.test(redacted), `${input} leaked a secret`);
  });
});

test("free text a user typed instead of a URL is still passed through", () => {
  // The fallback is for labels, not for URLs — it must keep working, or the
  // field stops accepting "the checkout page" as an answer.
  assert.equal(core.redactReportSubject("the checkout page"), "the checkout page");
  assert.equal(core.redactReportSubject("doordash"), "doordash");
  assert.equal(core.redactReportSubject(""), "");
  assert.ok(core.redactReportSubject("x".repeat(500)).length <= 120, "and it is still length-capped");
});

// ---------------------------------------------------------------------------
// repeatHistory is the one stored map that is browsing-adjacent
// ---------------------------------------------------------------------------

// Retention is only real if the worker WRITES it back. readSettings prunes on
// read, but the copy that matters is the one on disk — that is what anyone with
// a moment at an unlocked machine can read, and it is the only reason this map
// was ever described as "a short-lived window".
test("switching repeat friction off deletes the history it was kept for", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const now = Date.now();

  const bg = loadBackground({
    repeatFrictionEnabled: true,
    repeatWindowMinutes: 60,
    repeatHistory: { "doordash.com": [now - 1000], "ubereats.com": [now - 2000] }
  });

  await bg.context.queueRefreshBlockingState();
  assert.deepEqual(Object.keys(bg.store.repeatHistory).sort(), ["doordash.com", "ubereats.com"],
    "precondition: the feature is on and the rows are fresh");

  // The user turns it off. Nothing reads the map any more, so nothing may keep
  // it: it is a brand-keyed record of every time they gave in.
  bg.store.repeatFrictionEnabled = false;
  await bg.context.queueRefreshBlockingState();

  // Object.keys, not deepEqual: the worker's objects are built inside the vm
  // sandbox, so an identical {} has a different realm's prototype.
  assert.deepEqual(Object.keys(bg.store.repeatHistory), [],
    "the relapse diary must not outlive the feature that read it");

  // And a continue while it is off writes nothing back.
  await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "site10" });
  assert.deepEqual(Object.keys(bg.store.repeatHistory), [], "and continuing must not start it again");
});

test("a stored repeat window cannot extend retention, because there is no such setting", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const now = Date.now();
  const hours = (n) => now - n * 60 * 60 * 1000;

  // A hand-edited profile (or an old backup) claiming a 12-hour window used to
  // be honoured, which made retention 36 hours — for a value no control in the
  // product could ever set. Retention is a documented constant now, so this row
  // is simply outside it.
  const bg = loadBackground({
    repeatFrictionEnabled: true,
    repeatWindowMinutes: 720,
    repeatHistory: { "doordash.com": [hours(12)] }
  });

  await bg.context.queueRefreshBlockingState();

  assert.deepEqual(Object.keys(bg.store.repeatHistory), [],
    "a smuggled window must not keep a brand-keyed timestamp alive on disk");
  assert.ok(
    core.repeatHistoryRetentionMs(720) <= core.repeatHistoryRetentionMs(core.DEFAULT_REPEAT_WINDOW_MINUTES) * 12,
    "and the ceiling is still bounded"
  );
});

test("the key that decides retention actually triggers a re-evaluation", () => {
  const source = shipped.find(([name]) => name === "background.js")[1];
  const keys = /const REFRESH_KEYS = \[([\s\S]*?)\];/.exec(source);

  assert.ok(keys, "background.js should still declare REFRESH_KEYS as a literal list");
  assert.ok(
    keys[1].includes('"repeatFrictionEnabled"'),
    "switching repeat friction off decides whether the history is kept at all, so it must refresh"
  );

  // And the phantom key stays gone from every list that made it look real.
  assert.ok(!source.includes('"repeatWindowMinutes"'), "background.js must not read a key nothing writes");
  const backupSource = shipped.find(([name]) => name === "backup.js")[1];
  assert.ok(
    !/^\s*"repeatWindowMinutes",/m.test(backupSource),
    "a backup must not carry a key nothing writes"
  );
});

test("no message handler exists that no FitShield surface sends", () => {
  const source = shipped.find(([name]) => name === "background.js")[1];
  const table = /const HANDLERS = \{([\s\S]*?)\n\};/.exec(source);

  assert.ok(table, "background.js should still declare HANDLERS as a literal table");

  const handlers = [...table[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]);
  assert.ok(handlers.length >= 10, `expected the message surface, found ${handlers.join(", ")}`);

  // Every handler must be sent by something that ships. `refreshBlocking` was
  // not: it rebuilt every rule and rewrote passes and repeat history on demand,
  // reachable from the one FitShield page a website can cause to load, and no
  // page, shim or script anywhere sent it.
  const senders = shipped
    .filter(([name]) => name !== "background.js")
    .map(([, text]) => text)
    .join("\n");

  const orphans = handlers.filter((type) => !senders.includes(`"${type}"`));
  assert.deepEqual(orphans, [], `message handlers nothing sends: ${orphans.join(", ")}`);
});

test("repeat history cannot become a permanent per-brand diary", () => {
  const now = Date.now();
  const year = 365 * 24 * 60 * 60 * 1000;

  const ancient = core.normalizeRepeatHistory(
    { "ubereats.com": [now - 2 * year, now - 3 * year], "dominos.com": [now - year] },
    { now, windowMinutes: 60 }
  );

  assert.deepEqual(ancient, {}, "nothing from years ago may survive a read");

  // And the ceiling holds for the longest window a user can configure.
  assert.ok(core.repeatHistoryRetentionMs(720) <= 36 * 60 * 60 * 1000);
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

// ---------------------------------------------------------------------------
// warning.html is web_accessible_resources with <all_urls> — it has to be, it is
// the declarativeNetRequest redirect target. That means any website could post
// the worker's recording messages, or embed the block page in a hidden iframe,
// and run up the user's interruption count and brand breakdown. Statistics the
// product presents as OBSERVED events must not be forgeable by the very pages it
// exists to interrupt.
// ---------------------------------------------------------------------------

test("a web page cannot forge a statistics event", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const fromWebPage = (payload) =>
    new Promise((resolve) => {
      const handled = bg.listeners.message(payload, { id: "evil", url: "https://evil.example/page" }, resolve);
      if (!handled) resolve({ ok: false });
    });

  const before = JSON.stringify(bg.store.stats || {});

  for (const type of [
    "recordInterruption",
    "recordLeft",
    "recordAlternativeShown",
    "recordAlternativeSelected",
    "markAlternativeMade"
  ]) {
    const response = await fromWebPage({ type, id: "naan-pizza", meta: { domain: "doordash.com" } });
    assert.equal(response.ok, false, `${type} must be refused from a web page`);
  }

  assert.equal(JSON.stringify(bg.store.stats || {}), before, "no counter may move");
});

test("a web page cannot grant itself a temporary pass", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const response = await new Promise((resolve) => {
    const handled = bg.listeners.message(
      { type: "grantPass", site: "delivery-doordash-com", presetId: "site30" },
      { id: "evil", url: "https://evil.example/page" },
      resolve
    );
    if (!handled) resolve({ ok: false });
  });

  assert.equal(response.ok, false, "a page must not be able to unblock itself");
  assert.equal((bg.store.passes || []).length, 0, "and no pass may exist");
});

// The origin check alone was not enough. warning.html is web_accessible_resources
// with <all_urls> at a STABLE chrome-extension:// URL (the extension id is fixed
// and public for a listed extension), so a hostile page can load it in a 1x1
// hidden iframe in a loop — and every one of those loads is a message from
// FitShield's own origin, which passed. A blocked delivery brand is exactly the
// party motivated to run the user's "ordering pages interrupted" count and
// per-brand breakdown up until the panel is worthless. The real block page is
// always a top-level main_frame redirect, so a framed sender is never one.
test("a website cannot fabricate statistics by iframing the block page", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const fromHiddenIframe = (payload) =>
    new Promise((resolve) => {
      const handled = bg.listeners.message(
        payload,
        {
          id: "test",
          // Our own page, our own origin — but embedded in a page on evil.example.
          url: "chrome-extension://test/warning.html?site=delivery-doordash-com",
          tab: { id: 7 },
          frameId: 3
        },
        resolve
      );
      if (!handled) resolve({ ok: false });
    });

  for (let load = 0; load < 5; load += 1) {
    const recorded = await fromHiddenIframe({ type: "recordInterruption" });
    const branded = await fromHiddenIframe({
      type: "recordBlockedBrand",
      meta: { domain: "doordash.com", category: "pizza", countries: ["US"] }
    });

    assert.equal(recorded.ok, false, "a framed block page must not record an interruption");
    assert.equal(branded.ok, false, "nor a brand");
  }

  core.STAT_EVENTS.forEach((event) => {
    assert.equal(bg.store.stats.totals[event], 0, `"${event}" moved for a framed page`);
  });
  assert.equal(bg.store.blockedByDomain, undefined, "and no brand breakdown was created");
});

test("a framed page cannot grant itself a pass either", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const response = await new Promise((resolve) => {
    const handled = bg.listeners.message(
      { type: "grantPass", site: "delivery-doordash-com", presetId: "site30" },
      { id: "test", url: "chrome-extension://test/warning.html", tab: { id: 7 }, frameId: 2 },
      resolve
    );
    if (!handled) resolve({ ok: false });
  });

  assert.equal(response.ok, false);
  assert.equal((bg.store.passes || []).length, 0);
});

test("the real, top-level, redirected block page is unaffected", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const response = await bg.message({ type: "recordInterruption" });

  assert.equal(response.ok, true, "the page the DNR rule redirected to must keep working");
  assert.equal(bg.store.stats.totals.interruptions, 1);
});

test("the extension's own non-block pages are still allowed", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  // The popup carries no frameId at all and is not the block page, so it needs
  // no redirect token.
  const response = await bg.message(
    { type: "recordInterruption" },
    { id: "test", url: "chrome-extension://test/popup.html" }
  );

  assert.equal(response.ok, true, "the popup must keep working");
  assert.equal(bg.store.stats.totals.interruptions, 1);
});

// ---------------------------------------------------------------------------
// The half the frameId rule does not cover.
//
// A hostile page does not have to EMBED the block page. It can send the tab
// straight to `chrome-extension://<id>/warning.html?site=delivery-doordash-com`,
// which is a top-level document on our own origin: same id, frameId 0, our
// origin. Every provenance check passed it.
//
// Measured in Chrome 149 against the built dist/chrome package before this was
// fixed: four such navigations moved stats.totals.interruptions from 2 to 6 and
// wrote doordash.com into blockedByDomain. The panel is the product's only
// feedback loop and it presents those numbers as facts about the user, so the
// brand being blocked could author them.
// ---------------------------------------------------------------------------

test("a block page the extension did not redirect to cannot record anything", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  // Exactly what a website can construct: our origin, our block page, a real
  // site key, top-level. Everything except the token, which lives only in the
  // dynamic rules and in chrome.storage.session.
  const navigated = (search) =>
    bg.message(
      { type: "recordInterruption" },
      { id: "test", url: `chrome-extension://test/warning.html${search}`, tab: { id: 7 }, frameId: 0 }
    );

  for (const search of [
    "?site=delivery-doordash-com",
    "?site=delivery-doordash-com&k=",
    "?site=delivery-doordash-com&k=guessed-token",
    "?site=delivery-doordash-com&k=0000000000000000",
    ""
  ]) {
    const response = await navigated(search);
    assert.equal(response.ok, false, `a forged block page at "${search}" recorded an interruption`);
  }

  const branded = await bg.message(
    { type: "recordBlockedBrand", meta: { domain: "doordash.com", category: "pizza", countries: ["US"] } },
    { id: "test", url: "chrome-extension://test/warning.html?site=delivery-doordash-com", frameId: 0 }
  );

  assert.equal(branded.ok, false, "nor a brand");
  core.STAT_EVENTS.forEach((event) => {
    assert.equal(bg.store.stats.totals[event], 0, `"${event}" moved for a forged block page`);
  });
  assert.equal(bg.store.blockedByDomain, undefined, "and no brand breakdown was created");
});

test("a forged block page cannot grant a pass or touch any durable state", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();
  const ruleCount = bg.rules().length;

  const forged = { id: "test", url: "chrome-extension://test/warning.html?site=delivery-doordash-com", frameId: 0 };

  const pass = await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "allTomorrow" }, forged);
  const revoke = await bg.message({ type: "revokeAllPasses" }, forged);
  const record = await bg.message({ type: "recordAlternativeSelected", id: "naan-pizza" }, forged);

  assert.equal(pass.ok, false, "a website that opens the block page must not be able to unblock a site");
  assert.equal(revoke.ok, false, "nor cancel the user's own passes");
  assert.equal(record.ok, false, "nor write to the rotation history");
  assert.equal((bg.store.passes || []).length, 0);
  assert.equal(bg.store.recentAlternatives, undefined);
  assert.equal(bg.rules().length, ruleCount, "blocking must be exactly as it was");
});

test("the token is in the redirect URL the worker actually installs", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const rules = bg.rules();
  assert.ok(rules.length > 100, "expected a real rule set");

  const token = await bg.evalIn("ensureBlockPageToken()");
  assert.ok(typeof token === "string" && token.length >= 16, `the token should be unguessable, got "${token}"`);

  rules.forEach((rule) => {
    const url = new URL(rule.action.redirect.url);
    assert.equal(url.searchParams.get("k"), token, "every redirect must carry the current token");
    assert.ok(url.searchParams.get("site"), "and still name the site");
  });
});

test("a block page opened as a PREVIEW is allowed, and records nothing", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  // Settings and the welcome tour open warning.html?preview=1 directly, with no
  // token — there was no redirect. It has to keep working, and it must stay
  // incapable of moving a number.
  const preview = { id: "test", url: "chrome-extension://test/warning.html?site=delivery-doordash-com&preview=1" };

  const recorded = await bg.message({ type: "recordInterruption" }, preview);
  const granted = await bg.message({ type: "grantPass", site: "delivery-doordash-com", presetId: "site10" }, preview);

  assert.equal(recorded.ok, true, "the preview must still render and answer");
  assert.equal(recorded.recorded, false, "but it must not count");
  assert.equal(granted.granted, false, "and it must not unblock anything");
  assert.equal(bg.store.stats.totals.interruptions, 0);
  assert.equal((bg.store.passes || []).length, 0);
});

test("a page cannot lie about being a preview, in either direction", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  // `preview` is read from the URL the worker can see, never from the message.
  // Claiming preview:false from a preview URL used to be the whole bypass.
  const lying = await bg.message(
    { type: "recordInterruption", preview: false },
    { id: "test", url: "chrome-extension://test/warning.html?site=delivery-doordash-com&preview=1" }
  );

  assert.equal(lying.recorded, false, "a preview URL records nothing whatever the message claims");
  assert.equal(bg.store.stats.totals.interruptions, 0);

  // And the reverse: the real block page cannot opt out of being counted.
  const real = await bg.message({ type: "recordInterruption", preview: true });
  assert.equal(real.recorded, true, "the real block page counts, whatever the message claims");
  assert.equal(bg.store.stats.totals.interruptions, 1);
});

test("read-only handlers are refused from a framed surface too", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground({ dietPreference: "vegan", avoidAllergens: ["peanut"], pantry: ["rice"] });
  await bg.context.queueRefreshBlockingState();

  // getBlockContext hands back the user's diet, allergens, pantry and their own
  // written-out recipes. Nothing FitShield ships runs in a frame, so a framed
  // caller is a hostile embed and gets nothing — not even a read.
  const framed = { id: "test", url: "chrome-extension://test/warning.html", tab: { id: 7 }, frameId: 4 };

  for (const type of ["getBlockState", "getBlockContext", "getDiagnostics"]) {
    const response = await bg.message({ type, site: "delivery-doordash-com" }, framed);
    assert.equal(response.ok, false, `${type} answered a framed caller`);
    assert.ok(
      !JSON.stringify(response).includes("peanut") && !JSON.stringify(response).includes("vegan"),
      `${type} leaked the user's preferences to a frame`
    );
  }
});

test("a forged message cannot pin a tab-bound pass to somebody else's tab", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  // The sender's real tab wins. `tabId` was read from the message first, so a
  // message could bind a pass to a tab it was not sent from.
  await bg.message(
    { type: "grantPass", site: "delivery-doordash-com", presetId: "tab", tabId: 999 },
    { id: "test", url: await bg.blockPageUrl(), tab: { id: 2 }, frameId: 0 }
  );

  assert.equal(bg.store.passes.length, 1);
  assert.equal(bg.store.passes[0].tabId, 2, "the pass belongs to the tab the block page was actually in");
});

// ---------------------------------------------------------------------------
// Theme values are written straight into CSS custom properties, so an imported
// backup could smuggle a remote resource reference into one and make the
// settings page and popup fetch it — a beacon on a product whose central claim
// is that it makes no network requests at all.
// ---------------------------------------------------------------------------

test("an imported theme cannot carry a remote resource reference", () => {
  const hostile = {
    bg: "#000000",
    accent: "url(" + "https://evil.example/beacon.png)",
    panel: "red; background:url(//evil.example/x)",
    text: "#fff",
    muted: "rgba(1, 2, 3, 0.5)",
    radius: "99999",
    popupWidth: "not-a-number",
    injected: "expression(alert(1))"
  };

  const clean = core.normalizeTheme(hostile);
  const serialized = JSON.stringify(clean);

  assert.ok(!/url\(/i.test(serialized), "no url() may survive");
  assert.ok(!/evil\.example/.test(serialized), "no remote host may survive");
  assert.ok(!/expression/i.test(serialized), "no CSS expression may survive");
  assert.equal(clean.bg, "#000000", "a real colour is kept");
  assert.equal(clean.muted, "rgba(1, 2, 3, 0.5)", "rgba is a real colour");
  assert.equal(clean.radius, 1000, "numbers are clamped, not passed through");
  assert.ok(!("popupWidth" in clean), "a non-numeric size is dropped");
  assert.ok(!("panel" in clean), "a colour with a declaration smuggled in is dropped");
});

// The helper being correct is a different claim from the IMPORT being correct.
// Asserting normalizeTheme in isolation passes happily while the import path
// routes around it — which is exactly how a beacon would get in.
test("the import PATH, not just the helper, strips a remote reference", () => {
  const backup = require("../extension/backup.js");
  const file = JSON.stringify({
    _type: "fitshield-settings-backup",
    schema: 2,
    settings: {
      enabled: true,
      theme: {
        bg: "url(" + "https://evil.example/beacon.png)",
        panel: "red;background:url(//evil.example/x)",
        accent: "#7ef0a8"
      }
    }
  });

  const restored = backup.normalizeImported(backup.parseBackup(file));
  const serialized = JSON.stringify(restored);

  assert.ok(!/evil\.example/.test(serialized), `a remote host reached storage: ${serialized}`);
  assert.ok(!/url\(/i.test(serialized), "no url() may reach storage");
  assert.equal(restored.theme.accent, "#7ef0a8", "and a real colour still restores");
});

// ---------------------------------------------------------------------------
// Untrusted backups, fuzzed through the real entry point.
//
// A backup is the documented way to accept a file from somewhere else, so it is
// the one place a stranger's bytes reach the store the worker trusts. Every one
// of these must end in the same three places: nothing executed, nothing
// polluted, and the user still protected.
// ---------------------------------------------------------------------------

test("a hostile backup is refused with a reason a person can act on, or normalized", () => {
  const backup = require("../extension/backup.js");

  const deeplyNested = (() => {
    const root = { enabled: true };
    let cursor = root;
    for (let i = 0; i < 400; i += 1) {
      cursor.n = {};
      cursor = cursor.n;
    }
    return { settings: root };
  })();

  const cases = {
    "prototype pollution": JSON.stringify({ settings: JSON.parse('{"__proto__":{"pwned":true},"enabled":true}') }),
    "constructor key": JSON.stringify({
      settings: JSON.parse('{"constructor":{"prototype":{"pwned":true}},"enabled":true}')
    }),
    "polluted nested value": JSON.stringify({
      settings: { customSites: JSON.parse('[{"__proto__":{"pwned":true},"domain":"x.example"}]') }
    }),
    "deep nesting": JSON.stringify(deeplyNested),
    "enormous array": JSON.stringify({ settings: { customSites: Array.from({ length: 60000 }, (_, i) => `s${i}.example`) } }),
    "10MB string": JSON.stringify({ settings: { dietPreference: "x".repeat(10 * 1024 * 1024) } }),
    "future schema": JSON.stringify({ _type: backup.BACKUP_TYPE, schema: 99, settings: { enabled: false } }),
    "non-numeric schema": JSON.stringify({ _type: backup.BACKUP_TYPE, schema: "banana", settings: { enabled: false } }),
    "wrong _type": JSON.stringify({ _type: "evil", settings: { enabled: false } }),
    "not json": "{oh no",
    empty: "",
    null: "null",
    array: "[1,2,3]",
    "no known keys": JSON.stringify({ settings: { hello: "world" } }),
    "script tags": JSON.stringify({
      settings: {
        enabled: true,
        customAlternatives: [
          { id: "<script>alert(1)</script>", name: "<img src=x onerror=alert(1)>", steps: ["<svg onload=alert(1)>"] }
        ]
      }
    }),
    "RTL override and null bytes": JSON.stringify({
      settings: { enabled: true, customAlternatives: [{ id: "a", name: "safe‮evil\u0000", steps: ["x\u0000y"] }] }
    }),
    "duplicate ids": JSON.stringify({
      settings: {
        enabled: true,
        customAlternatives: [
          { id: "dup", name: "A", steps: ["s"] },
          { id: "dup", name: "B", steps: ["s"] },
          { id: "dup", name: "C", steps: ["s"] }
        ]
      }
    })
  };

  const rejected = [];

  Object.entries(cases).forEach(([name, text]) => {
    let result = null;

    try {
      result = backup.normalizeImported(backup.parseBackup(text));
    } catch (error) {
      // A rejection must name a reason a page can localize AND a sentence a
      // person can act on. "That file isn't a valid FitShield backup" for a file
      // that is one invites the user to delete their only copy.
      assert.ok(error.i18nKey, `"${name}" was rejected with no localizable reason`);
      assert.ok(String(error.message).length > 10, `"${name}" was rejected with no human sentence`);
      rejected.push(name);
      return;
    }

    // A file that IS accepted must arrive inert and bounded. Markup is stored
    // verbatim on purpose — a recipe may legitimately be called "Fish & <chips>"
    // — and it is safe because every surface renders it with textContent; the
    // "no page that renders user or catalog data uses innerHTML" test above is
    // what keeps that true. What must not survive is anything unbounded,
    // unprintable, or ambiguous about identity.
    const serialized = JSON.stringify(result);
    assert.ok(!/\u0000/.test(serialized), `"${name}" carried a null byte into storage`);
    assert.ok(!/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(serialized), `"${name}" carried a control character`);
    assert.ok(serialized.length < 512 * 1024, `"${name}" wrote ${serialized.length} bytes into storage`);

    const alternatives = result.customAlternatives || [];
    alternatives.forEach((entry) => {
      assert.equal(typeof entry.id, "string");
      assert.ok(entry.id.length <= 64, `"${name}" stored a ${entry.id.length}-character id`);
      assert.ok(entry.title.length <= core.CUSTOM_LIMITS.name, `"${name}" stored an over-long title`);
    });

    const ids = alternatives.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `"${name}" imported duplicate ids — deleting one would delete several`);
  });

  assert.ok(({}).pwned === undefined, "Object.prototype was polluted by an imported backup");
  assert.ok([].pwned === undefined, "Array.prototype was polluted by an imported backup");
  assert.ok(
    rejected.length >= 6,
    `expected the clearly-broken files to be refused, only refused: ${rejected.join(", ")}`
  );
});

test("a hostile backup cannot leave the user unprotected", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const backup = require("../extension/backup.js");

  // The three shapes that would matter most: a file that switches everything
  // off, one that empties the blocklists, and one that arrives with an active
  // pass already granted.
  const hostile = backup.normalizeImported(
    backup.parseBackup(
      JSON.stringify({
        settings: {
          enabled: false,
          deliverySitesEnabled: false,
          fastFoodSitesEnabled: false,
          passes: [{ scope: "all", expiresAt: Date.now() + 9e11, createdAt: Date.now() }],
          siteBypasses: { "doordash.com": Date.now() + 9e11 }
        }
      })
    )
  );

  // `passes` and `siteBypasses` are excluded from a backup precisely so a file
  // cannot hand itself an active permission to reach a blocked site.
  assert.ok(!("passes" in hostile), "an imported file must not be able to carry a live pass");
  assert.ok(!("siteBypasses" in hostile), "nor its retired spelling");

  // The rest is honest user intent — it CAN turn blocking off, the same way the
  // switch can — but the user has to have confirmed the import, and turning it
  // back on must work immediately.
  const bg = loadBackground(hostile);
  await bg.context.queueRefreshBlockingState();
  assert.equal(bg.rules().length, 0, "an off profile blocks nothing, which is what it says");

  bg.store.enabled = true;
  bg.store.deliverySitesEnabled = true;
  bg.store.fastFoodSitesEnabled = true;
  await bg.context.queueRefreshBlockingState();
  assert.ok(bg.rules().length > 100, "and switching it back on restores blocking with no repair step");
});

// ---------------------------------------------------------------------------
// Corrupt storage. A crash that leaves the user unblocked is the worst failure
// this product has: the one thing it promises is that the site does not open.
// ---------------------------------------------------------------------------

test("blocking survives every corrupt value a profile can hold", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");

  const corruptions = {
    "customSites is a string": { customSites: "not-an-array" },
    "customSites holds nulls": { customSites: [null, 5, {}, { domain: null }] },
    "schedule is an array": { schedule: [1, 2, 3] },
    "schedule is null": { schedule: null },
    "schedule windows are junk": { schedule: { mode: "windows", windows: [null, { days: "everyday", start: {} }] } },
    "passes is an object": { passes: { a: 1 } },
    "passes hold junk": { passes: [null, "x", { expiresAt: "soon" }] },
    "stats is a number": { stats: 42 },
    "stats.totals is a string": { stats: { totals: "nope", history: 7 } },
    "schemaVersion is not a number": { schemaVersion: "banana" },
    "schemaVersion is from the future": { schemaVersion: 9999 },
    "enabled is the string false": { enabled: "false" },
    "timerSeconds is Infinity": { timerSeconds: Infinity },
    "timerSeconds is NaN": { timerSeconds: NaN },
    "disabled keys are deeply nested": { disabledDeliverySiteKeys: [[[[["a"]]]]] },
    "repeatHistory is an array": { repeatHistory: [1, 2, 3] },
    "repeatHistory holds strings": { repeatHistory: { "a.com": "yesterday" } },
    "blockedByDomain holds objects": { blockedByDomain: { "a.com": { n: 1 } } },
    "enabledCountries is a number": { enabledCountries: 7 },
    "customAlternatives are hostile": { customAlternatives: [{ id: "a", name: "<img src=x onerror=1>", steps: [1, {}] }, null, "z"] },
    "a huge string value": { dietPreference: "x".repeat(200000) },
    "prototype-polluting keys": JSON.parse('{"__proto__":{"pwned":true},"constructor":{"x":1},"customSites":[]}')
  };

  for (const [label, patch] of Object.entries(corruptions)) {
    const bg = loadBackground({
      enabled: true,
      deliverySitesEnabled: true,
      fastFoodSitesEnabled: true,
      ...patch
    });

    await bg.context.queueRefreshBlockingState();

    assert.ok(({}).pwned === undefined, `${label}: Object.prototype was polluted`);
    assert.ok(
      bg.rules().length > 100,
      `${label}: blocking collapsed to ${bg.rules().length} rules — a corrupt profile must not unblock the user`
    );
    assert.ok(
      bg.rules().some((rule) => rule.condition.urlFilter === "||doordash.com"),
      `${label}: a known brand stopped being blocked`
    );

    // And the block page can still answer, which is what the user actually sees.
    const context = await bg.message({ type: "getBlockContext", site: "delivery-doordash-com" });
    assert.equal(context.ok, true, `${label}: the block page could not be rendered`);
    assert.ok(Number.isFinite(context.timerSeconds), `${label}: the countdown was not a number`);
  }
});
