"use strict";
/**
 * Minimal WebDriver BiDi client for Firefox. Node built-ins only.
 *
 * Firefox used to answer the Chrome DevTools Protocol on
 * `--remote-debugging-port`; as of Firefox 153 those endpoints are gone (the
 * /json/* routes 404) and the Remote Agent speaks WebDriver BiDi instead. This
 * is that protocol, at the size this project needs it: install the built
 * extension, open its pages, run script in them, and collect console errors.
 *
 * `webExtension.install` gives back the gecko id, but a page's URL needs the
 * per-profile UUID Firefox assigns, which is not in the reply. It lands in the
 * profile's own prefs, so that is where it is read from.
 *
 *   const ff = await launchFirefox({ extensionDir });
 *   const page = await ff.newPage();
 *   await page.goto(ff.url("popup.html"));
 *   await ff.close();
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function findFirefox() {
  const fromEnv = process.env.FS_FIREFOX;

  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  return (
    [
      "C:/Program Files/Mozilla Firefox/firefox.exe",
      "C:/Program Files (x86)/Mozilla Firefox/firefox.exe",
      "/usr/bin/firefox",
      "/snap/bin/firefox",
      "/Applications/Firefox.app/Contents/MacOS/firefox"
    ].find((p) => fs.existsSync(p)) || null
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Firefox writes the id -> UUID map into the profile as a JSON string inside a
// pref line. Polled because the pref is flushed a moment after install.
async function extensionUuid(profile, geckoId, timeoutMs = 15000) {
  const prefsFile = path.join(profile, "prefs.js");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (fs.existsSync(prefsFile)) {
      const prefs = fs.readFileSync(prefsFile, "utf8");
      const match = /extensions\.webextensions\.uuids",\s*"(.*?)"\);/.exec(prefs);

      if (match) {
        try {
          const map = JSON.parse(match[1].replace(/\\"/g, '"'));

          if (map[geckoId]) {
            return map[geckoId];
          }
        } catch (_) {
          /* half-written pref; try again */
        }
      }
    }

    if (Date.now() > deadline) {
      return null;
    }

    await sleep(300);
  }
}

async function launchFirefox({
  extensionDir,
  headless = true,
  binary = findFirefox(),
  port = 0,
  // Extra command-line arguments, e.g. ["-width", "320"]. BiDi's
  // browsingContext.setViewport refuses a privileged (moz-extension://) context
  // — "The command does not support browsing contexts in privileged scope" — so
  // sizing the WINDOW at launch is the only way to put an extension page in a
  // narrow viewport in Firefox, which the minimum-layout regression test needs.
  extraArgs = []
} = {}) {
  if (!binary) {
    const error = new Error("no Firefox binary found");
    error.code = "NO_BROWSER";
    throw error;
  }

  // A fixed port keeps this simple; Firefox does not print the chosen one in a
  // form as convenient as Chrome's. Derived from the pid so parallel runs on
  // one machine do not collide.
  const chosen = port || 9500 + (process.pid % 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fs-bidi-"));
  // --remote-allow-system-access is REQUIRED from Firefox 139 onward: without
  // it script.evaluate in the system sandbox fails with "System access is
  // required", and that is the call this module uses to read the per-profile
  // extension UUID out of prefs. Firefox 156 refuses it outright, so this
  // audit could not run at all until the flag was passed.
  const args = [
    `--remote-debugging-port=${chosen}`,
    "--remote-allow-system-access",
    "--profile", profile,
    "--no-remote",
    ...extraArgs,
    "about:blank"
  ];

  if (headless) {
    args.unshift("--headless");
  }

  const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  // The Remote Agent needs a moment; retry the socket rather than guessing one
  // sleep long enough for every machine.
  let ws = null;
  const deadline = Date.now() + 40000;

  for (;;) {
    try {
      const candidate = new WebSocket(`ws://127.0.0.1:${chosen}/session`);
      await new Promise((resolve, reject) => {
        candidate.addEventListener("open", resolve, { once: true });
        candidate.addEventListener("error", () => reject(new Error("not up")), { once: true });
      });
      ws = candidate;
      break;
    } catch (_) {
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error(`Firefox Remote Agent never answered on ${chosen}.\n${stderr}`);
      }

      await sleep(500);
    }
  }

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));

    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
      return;
    }

    if (message.method === "log.entryAdded" && message.params && message.params.level === "error") {
      consoleErrors.push({
        text: message.params.text || "",
        source: (message.params.source && message.params.source.realm) || "",
        // Which browsing context produced it. Without this a caller cannot tell
        // an error thrown by one of OUR pages from one thrown by a third-party
        // website it happened to open in a tab.
        context: (message.params.source && message.params.source.context) || ""
      });
    }
  });

  function send(method, params = {}) {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      pending.set(id, (message) => {
        if (message.error) {
          reject(new Error(`${method}: ${message.error} ${message.message || ""}`));
          return;
        }

        resolve(message.result);
      });

      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`BiDi timeout: ${method}`));
        }
      }, 30000);
    });
  }

  await send("session.new", { capabilities: {} });
  await send("session.subscribe", { events: ["log.entryAdded"] });

  let uuid = null;
  let geckoId = null;

  if (extensionDir) {
    const installed = await send("webExtension.install", {
      extensionData: { type: "path", path: path.resolve(extensionDir) }
    });
    geckoId = installed.extension;
    uuid = await extensionUuid(profile, geckoId);
  }

  return {
    send,
    geckoId,
    uuid,
    consoleErrors,
    url: (page) => `moz-extension://${uuid}/${page}`,
    async newPage() {
      const { context } = await send("browsingContext.create", { type: "tab" });

      return {
        context,
        async goto(url, settleMs = 1500) {
          await send("browsingContext.navigate", { context, url, wait: "complete" });
          await sleep(settleMs);
        },
        async evaluate(expression) {
          const result = await send("script.evaluate", {
            expression,
            target: { context },
            awaitPromise: true,
            resultOwnership: "none"
          });

          if (result.type === "exception") {
            throw new Error(result.exceptionDetails ? result.exceptionDetails.text : "evaluate threw");
          }

          return result.result ? result.result.value : undefined;
        },
        close: () => send("browsingContext.close", { context })
      };
    },
    async close() {
      try {
        ws.close();
      } catch (_) {
        /* already gone */
      }

      proc.kill();
      await sleep(300);

      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch (_) {
        /* temp dir; Windows sometimes holds it briefly */
      }
    }
  };
}

module.exports = { launchFirefox, findFirefox, sleep };
