"use strict";
/**
 * tools/check-doc-links.js — slugger, link extraction, and the real repo.
 * Runs under `node --test`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkDocLinks, slugify, extractLinks, collectAnchors } = require("../tools/check-doc-links");

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doclinks-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

test("slugify follows GitHub heading rules", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("What's new? (v1.0)"), "whats-new-v10");
  assert.equal(slugify("`npm run` — the *tools*"), "npm-run--the-tools");
  assert.equal(slugify("See [the docs](x.md) now"), "see-the-docs-now");
  assert.equal(slugify("snake_case & dash-ed"), "snake_case--dash-ed");
});

test("collectAnchors numbers duplicates and skips fenced headings", () => {
  const set = collectAnchors("# A\n## A\n## A\n```\n# fake\n```\n<a name=\"manual\"></a>\n");
  assert.deepEqual([...set].sort(), ["a", "a-1", "a-2", "manual"]);
});

test("extractLinks ignores code, handles angle brackets, parens and definitions", () => {
  const text = [
    "[a](one.md) and `[b](skip.md)`",
    "```",
    "[c](skip2.md)",
    "```",
    "[d](<with space.md>) ![img](pic.png \"title\")",
    "[e](dir/f(1).md#x)",
    "[ref]: refdoc.md"
  ].join("\n");
  const got = extractLinks(text).map((l) => `${l.line}:${l.target}`);
  assert.deepEqual(got, ["1:one.md", "5:with space.md", "5:pic.png", "6:dir/f(1).md#x", "7:refdoc.md"]);
});

test("checker passes on good links and reports each kind of bad link", () => {
  const good = fixture({
    "README.md": "# Top\n[x](docs/a.md#section) [self](#top) [enc](FS%20Engine/README.md) [sp](<FS Engine/README.md>) [ext](https://x.y/z) [dir](docs)\n",
    "docs/a.md": "## Section\n",
    "FS Engine/README.md": "hi\n"
  });
  const ok = checkDocLinks({ root: good });
  assert.deepEqual(ok.errors, []);

  const bad = fixture({
    "README.md": "[m](missing.md)\n[b](docs/a.md#nope)\n[s](#nowhere)\n[c](Docs/a.md)\n",
    "docs/a.md": "## Section\n",
    "docs/history/old.md": "[gone](nothing.md)\n",
    "changelog/0.1.md": "[gone](nothing.md)\n",
    "other.md": "[into archive](docs/history/old.md) [dead](docs/history/zzz.md)\n"
  });
  const r = checkDocLinks({ root: bad });
  assert.equal(r.errors.length, 5, r.errors.join("\n"));
  assert.ok(r.errors.some((e) => e.startsWith("README.md:1 ")));
  assert.ok(r.errors.some((e) => e.startsWith("README.md:2 ") && /nope/.test(e)));
  assert.ok(r.errors.some((e) => e.startsWith("README.md:3 ")));
  assert.ok(r.errors.some((e) => e.startsWith("README.md:4 ")), "case mismatch must fail");
  assert.ok(r.errors.some((e) => e.startsWith("other.md:1 ") && /zzz/.test(e)));
});

test("every relative link in the repo's Markdown resolves", () => {
  const reporter = checkDocLinks();
  assert.deepEqual(reporter.errors, [], "broken documentation links:\n" + reporter.errors.join("\n"));
});
