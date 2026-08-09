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

test("the real, top-level block page is unaffected", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const response = await new Promise((resolve) => {
    const handled = bg.listeners.message(
      { type: "recordInterruption" },
      { id: "test", url: "chrome-extension://test/warning.html", tab: { id: 7 }, frameId: 0 },
      resolve
    );
    if (!handled) resolve({ ok: false });
  });

  assert.equal(response.ok, true, "frameId 0 is the document the DNR rule redirected");
  assert.equal(bg.store.stats.totals.interruptions, 1);
});

test("the extension's own pages are still allowed", async () => {
  const { loadBackground } = require("./helpers/background-harness.js");
  const bg = loadBackground();
  await bg.context.queueRefreshBlockingState();

  const response = await new Promise((resolve) => {
    const handled = bg.listeners.message(
      { type: "recordInterruption" },
      { id: "test", url: "chrome-extension://test/warning.html" },
      resolve
    );
    if (!handled) resolve({ ok: false });
  });

  assert.equal(response.ok, true, "the block page must keep working");
  assert.equal(bg.store.stats.totals.interruptions, 1);
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
