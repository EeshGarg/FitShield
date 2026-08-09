"use strict";
/**
 * What actually gets uploaded to the stores: the ZIP.
 *
 * Everything else in the suite stops one step short of the artifact.
 * tools/extension-audit.js proves build.js's FILES/DIRS lists are internally
 * consistent; tools/verify-unpacked.js builds a STAGE DIRECTORY and runs the
 * engine out of it. Neither one ever opens the zip. So every property that is
 * only true of the archive — its path separators, its entry list, its per-engine
 * manifest, whether two builds of the same source agree byte for byte — was
 * unverified, and the archive is the only thing a reviewer at Google or Mozilla
 * ever sees.
 *
 * These tests build both engine packages into a temp directory, zip them with
 * the real writer, and then read the archives back through a minimal
 * central-directory parser (no dependencies — this project ships none, test
 * harnesses included) and assert against the bytes.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const build = require("../build.js");

const ROOT = path.join(__dirname, "..");
const manifestBase = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));

// ---------------------------------------------------------------------------
// Minimal ZIP reader — walks the central directory, the same structure a store's
// unpacker reads. Deliberately independent of build.js's writer: a reader that
// shared the writer's code could not catch the writer being wrong.
// ---------------------------------------------------------------------------
function readZip(file) {
  const buf = fs.readFileSync(file);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, `${path.basename(file)} has no end-of-central-directory record`);

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, "corrupt central directory header");
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const localHeader = buf.readUInt32LE(offset + 42);

    const localNameLen = buf.readUInt16LE(localHeader + 26);
    const localExtraLen = buf.readUInt16LE(localHeader + 28);
    const start = localHeader + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    entries.push({ name, method, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// Build one engine's package into a temp dir and zip it. Uses the real staging
// and manifest-derivation code paths, so a change to either is covered here.
function packageFor(engine, tmpRoot) {
  const stage = path.join(tmpRoot, engine);
  build.copyInto(stage);

  const manifest = engine === "firefox" ? build.firefoxManifest(manifestBase) : build.chromeManifest(manifestBase);
  fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const zip = path.join(tmpRoot, `${engine}.zip`);
  build.zipDir(stage, zip);
  return { stage, zip, entries: readZip(zip) };
}

let tmpRoot;
let chrome;
let firefox;

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fitshield-pkg-"));
  chrome = packageFor("chrome", tmpRoot);
  firefox = packageFor("firefox", tmpRoot);
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Nothing in the package that must not ship
// ---------------------------------------------------------------------------

// Each pattern is a category of thing that has no business in a store upload.
// Named individually so a failure says WHICH kind of file leaked.
const FORBIDDEN = [
  ["developer directories", /(^|\/)(tools|test|tests|node_modules|\.git|\.claude|scratchpad|changelog|android|docs|FS Engine)\//i],
  ["markdown / documentation", /\.md$/i],
  ["source maps", /\.map$/i],
  ["editor and OS junk", /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|.*\.swp|.*~)$/i],
  ["dotfiles", /(^|\/)\.[^/]+$/],
  ["archives", /\.(zip|tar|gz|7z)$/i],
  ["test fixtures", /(^|\/)(fixtures?|__mocks__|__snapshots__)\//i],
  ["Android-only datasets", /^data\/(android|generated)\//]
];

for (const engine of ["chrome", "firefox"]) {
  test(`${engine} package contains nothing that should not ship`, () => {
    const names = (engine === "chrome" ? chrome : firefox).entries.map((e) => e.name);

    for (const [label, pattern] of FORBIDDEN) {
      assert.deepEqual(names.filter((n) => pattern.test(n)), [], `${label} leaked into the ${engine} package`);
    }
  });

  test(`${engine} package uses forward-slash paths with manifest.json at the root`, () => {
    const names = (engine === "chrome" ? chrome : firefox).entries.map((e) => e.name);

    // Windows' Compress-Archive stores backslashes, which breaks extension
    // resource loading and AMO validation. This is why build.js has its own
    // zip writer at all, so the property is worth asserting on the bytes.
    assert.deepEqual(names.filter((n) => n.includes("\\")), [], "backslash separators in archive paths");
    assert.deepEqual(names.filter((n) => n.startsWith("/") || n.includes("..")), [], "absolute or traversing paths");
    assert.ok(names.includes("manifest.json"), "manifest.json must be at the archive root");
    assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], "duplicate archive entries");
  });

  test(`${engine} package contains every file its manifest and pages reference`, () => {
    const pkg = engine === "chrome" ? chrome : firefox;
    const names = new Set(pkg.entries.map((e) => e.name));
    const manifest = JSON.parse(pkg.entries.find((e) => e.name === "manifest.json").data.toString("utf8"));

    const refs = new Set();
    JSON.stringify(manifest).replace(/"([A-Za-z0-9_\-/.]+\.(?:js|html|json|png|css))"/g, (m, ref) => {
      refs.add(ref);
      return m;
    });
    assert.ok(refs.size > 0, "expected the manifest to name some files");
    for (const ref of refs) {
      assert.ok(names.has(ref), `manifest names ${ref}, which is not in the ${engine} package`);
    }

    // Same-origin assets of every packaged page, read out of the archive.
    for (const page of pkg.entries.filter((e) => e.name.endsWith(".html"))) {
      const html = page.data.toString("utf8");
      for (const tag of html.match(/<(?:script|link|img)\b[^>]*>/g) || []) {
        const ref = /\s(?:src|href)="([^"]+)"/.exec(tag);
        if (ref && !/^(https?:|data:|#|mailto:|chrome-extension:)/.test(ref[1])) {
          const target = ref[1].replace(/^\.\//, "");
          assert.ok(names.has(target), `${page.name} loads ${target}, which is not in the ${engine} package`);
        }
      }
    }

    // The default locale must be readable, or every __MSG_ name renders raw.
    const localeFile = `_locales/${manifest.default_locale}/messages.json`;
    assert.ok(names.has(localeFile), `default_locale ${manifest.default_locale} has no messages.json`);
    assert.doesNotThrow(
      () => JSON.parse(pkg.entries.find((e) => e.name === localeFile).data.toString("utf8")),
      "packaged default locale must be valid JSON"
    );
  });
}

// ---------------------------------------------------------------------------
// Per-engine manifest contract, asserted on the PACKAGED bytes
// ---------------------------------------------------------------------------

test("the Chrome package carries no Firefox-only keys and no background.scripts", () => {
  const manifest = JSON.parse(chrome.entries.find((e) => e.name === "manifest.json").data.toString("utf8"));

  // Chromium emits "Unrecognized manifest key 'browser_specific_settings'" and
  // "'background.scripts' requires manifest version of 2 or lower." — both are
  // visible to a store reviewer loading the package.
  assert.equal(manifest.browser_specific_settings, undefined, "gecko keys must be stripped for Chrome");
  assert.equal(manifest.background.scripts, undefined, "background.scripts is MV2-only on Chromium");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.manifest_version, 3);
});

test("the Firefox package carries background.scripts in load order plus its gecko keys", () => {
  const manifest = JSON.parse(firefox.entries.find((e) => e.name === "manifest.json").data.toString("utf8"));

  assert.ok(manifest.browser_specific_settings, "AMO needs browser_specific_settings");
  assert.ok(manifest.browser_specific_settings.gecko.id, "AMO needs a gecko id");

  // Order matters: background.js references both globals, so the engine bundle
  // and the shared decision layer must be evaluated before it.
  assert.deepEqual(manifest.background.scripts, ["blocklist.js", "fitshield-core.js", "background.js"]);
  assert.equal(manifest.background.service_worker, "background.js");
});

test("both packages request exactly the three approved permissions", () => {
  for (const [engine, pkg] of [["chrome", chrome], ["firefox", firefox]]) {
    const manifest = JSON.parse(pkg.entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
    assert.deepEqual(
      [...(manifest.permissions || [])].sort(),
      ["alarms", "declarativeNetRequest", "storage"],
      `${engine} package must request exactly the approved permissions`
    );
  }
});

test("the packaged version agrees with package.json and the changelog", () => {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const changelog = JSON.parse(fs.readFileSync(path.join(ROOT, "changelog.json"), "utf8"));
  const latest = changelog.entries[0].version;

  for (const [engine, pkg] of [["chrome", chrome], ["firefox", firefox]]) {
    const manifest = JSON.parse(pkg.entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
    assert.equal(manifest.version, latest, `${engine} manifest version must match the newest changelog entry`);
    // package.json carries a semver patch field the manifest does not.
    assert.ok(
      pkgVersion === manifest.version || pkgVersion.startsWith(`${manifest.version}.`),
      `package.json ${pkgVersion} does not correspond to manifest ${manifest.version}`
    );
  }
});

// ---------------------------------------------------------------------------
// Reproducibility
// ---------------------------------------------------------------------------

test("zipping the same stage twice produces byte-identical archives", () => {
  // Regression guard. The writer used to stamp `new Date()` into every entry, so
  // two builds seconds apart differed in 232 bytes over identical files — one
  // per local header and one per central-directory header. Nobody can verify a
  // published artifact against its source if rebuilding it never reproduces it.
  const a = path.join(tmpRoot, "repro-a.zip");
  const b = path.join(tmpRoot, "repro-b.zip");

  build.zipDir(chrome.stage, a);
  build.zipDir(chrome.stage, b);

  assert.deepEqual(fs.readFileSync(a), fs.readFileSync(b), "two zips of one stage must be byte-identical");
});

test("archive timestamps are fixed, and SOURCE_DATE_EPOCH overrides them", () => {
  const previous = process.env.SOURCE_DATE_EPOCH;

  try {
    delete process.env.SOURCE_DATE_EPOCH;
    assert.equal(build.archiveDate().getTime(), build.DOS_EPOCH_MS, "default must be the fixed DOS epoch");

    // Encoding must be timezone-independent, or the same source produces
    // different bytes on two machines.
    assert.deepEqual(build.dosDateTime(new Date(build.DOS_EPOCH_MS)), { time: 0, day: 0x21 });

    process.env.SOURCE_DATE_EPOCH = String(Date.UTC(2020, 5, 15, 12, 30, 0) / 1000);
    assert.equal(build.archiveDate().getUTCFullYear(), 2020);
    assert.equal(build.archiveDate().getUTCMonth(), 5);

    // Anything MS-DOS cannot represent falls back rather than wrapping into a
    // nonsense date that would still differ run to run.
    process.env.SOURCE_DATE_EPOCH = "0"; // 1970, before the DOS epoch
    assert.equal(build.archiveDate().getTime(), build.DOS_EPOCH_MS);

    process.env.SOURCE_DATE_EPOCH = "not-a-number";
    assert.equal(build.archiveDate().getTime(), build.DOS_EPOCH_MS);
  } finally {
    if (previous === undefined) {
      delete process.env.SOURCE_DATE_EPOCH;
    } else {
      process.env.SOURCE_DATE_EPOCH = previous;
    }
  }
});

test("archive entries are ordered by codepoint, not by locale", () => {
  // localeCompare depends on the machine's default locale, so two developers
  // could lay identical files out in different orders and get different bytes.
  const names = chrome.entries.map((e) => e.name);
  assert.deepEqual(names, [...names].sort(), "entries must be in plain codepoint order");
});

// ---------------------------------------------------------------------------
// The staged-package closure check must cover every page, not just one
// ---------------------------------------------------------------------------

test("dropping any page's script from the package fails the build", () => {
  // verifyStage used to read warning.html and nothing else, while its comment
  // claimed it proved "the page's dependency graph is closed". settings.html
  // alone loads six scripts warning.html never touches, so removing one of them
  // from FILES produced a dead options page and a green build.
  //
  // One victim per page, each chosen because ONLY that page loads it.
  const victims = {
    "warning.html": "warning.js",
    "settings.html": "preferences.js",
    "popup.html": "popup.js",
    "welcome.html": "welcome.js",
    "whats-new.html": "whats-new.js",
    "diagnostics.html": "diagnostics.js"
  };

  for (const [page, script] of Object.entries(victims)) {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "fitshield-closure-"));
    try {
      build.copyInto(stage);
      assert.ok(
        fs.readFileSync(path.join(stage, page), "utf8").includes(`"${script}"`),
        `${page} is expected to load ${script}; update this test if the page changed`
      );

      fs.rmSync(path.join(stage, script));
      assert.throws(
        () => build.verifyStage(stage),
        (error) => error.message.includes(page) && error.message.includes(script),
        `removing ${script} must fail the build and name ${page}`
      );
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// dist/ hygiene
// ---------------------------------------------------------------------------

test("a build sweeps previous versions' zips out of dist/ and keeps the current ones", () => {
  // Every past release's zips used to accumulate in dist/ forever, so "upload
  // the zip in dist/" had several answers, some of them already published.
  const dist = path.join(tmpRoot, "dist-probe");
  fs.mkdirSync(dist, { recursive: true });

  const stale = ["FitShield-0.53-chrome.zip", "FitShield-0.53-firefox.zip", "FitShield-0.54-nightly-safari.zip"];
  const current = ["FitShield-0.55-chrome.zip", "FitShield-0.55-firefox.zip", "FitShield-0.55-nightly-safari.zip"];
  const untouched = ["fitshield-rules.json", "BUILD.txt", "FitShield-0.55-debug.apk"];

  for (const name of [...stale, ...current, ...untouched]) {
    fs.writeFileSync(path.join(dist, name), "x");
  }

  // removeStaleBrowserZips reads module-level DIST, so exercise the predicate it
  // is built from against the same inputs.
  const removed = [...stale, ...current, ...untouched].filter(
    (name) => build.BROWSER_ZIP.test(name) && !current.includes(name)
  );

  assert.deepEqual(removed.sort(), [...stale].sort(), "only other versions' browser zips may be swept");
  for (const name of untouched) {
    assert.ok(!build.BROWSER_ZIP.test(name), `${name} belongs to the Android pipeline and must never be swept`);
  }
});
