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

  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

async function launch({ extensionDir, headless = true, chrome = findChrome() } = {}) {
  if (!chrome) {
    const error = new Error("no Chrome/Chromium binary found");
    error.code = "NO_BROWSER";
    throw error;
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fs-cdp-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "about:blank"
  ];

  if (headless) {
    args.unshift("--headless=new");
  }

  if (extensionDir) {
    const abs = path.resolve(extensionDir);
    args.unshift(`--disable-extensions-except=${abs}`, `--load-extension=${abs}`);
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
          const size = await page.evaluate("document.body ? document.body.innerHTML.length : 0");

          if (Number(size) > 300) {
            return id;
          }
        }
      } finally {
        await page.close();
      }

      return null;
    },
    async close() {
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
