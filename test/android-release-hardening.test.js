"use strict";
/**
 * Four things that would have shipped, and the release bundle that could not
 * have shipped at all.
 *
 *  - **No launcher icon.** `<application>` declared no `android:icon` and there
 *    were no mipmap resources, so the app installed as Android's grey
 *    placeholder. The 512x512 store icon does not fix what is on the home screen.
 *  - **POST_NOTIFICATIONS declared and never requested**, therefore denied on
 *    every Android 13+ device. Losing the ongoing foreground notice is cosmetic;
 *    losing the "protection is off after your restart" notice means the boot
 *    fallback posts into nothing.
 *  - **No affirmative consent before the accessibility request** — the fifth of
 *    Google's five prominent-disclosure conditions, on one of the two most
 *    scrutinised declarations a Play listing can carry.
 *  - **No release bundle.** Play takes an AAB and the tooling built a debug APK,
 *    so there was no path to an upload at all; and an AAB that comes out
 *    unsigned must fail loudly rather than be reported as a successful build.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const androidAudit = require("../tools/android-audit.js");
const build = require("../tools/build-android.js");
const { loadPage } = require("./helpers/android-webview.js");

const ROOT = path.join(__dirname, "..");
const ANDROID = path.join(ROOT, "android", "app", "src", "main");
const RES = path.join(ANDROID, "res");
const KOTLIN = path.join(ANDROID, "java", "com", "usha", "fitshield");
const MANIFEST = fs.readFileSync(path.join(ANDROID, "AndroidManifest.xml"), "utf8");
const manifestBody = MANIFEST.replace(/<!--[\s\S]*?-->/g, " ");

const kotlin = (name) => fs.readFileSync(path.join(KOTLIN, name), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\r\n]*/g, " ");

// ---------------------------------------------------------------------------
// Launcher icon
// ---------------------------------------------------------------------------

test("the app ships its own launcher icon, not Android's placeholder", () => {
  const icon = manifestBody.match(/<application[\s\S]*?android:icon="@(mipmap|drawable)\/([A-Za-z0-9_]+)"/);
  assert.ok(icon, "<application> declares no android:icon — the app installs as a grey placeholder");

  const [, type, name] = icon;
  const buckets = fs.readdirSync(RES).filter((d) => d === type || d.startsWith(`${type}-`));
  const providing = buckets.filter((bucket) =>
    fs.readdirSync(path.join(RES, bucket)).some((f) => f.replace(/\.[^.]+$/, "") === name)
  );
  assert.notDeepEqual(providing, [], `no res/${type}* directory provides ${name}`);

  // minSdk is 26, so an adaptive icon in mipmap-anydpi-v26 is reachable on every
  // supported device and no density-bucket PNG fallback can ever be needed.
  const minSdk = Number(
    fs.readFileSync(path.join(ROOT, "android", "app", "build.gradle"), "utf8").match(/minSdk\s+(\d+)/)[1]
  );
  if (providing.some((b) => b.endsWith("-anydpi-v26"))) {
    assert.ok(minSdk >= 26,
      `the icon is only provided for API 26+ but minSdk is ${minSdk}; older devices would find no icon`);
  }
});

test("the launcher icon is the mark the browser build already uses", () => {
  // The icon was a vector hand-traced from the browser icon. It was close, and
  // "close" is the wrong standard for the mark on someone's home screen — so it
  // is now RENDERED from the brand master, `brand/fitshield-f-512.png`, by
  // `tools/make-android-icon.js`. The same file is the 512x512 Play listing
  // icon, which is what stops the store and the launcher wearing two faces.
  const generator = require("../tools/make-android-icon.js");

  [generator.OUT, generator.OUT_MONO].forEach((file) => {
    assert.ok(fs.existsSync(file), `${path.basename(file)} is missing — run node tools/make-android-icon.js`);
  });

  // Regenerating must reproduce the committed bytes. If it does not, either the
  // artwork moved and the icon was not rebuilt, or someone edited the output by
  // hand and the next regeneration will silently throw their work away.
  const before = [generator.OUT, generator.OUT_MONO].map((file) => fs.readFileSync(file));
  generator.build();
  [generator.OUT, generator.OUT_MONO].forEach((file, index) => {
    assert.ok(
      before[index].equals(fs.readFileSync(file)),
      `${path.basename(file)} is not what the generator produces from brand/fitshield-f-512.png`
    );
  });

  // Same green as the browser icon, within the tolerance two exports of one
  // logo differ by. They are separate files, so an exact match would be luck.
  const master = generator.dominantHex(generator.SOURCE);
  const browser = dominantInk(path.join(ROOT, "extension", "icons", "icon-128.png"));
  const channels = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const drift = channels(master).map((value, i) => Math.abs(value - channels(browser)[i]));
  assert.ok(
    Math.max(...drift) <= 24,
    `the brand master's green (#${master}) and the browser icon's (#${browser}) are different colours`
  );

  // The artwork must sit inside the adaptive-icon safe zone: Android masks the
  // 108dp canvas down to its central 72dp, and the F in the master bleeds off
  // the bottom edge, so dropped in at full size the letter would be cut.
  const drawn = generator.build();
  assert.ok(drawn.drawW <= generator.SAFE && drawn.drawH <= generator.SAFE,
    `artwork ${drawn.drawW}x${drawn.drawH} exceeds the ${generator.SAFE}px safe zone`);
  assert.ok(drawn.originX >= 0 && drawn.originY >= 0, "the artwork is positioned off the canvas");
  assert.ok(
    drawn.originX + drawn.drawW <= generator.CANVAS && drawn.originY + drawn.drawH <= generator.CANVAS,
    "the artwork runs past the edge of the canvas"
  );
});

// ---------------------------------------------------------------------------
// Notification permission
// ---------------------------------------------------------------------------

test("POST_NOTIFICATIONS is requested at runtime, not merely declared", () => {
  assert.match(manifestBody, /android\.permission\.POST_NOTIFICATIONS/,
    "the foreground service needs this permission declared");

  const activity = kotlin("MainActivity.kt");
  assert.match(activity, /requestPermissions\s*\(/,
    "POST_NOTIFICATIONS is declared and never requested — Android 13+ denies it, and every notification " +
    "this app posts, including the restore notice, goes nowhere");
  assert.match(activity, /POST_NOTIFICATIONS/);
  assert.match(activity, /onRequestPermissionsResult/,
    "nothing resumes the enable flow after the permission dialog is answered");

  // Asked once, in the flow that needs it, and never made a blocker: a decline
  // must still let the user turn protection on.
  assert.match(activity, /if \(requestCode == REQUEST_NOTIFICATIONS\) continueVpnEnable\(\)/,
    "a declined notification permission must not abandon the VPN enable flow");
});

test("the dashboard says what a declined notification permission costs", async () => {
  const page = await loadPage({
    page: "index.html",
    script: "app.js",
    store: { androidWelcomed: true, appBlockingEnabled: true }
  });
  assert.ok(page.document.getElementById("notifStatus"),
    "the dashboard has nowhere to say that notifications are off, so the boot restore notice fails silently");
  assert.ok(page.document.getElementById("notifOpen"),
    "there is no way to reach the notification setting from the dashboard");

  const shim = fs.readFileSync(path.join(ROOT, "android", "web-src", "android-shim.js"), "utf8");
  assert.match(shim, /notificationsEnabled/);
  assert.match(kotlin("WebAppBridge.kt"), /areNotificationsEnabled/);
});

// ---------------------------------------------------------------------------
// Prominent disclosure
// ---------------------------------------------------------------------------

test("the accessibility request is gated on an affirmative in-app consent", () => {
  const bridge = kotlin("WebAppBridge.kt");
  const opener = bridge.slice(bridge.indexOf("fun openAccessibilitySettings"));
  const body = opener.slice(0, opener.indexOf("\n    }") + 1);

  assert.match(body, /accessibilityConsentGiven\(\)/,
    "openAccessibilitySettings opens the system screen without checking the recorded consent; a UI change " +
    "could then route around the disclosure entirely");
  assert.match(bridge, /fun recordAccessibilityConsent/);
  assert.match(bridge, /accessibilityDisclosureAcceptedAt/,
    "the acceptance should be recorded as a timestamp, so it is auditable rather than a bare flag");
});

test("the disclosure states what is read, what is not, and cannot be swiped away", async () => {
  const page = await loadPage({ page: "index.html", script: "app.js", store: { androidWelcomed: true } });
  const dialog = page.document.getElementById("a11yDisclosure");
  assert.ok(dialog, "there is no in-app disclosure dialog; a privacy-policy line does not satisfy Google");

  const markup = fs.readFileSync(path.join(ANDROID, "assets", "web", "index.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const card = markup.slice(markup.indexOf('id="a11yDisclosure"'), markup.indexOf('<header>'));

  assert.match(card, /role="dialog"/);
  assert.match(card, /aria-modal="true"/);
  for (const [what, pattern] of [
    ["the data it reads", /package name/i],
    ["that screen content is not read", /never reads/i],
    ["the system-level guarantee", /canRetrieveWindowContent/],
    ["what it is used for", /pause screen/i],
    ["that nothing leaves the device", /nowhere|nothing uploaded/i],
    ["how to turn it off", /turning it off/i]
  ]) {
    assert.match(card, pattern, `the disclosure does not state ${what}`);
  }

  // Two explicit choices, and no third way out.
  assert.ok(page.document.getElementById("a11yAccept"), "no affirmative accept control");
  assert.ok(page.document.getElementById("a11yDecline"), "no way to decline");
  assert.ok(!/onclick|backdrop|data-dismiss/i.test(card),
    "the disclosure must not be dismissible other than by the two buttons");
});

// ---------------------------------------------------------------------------
// The release bundle
// ---------------------------------------------------------------------------

test("the bundle command refuses to guess a versionCode", () => {
  assert.deepEqual(build.parseArgs([]), { bundle: false });

  assert.match(build.parseArgs(["--bundle"]).error || "", /requires --versionCode/,
    "Play rejects a re-used versionCode and there is no way to reclaim one; it may never be defaulted");
  assert.match(build.parseArgs(["--bundle", "--versionCode=0"]).error || "", /positive integer/);
  assert.match(build.parseArgs(["--bundle", "--versionCode=x"]).error || "", /positive integer/);
  assert.match(build.parseArgs(["--versionCode=7"]).error || "", /only applies to --bundle/);

  assert.deepEqual(build.parseArgs(["--bundle", "--versionCode=7"]), { bundle: true, versionCode: 7 });
});

test("an unsigned bundle fails the build instead of reporting success", () => {
  const ok = { hasGradle: true, gradleStatus: 0, bundleFound: true, signed: true };

  assert.equal(build.bundleOutcome(ok).exitCode, 0);
  assert.equal(build.bundleOutcome(ok).built, true);

  const unsigned = build.bundleOutcome({ ...ok, signed: false });
  assert.equal(unsigned.exitCode, 1,
    "an unsigned .aab is not an upload — reporting success over it is the same failure as printing PASS " +
    "over a broken package");
  assert.equal(unsigned.built, false);
  assert.match(unsigned.reason, /UNSIGNED/);
  assert.match(unsigned.reason, /keystore\.properties/, "the failure has to say how to fix itself");

  assert.equal(build.bundleOutcome({ ...ok, gradleStatus: 1 }).exitCode, 1);
  assert.equal(build.bundleOutcome({ ...ok, bundleFound: false }).exitCode, 1);
  // Absent tooling stays a skip, exactly as the APK path treats it.
  assert.equal(build.bundleOutcome({ ...ok, hasGradle: false }).exitCode, 0);
});

test("the signature check reads the archive, not the build's own opinion of it", () => {
  // A zip carrying the three entries a jarsigner signature consists of.
  const signed = makeZip(["META-INF/MANIFEST.MF", "META-INF/FITSHIEL.SF", "META-INF/FITSHIEL.RSA", "base/manifest/AndroidManifest.xml"]);
  const unsigned = makeZip(["META-INF/MANIFEST.MF", "base/manifest/AndroidManifest.xml"]);
  const partial = makeZip(["META-INF/MANIFEST.MF", "META-INF/FITSHIEL.SF", "base/manifest/AndroidManifest.xml"]);

  const tmp = path.join(require("node:os").tmpdir(), `fitshield-sig-${process.pid}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const write = (name, buf) => { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; };
    assert.equal(build.isBundleSigned(write("signed.aab", signed)), true);
    assert.equal(build.isBundleSigned(write("unsigned.aab", unsigned)), false,
      "a bundle with no signature block must read as unsigned");
    assert.equal(build.isBundleSigned(write("partial.aab", partial)), false,
      "a .SF without its key block is not a signature");
    assert.deepEqual(build.zipEntryNames(Buffer.from("not a zip at all")), [],
      "an unreadable archive must read as unsigned rather than throw");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the audit accepts this build's API level and would reject a lower one", async () => {
  const gradle = fs.readFileSync(path.join(ROOT, "android", "app", "build.gradle"), "utf8");
  const compileSdk = Number(gradle.match(/compileSdk\s+(\d+)/)[1]);
  const targetSdk = Number(gradle.match(/targetSdk\s+(\d+)/)[1]);

  // Play requires API 36 for new apps and updates submitted from 31 August 2026.
  assert.ok(compileSdk >= 36, `compileSdk ${compileSdk} is below the level Play accepts`);
  assert.equal(compileSdk, targetSdk, "compileSdk and targetSdk must agree");

  const audit = fs.readFileSync(path.join(ROOT, "tools", "android-audit.js"), "utf8");
  const floor = Number(audit.match(/const PLAY_MIN_SDK = (\d+);/)[1]);
  assert.equal(floor, 36, "the audit's floor must track the level Play accepts, or the gate means nothing");

  const reporter = await androidAudit();
  assert.deepEqual(reporter.errors, []);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A minimal, valid zip containing empty entries with the given names. */
function makeZip(names) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  names.forEach((name) => {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(Buffer.alloc(0)) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);          // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length;
  });

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);

  return Buffer.concat([localBuf, centralBuf, end]);
}

/** The most common opaque non-white colour in a PNG, as RRGGBB. */
function dominantInk(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === "IDAT") idat.push(data);
    off += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p]; p += 1;
    const line = raw.subarray(p, p + stride); p += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[y * stride + x] = v & 255;
    }
  }

  const counts = new Map();
  for (let i = 0; i < width * height; i += 1) {
    const r = out[i * bpp]; const g = out[i * bpp + 1]; const b = out[i * bpp + 2]; const alpha = out[i * bpp + 3];
    if (alpha < 128) continue;
    if (r > 240 && g > 240 && b > 240) continue;   // the white field
    const key = [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
