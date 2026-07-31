"use strict";
/**
 * Apple/Safari feature-parity guard.
 *
 * The Safari (nightly) build must ship the EXACT same feature payload as the
 * Chrome build — same UI (popup, settings, block page, welcome, what's-new,
 * diagnostics), the same generated engine bundle, blocklists, recipes, locales,
 * and icons — with the manifest differing ONLY by the nightly markers. Both are
 * produced by build.copyInto, so this stages each and proves it byte-for-byte,
 * so Safari can never quietly fall behind the browser builds.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const build = require("../build.js");

const EXT_MANIFEST = path.join(__dirname, "..", "extension", "manifest.json");

function walk(dir, base = dir, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else {
      out.set(path.relative(base, full).split(path.sep).join("/"), full);
    }
  }
  return out;
}

test("Apple/Safari payload matches the Chrome payload except the manifest", () => {
  const base = JSON.parse(fs.readFileSync(EXT_MANIFEST, "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-parity-"));
  const chromeDir = path.join(tmp, "chrome");
  const appleDir = path.join(tmp, "apple");

  try {
    build.copyInto(chromeDir);
    fs.writeFileSync(
      path.join(chromeDir, "manifest.json"),
      JSON.stringify(build.chromeManifest(base), null, 2) + "\n"
    );

    build.copyInto(appleDir);
    fs.writeFileSync(
      path.join(appleDir, "manifest.json"),
      JSON.stringify(build.safariManifest(base), null, 2) + "\n"
    );

    const chromeFiles = walk(chromeDir);
    const appleFiles = walk(appleDir);

    assert.deepStrictEqual(
      [...appleFiles.keys()].sort(),
      [...chromeFiles.keys()].sort(),
      "Apple and Chrome must stage the same file set (feature parity)"
    );

    const differing = [];
    for (const [rel, applePath] of appleFiles) {
      if (rel === "manifest.json") {
        continue;
      }
      if (!fs.readFileSync(applePath).equals(fs.readFileSync(chromeFiles.get(rel)))) {
        differing.push(rel);
      }
    }
    assert.deepStrictEqual(differing, [], `Apple payload must be byte-identical to Chrome except manifest.json; differs at: ${differing.join(", ")}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Safari manifest differs from Chrome only by the nightly markers", () => {
  const base = JSON.parse(fs.readFileSync(EXT_MANIFEST, "utf8"));
  const chrome = build.chromeManifest(base);
  const safari = build.safariManifest(base);

  assert.strictEqual(safari.name, build.SAFARI_NIGHTLY_NAME, 'Safari name must be the nightly name');
  assert.strictEqual(safari.version_name, `${base.version}-nightly`, "Safari version_name must be <version>-nightly");

  // Strip the two nightly-only keys; the rest of the manifest must be identical
  // to Chrome's (same permissions, host_permissions, background, WAR, icons, …).
  const chromeRest = { ...chrome };
  delete chromeRest.name;
  const safariRest = { ...safari };
  delete safariRest.name;
  delete safariRest.version_name;

  assert.deepStrictEqual(
    safariRest,
    chromeRest,
    "Safari manifest must equal Chrome's apart from name + version_name"
  );
});
