"use strict";
/**
 * The build gate must grade the package it is about to ship.
 *
 * `node build.js` ran validateAll() and THEN packaged. Three of the nineteen
 * audits — browser-a11y, announcement and firefox — load the built package out
 * of `dist/`, so validating first meant those three read the PREVIOUS build.
 * Two consequences, both observed:
 *
 *   1. A tree could be packaged and reported PASS while the browser audits had
 *      never seen it. One run here validated a good dist, packaged an extension
 *      whose background page installed no blocking rules at all, and printed a
 *      clean summary. The next build read that artifact and failed — which from
 *      the outside is indistinguishable from an intermittent gate, and is how it
 *      was first (mis)diagnosed.
 *
 *   2. On a clean checkout with no `dist/`, those three audits report "not built
 *      — run node build.js first" as a WARNING. Warnings do not abort. So the
 *      first build of any tree skipped all three browser gates entirely.
 *
 * These tests drive the real `main()` with the validator stubbed, so they assert
 * the ORDER as behaviour — what exists on disk when validateAll() is called, and
 * what exists after it refuses — rather than reading build.js's source. A
 * source-order grep would keep passing if someone moved the zip write into a
 * helper.
 *
 * Nothing here launches a browser: `validateAll` is replaced in the require
 * cache before build.js reaches for it.
 *
 * Runs under `node --test`.
 */

const test = require("node:test");
const { before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const VALIDATE_ALL = require.resolve("../tools/validate-all");
const BUILD = require.resolve("../build.js");

const DIST = path.join(ROOT, "dist");
const version = () => JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8")).version;

// `dist/` is moved aside for the whole file and put back afterwards, because one
// of these tests deliberately fails the gate and a failed build leaves no
// archives — which would silently delete the packages a developer, or another
// audit in this same session, is relying on. Parked once rather than per test so
// there is a single window to close, and restored from a process-exit hook too:
// a crash between the two must not be how someone loses their dist/.
let parked = null;

/**
 * Rename, retrying briefly while another process still holds the directory.
 *
 * `node --test` runs files concurrently, and test/tools.test.js runs the whole
 * validate-all — which launches Chrome and Firefox with dist/chrome and
 * dist/firefox as UNPACKED EXTENSION directories. On Windows a directory with an
 * open handle inside it cannot be renamed, so parking intermittently failed with
 * EPERM and took all four tests in this file down with it. The browsers release
 * dist/ as soon as they exit, so the contention is short; waiting it out is the
 * fix, and giving up loudly is the alternative to silently not parking (which
 * would let the deliberately-failed-gate test below delete a real dist/).
 */
function renameWhenFree(from, to, what) {
  const deadline = Date.now() + 30000;
  let last = null;

  for (;;) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EBUSY" && error.code !== "EACCES") {
        throw error;
      }

      last = error;

      if (Date.now() > deadline) {
        throw new Error(
          `could not ${what} dist/ after 30s — something still holds it open (${last.code}). ` +
            "A browser launched by another suite against dist/chrome or dist/firefox is the usual cause."
        );
      }

      // Synchronous wait: before/after hooks here are sync, and this must not
      // interleave with the very work it is waiting to finish.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function park() {
  if (parked || !fs.existsSync(DIST)) {
    return;
  }

  const target = path.join(os.tmpdir(), `fs-dist-parked-${process.pid}-${Date.now()}`);
  renameWhenFree(DIST, target, "park");
  parked = target;
}

function unpark() {
  if (!parked) {
    return;
  }

  const from = parked;
  parked = null;
  fs.rmSync(DIST, { recursive: true, force: true });
  renameWhenFree(from, DIST, "restore");
}

before(park);
after(unpark);
process.on("exit", unpark);

/** Run build.js's real main() with validateAll() replaced. */
async function buildWith(validation, observe) {
  const realValidateAll = require(VALIDATE_ALL).validateAll;
  const seen = { atValidation: null };

  require(VALIDATE_ALL).validateAll = async () => {
    // Snapshot the world at the exact moment the gate runs.
    seen.atValidation = observe();
    return validation;
  };

  // build.js caches nothing from validate-all at require time (it requires it
  // inside main()), but drop it anyway so a stale copy can never be used.
  delete require.cache[BUILD];

  let error = null;

  try {
    await require(BUILD).main();
  } catch (thrown) {
    error = thrown;
  } finally {
    require(VALIDATE_ALL).validateAll = realValidateAll;
    delete require.cache[BUILD];
  }

  return { error, atValidation: seen.atValidation, after: observe() };
}

// Each test starts from nothing staged, so "was it there when the gate ran?" is
// a statement about THIS build and not a leftover from the previous test.
function clearDist() {
  fs.rmSync(DIST, { recursive: true, force: true });
}

const worldState = () => ({
  chromeManifest: fs.existsSync(path.join(DIST, "chrome", "manifest.json")),
  firefoxManifest: fs.existsSync(path.join(DIST, "firefox", "manifest.json")),
  chromeBackground: fs.existsSync(path.join(DIST, "chrome", "background.js")),
  zips: fs.existsSync(DIST)
    ? fs.readdirSync(DIST).filter((name) => name.endsWith(".zip"))
    : []
});

// ---------------------------------------------------------------------------

test("the validators run against a staged package, not against last time's", async () => {
  clearDist();
  const { atValidation } = await buildWith({ ok: true, errors: 0 }, worldState);

  assert.ok(
    atValidation.chromeManifest && atValidation.firefoxManifest,
    "validateAll() ran before dist/chrome and dist/firefox existed — the three audits that read the built " +
      "package (browser-a11y, announcement, firefox) were grading the previous build, or skipping with a warning"
  );
  assert.ok(
    atValidation.chromeBackground,
    "the Chrome stage held a manifest but no payload when the validators ran"
  );
});

test("a failed gate leaves no archive anyone could ship", async () => {
  clearDist();
  const { error, after } = await buildWith({ ok: false, errors: 3 }, worldState);

  assert.ok(error, "a validation failure must stop the build");
  assert.equal(error.code, "VALIDATION_FAILED");
  assert.match(error.message, /3 validation error\(s\)/);

  assert.deepEqual(
    after.zips,
    [],
    `the build refused the package and wrote ${after.zips.join(", ")} anyway`
  );
});

test("a passing gate publishes both engines", async () => {
  clearDist();
  const { error, after } = await buildWith({ ok: true, errors: 0 }, worldState);

  assert.equal(error, null, error && error.message);

  const v = version();

  assert.ok(after.zips.includes(`FitShield-${v}-chrome.zip`), `no Chrome archive: ${after.zips.join(", ")}`);
  assert.ok(after.zips.includes(`FitShield-${v}-firefox.zip`), `no Firefox archive: ${after.zips.join(", ")}`);
});

test("the archives are written after the gate, never before it", async () => {
  // The tightest statement of the invariant: at the moment validateAll() is
  // called, the payload is fully staged and NOTHING is published yet.
  clearDist();
  const { atValidation } = await buildWith({ ok: true, errors: 0 }, worldState);

  assert.ok(atValidation.chromeManifest, "the package must be staged when the gate runs");
  assert.deepEqual(
    atValidation.zips,
    [],
    `an archive already existed when the gate ran (${atValidation.zips.join(", ")}) — a failing gate would ` +
      "have left a shippable package behind"
  );
});
