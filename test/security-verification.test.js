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

// ---------------------------------------------------------------------------
// The brands this file drives
// ---------------------------------------------------------------------------
//
// Read from the shipped list rather than written down, because the catalog moves
// underneath this file: thirty brands were removed and 191 records moved between
// the two lists in the commits immediately before this was written.
//
// An earlier draft hard-coded `https://deliveroo.com/` as a fourth brand. That
// domain is in NEITHER shipped list — only the country sites are (deliveroo.ae,
// deliveroo.co.uk, ...) — so the navigation was not redirected by any rule. It
// left the machine, reached the public internet, and the "block" that was
// counted came back from Deliveroo's own redirect to a country domain that IS
// listed. The assertion passed for a reason that had nothing to do with
// FitShield, and it would have failed on any machine without a network. A test
// for a product whose whole claim is that nothing leaves the machine may not
// itself depend on the internet.
const DELIVERY_ENTRIES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "extension", "blocklists", "delivery.json"), "utf8")
).entries;

// Mirrors domainToKey(domain, type) in background.js, trimming included — the
// worker resolves a site by this exact string, so a near-miss reads as "Unknown
// site." rather than as a wrong key.
const slug = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const siteKeyFor = (domain, type) => `${slug(type)}-${slug(domain)}`;

function deliveryBrand(domain) {
  const entry = DELIVERY_ENTRIES.find((candidate) => candidate.domain === domain);

  if (!entry || entry.enabled === false) {
    throw new Error(
      `${domain} is no longer an enabled entry in extension/blocklists/delivery.json. ` +
        "Pick another brand from that file rather than navigating to a domain the extension does not block."
    );
  }

  return { domain, key: siteKeyFor(domain, entry.type || "delivery"), url: `https://${domain}/` };
}

const BRAND = deliveryBrand("doordash.com");
const SECOND = deliveryBrand("ubereats.com");
const THIRD = deliveryBrand("grubhub.com");

const BLOCKED_URL = BRAND.url;
const BLOCKED_KEY = BRAND.key;
const BLOCKED_DOMAIN = BRAND.domain;
const SECOND_URL = SECOND.url;
const THIRD_URL = THIRD.url;

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

/**
 * A brand taken from the rules the worker ACTUALLY wrote, skipping any the
 * caller is already using.
 *
 * Nothing in the token path depends on how many rules there are or on which
 * brands are in them, and this is how that is kept true: the extra targets these
 * tests need are whatever the enforced rule set happens to contain today, so a
 * catalog change cannot quietly move what is being measured. It also guarantees
 * the navigation is intercepted before it reaches the network, which a
 * hand-written domain does not.
 */
async function brandFromRules(control, exclude = []) {
  const skip = new Set(exclude);
  const found = JSON.parse(
    await control.evaluate(`(async () => {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const skip = new Set(${JSON.stringify([...skip])});
      const out = [];

      for (const rule of rules) {
        const host = String((rule.condition || {}).urlFilter || "").replace(/^\\|\\|/, "");
        let key = "";
        try { key = new URL(rule.action.redirect.url).searchParams.get("site") || ""; } catch (_) { key = ""; }

        // An apex host only: a rule whose filter carries a path or a wildcard is
        // not something a plain https://host/ navigation would hit.
        if (host && key && /^[a-z0-9.-]+$/.test(host) && !skip.has(host) && !out.some((s) => s.key === key)) {
          out.push({ domain: host, key });
        }

        if (out.length >= 8) break;
      }

      return JSON.stringify(out);
    })()`)
  );

  assert.ok(found.length > 0, "the enforced rule set offered no usable brand");
  return found.map((brand) => ({ ...brand, url: `https://${brand.domain}/` }));
}

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

    // 8. A second window is not a second browser. The brand comes from the rule
    //    set rather than from memory, so this navigation is guaranteed to be
    //    intercepted rather than sent to the internet.
    const [fourth] = await brandFromRules(control, [BLOCKED_DOMAIN, SECOND.domain, THIRD.domain]);
    const { targetId: windowTarget } = await browser.cdp.send("Target.createTarget", {
      url: fourth.url,
      newWindow: true
    });
    await sleep(3000);
    await browser.cdp.send("Target.closeTarget", { targetId: windowTarget }).catch(() => {});

    // The service worker writes the counters AFTER the navigation completes, so
    // a fixed settle races it: under load this failed with the total already at
    // 6 while the per-brand breakdown was still one behind — the write had
    // happened, the test just looked too early.
    //
    // The assertions are unchanged and still exact. Only the waiting is: poll
    // for the state the test demands, and if it never arrives, fall through and
    // let the same assertions fail with the same message. Loosening the numbers
    // would have hidden a real regression; waiting for them does not.
    await until(
      async () => {
        state = await readState(control);
        return state.interruptions === 6 && state.byDomain[BLOCKED_DOMAIN] === 3;
      },
      { what: "six interruptions and their brand breakdown to settle", timeoutMs: 20000 }
    ).catch(() => { /* fall through to the assertions below for a real message */ });

    assert.equal(state.interruptions, 6, `expected 6 real interruptions, got ${state.interruptions}`);
    assert.equal(state.byDomain[BLOCKED_DOMAIN], 3, "the brand breakdown lost a genuine block");
    assert.equal(state.byDomain[fourth.domain], 1, `the block in a second window was not recorded for ${fourth.domain}`);

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
    //
    //    userGesture, and the `opened` check below, are both load-bearing. The
    //    launcher passes no --disable-popup-blocking, so a scripted window.open
    //    with no gesture behind it returns null — and then every probe below
    //    throws a TypeError on null and the whole check passes without a window
    //    ever having existed. Prove the popup opened before believing what it
    //    refuses to answer.
    const handle = JSON.parse(
      (
        await attacker.send("Runtime.evaluate", {
          expression: `(async () => {
        const w = window.open(${JSON.stringify(BLOCKED_URL)}, "victim");
        const out = { opened: !!w };
        if (!w) { return JSON.stringify(out); }
        await new Promise(r => setTimeout(r, 2800));
        const probe = (name, fn) => { try { out[name] = String(fn()); } catch (e) { out[name] = "THREW:" + e.name; } };
        probe("href", () => w.location.href);
        probe("search", () => w.location.search);
        probe("name", () => w.name);
        probe("historyLength", () => w.history.length);
        probe("performance", () => w.performance.getEntriesByType("navigation")[0].name);
        probe("document", () => w.document.URL);
        out.closedAlready = w.closed;
        try { w.close(); } catch (e) { /* already closed */ }
        return JSON.stringify(out);
      })()`,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        })
      ).result.value
    );

    assert.equal(handle.opened, true, "the popup never opened, so the accessors below prove nothing");
    assert.equal(handle.closedAlready, false, "the popup was closed before it could be probed");

    const { opened, closedAlready, ...accessors } = handle;
    assert.ok(Object.keys(accessors).length >= 6, "the cross-origin accessors were not all probed");

    Object.entries(accessors).forEach(([channel, value]) => {
      // A SecurityError is the browser refusing. A TypeError would mean the
      // handle was empty, which is a broken measurement, not a defence.
      assert.ok(
        value === "THREW:SecurityError" || value === "THREW:DOMException",
        `window.${channel} answered "${value}" instead of refusing a cross-origin read`
      );
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

/**
 * Frame the block page from a hostile origin and ask the FRAMED DOCUMENT what
 * it is, by attaching to its target. A console message saying a policy was
 * violated is not the same fact as the document having failed to run, and an
 * earlier version of this check read the console — which cannot tell a refused
 * frame from a frame that loaded and logged something.
 */
async function frameTheBlockPage(extraCsp, options = {}) {
  const hostile = await hostileOrigin();
  const strip = options.withoutFrameAncestors === true;
  const dir = stageOnce(
    extraCsp ? `csp:${extraCsp}` : strip ? "csp:no-frame-ancestors" : "shipped",
    extraCsp
      ? (manifest) => {
          manifest.content_security_policy.extension_pages += `; ${extraCsp}`;
        }
      : strip
        ? (manifest) => {
            manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages
              .split(";")
              .map((part) => part.trim())
              .filter((part) => !part.startsWith("frame-ancestors"))
              .join("; ");
          }
        : null
  );
  const browser = await launch({ extensionDir: dir });

  try {
    const id = await extensionId(browser, dir);
    const attacker = await browser.newPage();
    await attacker.goto(`${hostile.origin}/evil.html`, 800);
    await attacker.evaluate(`(async () => {
      const f = document.createElement("iframe");
      f.style.width = "1px"; f.style.height = "1px";
      f.src = "chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}";
      document.body.appendChild(f);
      await new Promise(r => setTimeout(r, 3500));
      return 1;
    })()`);

    // The block page is an out-of-process iframe, so it is a TARGET rather than
    // a child in the parent's frame tree. Attach to it and read it from inside.
    const target = (await browser.cdp.send("Target.getTargets")).targetInfos.find((entry) =>
      entry.url.includes("warning.html")
    );

    if (!target) {
      return { framed: false, detail: "no target for the block page at all" };
    }

    const { sessionId } = await browser.cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true
    });
    await browser.cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
    const inside = JSON.parse(
      (
        await browser.cdp.send(
          "Runtime.evaluate",
          {
            expression: `JSON.stringify({
              href: location.href,
              textLength: (document.body ? document.body.innerText : "").length,
              hasRuntime: typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id),
              hasTimer: !!document.getElementById("timer")
            })`,
            returnByValue: true
          },
          sessionId
        )
      ).result.value
    );

    return { framed: inside.hasRuntime && inside.href.startsWith("chrome-extension://"), detail: inside };
  } finally {
    await browser.close();
    await hostile.close();
  }
}

test("a hostile page can embed the running block page, and frame-ancestors stops it", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // Two measurements, because only the pair means anything.
  //
  // `frame-ancestors` was left out of the manifest on the belief that Chrome
  // accepts the directive but does not apply it to a web-accessible resource.
  // Measured here against the built package: that is not what Chrome does.
  //
  //   shipped        the framed block page RUNS inside the hostile document —
  //                  extension origin, chrome.runtime.id present, its markup
  //                  and countdown built.
  //   + the guard    the frame becomes chrome-error://chromewebdata/ and no
  //                  extension context exists in it at all.
  //
  // Nothing is currently recorded through a framed page — senderSurface refuses
  // any sender with a frameId other than 0 — so this is not an open hole. It is
  // the evidence for the manifest decision, and it says the stated reason for
  // that decision does not hold.
  // The "before" run stages a copy with the directive REMOVED. It used to use
  // the shipped manifest, which was correct while the manifest omitted
  // frame-ancestors — and this measurement is why it no longer does. Left as it
  // was, the pair would have quietly stopped proving anything: the unguarded
  // half would report "did not load in a hostile frame" and the test would fail
  // for the reason the fix exists.
  const shipped = await frameTheBlockPage(null, { withoutFrameAncestors: true });
  assert.equal(
    shipped.framed,
    true,
    `the block page did not load in a hostile frame, so the guarded run proves nothing: ${JSON.stringify(shipped.detail)}`
  );
  assert.ok(shipped.detail.hasTimer, "the framed block page did not build its countdown");

  const guarded = await frameTheBlockPage("frame-ancestors 'none'");
  assert.equal(
    guarded.framed,
    false,
    `Chrome did not refuse the framing — frame-ancestors 'none' had no effect on a web-accessible resource: ${JSON.stringify(guarded.detail)}`
  );
  assert.equal(
    guarded.detail.hasRuntime,
    false,
    "the refused frame still had an extension context, so it was not really refused"
  );
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

// ---------------------------------------------------------------------------
// Egress, measured rather than inferred
// ---------------------------------------------------------------------------

/**
 * Attach to every target the browser has, including the service worker, and
 * keep the raw network traffic.
 *
 * The CSP checks elsewhere in this file prove a remote resource is REFUSED when
 * something asks for one. They cannot prove nothing asked. That needs the
 * network domain enabled on the worker itself, which never has a page attached
 * to it and so never appears in a page-level measurement.
 */
async function recordNetwork(browser) {
  const sessions = new Map();
  const requests = [];
  const responses = [];

  browser.cdp.ws.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));

    if (message.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = message.params;
      sessions.set(sessionId, targetInfo);
      browser.cdp.send("Network.enable", {}, sessionId).catch(() => {});
      browser.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      return;
    }

    if (message.method === "Network.requestWillBeSent") {
      requests.push({ url: message.params.request.url, session: sessions.get(message.sessionId) || null });
    }

    if (message.method === "Network.responseReceived") {
      responses.push({
        url: message.params.response.url,
        remoteIP: message.params.response.remoteIPAddress || "",
        session: sessions.get(message.sessionId) || null
      });
    }
  });

  await browser.cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true
  });

  return {
    sessions,
    requests,
    responses,
    reset() {
      requests.length = 0;
      responses.length = 0;
    }
  };
}

const LOCAL_SCHEME = /^(chrome-extension|about|data|blob|devtools|chrome):/;
const LOCAL_ADDRESS = (ip) => ip === "" || ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0";

test("the whole product runs without one request leaving the machine", { concurrency: 1 }, async (t) => {
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

    const net = await recordNetwork(browser);

    // The worker is torn down between messages, so wake it and let it attach
    // before anything is measured — otherwise its requests are simply missed
    // and the test reports a silence it never listened for.
    await control.evaluate(`(async () => chrome.runtime.sendMessage({ type: "getDiagnostics" }))()`).catch(() => {});
    await until(
      async () =>
        [...net.sessions.values()].some(
          (target) => target.type === "service_worker" && target.url.includes(`${id}/background.js`)
        ),
      { what: "the service worker to attach", timeoutMs: 20000 }
    );
    net.reset();

    // ---- exercise the product, not a corner of it -------------------------
    const tab = await browser.newPage();
    await tab.goto(BLOCKED_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "the block page",
      timeoutMs: 15000
    });
    await sleep(2000);

    const granted = JSON.parse(
      await tab.evaluate(`(async () => JSON.stringify(await chrome.runtime.sendMessage({
        type: "grantPass", site: new URLSearchParams(location.search).get("site"), presetId: "site10"
      })))()`)
    );
    assert.equal(granted.ok, true, "the exercise did not get as far as taking a pass");

    for (const file of ["popup.html", "settings.html", "welcome.html", "whats-new.html", "diagnostics.html"]) {
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${id}/${file}`, 2200);
      await page.close();
    }

    const settings = await browser.newPage();
    await settings.goto(`chrome-extension://${id}/settings.html`, 2500);
    const exported = await settings.evaluate(
      `(async () => { try { await FitShieldBackup.downloadBackup(); return "ok"; } catch (e) { return "threw: " + e.message; } })()`
    );
    assert.equal(exported, "ok", "the backup export did not run, so it was not measured");
    await sleep(2000);

    // ---- what actually went out -------------------------------------------
    //
    // Attribution matters: this profile also runs Chrome's own component
    // extensions, and their traffic is not FitShield's. Only sessions whose
    // target belongs to THIS extension are FitShield.
    const ours = (entry) => entry.session && String(entry.session.url || "").startsWith(`chrome-extension://${id}/`);
    const fitshieldRequests = net.requests.filter(ours).filter((entry) => !LOCAL_SCHEME.test(entry.url));

    assert.deepEqual(
      fitshieldRequests.map((entry) => `${entry.session.type} -> ${entry.url}`),
      [],
      "a FitShield page or its service worker requested something off its own origin"
    );

    // The service worker on its own, named explicitly: it is the one context
    // that could phone home with no page open to notice.
    const workerRequests = net.requests
      .filter((entry) => entry.session && entry.session.type === "service_worker" && entry.session.url.includes(id))
      .filter((entry) => !LOCAL_SCHEME.test(entry.url));
    assert.deepEqual(workerRequests.map((entry) => entry.url), [], "the service worker made a network request");

    // And nothing anywhere in the browser was answered by a remote host. A
    // blocked navigation is redirected by declarativeNetRequest before the
    // request is issued, so even the user's own attempt to reach the brand
    // never reaches it — the strongest form of the claim, and the one that
    // catches a redirect that silently stopped working.
    const remote = net.responses.filter((entry) => !LOCAL_ADDRESS(entry.remoteIP));
    assert.deepEqual(
      remote.map((entry) => `${entry.url} <- ${entry.remoteIP}`),
      [],
      "a response came back from a remote address during the exercise"
    );
  } finally {
    await browser.close();
  }
});

test("the block-page token never reaches disk, a backup, or the diagnostics page", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // The token is a bearer credential: anything holding it can record an
  // interruption (measured below). chrome.storage.session is memory only, so it
  // should never appear anywhere a person could copy it out of — a backup file
  // they email themselves, a diagnostics report they paste into a bug thread,
  // or the profile on disk.
  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);
    const token = new URL(await ruleRedirectUrl(control)).searchParams.get("k");
    assert.match(token || "", /^[0-9a-f]{32}$/);

    const tab = await browser.newPage();
    await tab.goto(BLOCKED_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "the block page",
      timeoutMs: 15000
    });
    await sleep(SETTLE_MS);

    const local = await control.evaluate(`(async () => JSON.stringify(await chrome.storage.local.get(null)))()`);
    assert.ok(!String(local).includes(token), "the token was written to chrome.storage.local, which is on disk");

    // backup.js only loads on Settings, which is where Export lives, so the
    // export has to be read from there rather than from the control page.
    const settings = await browser.newPage();
    await settings.goto(`chrome-extension://${id}/settings.html`, 2500);
    const backup = await settings.evaluate(`(async () => JSON.stringify(await FitShieldBackup.collectBackup()))()`);
    assert.ok(String(backup).includes("fitshield-settings-backup"), "the backup export produced nothing to inspect");
    assert.ok(!String(backup).includes(token), "the exported backup carries the token");

    const diagnostics = await browser.newPage();
    await diagnostics.goto(`chrome-extension://${id}/diagnostics.html`, 2500);
    const shown = await diagnostics.evaluate(`document.body.innerText`);
    assert.ok(!String(shown).includes(token), "the diagnostics page prints the token");

    const reported = await control.evaluate(
      `(async () => JSON.stringify(await chrome.runtime.sendMessage({ type: "getDiagnostics" })))()`
    );
    assert.ok(
      !String(reported).includes(token),
      "the diagnostics payload carries the token, so a support report would leak it"
    );
  } finally {
    await browser.close();
  }
});

test("the token is a bearer credential, and it does not rotate in normal use", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // Two facts that only matter together, pinned so neither drifts unnoticed:
  //
  //   1. possession is sufficient — a hostile page holding the token forges an
  //      interruption exactly as it did before the fix;
  //   2. it does not rotate in normal use, and the browser-restart test above
  //      shows it is re-adopted from the persisted rules after a restart. So
  //      "session" describes where it is STORED, not how long it lives.
  //
  // Nothing in this file finds a way to leak it, and that is the whole defence.
  // Worth stating out loud rather than leaving implied.
  const hostile = await hostileOrigin();
  t.after(() => hostile.close());

  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);
    const token = new URL(await ruleRedirectUrl(control)).searchParams.get("k");

    // 1. Possession is sufficient.
    const before = await readState(control);
    const attacker = await browser.newPage();
    const landed = await navigateFromHostile(
      attacker,
      hostile,
      `chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}&k=${token}`
    );
    assert.ok(landed.includes("warning.html"), "the replay navigation did not reach the block page");
    await sleep(SETTLE_MS);

    assert.equal(
      (await readState(control)).interruptions,
      before.interruptions + 1,
      "a page holding the token did not record — the token is not what the gate turns on, so this file measures the wrong thing"
    );

    // 2. It does not rotate when the product is used normally.
    const tab = await browser.newPage();
    await tab.goto(SECOND_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "a block page",
      timeoutMs: 15000
    });
    await tab.evaluate(`(async () => chrome.runtime.sendMessage({
      type: "grantPass", site: new URLSearchParams(location.search).get("site"), presetId: "site10"
    }))()`);
    await sleep(SETTLE_MS);
    assert.equal(
      new URL(await ruleRedirectUrl(control)).searchParams.get("k"),
      token,
      "granting a pass rotated the token"
    );

    await control.evaluate(`(async () => { await chrome.storage.local.set({ enabled: false }); return 1; })()`);
    await sleep(2500);
    await control.evaluate(`(async () => { await chrome.storage.local.set({ enabled: true }); return 1; })()`);
    await waitForRules(control);
    assert.equal(
      new URL(await ruleRedirectUrl(control)).searchParams.get("k"),
      token,
      "switching blocking off and on again rotated the token"
    );
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// What the token gate did NOT cover
// ---------------------------------------------------------------------------
//
// The three checks below were written after the provenance work was reviewed
// and called done. Each one measures a claim the code makes about itself, from
// the outside, in a real browser. Each one currently fails, and the failure
// message says what to change. None of them is a new feature request: they are
// the stated behaviour of the code as its own comments describe it.

test("two block pages granting at the same moment both keep their pass", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // grantPass now re-reads the pass list inside a queuePassUpdate chain, and the
  // commit that did it says the erasure is fixed. It is not: refreshBlockingState
  // reads `settings` (which carries `passes`) at the top, spends the time it
  // takes to write every redirect rule, and then blind-writes
  //
  //     await chrome.storage.local.set({ passes: activePasses });
  //
  // from that stale snapshot. grantPass ENDS by queueing that refresh, so the
  // racing writer is not hypothetical — it is on the path every grant takes.
  //
  // This is the same read-modify-write, moved one function along and onto a
  // different chain, so the pass-chain serialisation cannot see it.
  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);

    // Two real block pages in two tabs, each with a valid token. This is two
    // hands on two tabs, not a synthetic message storm.
    const tabA = await browser.newPage();
    const tabB = await browser.newPage();
    await tabA.goto(BLOCKED_URL, 2500);
    await tabB.goto(SECOND_URL, 2500);
    await until(
      async () =>
        (await tabA.evaluate("location.href")).includes("warning.html") &&
        (await tabB.evaluate("location.href")).includes("warning.html"),
      { what: "two block pages", timeoutMs: 20000 }
    );

    const press = (tab) =>
      tab.evaluate(`(async () => JSON.stringify(await chrome.runtime.sendMessage({
        type: "grantPass", site: new URLSearchParams(location.search).get("site"), presetId: "site10"
      })))()`);

    const answers = (await Promise.all([press(tabA), press(tabB)])).map((raw) => JSON.parse(raw));
    answers.forEach((answer, index) =>
      assert.equal(answer.ok && answer.granted, true, `tab ${index} was refused: ${JSON.stringify(answer)}`)
    );

    await sleep(SETTLE_MS * 2);
    const state = await readState(control);
    const targets = state.passes.map((pass) => pass.target).sort();

    assert.deepEqual(
      targets,
      [BLOCKED_DOMAIN, SECOND.domain].sort(),
      "both tabs were told yes and only one pass was stored. refreshBlockingState writes " +
        "`chrome.storage.local.set({ passes: activePasses })` from a snapshot taken before the " +
        "other grant landed, which erases it. Route that write through queuePassUpdate and re-read " +
        "the list inside the chain, the way grantPass already does — measured to fix it."
    );

    // The counter must not claim a pass the user does not have.
    assert.equal(
      state.passesUsed,
      state.passes.length,
      `"Temporary passes used" says ${state.passesUsed} and the user has ${state.passes.length}`
    );

    // And the customer-visible half: the tab whose pass was erased is blocked
    // again the instant it follows the destination it was handed.
    const destination = answers[1].destination;
    await tabB.goto(destination, 3000);
    assert.ok(
      !(await tabB.evaluate("location.href")).includes("warning.html"),
      "the second tab was told its pass was granted and was blocked again the moment it continued"
    );
  } finally {
    await browser.close();
  }
});

test("a preview block page changes no durable state", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // senderMayRun lets a preview past the token check, and says why:
  //
  //   "The preview is exempt because it records nothing by construction"
  //
  // Construction is the claim under test. Every state-changing message is sent
  // from a REAL preview page — the one surface a website can put the tab on
  // without holding the token — and storage is compared before and after each.
  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);

    // Give the preview something to destroy, so "nothing changed" is a result
    // and not just an empty profile.
    const tab = await browser.newPage();
    await tab.goto(BLOCKED_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "a real block page",
      timeoutMs: 15000
    });
    await tab.evaluate(`(async () => chrome.runtime.sendMessage({
      type: "grantPass", site: new URLSearchParams(location.search).get("site"), presetId: "site10"
    }))()`);
    await sleep(SETTLE_MS);
    assert.ok((await readState(control)).passes.length > 0, "the fixture pass was not granted");

    const preview = await browser.newPage();
    await preview.goto(`chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}&preview=1`, 2500);

    // The set is read from the worker's own WEB_FORGEABLE list rather than
    // written down here, so a handler added to it cannot skip this check.
    const forgeable = [
      ...BACKGROUND.slice(BACKGROUND.indexOf("const WEB_FORGEABLE")).matchAll(/"([a-zA-Z]+)"/g)
    ]
      .slice(0, 32)
      .map((match) => match[1]);
    assert.ok(forgeable.length >= 9, `expected the WEB_FORGEABLE list, found ${forgeable.length}`);

    const audited = JSON.parse(
      await preview.evaluate(`(async () => {
        const keys = ["stats", "passes", "pendingAlternatives", "blockedByDomain", "blockedByCategory", "repeatHistory"];
        const snapshot = async () => JSON.stringify(await chrome.storage.local.get(keys));
        const changed = [];

        for (const type of ${JSON.stringify(forgeable)}) {
          const before = await snapshot();
          await chrome.runtime.sendMessage({
            type,
            id: "preview-probe",
            site: ${JSON.stringify(BLOCKED_KEY)},
            presetId: "site10",
            meta: { domain: ${JSON.stringify(BLOCKED_DOMAIN)}, category: "delivery" }
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 800));

          if ((await snapshot()) !== before) {
            changed.push(type);
          }
        }

        return JSON.stringify(changed);
      })()`)
    );

    assert.deepEqual(
      audited,
      [],
      "a preview block page wrote durable state through these handlers. Both ignore the preview " +
        "flag the worker hands them: `revokeAllPasses: () => revokeAllPasses()` and " +
        "`markAlternativeMade: (message) => markAlternativeMade(message.id)` never receive it, " +
        "so `preview` is honoured by seven of the nine and asserted of all nine. Pass the message " +
        "through and return early on `preview === true`, as recordEvent and grantPass already do"
    );
  } finally {
    await browser.close();
  }
});

test("a block page the user still has open never becomes a dead end", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // The token is adopted from the persisted rules on a cold start, so it
  // normally survives a restart. It does NOT survive a cold start that finds no
  // rules to adopt from, and blocking being switched off is exactly what empties
  // them. A user who pauses FitShield, closes the browser, reopens it and turns
  // FitShield back on has a worker holding a new token and, in a restored tab, a
  // block page holding the old one.
  //
  // That page still renders a countdown and a Continue button. Both are dead:
  // every message it sends is refused, and warning.js answers a refused
  // grantPass by re-enabling the button and showing the generic error hint. The
  // user is looking at a working-looking screen whose only working control is
  // Back. "No dead customer-facing control" is a release condition.
  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);
    const original = new URL(await ruleRedirectUrl(control)).searchParams.get("k");

    const tab = await browser.newPage();
    await tab.goto(BLOCKED_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "the block page",
      timeoutMs: 15000
    });
    assert.equal(new URL(await tab.evaluate("location.href")).searchParams.get("k"), original);

    // Reproduce the cold start that finds nothing to adopt: rules emptied by the
    // master switch, session storage gone, worker torn down. This is the state a
    // browser restart leaves behind when FitShield was paused at closing time.
    await control.evaluate(`(async () => { await chrome.storage.local.set({ enabled: false }); return 1; })()`);
    await until(async () => (await ruleRedirectUrl(control)) === "", {
      what: "the rules to be cleared",
      timeoutMs: 20000
    });
    await control.evaluate(`(async () => { await chrome.storage.session.clear(); return 1; })()`);
    for (const worker of (await browser.cdp.send("Target.getTargets")).targetInfos.filter(
      (target) => target.type === "service_worker" && target.url.includes("background.js")
    )) {
      await browser.cdp.send("Target.closeTarget", { targetId: worker.targetId }).catch(() => {});
    }
    await sleep(1500);
    await control.evaluate(`(async () => { await chrome.storage.local.set({ enabled: true }); return 1; })()`);
    await waitForRules(control);

    const rotated = new URL(await ruleRedirectUrl(control)).searchParams.get("k");
    assert.notEqual(rotated, original, "the token did not rotate, so this scenario was not reached");

    // The tab was never touched. This is what the user comes back to.
    assert.equal(
      new URL(await tab.evaluate("location.href")).searchParams.get("k"),
      original,
      "the open block page moved on its own"
    );

    const answer = JSON.parse(
      await tab.evaluate(`(async () => JSON.stringify(await chrome.runtime.sendMessage({
        type: "grantPass", site: new URLSearchParams(location.search).get("site"), presetId: "site10"
      })))()`)
    );

    // This asserted `answer.ok === true` — accept the retired token — and named
    // the alternative itself: "give a stale-but-genuine block page a way
    // forward instead of refusing it". The first option was tried and backed
    // out. Accepting a retired token means REMEMBERING retired tokens, and the
    // only durable place is disk, where "the block-page token never reaches
    // disk, a backup, or the diagnostics page" — asserted two tests above —
    // says it must not go. Two guarantees in this file were in tension and the
    // disk one protects a promise the product makes to its user.
    //
    // So the refusal stands, and what changed is that it is now legible. The
    // worker answers `staleSurface` instead of the flat "not a FitShield
    // surface", which a forgery can never earn: it needs to be one of our own
    // pages, unframed, holding a token, and a hostile page has no token to be
    // stale. warning.js turns that into asking for the site again, which the
    // browser redirects into a fresh block page the user can continue from.
    assert.equal(answer.ok, false, "a retired token must still be refused — it is not remembered anywhere");
    assert.equal(
      answer.reason,
      "staleSurface",
      "the refusal must be distinguishable from a forgery, or the page cannot recover from it: " +
        `got ${JSON.stringify(answer)}`
    );

    const page = fs.readFileSync(path.join(ROOT, "extension", "warning.js"), "utf8");
    assert.match(
      page,
      /reason === "staleSurface"/,
      "warning.js must recognise the stale refusal rather than treating it as a generic failure"
    );
    assert.match(
      page,
      /window\.location\.href = again/,
      "warning.js must ask for the site again, so the browser issues a fresh block page"
    );
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// The channels a website still has to a page on our origin
// ---------------------------------------------------------------------------

test("a website that opens the block page gets no channel into it", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // warning.html is web-accessible, so any site can open it and hold a window
  // handle. Everything that crosses that boundary WITHOUT reading the URL is
  // checked here: the opener names the window, so window.name is attacker-
  // controlled input arriving inside our origin; postMessage delivers an
  // attacker-controlled object; and window.opener points back, so anything the
  // block page ever posts would land on the hostile page.
  //
  // None of these is closed by the token — the token gates what the worker
  // ACCEPTS, and these are all ways of talking to the PAGE.
  const hostile = await hostileOrigin();
  t.after(() => hostile.close());

  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);
    const before = await readState(control);

    const attacker = await browser.newPage();
    await attacker.goto(`${hostile.origin}/evil.html`, 800);

    // userGesture, because the launcher passes no --disable-popup-blocking and a
    // scripted window.open with nothing behind it returns null. A null handle
    // would make every assertion below pass without a window ever existing.
    const result = JSON.parse(
      (
        await attacker.send("Runtime.evaluate", {
          expression: `(async () => {
        const received = [];
        window.addEventListener("message", (event) => received.push(String(event.origin) + " " + JSON.stringify(event.data).slice(0, 200)));

        // The window NAME is chosen by the opener and readable inside the page,
        // so it is attacker-controlled input arriving on our own origin.
        const victim = window.open(
          "chrome-extension://${id}/warning.html?site=${BLOCKED_KEY}",
          JSON.stringify({ k: "forged-token", preview: false, site: ${JSON.stringify(BLOCKED_KEY)} })
        );

        if (!victim) { return JSON.stringify({ opened: false, received }); }
        await new Promise(r => setTimeout(r, 2500));

        // Anything a listener on our origin might act on.
        const posted = [
          { type: "recordInterruption" },
          { type: "grantPass", site: ${JSON.stringify(BLOCKED_KEY)}, presetId: "site10" },
          { type: "revokeAllPasses" },
          { k: "forged-token" }
        ];

        for (const payload of posted) {
          try { victim.postMessage(payload, "*"); } catch (e) { /* nothing to do */ }
        }

        await new Promise(r => setTimeout(r, 2500));
        try { victim.close(); } catch (e) { /* already gone */ }

        return JSON.stringify({ opened: true, received });
      })()`,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        })
      ).result.value
    );

    assert.equal(result.opened, true, "the block page never opened, so nothing was actually attacked");

    // The block page never speaks to whoever opened it. If it ever did, the
    // token is in its own URL and this is where it would go.
    assert.deepEqual(
      result.received,
      [],
      `the block page posted a message back to the site that opened it: ${JSON.stringify(result.received)}`
    );

    await sleep(SETTLE_MS);
    const after = await readState(control);
    assert.equal(after.interruptions, before.interruptions, "a postMessage into the block page recorded an interruption");
    assert.deepEqual(after.passes, before.passes, "a postMessage into the block page changed the pass list");
    assert.deepEqual(after.byDomain, before.byDomain, "a postMessage into the block page wrote the brand breakdown");
  } finally {
    await browser.close();
  }
});

test("the token is random per install, not derived from anything a site knows", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // A 32-hex string proves length, not unpredictability. If the token were
  // derived from the extension id, the version, the clock or the rule set, a
  // website could compute it — it knows the id, and the rest is public. Two
  // independent installs of the same build, minutes apart, must not agree.
  const tokens = [];

  for (const key of ["shipped", "second-install"]) {
    const dir = stageOnce(key, null);
    const browser = await launch({ extensionDir: dir });

    try {
      const id = await extensionId(browser, dir);
      const control = await controlPage(browser, id);
      await waitForRules(control);
      tokens.push(new URL(await ruleRedirectUrl(control)).searchParams.get("k"));
    } finally {
      await browser.close();
    }
  }

  tokens.forEach((token) => assert.match(String(token), /^[0-9a-f]{32}$/));
  assert.notEqual(tokens[0], tokens[1], "two separate installs minted the same token — it is derived, not random");
});

test("many passes granted and revoked at once neither hang nor survive an End all", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // Two properties of the pass chain that are separate from whether a grant is
  // erased (measured above): it must not deadlock, and "End all passes" must
  // mean it once it has answered. queuePassUpdate keeps the chain alive across a
  // rejected link; if it ever stops doing so, one failed grant silently freezes
  // every later pass operation and nothing reports it.
  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);

    const tab = await browser.newPage();
    await tab.goto(BLOCKED_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "the block page",
      timeoutMs: 15000
    });

    // Four is enough to interleave and few enough that the rule rebuild each
    // grant queues does not push the whole storm past its own deadline.
    const brands = (await brandFromRules(control, [])).slice(0, 4).map((brand) => brand.key);
    assert.equal(brands.length, 4, "not enough brands in the rule set to hammer the chain");

    // Grants, revokes and a deliberately invalid grant, all in flight together.
    // Every one must settle; a hang here is the failure.
    const hammered = JSON.parse(
      await tab.evaluate(`(async () => {
        const brands = ${JSON.stringify(brands)};
        const calls = [];

        brands.forEach((site, index) => {
          calls.push(chrome.runtime.sendMessage({ type: "grantPass", site, presetId: "site10" }).catch(e => ({ ok: false, error: String(e) })));
          if (index === 2) {
            calls.push(chrome.runtime.sendMessage({ type: "revokeAllPasses" }).catch(e => ({ ok: false, error: String(e) })));
            calls.push(chrome.runtime.sendMessage({ type: "grantPass", site: "no-such-brand-at-all", presetId: "site10" }).catch(e => ({ ok: false, error: String(e) })));
          }
        });

        // Generous, because every grant queues a rebuild of a few thousand
        // redirect rules and they run one after another. This deadline is here
        // to catch a chain that has stopped, not one that is merely busy.
        const settled = await Promise.race([
          Promise.all(calls),
          new Promise(r => setTimeout(() => r("TIMED OUT"), 60000))
        ]);

        return JSON.stringify({ settled: settled === "TIMED OUT" ? "TIMED OUT" : settled.map(r => !!(r && r.ok)) });
      })()`)
    );

    assert.notEqual(hammered.settled, "TIMED OUT", "the pass chain deadlocked under interleaved grants and revokes");
    assert.equal(
      hammered.settled.length,
      brands.length + 2,
      "a message in the storm never came back, so the chain dropped a link"
    );

    // The chain survived a rejected grant: the operations queued after the
    // unknown brand still answered.
    assert.ok(
      hammered.settled.slice(-2).some(Boolean),
      "operations queued after a rejected grant never completed — one failure froze the chain"
    );

    // And an awaited "End all passes" is absolute.
    await sleep(SETTLE_MS * 2);
    const revoked = JSON.parse(
      await tab.evaluate(`(async () => {
        const answer = await chrome.runtime.sendMessage({ type: "revokeAllPasses" });
        await new Promise(r => setTimeout(r, 2000));
        const stored = await chrome.storage.local.get(["passes"]);
        return JSON.stringify({ answer, passes: (stored.passes || []).map(p => p.target) });
      })()`)
    );

    assert.equal(revoked.answer.ok, true, "End all passes reported a failure");
    assert.deepEqual(revoked.passes, [], "passes survived an End all that had already answered");
  } finally {
    await browser.close();
  }
});

test("every enforced rule carries the token, however many there are", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // The catalog moves constantly — thirty brands were removed and 191 records
  // moved between the two lists in the five commits before this was written —
  // and the token lives in the redirect URL of every single rule. Three ways
  // that could quietly break:
  //
  //   a rule minted without the token, so blocks on that brand are refused;
  //   a rule pointing somewhere other than the block page;
  //   the list outgrowing the dynamic-rule ceiling, at which point
  //   updateDynamicRules fails and NOTHING is blocked at all.
  //
  // None of these shows up as an error anywhere a user would see. All three are
  // properties of the whole rule set, so all three are checked over the whole
  // rule set rather than over rule[0], which is what every other check in this
  // file reads.
  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);

    const survey = JSON.parse(
      await control.evaluate(`(async () => {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        const tokens = new Set();
        const bad = { noToken: [], notBlockPage: [], noSite: [], wrongResource: [] };

        for (const rule of rules) {
          let url = null;
          try { url = new URL(rule.action.redirect.url); } catch (_) { url = null; }

          if (!url || !url.pathname.endsWith("/warning.html")) {
            if (bad.notBlockPage.length < 5) bad.notBlockPage.push(rule.condition.urlFilter);
            continue;
          }

          const token = url.searchParams.get("k") || "";
          const site = url.searchParams.get("site") || "";

          if (!token && bad.noToken.length < 5) bad.noToken.push(rule.condition.urlFilter);
          if (!site && bad.noSite.length < 5) bad.noSite.push(rule.condition.urlFilter);
          if (token) tokens.add(token);

          const types = rule.condition.resourceTypes || [];
          if (types.length !== 1 || types[0] !== "main_frame") {
            if (bad.wrongResource.length < 5) bad.wrongResource.push(rule.condition.urlFilter + " " + types.join(","));
          }
        }

        return JSON.stringify({
          count: rules.length,
          distinctTokens: [...tokens].length,
          ceiling: chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || null,
          lastError: (chrome.runtime.lastError && chrome.runtime.lastError.message) || null,
          bad
        });
      })()`)
    );

    assert.ok(survey.count > 100, `only ${survey.count} rules were written — the catalog or the loader is broken`);
    assert.deepEqual(survey.bad.notBlockPage, [], "a rule redirects somewhere other than the block page");
    assert.deepEqual(survey.bad.noToken, [], "a rule was minted without the token — blocks on that brand would be refused");
    assert.deepEqual(survey.bad.noSite, [], "a rule carries no site key, so the block page cannot name the brand");
    assert.deepEqual(survey.bad.wrongResource, [], "a rule matches a resource type a website can read the result of");
    assert.equal(survey.distinctTokens, 1, "the rule set carries more than one token, so some blocks would be refused");

    // Headroom, not just a pass. If the catalog ever crosses the ceiling,
    // updateDynamicRules rejects the whole batch and blocking silently stops.
    if (survey.ceiling) {
      assert.ok(
        survey.count < survey.ceiling,
        `the rule set (${survey.count}) has reached the dynamic-rule ceiling (${survey.ceiling}) — blocking would stop entirely`
      );
    }

    // And the count is genuinely not assumed anywhere: a block still lands on a
    // brand picked from the far end of the list, not the famous ones at the top.
    const brands = await brandFromRules(control, []);
    const last = brands[brands.length - 1];
    const before = await readState(control);
    const tab = await browser.newPage();
    await tab.goto(last.url, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: `a block page for ${last.domain}`,
      timeoutMs: 15000
    });
    await sleep(SETTLE_MS);

    assert.equal(
      (await readState(control)).interruptions,
      before.interruptions + 1,
      `a genuine block on ${last.domain} was not counted`
    );
  } finally {
    await browser.close();
  }
});

test("End all passes means it, even with a settings change in flight", { concurrency: 1 }, async (t) => {
  if (noBrowser) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  // revokeAllPasses says of itself:
  //
  //   "On the same chain as grantPass, so a revoke cannot be quietly undone by a
  //    grant that was already in flight when the user pressed it. 'End all
  //    passes' has to mean it."
  //
  // The pass chain is not the only writer of that key. Every settings change
  // fires chrome.storage.onChanged over REFRESH_KEYS, which queues a refresh
  // nobody awaits, and refreshBlockingState ends by blind-writing the pass list
  // from the snapshot it read on entry. So a refresh that started before the
  // revoke restores what the revoke deleted — and because revokeAllPasses awaits
  // a refresh of its own afterwards, that later refresh reads the resurrected
  // list and writes it back again.
  //
  // Reachable with two ordinary clicks: change any setting, then press End all
  // passes. This is the same defect as the concurrent-grant loss above, seen
  // from the side that matters more — a safety control reporting success and
  // doing nothing.
  const shipped = stageOnce("shipped", null);
  const browser = await launch({ extensionDir: shipped });

  try {
    const id = await extensionId(browser, shipped);
    const control = await controlPage(browser, id);
    await waitForRules(control);

    const tab = await browser.newPage();
    await tab.goto(BLOCKED_URL, 2500);
    await until(async () => (await tab.evaluate("location.href")).includes("warning.html"), {
      what: "the block page",
      timeoutMs: 15000
    });
    await tab.evaluate(`(async () => chrome.runtime.sendMessage({
      type: "grantPass", site: new URLSearchParams(location.search).get("site"), presetId: "site10"
    }))()`);
    await sleep(SETTLE_MS * 2);
    assert.deepEqual(
      (await readState(control)).passes.map((pass) => pass.target),
      [BLOCKED_DOMAIN],
      "the fixture pass was not granted, so the revoke below would prove nothing"
    );

    // A setting the user might plausibly change on the way to the button. The
    // refresh it queues is not awaited by anyone.
    const outcome = JSON.parse(
      await control.evaluate(`(async () => {
        await chrome.storage.local.set({ timerSeconds: 45 });
        const answer = await chrome.runtime.sendMessage({ type: "revokeAllPasses" });
        const rightAfter = ((await chrome.storage.local.get(["passes"])).passes || []).map(p => p.target);
        return JSON.stringify({ answer, rightAfter });
      })()`)
    );

    assert.equal(outcome.answer.ok, true, "End all passes reported a failure");

    // Give every queued refresh time to land, so this is the settled answer and
    // not a snapshot taken mid-flight.
    await sleep(SETTLE_MS * 3);
    const settled = (await readState(control)).passes.map((pass) => pass.target);

    assert.deepEqual(
      settled,
      [],
      `End all passes answered ok and the pass is still there (right after: ${JSON.stringify(outcome.rightAfter)}). ` +
        "refreshBlockingState blind-writes `passes` from a snapshot read on entry; a refresh queued by " +
        "the settings change restores what the revoke deleted. Same fix as the concurrent-grant loss: " +
        "route that write through queuePassUpdate and re-read the list inside the chain"
    );
  } finally {
    await browser.close();
  }
});
