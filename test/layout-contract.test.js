"use strict";
/**
 * The minimum layout contract, and the narrow-viewport regression it exists for.
 *
 * THE BUG. No FitShield surface declared a minimum width. The popup sized itself
 * from the viewport alone (`width: min(var(--popup-width), 100vw)`) and every
 * other page used `width: min(100%, Npx)` or a bare `max-width`, so the layout
 * followed the viewport down without limit. Measured in real Chromium against the
 * built package, before the fix, at a 120px viewport:
 *
 *     popup       body 120px, card       100px
 *     settings    body 105px, content     49px
 *     diagnostics body 105px, content     65px
 *
 * — the interface collapsed into an unreadable vertical strip, which is what a
 * Brave/Chromium user hit. Chromium gives an extension page whatever width its
 * container has (a narrow window, a side panel, a split view). Firefox clamps its
 * browser window instead: asked for a 320px and then a 120px window it produced a
 * 500px viewport both times, so the same missing floor was simply unreachable
 * there. One cross-browser CSS defect; one engine able to expose it.
 *
 * WHAT IS TESTED HERE, AND WHY IT IS NOT A GREP. A `min-width` in a source file
 * proves nothing: the rule can be overridden by a later cascade entry, dropped by
 * packaging, or defeated by a `width` on the same element. So the floor is
 * asserted three ways —
 *
 *   1. BEHAVIOUR (real Chromium, real built package, real narrow viewports):
 *      the laid-out width never goes below the floor, controls stay on screen and
 *      reachable, and a normal viewport gains no horizontal scrollbar.
 *   2. BEHAVIOUR (real Firefox): the floor is in force there too, at the
 *      narrowest window Firefox will actually produce.
 *   3. ARTIFACT: the stylesheet is inside BOTH store archives and every page in
 *      both archives links it — the half a source-only test cannot see.
 *
 * The browser halves skip when no browser is installed, and say so. The artifact
 * half always runs.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const build = require("../build.js");
const core = require("../extension/fitshield-core.js");
const { launch, findChrome } = require("../tools/lib/cdp.js");
const { launchFirefox, findFirefox } = require("../tools/lib/bidi.js");

const ROOT = path.join(__dirname, "..");
const EXTENSION_DIR = path.join(ROOT, "extension");
const CONTRACT_FILE = "fitshield-layout.css";

/** Every extension surface a user can put in front of themselves. */
const SURFACES = ["popup.html", "settings.html", "warning.html", "welcome.html", "whats-new.html", "diagnostics.html"];

/** The floor, from the one place that defines it. */
const FLOOR = core.MIN_LAYOUT_WIDTH;

// ---------------------------------------------------------------------------
// 1. One contract, stated once
// ---------------------------------------------------------------------------

test("the floor is one number, and the three places that state it agree", () => {
  const css = fs.readFileSync(path.join(EXTENSION_DIR, CONTRACT_FILE), "utf8");

  const declared = /--fs-min-layout-width:\s*(\d+)px/.exec(css);
  assert.ok(declared, `${CONTRACT_FILE} no longer declares --fs-min-layout-width`);
  assert.equal(
    Number(declared[1]),
    FLOOR,
    `${CONTRACT_FILE} says ${declared[1]}px but FitShieldCore.MIN_LAYOUT_WIDTH says ${FLOOR}`
  );

  // The slider is where 420 came from: it is the narrowest popup the product has
  // ever offered. If someone widens that minimum, the floor has to move with it
  // or the product offers a width its own layout does not support.
  const settings = fs.readFileSync(path.join(EXTENSION_DIR, "settings.html"), "utf8");
  const slider = /<input id="popupWidthRange"[^>]*>/.exec(settings);
  assert.ok(slider, "settings.html no longer has the popup-width slider");

  const min = /\bmin="(\d+)"/.exec(slider[0]);
  const max = /\bmax="(\d+)"/.exec(slider[0]);
  assert.ok(min && max, "the popup-width slider no longer declares min and max");

  assert.equal(Number(min[1]), FLOOR, "the popup-width slider's minimum and the layout floor must be the same number");
  assert.equal(Number(max[1]), core.MAX_POPUP_WIDTH, "the slider's maximum and MAX_POPUP_WIDTH must agree");
});

test("a stored popup width outside the slider's range cannot reach the layout", () => {
  // normalizeTheme clamped to 0..1000 while the only control that writes this
  // offered 420..620, so an imported backup could carry `popupWidth: 12` and the
  // popup rendered twelve pixels wide.
  assert.equal(core.normalizeTheme({ popupWidth: 12 }).popupWidth, FLOOR);
  assert.equal(core.normalizeTheme({ popupWidth: 0 }).popupWidth, FLOOR);
  assert.equal(core.normalizeTheme({ popupWidth: 9000 }).popupWidth, core.MAX_POPUP_WIDTH);

  // …and a legitimate value is still passed through untouched.
  assert.equal(core.normalizeTheme({ popupWidth: 516 }).popupWidth, 516);
  assert.equal(core.normalizeTheme({ popupWidth: FLOOR }).popupWidth, FLOOR);
  assert.equal(core.normalizeTheme({ popupWidth: core.MAX_POPUP_WIDTH }).popupWidth, core.MAX_POPUP_WIDTH);
});

test("every surface links the contract, and none re-declares a floor of its own", () => {
  for (const page of SURFACES) {
    const html = fs.readFileSync(path.join(EXTENSION_DIR, page), "utf8");

    assert.match(
      html,
      new RegExp(`<link[^>]+href="${CONTRACT_FILE}"`),
      `${page} does not link ${CONTRACT_FILE} — its layout has no floor`
    );

    // A page-local floor is how this becomes scattered magic numbers again. The
    // contract is one file; a page that needs a different width should change
    // the contract, not shadow it.
    const pageStyle = /<style>([\s\S]*?)<\/style>/.exec(html);
    assert.ok(pageStyle, `${page} has no <style> block`);

    const localFloor = /(?:^|[{;\s])min-width:\s*(\d+)px/g;
    const offenders = [];
    let hit;
    while ((hit = localFloor.exec(pageStyle[1])) !== null) {
      if (Number(hit[1]) >= 300) {
        offenders.push(`${hit[1]}px`);
      }
    }

    assert.deepEqual(offenders, [], `${page} declares its own wide min-width (${offenders.join(", ")})`);
  }
});

// ---------------------------------------------------------------------------
// 2. The artifact — both store archives
// ---------------------------------------------------------------------------

let tmpRoot = null;
const packages = {};

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fitshield-layout-"));

  for (const engine of ["chrome", "firefox"]) {
    const stage = path.join(tmpRoot, engine);
    fs.mkdirSync(stage, { recursive: true });
    build.copyInto(stage);

    const manifestBase = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
    const manifest = engine === "chrome" ? build.chromeManifest(manifestBase) : build.firefoxManifest(manifestBase);
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));

    packages[engine] = stage;
  }
});

test.after(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

for (const engine of ["chrome", "firefox"]) {
  test(`the ${engine} package ships the contract and every page in it links the contract`, () => {
    const stage = packages[engine];
    const css = path.join(stage, CONTRACT_FILE);

    assert.ok(fs.existsSync(css), `${engine}: ${CONTRACT_FILE} is missing from the package — the floor did not ship`);

    // Present is not enough: it has to still say the number.
    const shipped = fs.readFileSync(css, "utf8");
    assert.match(
      shipped,
      new RegExp(`--fs-min-layout-width:\\s*${FLOOR}px`),
      `${engine}: the packaged stylesheet no longer declares the floor`
    );
    assert.match(shipped, /min-width:\s*var\(--fs-min-layout-width\)/, `${engine}: the packaged rule does not apply it`);

    for (const page of SURFACES) {
      const packagedPage = path.join(stage, page);
      assert.ok(fs.existsSync(packagedPage), `${engine}: ${page} is missing from the package`);
      assert.match(
        fs.readFileSync(packagedPage, "utf8"),
        new RegExp(`<link[^>]+href="${CONTRACT_FILE}"`),
        `${engine}: packaged ${page} does not link the contract`
      );
    }
  });
}

test("both packages ship the byte-identical contract", () => {
  // Per-browser packaging is where a shared asset quietly diverges.
  const chrome = fs.readFileSync(path.join(packages.chrome, CONTRACT_FILE));
  const firefox = fs.readFileSync(path.join(packages.firefox, CONTRACT_FILE));

  assert.ok(chrome.equals(firefox), "the two packages ship different layout contracts");
});

// ---------------------------------------------------------------------------
// 3. Behaviour — real Chromium, real package, real narrow viewports
// ---------------------------------------------------------------------------

const NO_CHROME = !findChrome();

/** Well under the floor, at the floor, and comfortably above it. */
const NARROW = [120, 180, 300, 419];
const NORMAL = [520, 1024, 1280];

test("Chromium: no surface shrinks below the floor, however narrow the viewport", { concurrency: 1 }, async (t) => {
  if (NO_CHROME) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  const stage = packages.chrome;
  const browser = await launch({ extensionDir: stage });

  try {
    const id = await browser.resolveExtensionId(stage);
    const page = await browser.newPage();
    const failures = [];

    for (const surface of SURFACES) {
      for (const width of NARROW) {
        await page.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 760,
          deviceScaleFactor: 1,
          mobile: false
        });
        await page.goto(`chrome-extension://${id}/${surface}`, 600);

        const seen = JSON.parse(
          await page.evaluate(`(() => {
            const body = document.body;
            const doc = document.documentElement;
            return JSON.stringify({
              body: Math.round(body.getBoundingClientRect().width),
              html: Math.round(doc.getBoundingClientRect().width),
              scrollWidth: doc.scrollWidth,
              clientWidth: doc.clientWidth
            });
          })()`)
        );

        if (seen.body < FLOOR) {
          failures.push(`${surface} at ${width}px: body laid out at ${seen.body}px, below the ${FLOOR}px floor`);
        }

        // The whole point of a floor is that the content is still THERE and can
        // be scrolled to, rather than being squeezed out of existence.
        if (seen.scrollWidth < FLOOR) {
          failures.push(`${surface} at ${width}px: scrollWidth ${seen.scrollWidth}px cannot reach the floor`);
        }
      }
    }

    await page.close();
    assert.deepEqual(failures, [], `narrow-viewport collapse:\n  ${failures.join("\n  ")}`);
  } finally {
    await browser.close();
  }
});

test("Chromium: controls stay on screen and reachable at a collapsed viewport", { concurrency: 1 }, async (t) => {
  if (NO_CHROME) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  const stage = packages.chrome;
  const browser = await launch({ extensionDir: stage });

  try {
    const id = await browser.resolveExtensionId(stage);
    const page = await browser.newPage();

    const probe = `(() => {
      const shown = [...document.querySelectorAll("button, input, select, a[href]")]
        .filter((el) => el.offsetParent !== null);
      const boxes = shown.map((el) => el.getBoundingClientRect());
      return JSON.stringify({
        shown: shown.length,
        collapsed: boxes.filter((b) => b.width < 1 || b.height < 1).length,
        offLeft: boxes.filter((b) => b.left < 0).length,
        beyondScroll: boxes.filter((b) => b.right > document.documentElement.scrollWidth + 1).length
      });
    })()`;

    for (const surface of ["popup.html", "settings.html", "warning.html"]) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 760,
        deviceScaleFactor: 1,
        mobile: false
      });
      await page.goto(`chrome-extension://${id}/${surface}`, 700);
      const wide = JSON.parse(await page.evaluate(probe));

      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 120,
        height: 760,
        deviceScaleFactor: 1,
        mobile: false
      });
      await page.goto(`chrome-extension://${id}/${surface}`, 700);
      const narrow = JSON.parse(await page.evaluate(probe));

      // Comparing against the SAME page at a normal width is what makes this a
      // regression test rather than a snapshot: a control that is hidden or
      // zero-sized in both is a pre-existing detail of the design, not damage
      // done by narrowing.
      assert.equal(
        narrow.shown,
        wide.shown,
        `${surface}: ${wide.shown - narrow.shown} control(s) disappeared when the viewport collapsed`
      );
      assert.equal(
        narrow.collapsed,
        wide.collapsed,
        `${surface}: ${narrow.collapsed - wide.collapsed} control(s) were crushed to zero size`
      );
      assert.equal(narrow.offLeft, 0, `${surface}: ${narrow.offLeft} control(s) pushed off the left edge`);
      assert.equal(narrow.beyondScroll, 0, `${surface}: ${narrow.beyondScroll} control(s) unreachable by scrolling`);
    }

    await page.close();
  } finally {
    await browser.close();
  }
});

test("Chromium: a normal viewport gains no horizontal scrollbar", { concurrency: 1 }, async (t) => {
  if (NO_CHROME) {
    t.skip("no Chromium found — set FS_CHROME to a browser binary");
    return;
  }

  const stage = packages.chrome;
  const browser = await launch({ extensionDir: stage });

  try {
    const id = await browser.resolveExtensionId(stage);
    const page = await browser.newPage();
    const overflowing = [];

    // The popup is excluded: it is a fixed-width panel the browser sizes to its
    // content, not a page laid out in a tab, so it is legitimately wider than a
    // narrow tab viewport. Every full-page surface must fit.
    for (const surface of SURFACES.filter((s) => s !== "popup.html")) {
      for (const width of NORMAL) {
        await page.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false
        });
        await page.goto(`chrome-extension://${id}/${surface}`, 600);

        const overflow = JSON.parse(
          await page.evaluate(`(() => {
            const doc = document.documentElement;
            return JSON.stringify({ scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth });
          })()`)
        );

        if (overflow.scrollWidth > overflow.clientWidth) {
          overflowing.push(
            `${surface} at ${width}px: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`
          );
        }
      }
    }

    await page.close();
    assert.deepEqual(overflowing, [], `horizontal overflow at a supported width:\n  ${overflowing.join("\n  ")}`);
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Behaviour — real Firefox
// ---------------------------------------------------------------------------

const NO_FIREFOX = !findFirefox();

test("Firefox: the floor is in force, at the narrowest window Firefox will give", { concurrency: 1 }, async (t) => {
  if (NO_FIREFOX) {
    t.skip("no Firefox found");
    return;
  }

  // BiDi refuses browsingContext.setViewport on a privileged (moz-extension://)
  // context, so the window is sized at launch instead. Firefox clamps it — ask
  // for 120 and it produces roughly 500 — which is exactly why this regression
  // could not be reproduced here, and why the assertion below is about the floor
  // holding rather than about reaching a sub-floor viewport.
  const firefox = await launchFirefox({
    extensionDir: packages.firefox,
    extraArgs: ["-width", "120", "-height", "760"]
  });

  try {
    const page = await firefox.newPage();

    for (const surface of SURFACES) {
      await page.goto(firefox.url(surface), 900);

      const seen = JSON.parse(
        await page.evaluate(`(() => {
          const doc = document.documentElement;
          const applied = getComputedStyle(doc).minWidth;
          return JSON.stringify({
            body: Math.round(document.body.getBoundingClientRect().width),
            clientWidth: doc.clientWidth,
            minWidth: applied
          });
        })()`)
      );

      // The contract is loaded and computed, not merely present on disk.
      assert.equal(
        seen.minWidth,
        `${FLOOR}px`,
        `${surface}: Firefox computed min-width "${seen.minWidth}" — the contract did not apply`
      );
      assert.ok(
        seen.body >= FLOOR,
        `${surface}: body laid out at ${seen.body}px in a ${seen.clientWidth}px viewport, below the floor`
      );
    }

    await page.close();
  } finally {
    await firefox.close();
  }
});
