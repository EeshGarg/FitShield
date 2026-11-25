#!/usr/bin/env node
"use strict";
/**
 * Screenshot every surface the product shows a user, in both themes and at the
 * sizes that break layouts, into dist/acceptance/.
 *
 * Whether the friction feels right rather than manipulative is a judgement only
 * a person can make. This does not try to make it: it removes everything around
 * that judgement that is not judgement. Instead of installing a build, clicking
 * through six surfaces twice, and remembering what the other theme looked like,
 * the reviewer opens one folder.
 *
 *   node tools/capture-surfaces.js
 *   node tools/capture-surfaces.js --docs   # the five consumer-guide shots
 *
 * --docs writes light-theme English screenshots into docs/assets/screenshots/
 * (block-page, popup, settings, welcome, android-dashboard). The Android shot
 * serves the real WebView bundle over loopback with a stubbed `Android` bridge.
 *
 * Needs a built dist/chrome and a Chromium. Writes nothing into the repository.
 */

const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("./lib/cdp.js");

const ROOT = path.join(__dirname, "..");
const PACKAGE_DIR = path.join(ROOT, "dist", "chrome");
const OUT_DIR = path.join(ROOT, "dist", "acceptance");

// width/height are the viewport; the popup is captured at its own fixed width,
// and again narrow, because that is where a zoomed popup actually clips.
const SHOTS = [
  { page: "popup.html", name: "popup", width: 560, height: 700 },
  { page: "popup.html", name: "popup-narrow", width: 360, height: 700 },
  { page: "warning.html?site=delivery-doordash-com", name: "block-page", width: 1280, height: 900 },
  { page: "warning.html?site=delivery-doordash-com", name: "block-page-short", width: 1280, height: 620 },
  { page: "warning.html?site=fast-food-jollibee-com", name: "block-page-many-countries", width: 1280, height: 900 },
  { page: "settings.html", name: "settings", width: 1280, height: 1400 },
  { page: "settings.html", name: "settings-narrow", width: 720, height: 1400 },
  { page: "welcome.html", name: "welcome", width: 1100, height: 900 },
  { page: "whats-new.html", name: "whats-new", width: 1100, height: 900 },
  { page: "diagnostics.html", name: "diagnostics", width: 1100, height: 900 }
];

// `themeMode` is a STORED setting, not an OS query — its default is "dark", so
// emulating prefers-color-scheme alone produced two identical dark sets
// labelled "dark" and "light". A mislabelled screenshot is worse than no
// screenshot: it is the reviewer being shown the wrong thing under the right
// name. The mode is written to storage, and the OS preference is emulated too
// so that "system" resolves the way the label claims.
// Both palettes are captured through Theme = System, which is the path that
// actually resolves against the OS. Writing `themeMode: "light"` alone does
// NOT repaint: with an explicit choice the pages use the stored `theme`
// palette, which Settings writes at the moment the user picks — so setting the
// mode without the palette left every "light" capture dark, two identical sets
// under two different labels. A mislabelled screenshot is worse than none: it
// shows the reviewer the wrong thing under the right name.
const THEMES = [
  { id: "dark", mode: "system", media: "dark" },
  { id: "light", mode: "system", media: "light" }
];

async function capture() {
  if (!fs.existsSync(path.join(PACKAGE_DIR, "manifest.json"))) {
    console.error("dist/chrome is not built — run `node build.js` first.");
    process.exit(1);
  }

  let browser;

  try {
    browser = await launch({ extensionDir: PACKAGE_DIR });
  } catch (error) {
    console.error(error.code === "NO_BROWSER" ? "No Chromium found. Set FS_CHROME to a browser binary." : error.message);
    process.exit(1);
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let written = 0;

  try {
    const id = await browser.resolveExtensionId(PACKAGE_DIR);

    if (!id) {
      console.error("The extension did not load.");
      process.exit(1);
    }

    for (const theme of THEMES) {
      for (const shot of SHOTS) {
        const tab = await browser.newPage();

        try {
          // Theme "System" resolves against the OS, so the emulated preference
          // is what actually drives both palettes here.
          await tab.send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: theme.media }]
          });
          await tab.send("Emulation.setDeviceMetricsOverride", {
            width: shot.width,
            height: shot.height,
            deviceScaleFactor: 1,
            mobile: false
          });

          // Land on an extension page first so chrome.storage is reachable,
          // set the mode, then navigate to the surface being captured.
          await tab.goto(`chrome-extension://${id}/${shot.page}`, 900);
          await tab.evaluate(
            `new Promise((done) => chrome.storage.local.set({ themeMode: ${JSON.stringify(theme.mode)} }, done))`
          );
          await tab.goto(`chrome-extension://${id}/${shot.page}`, 2200);
          // The block page runs a countdown and paints its alternative after a
          // fetch; a moment of settle avoids capturing a half-rendered card.
          await sleep(900);

          const { data } = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
          const file = path.join(OUT_DIR, `${theme.id}-${shot.name}.png`);
          fs.writeFileSync(file, Buffer.from(data, "base64"));
          written++;
          console.log(`  ${path.basename(file)}`);
        } finally {
          await tab.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${written} screenshot(s) in ${path.relative(ROOT, OUT_DIR).split(path.sep).join("/")}`);
  console.log("Review against docs/ACCEPTANCE.md — the judgement calls are listed there.");
}

// The Android stub reports the real version, so screenshots never show a stale one.
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8")).version;
const DOCS_DIR = path.join(ROOT, "docs", "assets", "screenshots");
const DOCS_SHOTS = [
  { page: "warning.html?site=delivery-doordash-com", name: "block-page", width: 1280, height: 1000, click: "#intentOptions button" },
  { page: "popup.html", name: "popup", width: 560, height: 700, fit: true },
  { page: "settings.html", name: "settings", width: 1280, height: 800 },
  { page: "welcome.html", name: "welcome", width: 1280, height: 800 }
];

async function shoot(tab, file, clip) {
  const params = { format: "png" };
  if (clip) params.clip = { x: 0, y: 0, ...clip, scale: 1 };
  const { data } = await tab.send("Page.captureScreenshot", params);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  ${path.relative(ROOT, file).split(path.sep).join("/")} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}

// A stand-in for the native bridge, backed by an in-memory map. Only the
// Android side is stubbed; every file the page runs is the shipped one.
const ANDROID_STUB = `(() => {
  const store = {
    themeMode: JSON.stringify("light"),
    androidWelcomed: JSON.stringify(true),
    accessibilityConsent: JSON.stringify(true)
  };
  window.Android = {
    storageGet: (k) => (k in store ? store[k] : null),
    storageGetMany: (ks) => { const o = {}; JSON.parse(ks).forEach((k) => { if (k in store) o[k] = store[k]; }); return JSON.stringify(o); },
    storageSet: (k, v) => { store[k] = v; }, storageRemove: (k) => { delete store[k]; },
    storageClear: () => {}, storageKeys: () => JSON.stringify(Object.keys(store)),
    accessibilityConsentGiven: () => true, accessibilityEnabled: () => true,
    overlayEnabled: () => true, notificationsEnabled: () => true, batteryUnrestricted: () => true,
    keepAliveEnabled: () => true, appPackageCount: () => 6, blockableApps: () => "[]",
    getUiLanguage: () => "en", getVersion: () => ${JSON.stringify(MANIFEST_VERSION)},
    recordAccessibilityConsent: () => {}, clearAccessibilityConsent: () => {}, setKeepAlive: () => {},
    openAccessibilitySettings: () => {}, openBatterySettings: () => {}, openNotificationSettings: () => {},
    openOverlaySettings: () => {}, openUrl: () => {}, exportSettings: () => "{}", importSettings: () => "{}"
  };
})();`;

async function captureDocs() {
  const http = require("http");
  if (!fs.existsSync(path.join(PACKAGE_DIR, "manifest.json"))) {
    console.error("dist/chrome is not built — run `node build.js` first.");
    process.exit(1);
  }
  const webDir = path.join(ROOT, "android", "app", "src", "main", "assets", "web");
  const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".css": "text/css" };
  const server = http.createServer((req, res) => {
    const file = path.join(webDir, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
    if (!file.startsWith(webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const browser = await launch({ extensionDir: PACKAGE_DIR });
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  try {
    const id = await browser.resolveExtensionId(PACKAGE_DIR);
    if (!id) throw new Error("The extension did not load.");

    for (const shot of DOCS_SHOTS) {
      const tab = await browser.newPage();
      try {
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
        await tab.send("Emulation.setDeviceMetricsOverride", { width: shot.width, height: shot.height, deviceScaleFactor: 1, mobile: false });
        await tab.goto(`chrome-extension://${id}/${shot.page}`, 900);
        await tab.evaluate(`new Promise((done) => chrome.storage.local.set({ themeMode: "system" }, done))`);
        await tab.goto(`chrome-extension://${id}/${shot.page}`, 2200);
        await sleep(900);
        if (shot.click) {
          // Answer the optional intent prompt so the recipe alternative shows.
          await tab.evaluate(`document.querySelector(${JSON.stringify(shot.click)}).click()`);
          await sleep(1200);
        }
        let clip = null;
        if (shot.fit) {
          const h = await tab.evaluate("document.documentElement.scrollHeight");
          clip = { width: shot.width, height: Math.min(Math.max(h, 200), 1100) };
          await tab.send("Emulation.setDeviceMetricsOverride", { width: shot.width, height: clip.height, deviceScaleFactor: 1, mobile: false });
          await sleep(300);
        }
        await shoot(tab, path.join(DOCS_DIR, `${shot.name}.png`), clip);
      } finally {
        await tab.close();
      }
    }

    const tab = await browser.newPage();
    try {
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
      await tab.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
      await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: ANDROID_STUB });
      await tab.goto(`http://127.0.0.1:${server.address().port}/index.html`, 3000);
      await shoot(tab, path.join(DOCS_DIR, "android-dashboard.png"));
    } finally {
      await tab.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

module.exports = capture;

if (require.main === module) {
  (process.argv.includes("--docs") ? captureDocs().then(() => process.exit(0)) : capture()).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
