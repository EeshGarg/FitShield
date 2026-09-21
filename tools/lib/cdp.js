"use strict";
/**
 * Minimal Chrome DevTools Protocol client. Node built-ins only.
 *
 * This exists in the repository rather than in a scratch directory because the
 * previous real-browser harnesses lived in a temp folder and were deleted by the
 * OS between sessions, taking every browser-level guarantee with them. A check
 * that cannot be re-run is not a check.
 *
 * Node 22+ exposes a global WebSocket, so the transport needs no dependency.
 *
 *   const { launch } = require("./lib/cdp.js");
 *   const browser = await launch({ extensionDir });
 *   const page = await browser.newPage();
 *   await page.goto("chrome-extension://<id>/popup.html");
 *   const tree = await page.send("Accessibility.getFullAXTree");
 *   await browser.close();
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Playwright ships a Chromium build; a system Chrome works equally well. Both
// are searched so this runs on a machine that has either.
function findChrome() {
  const fromEnv = process.env.FS_CHROME;

  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  const candidates = [];
  const playwright = path.join(os.homedir(), "AppData", "Local", "ms-playwright");

  if (fs.existsSync(playwright)) {
    fs.readdirSync(playwright)
      .filter((name) => name.startsWith("chromium-"))
      .forEach((name) => {
        candidates.push(path.join(playwright, name, "chrome-win64", "chrome.exe"));
        candidates.push(path.join(playwright, name, "chrome-linux", "chrome"));
      });
  }

  // Any Chromium drives these audits — they speak CDP, not Chrome. The list
  // used to name Google Chrome and two Linux paths only, so a machine with
  // Brave or Edge on it (and nothing else) reported "no Chromium found", and
  // ~18 real-browser security tests plus both accessibility audits skipped while
  // validate-all printed PASS. A skip that depends on which browser the
  // developer happens to prefer is not a meaningful gate.
  const home = os.homedir();
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(home, "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Chromium/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/brave-browser",
    "/usr/bin/microsoft-edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ].forEach((p) => candidates.push(p));

  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Chrome derives an unpacked extension's id from the SHA-256 of its absolute
// path: first 16 bytes, each nibble mapped 0-f => a-p. Windows hashes the path
// as UTF-16LE. Deriving it beats scraping chrome://extensions.
function unpackedExtensionId(dir) {
  const absolute = path.resolve(dir);
  const variants = new Set();

  [absolute, absolute.replace(/\//g, "\\"), absolute.replace(/\\/g, "/")].forEach((form) => {
    variants.add(form);
    variants.add(form.charAt(0).toUpperCase() + form.slice(1));
    variants.add(form.charAt(0).toLowerCase() + form.slice(1));
  });

  const ids = [];

  variants.forEach((form) => {
    [Buffer.from(form, "utf16le"), Buffer.from(form, "utf8")].forEach((buf) => {
      const digest = crypto.createHash("sha256").update(buf).digest();
      let id = "";

      for (let i = 0; i < 16; i++) {
        id += String.fromCharCode(97 + (digest[i] >> 4));
        id += String.fromCharCode(97 + (digest[i] & 0x0f));
      }

      if (!ids.includes(id)) {
        ids.push(id);
      }
    });
  });

  return ids;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, { timeoutMs = 20000, everyMs = 150, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await fn();

    if (value) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await sleep(everyMs);
  }
}

// Building a full accessibility tree for a 232-control page is far slower than
// a navigation, and slower again when the whole suite runs in parallel.
function timeoutFor(method) {
  if (/^Accessibility\./.test(method)) {
    return 120000;
  }

  if (/^Page\.(navigate|captureScreenshot)$/.test(method)) {
    return 60000;
  }

  return 30000;
}

class Connection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));

      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || "")})`)) : resolve(msg.result);
        return;
      }

      if (msg.method === "Target.attachedToTarget") {
        this.sessions.set(msg.params.targetInfo.targetId, msg.params.sessionId);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };

    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      // Per-method, because a flat 30s was not enough under load. `npm test`
      // runs ~39 files in parallel and the settings page carries 232 controls,
      // so Accessibility.getFullAXTree there intermittently blew the deadline
      // and turned a green suite red for reasons that had nothing to do with
      // the code under test. An intermittently failing check teaches people to
      // re-run rather than to read.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout after ${timeoutFor(method) / 1000}s: ${method}`));
        }
      }, timeoutFor(method));
    });
  }
}

/**
 * `profileDir` pins the user-data directory instead of making a throwaway one,
 * which is the only way to ask "does this survive the browser being closed and
 * reopened?". A pinned profile is the CALLER's: it is not deleted on close, and
 * close() quits the browser politely so the profile is flushed the way a real
 * one is rather than killed mid-write. `extraArgs` exists for the same caller —
 * `--restore-last-session` is meaningless without a profile to restore.
 */
async function launch({ extensionDir, headless = true, chrome = findChrome(), profileDir = null, extraArgs = [] } = {}) {
  if (!chrome) {
    const error = new Error("no Chrome/Chromium binary found");
    error.code = "NO_BROWSER";
    throw error;
  }

  const ownsProfile = !profileDir;
  const profile = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), "fs-cdp-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    ...extraArgs,
    "about:blank"
  ];

  if (headless) {
    args.unshift("--headless=new");
  }

  if (extensionDir) {
    const abs = path.resolve(extensionDir);

    // --load-extension only: NOT --disable-extensions-except. That second flag
    // turns the extension system off except for an allowlist, and on Chrome 137+
    // it also suppresses the extension this module now loads over CDP below —
    // Extensions.loadUnpacked returns the right id and no extension target ever
    // appears, which reads exactly like a package that will not load. Measured on
    // Chrome 153: with both flags the target is absent, with --load-extension
    // alone it is present. The profile here is a fresh mkdtemp with no other
    // extension in it, so restricting an allowlist was never buying anything.
    args.unshift(`--load-extension=${abs}`);
  }

  const proc = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome did not report a debugging port.\n${stderr}`)), 30000);

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = /ws:\/\/[^\s]+/.exec(stderr);

      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}) before listening.\n${stderr}`)));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });

  const cdp = new Connection(ws);
  await cdp.send("Target.setDiscoverTargets", { discover: true });

  // Chrome 137 removed --load-extension: the switch is parsed and then
  // ignored, so the browser comes up with no extension and the only symptom
  // is "no target reported an id the package path can produce" — the audit
  // blaming the package for a flag the browser dropped. Extensions.loadUnpacked
  // is the CDP command Chrome provides in its place, and it needs no special
  // launch flag. The --load-extension arguments above are kept because older
  // Chromium builds (and Brave) still honour them and do not implement this
  // domain; whichever of the two works, the extension is loaded exactly once —
  // a second load of the same path returns the same id rather than a duplicate.
  if (extensionDir) {
    // Only install it if it is not already there. A pinned profile KEEPS an
    // extension installed this way, and re-installing it on the next launch
    // restarts it — which tears down every page it owns, including one that
    // --restore-last-session has just brought back. Installing over the top is
    // also how a restored extension tab ends up on chrome-error://chromewebdata:
    // the tab is restored at start-up and the extension it belongs to does not
    // exist until a moment later.
    const candidates = new Set(unpackedExtensionId(extensionDir));
    const alreadyLoaded = async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.some((target) => {
        try {
          return target.url.startsWith("chrome-extension://") && candidates.has(new URL(target.url).host);
        } catch (_) {
          return false;
        }
      });
    };

    let present = false;
    for (let i = 0; i < 12 && !present; i++) {
      present = await alreadyLoaded();
      if (!present) {
        await sleep(150);
      }
    }

    if (!present) {
      try {
        await cdp.send("Extensions.loadUnpacked", { path: path.resolve(extensionDir) });
      } catch (_) {
        // Not implemented (older Chromium), where --load-extension above did the
        // job. Not fatal either way: the caller resolves the id and decides.
      }
    }
  }

  const browser = {
    cdp,
    async newPage() {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);

      return {
        sessionId,
        targetId,
        send: (method, params) => cdp.send(method, params, sessionId),
        async goto(url, settleMs = 1200) {
          await cdp.send("Page.navigate", { url }, sessionId);
          await sleep(settleMs);
        },
        async evaluate(expression) {
          const result = await cdp.send(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true },
            sessionId
          );

          if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || "evaluate threw");
          }

          return result.result.value;
        },
        close: () => cdp.send("Target.closeTarget", { targetId })
      };
    },
    async resolveExtensionId(dir, probePage = "popup.html") {
      const page = await browser.newPage();

      try {
        for (const id of unpackedExtensionId(dir)) {
          await page.goto(`chrome-extension://${id}/${probePage}`, 600);

          // Ask the page whether it IS the extension, rather than whether it
          // rendered something. This used to accept any page with more than 300
          // bytes of markup — and Chrome's "this extension is not installed"
          // error page measures 42,205, while the real popup measures 10,099.
          // So the wrong candidate won deterministically, and which one won
          // depended on the drive-letter case of the path passed in.
          const runtimeId = await page.evaluate(
            'typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id ? String(chrome.runtime.id) : ""'
          );

          if (runtimeId === id) {
            return id;
          }
        }
      } finally {
        await page.close();
      }

      return null;
    },
    async close() {
      // A pinned profile is going to be reopened, so the browser is asked to
      // quit and given time to do it. Killing the process instead leaves the
      // session state half-written, and "it did not survive the restart" would
      // then be a fact about this teardown rather than about the product.
      if (!ownsProfile) {
        await cdp.send("Browser.close").catch(() => {});
        await new Promise((done) => {
          proc.on("exit", done);
          setTimeout(() => {
            proc.kill();
            done();
          }, 8000);
        });
        await sleep(400);
        return;
      }

      try {
        ws.close();
      } catch (_) {
        /* already gone */
      }

      proc.kill();
      await sleep(200);

      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch (_) {
        /* Windows sometimes holds the profile briefly; it is a temp dir */
      }
    }
  };

  return browser;
}

module.exports = { launch, findChrome, unpackedExtensionId, sleep, until };
