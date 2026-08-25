"use strict";
/**
 * Independent verification of the block-page provenance work, in a real browser.
 *
 * The claims under test are behavioural, and every one of them was previously
 * argued from source. Source cannot answer them. Whether a website can forge an
 * interruption, whether a genuine block still counts after the browser has been
 * closed and reopened, whether a Content Security Policy blocks a remote image
 * or breaks the page it protects — all of that is decided by the browser, so all
 * of it is measured here by driving the built package in Chromium and reading
 * what actually landed in storage.
 *
 * Two things this file deliberately does NOT do:
 *
 *   1. It never greps the source for the shape of a fix. A source-text assertion
 *      passes while the behaviour underneath is broken, which is exactly how the
 *      hole it is verifying survived earlier review.
 *   2. It never asserts that an attack fails without first proving the harness
 *      can see the attack succeed. The forgery checks run against a deliberately
 *      un-gated copy of the package first; if the counters do not move there,
 *      the harness is broken and the test says so rather than passing.
 *
 * Skips (does not fail) when no Chromium is present, matching
 * tools/browser-a11y-audit.js. Set FS_CHROME to point at a binary.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const build = require("../build.js");
const core = require("../extension/fitshield-core.js");
const { launch, findChrome, unpackedExtensionId, sleep, until } = require("../tools/lib/cdp.js");

const ROOT = path.join(__dirname, "..");
const BACKGROUND = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");

// A brand that is certain to be in the shipped delivery list, and its site key.
const BLOCKED_URL = "https://doordash.com/";
const BLOCKED_KEY = "delivery-doordash-com";
const BLOCKED_DOMAIN = "doordash.com";
const SECOND_URL = "https://ubereats.com/";
const THIRD_URL = "https://grubhub.com/";

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

// Built from source rather than read from dist/chrome: dist may be stale, may be
// mid-rebuild by another process, and is not what a reviewer changed.
function stagePackage(mutateManifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-secver-"));
  build.copyInto(dir);
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
  const manifest = build.chromeManifest(base);

  if (mutateManifest) {
    mutateManifest(manifest);
  }

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return dir;
}

const staged = [];

function stageOnce(key, mutate) {
  const found = staged.find((entry) => entry.key === key);

  if (found) {
    return found.dir;
  }

  const dir = stagePackage(mutate);
  staged.push({ key, dir });
  return dir;
}

test.after(() => {
  staged.forEach(({ dir }) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* a temp dir; Windows sometimes holds it briefly */
    }
  });
});

// ---------------------------------------------------------------------------
// A genuinely hostile web origin
// ---------------------------------------------------------------------------

// chrome-extension:// pages cannot be attacked from another chrome-extension://
// page, and a data: or file: URL is not a web origin either. A real HTTP server
// on the loopback interface is the only way to hold a page that is, from the
// browser's point of view, an ordinary website. It also records every request it
// receives, which is how "no remote resource loaded" is proven rather than
// assumed.
function hostileOrigin() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, referer: req.headers.referer || null });

    if (req.url.startsWith("/evil")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>hostile</title><body>hostile</body>");
      return;
    }

    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end("payload");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        requests,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done))
      })
    );
  });
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

// resolveExtensionId in tools/lib/cdp.js probes each candidate id once with a
// fixed settle and returns null when the page was merely slow, which turns into
// a confusing failure several steps later. Ask the page for its own runtime id
// instead, and retry.
async function extensionId(browser, dir) {
  const candidates = unpackedExtensionId(dir);
  const page = await browser.newPage();

  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const id of candidates) {
        await page.goto(`chrome-extension://${id}/popup.html`, 600 + attempt * 400);
        const seen = await page
          .evaluate(`(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) || ""`)
          .catch(() => "");

        if (seen === id) {
          return id;
        }
      }
    }
  } finally {
    await page.close();
  }

  throw new Error(`could not resolve the extension id for ${dir}`);
}

// A page on the extension's own origin, used to read storage and to speak to the
// worker. Not the block page: this one is never the subject of a test.
async function controlPage(browser, id) {
  const page = await browser.newPage();
  await until(
    async () => {
      await page.goto(`chrome-extension://${id}/popup.html`, 600);
      return page.evaluate(`!!(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)`).catch(() => false);
    },
    { what: "an extension page", timeoutMs: 25000 }
  );
  return page;
}

const STATE_KEYS = ["stats", "blockedByDomain", "blockedByCategory", "passes"];

async function readState(control) {
  const raw = await control.evaluate(
    `(async () => JSON.stringify(await chrome.storage.local.get(${JSON.stringify(STATE_KEYS)})))()`
  );
  const parsed = JSON.parse(raw);
  return {
    interruptions: parsed.stats.totals.interruptions,
    passesUsed: parsed.stats.totals.passesUsed,
    byDomain: parsed.blockedByDomain || {},
    byCategory: parsed.blockedByCategory || {},
    passes: parsed.passes || []
  };
}

const ruleRedirectUrl = (control) =>
  control.evaluate(
    `(async () => { const r = await chrome.declarativeNetRequest.getDynamicRules(); return r.length ? r[0].action.redirect.url : ""; })()`
  );

// Blocking is built asynchronously on first wake. Nothing may be asserted about
// a block before the rules exist, or the test measures the wake-up race instead
// of the thing under test.
const waitForRules = (control) =>
  until(async () => (await ruleRedirectUrl(control)).includes("warning.html"), {
    what: "the blocking rules to be written",
    timeoutMs: 25000
  });

// Drive a top-level navigation FROM the hostile page, which is what a website
// can actually do, and report where the tab ended up.
async function navigateFromHostile(page, hostile, target) {
  await page.goto(`${hostile.origin}/evil.html`, 400);
  await page.evaluate(`location.href = ${JSON.stringify(target)}`);
  await sleep(1600);
  return page.evaluate("location.href");
}

// Storage writes are queued behind rule rebuilds that touch thousands of rules,
// so "nothing happened" has to be given long enough to have happened.
const SETTLE_MS = 2500;

// ---------------------------------------------------------------------------
// Source-level invariants (no browser needed)
// ---------------------------------------------------------------------------

test("no external message surface exists at all", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));

  assert.equal(
    manifest.externally_connectable,
    undefined,
    "externally_connectable would let web pages or other extensions message the worker directly"
  );
  assert.ok(
    !/onMessageExternal|onConnectExternal/.test(BACKGROUND),
    "an external message listener bypasses senderSurface entirely"
  );
  assert.ok(
    !/storage\.session\.setAccessLevel/.test(BACKGROUND),
    "raising the session-storage access level would expose the block-page token to untrusted contexts"
  );
});

test("the redirect rules match main_frame and nothing else", () => {
  // Every other resource type is a request a WEBSITE makes and can read the
  // result of. A rule that redirected one would hand the token, which lives in
  // the redirect URL, to the page that asked.
  const rules = [...BACKGROUND.matchAll(/resourceTypes:\s*\[([^\]]*)\]/g)].map((m) => m[1].replace(/\s|"/g, ""));

  assert.ok(rules.length > 0, "no declarativeNetRequest resourceTypes found in background.js");
  rules.forEach((types) => assert.equal(types, "main_frame", `a rule matches ${types}`));
});

test("every message handler has a sender that ships, and the deleted ones have none", () => {
  const senders = new Map();
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|html)$/.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        const record = (type) => senders.set(type, (senders.get(type) || new Set()).add(entry.name));

        // The three call shapes the product uses: a literal sendMessage, the
        // block page's send() wrapper, and diagnostics' ask() wrapper.
        for (const m of source.matchAll(/sendMessage\(\s*\{[\s\S]{0,240}?type\s*:\s*"([a-zA-Z]+)"/g)) record(m[1]);
        for (const m of source.matchAll(/\bsend\(\s*"([a-zA-Z]+)"/g)) record(m[1]);
        for (const m of source.matchAll(/\bask\(\s*\{\s*type\s*:\s*"([a-zA-Z]+)"/g)) record(m[1]);
      }
    });
  };

  walk(path.join(ROOT, "extension"));
  walk(path.join(ROOT, "android"));

  const table = BACKGROUND.slice(
    BACKGROUND.indexOf("const HANDLERS"),
    BACKGROUND.indexOf("// EVERY message must come from")
  );
  const handled = [...table.matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]);

  assert.ok(handled.length >= 10, `expected the full handler table, found ${handled.length}`);

  const orphans = handled.filter((type) => !senders.has(type));
  assert.deepEqual(orphans, [], `handlers nothing sends:\n  ${orphans.join("\n  ")}`);

  // The two that were removed. A reachable handler with no sender is attack
  // surface with no user, and refreshBlocking rebuilt every rule on demand.
  ["refreshBlocking", "getBlockedSiteInfo"].forEach((gone) => {
    assert.ok(!handled.includes(gone), `"${gone}" is back in the handler table`);
    assert.ok(!senders.has(gone), `something now sends "${gone}"`);
  });
});

test("every state-changing handler is treated as forgeable", () => {
  const table = BACKGROUND.slice(
    BACKGROUND.indexOf("const HANDLERS"),
    BACKGROUND.indexOf("// EVERY message must come from")
  );
  const handled = [...table.matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]);
  const forgeable = new Set(
    [...BACKGROUND.slice(BACKGROUND.indexOf("const WEB_FORGEABLE")).matchAll(/"([a-zA-Z]+)"/g)]
      .slice(0, 32)
      .map((m) => m[1])
  );

  // Anything that is not a plain read has to be inside the provenance gate. The
  // three reads are named explicitly so adding a fourth is a deliberate act.
  const reads = new Set(["getBlockState", "getBlockContext", "getDiagnostics"]);
  const ungated = handled.filter((type) => !reads.has(type) && !forgeable.has(type));

  assert.deepEqual(ungated, [], `state-changing handlers outside WEB_FORGEABLE:\n  ${ungated.join("\n  ")}`);
});

test("retiring repeatWindowMinutes did not change how long repeat history is kept", () => {
  // The key was removed from storage and from the backup payload. What must not
  // have changed is the RETENTION a user experiences, so that is what is
  // measured: a stored value must have no effect, and the effective window must
  // still be the documented hour.
  const now = Date.parse("2026-03-01T12:00:00Z");
  const settings = core.readSettings({ repeatWindowMinutes: 720 }, { now });

  assert.equal(settings.repeatWindowMinutes, core.DEFAULT_REPEAT_WINDOW_MINUTES);
  assert.equal(core.DEFAULT_REPEAT_WINDOW_MINUTES, 60);

  // A row just inside the retention window survives; one just outside does not,
  // and a stored 720 cannot stretch that boundary.
  const retention = core.repeatHistoryRetentionMs(core.DEFAULT_REPEAT_WINDOW_MINUTES);
  // A repeat-history row is an ARRAY of continue timestamps per domain, not a
  // {count, last} record — an earlier draft of this test used the latter shape,
  // which normalizeRepeatHistory correctly discards as malformed, so it failed
  // while reporting that retention had changed. It had not.
  const kept = core.readSettings(
    {
      repeatWindowMinutes: 720,
      repeatHistory: {
        [BLOCKED_DOMAIN]: [now - retention + 60000],
        "old.example": [now - retention - 60000]
      }
    },
    // An options object, not a bare timestamp: readSettings reads `opts.now`
    // and silently falls back to Date.now(), so passing the number directly
    // aged every fixture row out against the real clock.
    { now }
  ).repeatHistory;

  assert.ok(kept[BLOCKED_DOMAIN], "a row inside the retention window was dropped");
  assert.ok(!kept["old.example"], "a stored repeatWindowMinutes stretched retention");
});

// ---------------------------------------------------------------------------
// Real browser
// ---------------------------------------------------------------------------

const noBrowser = !findChrome();

test("a website cannot forge an interruption by navigating the tab to the block page", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  const hostile = await hostileOrigin();
  t.after(() => hostile.close());

  // ---- calibration ------------------------------------------------------
  // Prove the harness can SEE the original attack. This copy has the token
  // dropped from the redirect URL and the provenance check reduced to "yes",
  // which is the code as it stood before the fix. If the counters do not move
  // here, every assertion below is worthless.
  const vulnerable = stageOnce("vulnerable", null);
  const bgPath = path.join(vulnerable, "background.js");
  const patched = fs
    .readFileSync(bgPath, "utf8")
    .replace(
      'return surface.token !== "" && surface.token === (await ensureBlockPageToken());',
      "return true;"
    );
  assert.notEqual(patched, fs.readFileSync(bgPath, "utf8"), "could not un-gate the package for calibration");
  fs.writeFileSync(bgPath, patched);

  let browser = await launch({ extensionDir: vulnerable });

  try {
    const id = await extensionId(browser, vulnerable);
    const control = await controlPage(browser, id);
    const before = await readState(control);
    const attacker = await browser.newPage();

    for (let i = 0; i < 4; i++) {
      await navigateFromHostile(attacker, hostile, `chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}`);
    }

    await sleep(SETTLE_MS);
    const after = await readState(control);

    assert.equal(
      after.interruptions,
      before.interruptions + 4,
      "the un-gated build did not record the forged navigations, so this test cannot detect the bug it exists for"
    );
    assert.equal(after.byDomain[BLOCKED_DOMAIN], 4, "the un-gated build did not write the forged brand");
  } finally {
    await browser.close();
  }

  // ---- the shipped package ---------------------------------------------
  const shipped = stageOnce("shipped", null);
  browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);
    const before = await readState(control);
    const attacker = await browser.newPage();

    const forgeries = [
      `chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}`,
      `chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}&k=`,
      `chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}&k=${"a".repeat(32)}`,
      `chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}&k=0`,
      // The preview exemption: preview is the one way past the token check, so
      // it must record nothing at all.
      `chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}&preview=1`,
      `chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}&preview=1&k=${"b".repeat(32)}`
    ];

    for (const forged of forgeries) {
      const landed = await navigateFromHostile(attacker, hostile, forged);
      assert.ok(landed.startsWith(`chrome-extension://${id}/warning.html`), `the navigation did not reach the block page: ${landed}`);
    }

    // A hidden iframe is the silent half of the same hole.
    await attacker.goto(`${hostile.origin}/evil.html`, 400);
    await attacker.evaluate(`(async () => {
      const f = document.createElement("iframe");
      f.style.width = "1px"; f.style.height = "1px";
      f.src = "chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}";
      document.body.appendChild(f);
      await new Promise(r => setTimeout(r, 2500));
      return 1;
    })()`);

    await sleep(SETTLE_MS);
    const after = await readState(control);

    assert.equal(after.interruptions, before.interruptions, "a forged navigation moved the interruption counter");
    assert.deepEqual(after.byDomain, before.byDomain, "a forged navigation wrote the brand breakdown");
    assert.deepEqual(after.passes, before.passes, "a forged navigation changed the pass list");
    assert.equal(after.passesUsed, before.passesUsed, "a forged navigation moved the pass counter");
  } finally {
    await browser.close();
  }
});

test("a genuine block still redirects, renders, and counts exactly once", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);

    // 1. The redirect happens, and it carries a token the rules minted.
    const tab = await browser.newPage();
    await tab.goto(BLOCKED_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "the block page",
      timeoutMs: 15000
    });
    const blockUrl = await tab.evaluate("location.href");
    const token = new URL(blockUrl).searchParams.get("k");

    assert.match(token || "", /^[0-9a-f]{32}$/, `the block page carries no 128-bit token: ${blockUrl}`);
    assert.equal(new URL(blockUrl).searchParams.get("site"), BLOCKED_KEY);

    // 2. It renders. A block page that counts but shows nothing is worse than
    //    one that does neither.
    const rendered = JSON.parse(
      await tab.evaluate(`JSON.stringify({
        title: document.title,
        text: document.body.innerText.replace(/\\s+/g, " ").trim().length,
        timer: (document.getElementById("timer") || {}).textContent || "",
        hasContinue: !!document.getElementById("continue"),
        hasBack: !!document.getElementById("back"),
        sheets: document.styleSheets.length
      })`)
    );
    assert.ok(rendered.text > 100, `the block page rendered almost nothing (${rendered.text} chars)`);
    assert.ok(rendered.hasContinue && rendered.hasBack, "the block page is missing its exits");
    assert.match(rendered.timer, /\d/, "the countdown did not render");
    assert.ok(rendered.sheets > 0, "no stylesheet applied — the CSP may be blocking styles");

    await sleep(SETTLE_MS);
    let state = await readState(control);
    assert.equal(state.interruptions, 1, "a genuine block did not count exactly once");
    assert.equal(state.byDomain[BLOCKED_DOMAIN], 1, "the brand breakdown missed a genuine block");
    assert.equal(state.byCategory.delivery, 1, "the category breakdown missed a genuine block");

    // 3. Reloading the block page is the same interruption, not a new one.
    for (let i = 0; i < 3; i++) {
      await tab.send("Page.reload", {});
      await sleep(1400);
    }
    await sleep(SETTLE_MS);
    state = await readState(control);
    assert.equal(state.interruptions, 1, "reloading the block page inflated the count");
    assert.equal(state.byDomain[BLOCKED_DOMAIN], 1, "reloading the block page inflated the brand breakdown");

    // 4. Going back and forward is the same interruption too.
    const history = await tab.send("Page.getNavigationHistory");
    const blockEntry = history.entries.find((entry) => entry.url.includes("warning.html"));
    await tab.send("Page.navigateToHistoryEntry", { entryId: history.entries[0].id }).catch(() => {});
    await sleep(1200);
    if (blockEntry) {
      await tab.send("Page.navigateToHistoryEntry", { entryId: blockEntry.id });
      await sleep(1800);
    }
    await sleep(SETTLE_MS);
    assert.equal((await readState(control)).interruptions, 1, "back/forward to the block page inflated the count");

    // 5. A second tab on the same brand IS a second interruption.
    const second = await browser.newPage();
    await second.goto(BLOCKED_URL, 2500);
    await until(async () => (await second.evaluate("location.href")).includes("warning.html"), {
      what: "a second block page",
      timeoutMs: 15000
    });
    await sleep(SETTLE_MS);
    assert.equal((await readState(control)).interruptions, 2, "a second tab was not counted");

    // 6. Two tabs blocked at the same instant: both count, both get the token.
    const a = await browser.newPage();
    const b = await browser.newPage();
    await Promise.all([
      a.send("Page.navigate", { url: SECOND_URL }),
      b.send("Page.navigate", { url: THIRD_URL })
    ]);
    await until(
      async () =>
        (await a.evaluate("location.href")).includes("warning.html") &&
        (await b.evaluate("location.href")).includes("warning.html"),
      { what: "two simultaneous block pages", timeoutMs: 20000 }
    );
    assert.equal(new URL(await a.evaluate("location.href")).searchParams.get("k"), token);
    assert.equal(new URL(await b.evaluate("location.href")).searchParams.get("k"), token);

    // 7. A tab that is never brought to the front still counts.
    const { targetId } = await browser.cdp.send("Target.createTarget", { url: BLOCKED_URL, background: true });
    await sleep(3000);
    await browser.cdp.send("Target.closeTarget", { targetId }).catch(() => {});

    // 8. A second window is not a second browser.
    const { targetId: windowTarget } = await browser.cdp.send("Target.createTarget", {
      url: "https://deliveroo.com/",
      newWindow: true
    });
    await sleep(3000);
    await browser.cdp.send("Target.closeTarget", { targetId: windowTarget }).catch(() => {});

    await sleep(SETTLE_MS);
    state = await readState(control);
    assert.equal(state.interruptions, 6, `expected 6 real interruptions, got ${state.interruptions}`);
    assert.equal(state.byDomain[BLOCKED_DOMAIN], 3, "the brand breakdown lost a genuine block");

    // 9. And the user can still leave. grantPass is the forward exit and it must
    //    answer a real block page with a destination.
    const granted = JSON.parse(
      await a.evaluate(`(async () => JSON.stringify(await chrome.runtime.sendMessage({
        type: "grantPass",
        site: new URLSearchParams(location.search).get("site"),
        presetId: "site10"
      })))()`)
    );
    assert.equal(granted.ok, true, `a real block page could not grant a pass: ${JSON.stringify(granted)}`);
    assert.equal(granted.granted, true);
    assert.match(String(granted.destination), /^https?:\/\//, "the pass granted no destination to continue to");
  } finally {
    await browser.close();
  }
});

test("the block-page token is not readable from a website", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  const hostile = await hostileOrigin();
  t.after(() => hostile.close());

  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);

    const attacker = await browser.newPage();
    await attacker.goto(`${hostile.origin}/evil.html`, 600);

    // 1. A window handle onto the block page. Every cross-origin accessor that
    //    could carry the URL must throw.
    const handle = JSON.parse(
      await attacker.evaluate(`(async () => {
        const w = window.open(${JSON.stringify(BLOCKED_URL)}, "victim");
        await new Promise(r => setTimeout(r, 2800));
        const out = {};
        const probe = (name, fn) => { try { out[name] = String(fn()); } catch (e) { out[name] = "THREW:" + e.name; } };
        probe("href", () => w.location.href);
        probe("search", () => w.location.search);
        probe("name", () => w.name);
        probe("historyLength", () => w.history.length);
        probe("performance", () => w.performance.getEntriesByType("navigation")[0].name);
        probe("document", () => w.document.URL);
        try { w.close(); } catch (e) { /* already closed */ }
        return JSON.stringify(out);
      })()`)
    );

    Object.entries(handle).forEach(([channel, value]) => {
      assert.ok(value.startsWith("THREW:"), `window.${channel} exposed "${value}" to a website`);
    });

    // 2. The block page is a web-accessible resource, so a website may be able
    //    to read the FILE. The token must not be anywhere in it.
    const body = await attacker.evaluate(`(async () => {
      try { const r = await fetch("chrome-extension://${id}/warning.html"); return await r.text(); }
      catch (e) { return ""; }
    })()`);
    assert.ok(!/[?&]k=[0-9a-f]{8}/.test(String(body)), "the block page source carries a token");

    // 3. No request a WEBSITE makes may be redirected to the block page: the
    //    redirect URL is where the token lives, and a page can read the final
    //    URL of its own subresource fetches.
    const subresources = JSON.parse(
      await attacker.evaluate(`(async () => {
        const out = {};
        for (const mode of ["cors", "no-cors"]) {
          try { const r = await fetch(${JSON.stringify(BLOCKED_URL)}, { mode }); out["fetch:" + mode] = r.url || r.type; }
          catch (e) { out["fetch:" + mode] = "failed"; }
        }
        await new Promise(done => {
          const i = new Image();
          i.onload = () => { out.img = i.currentSrc; done(); };
          i.onerror = () => { out.img = "failed"; done(); };
          i.src = ${JSON.stringify(BLOCKED_URL)} + "favicon.ico";
          setTimeout(() => { if (!out.img) { out.img = "timeout"; done(); } }, 4000);
        });
        return JSON.stringify(out);
      })()`)
    );

    Object.entries(subresources).forEach(([channel, value]) => {
      assert.ok(
        !String(value).includes("chrome-extension://"),
        `a ${channel} request to a blocked domain was redirected to the extension: ${value}`
      );
    });

    // 4. The destination the block page sends the user to must not receive the
    //    token, by Referer header or by document.referrer.
    const tab = await browser.newPage();
    await tab.goto(BLOCKED_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "the block page",
      timeoutMs: 15000
    });
    const token = new URL(await tab.evaluate("location.href")).searchParams.get("k");
    hostile.requests.length = 0;
    await tab.evaluate(`window.location.href = ${JSON.stringify(`${hostile.origin}/evil-landing.html`)}`);
    await sleep(2000);

    const referrer = await tab.evaluate("document.referrer");
    assert.ok(!String(referrer).includes(token), `document.referrer leaked the token: ${referrer}`);
    hostile.requests.forEach((request) => {
      assert.ok(!String(request.referer || "").includes(token), `the Referer header leaked the token: ${request.referer}`);
    });
  } finally {
    await browser.close();
  }
});

test("the extension pages work under the declared CSP, and load nothing remote", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  const hostile = await hostileOrigin();
  t.after(() => hostile.close());

  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  // Every CDP event on the shared socket, so console and security errors are
  // read from the browser rather than guessed at.
  const events = [];
  browser.cdp.ws.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (message.method) events.push(message);
  });

  try {
    const id = await extensionId(browser, shipped);

    // The six surfaces a user can reach, matching tools/browser-a11y-audit.js.
    const pages = [
      { file: "popup.html", needs: ["toggle", "status"] },
      { file: "settings.html", needs: ["protection-status"] },
      { file: "welcome.html", needs: ["dots"] },
      { file: `warning.html?site=${BLOCKED_KEY}`, needs: ["timer", "continue"] },
      { file: "whats-new.html", needs: ["releases"] },
      { file: "diagnostics.html", needs: ["banner"] }
    ];

    for (const { file, needs } of pages) {
      const page = await browser.newPage();
      await page.send("Log.enable", {});
      events.length = 0;
      await page.goto(`chrome-extension://${id}/${file}`, 2500);

      const health = JSON.parse(
        await page.evaluate(`JSON.stringify({
          title: document.title,
          text: document.body.innerText.replace(/\\s+/g, " ").trim().length,
          controls: document.querySelectorAll("button, input, select, textarea, [role=button]").length,
          sheets: document.styleSheets.length,
          missing: ${JSON.stringify(needs)}.filter(idAttr => !document.getElementById(idAttr))
        })`)
      );

      assert.ok(health.title.length > 0, `${file} rendered without a title`);
      assert.ok(health.text > 100, `${file} rendered almost no text (${health.text} chars) — the CSP may have broken it`);
      assert.ok(health.controls > 0, `${file} rendered no controls`);
      assert.ok(health.sheets > 0, `${file} applied no stylesheet — style-src may be too tight`);
      assert.deepEqual(health.missing, [], `${file} is missing elements it is built around`);

      // The measurement that found the original hole: a remote image loaded.
      const injected = JSON.parse(
        await page.evaluate(`(async () => {
          const out = {};
          const race = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r("timeout"), ms))]);
          out.img = await race(new Promise(r => {
            const i = new Image();
            i.onload = () => r("LOADED"); i.onerror = () => r("blocked");
            i.src = "${hostile.origin}/pixel.png";
          }), 2000);
          try { const res = await fetch("${hostile.origin}/data.json"); out.fetch = "LOADED " + res.status; }
          catch (e) { out.fetch = "blocked"; }
          out.script = await race(new Promise(r => {
            const s = document.createElement("script");
            s.onload = () => r("LOADED"); s.onerror = () => r("blocked");
            s.src = "${hostile.origin}/remote.js";
            document.head.appendChild(s);
          }), 2000);
          try { eval("1+1"); out.eval = "ALLOWED"; } catch (e) { out.eval = "blocked"; }
          try { new Function("return 1")(); out.newFunction = "ALLOWED"; } catch (e) { out.newFunction = "blocked"; }
          return JSON.stringify(out);
        })()`)
      );

      Object.entries(injected).forEach(([channel, verdict]) => {
        assert.ok(
          !String(verdict).startsWith("LOADED") && verdict !== "ALLOWED",
          `${file}: a remote ${channel} was ${verdict} — the CSP does not close this`
        );
      });

      // Nothing the page does on its own may produce a console error either. A
      // CSP that silently breaks a feature shows up here first.
      const errors = events
        .filter((event) => event.method === "Log.entryAdded")
        .map((event) => event.params.entry)
        .filter((entry) => entry.level === "error")
        .map((entry) => `${entry.source}: ${entry.text}`.replace(/\s+/g, " "))
        .filter((text) => !text.includes(hostile.origin));

      assert.deepEqual(errors, [], `${file} logged errors of its own:\n  ${errors.join("\n  ")}`);
      await page.close();
    }

    assert.deepEqual(
      hostile.requests,
      [],
      `the extension pages made ${hostile.requests.length} request(s) to a remote host: ${JSON.stringify(hostile.requests)}`
    );
  } finally {
    await browser.close();
  }
});

test("Chrome DOES enforce frame-ancestors on a web-accessible resource", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // This is a fact about the BROWSER, pinned because it was previously believed
  // to be the opposite, and that belief is the whole justification for leaving
  // frame-ancestors out of the manifest. If a future Chrome really does stop
  // applying it to a web-accessible resource, this test says so out loud instead
  // of the assumption being re-derived from memory.
  const hostile = await hostileOrigin();
  t.after(() => hostile.close());

  const guarded = stageOnce("frame-ancestors", (manifest) => {
    manifest.content_security_policy.extension_pages += "; frame-ancestors 'none'";
  });
  const browser = await launch({ extensionDir: guarded });

  const events = [];
  browser.cdp.ws.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (message.method) events.push(message);
  });

  try {
    const id = await extensionId(browser, guarded);
    const attacker = await browser.newPage();
    await attacker.send("Log.enable", {});
    await attacker.goto(`${hostile.origin}/evil.html`, 600);
    events.length = 0;

    await attacker.evaluate(`(async () => {
      const f = document.createElement("iframe");
      f.src = "chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}";
      document.body.appendChild(f);
      await new Promise(r => setTimeout(r, 3000));
      return 1;
    })()`);

    const blocked = events
      .filter((event) => event.method === "Log.entryAdded")
      .map((event) => String(event.params.entry.text))
      .some((text) => /frame-ancestors/.test(text) && /blocked/i.test(text));

    assert.ok(
      blocked,
      "Chrome did not refuse the framing — frame-ancestors 'none' had no effect on a web-accessible resource"
    );
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Browser restart
// ---------------------------------------------------------------------------

// tools/lib/cdp.js#launch always creates a throwaway profile, which cannot answer
// "does this survive the browser being closed and reopened?" — and that is the
// question the whole token-adoption path exists for. This is the same launcher
// with the profile pinned; it should collapse into launch({ profileDir }) if that
// option is ever added upstream.
function launchWithProfile({ extensionDir, profileDir, extraArgs = [] }) {
  const chrome = findChrome();
  const args = [
    "--headless=new",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    ...extraArgs,
    "about:blank"
  ];
  const proc = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome did not report a debugging port.\n${stderr}`)), 30000);

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = /ws:\/\/[^\s]+/.exec(stderr);

      if (!match) {
        return;
      }

      clearTimeout(timer);
      const ws = new WebSocket(match[0]);
      const pending = new Map();
      let nextId = 1;

      ws.addEventListener("message", (event) => {
        const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        if (message.id && pending.has(message.id)) {
          const { ok, fail } = pending.get(message.id);
          pending.delete(message.id);
          message.error ? fail(new Error(message.error.message)) : ok(message.result);
        }
      });

      const send = (method, params = {}, sessionId) =>
        new Promise((ok, fail) => {
          const id = nextId++;
          pending.set(id, { ok, fail });
          ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
          setTimeout(() => {
            if (pending.delete(id)) fail(new Error(`CDP timeout: ${method}`));
          }, 30000);
        });

      ws.addEventListener("open", async () => {
        await send("Target.setDiscoverTargets", { discover: true });
        resolve({
          cdp: { ws, send },
          async newPage() {
            const { targetId } = await send("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
            await send("Page.enable", {}, sessionId);
            await send("Runtime.enable", {}, sessionId);
            return {
              sessionId,
              targetId,
              send: (method, params) => send(method, params, sessionId),
              async goto(url, settle = 1200) {
                await send("Page.navigate", { url }, sessionId);
                await sleep(settle);
              },
              async evaluate(expression) {
                const result = await send(
                  "Runtime.evaluate",
                  { expression, returnByValue: true, awaitPromise: true },
                  sessionId
                );
                if (result.exceptionDetails) {
                  throw new Error(result.exceptionDetails.exception?.description || "evaluate threw");
                }
                return result.result.value;
              },
              close: () => send("Target.closeTarget", { targetId })
            };
          },
          async close() {
            // A clean quit, so the profile is flushed the way a real one is.
            await send("Browser.close").catch(() => {});
            await new Promise((done) => {
              proc.on("exit", done);
              setTimeout(() => {
                proc.kill();
                done();
              }, 8000);
            });
            await sleep(400);
          }
        });
      }, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });

    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}) before listening.\n${stderr}`)));
  });
}

test("a browser restart does not lose a real interruption", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  const shipped = stageOnce("shipped", null);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fs-secver-profile-"));
  t.after(() => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (_) {
      /* a temp dir */
    }
  });

  // ---- session one ------------------------------------------------------
  let browser = await launchWithProfile({ extensionDir: shipped, profileDir: profile });
  let token = "";

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);

    // A marker with the same lifetime the token is claimed to have. If session
    // storage really is cleared by a restart this cannot come back, and any
    // token found in session storage afterwards must have been re-derived.
    await control.evaluate(`(async () => { await chrome.storage.session.set({ __restartMarker: "one" }); return 1; })()`);

    const tab = await browser.newPage();
    await tab.goto(BLOCKED_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "the block page",
      timeoutMs: 15000
    });
    token = new URL(await tab.evaluate("location.href")).searchParams.get("k");
    assert.match(token || "", /^[0-9a-f]{32}$/);

    await sleep(SETTLE_MS);
    assert.equal((await readState(control)).interruptions, 1);
  } finally {
    await browser.close();
  }

  // ---- session two, same profile, with the first session's tabs restored ---
  browser = await launchWithProfile({
    extensionDir: shipped,
    profileDir: profile,
    extraArgs: ["--restore-last-session"]
  });

  try {
    await sleep(3500);

    // The restored block page must not count itself a second time. Chrome brings
    // back the navigation entry AND the tab's session storage, which is what the
    // once-only marker relies on.
    const restored = (await browser.cdp.send("Target.getTargets")).targetInfos.find(
      (target) => target.type === "page" && target.url.includes("warning.html")
    );
    assert.ok(restored, "the block page tab was not restored, so this check proved nothing");

    const { sessionId } = await browser.cdp.send("Target.attachToTarget", {
      targetId: restored.targetId,
      flatten: true
    });
    await browser.cdp.send("Runtime.enable", {}, sessionId);
    const restoredInfo = JSON.parse(
      (
        await browser.cdp.send(
          "Runtime.evaluate",
          {
            expression: `JSON.stringify({
              navType: performance.getEntriesByType("navigation")[0].type,
              counted: Object.keys(sessionStorage),
              href: location.href
            })`,
            returnByValue: true
          },
          sessionId
        )
      ).result.value
    );
    assert.ok(
      restoredInfo.counted.some((key) => key.startsWith("fitshield:counted:")),
      "the restored tab lost its once-only marker"
    );

    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);

    // Session storage really was emptied: the marker is gone.
    const session = JSON.parse(await control.evaluate(`(async () => JSON.stringify(await chrome.storage.session.get(null)))()`));
    assert.equal(session.__restartMarker, undefined, "chrome.storage.session survived a browser restart");

    // ...and yet the token is the same one, because it was adopted from the
    // dynamic rules, which do persist. This is the whole point of the adoption
    // path: without it the block page reached seconds after a restart would
    // carry a token the worker had just invalidated.
    await waitForRules(control);
    assert.equal(
      new URL(await ruleRedirectUrl(control)).searchParams.get("k"),
      token,
      "the token was re-minted instead of adopted from the persisted rules"
    );
    assert.equal(session.blockPageToken, token, "session storage holds a different token from the rules");

    await sleep(SETTLE_MS);
    assert.equal((await readState(control)).interruptions, 1, "the restored block page counted itself again");

    // A genuine block AFTER the restart still counts, which is the failure the
    // adoption path exists to prevent.
    const tab = await browser.newPage();
    await tab.goto(SECOND_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "a block page after the restart",
      timeoutMs: 15000
    });
    assert.equal(new URL(await tab.evaluate("location.href")).searchParams.get("k"), token);

    await sleep(SETTLE_MS);
    const state = await readState(control);
    assert.equal(state.interruptions, 2, "a genuine interruption after a browser restart went uncounted");
    assert.equal(state.byDomain["ubereats.com"], 1, "the brand breakdown missed a post-restart block");
  } finally {
    await browser.close();
  }
});

test("a cold worker with no session storage adopts the token from the persisted rules", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // The same state a browser restart produces — empty session storage, a torn
  // down worker, dynamic rules intact — reached without a restart, so the
  // adoption branch is exercised directly rather than inferred.
  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);
    const token = new URL(await ruleRedirectUrl(control)).searchParams.get("k");

    await control.evaluate(`(async () => { await chrome.storage.session.clear(); return 1; })()`);
    const workers = (await browser.cdp.send("Target.getTargets")).targetInfos.filter(
      (target) => target.type === "service_worker" && target.url.includes("background.js")
    );
    assert.ok(workers.length > 0, "the service worker was not running, so tearing it down proved nothing");
    for (const worker of workers) {
      await browser.cdp.send("Target.closeTarget", { targetId: worker.targetId }).catch(() => {});
    }
    await sleep(1500);

    assert.deepEqual(
      JSON.parse(await control.evaluate(`(async () => JSON.stringify(await chrome.storage.session.get(null)))()`)),
      {},
      "session storage did not clear"
    );

    const before = await readState(control);
    const tab = await browser.newPage();
    await tab.goto(THIRD_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "a block page from a cold worker",
      timeoutMs: 20000
    });
    assert.equal(
      new URL(await tab.evaluate("location.href")).searchParams.get("k"),
      token,
      "the cold worker did not adopt the token in the rules"
    );

    await sleep(SETTLE_MS);
    assert.equal(
      (await readState(control)).interruptions,
      before.interruptions + 1,
      "a block reached by a cold worker went uncounted"
    );
  } finally {
    await browser.close();
  }
});
