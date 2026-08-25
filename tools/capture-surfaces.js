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

module.exports = capture;

if (require.main === module) {
  capture().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
