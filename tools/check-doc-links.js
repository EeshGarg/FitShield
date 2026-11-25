#!/usr/bin/env node
"use strict";
/**
 * Documentation link check. Every relative Markdown link must resolve.
 *
 * Scans every tracked (or untracked-but-not-ignored) *.md file and verifies
 * each relative link `[x](path)` / `[x](path#anchor)` / `[x](#anchor)`:
 *   - the target file or directory exists (case-exactly, as on GitHub/Linux);
 *   - an #anchor into a Markdown file matches a GitHub-style heading slug
 *     (duplicates get -1, -2 ...) or an explicit <a name|id> anchor.
 *
 * Ignored: http(s)/mailto/other-scheme links, links inside fenced code blocks
 * and inline code. Archived text (docs/history/**, changelog/*.md) is not
 * scanned — history may name paths that no longer exist — but links INTO those
 * files from elsewhere are still checked.
 *
 * Errors only. No dependencies; developer-only, never bundled.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Reporter, runCli } = require("./lib/report");

const ROOT = path.join(__dirname, "..");
const ALWAYS_SKIP = /(^|\/)(graphify-out|node_modules|dist|\.git)\//;
const ARCHIVE = /^(docs\/history\/|changelog\/[^/]+\.md$)/;

/** GitHub-style heading slug (without duplicate suffix). */
function slugify(heading) {
  return heading
    .trim()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> their text
    .replace(/<[^>]+>/g, "") // inline html
    .replace(/[`*~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "")
    .replace(/ /g, "-");
}

/** Lines of `text` with fenced code blocks blanked (line count preserved). */
function stripFences(text) {
  let fence = null;
  return text.split(/\r?\n/).map((line) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        fence = null;
      }
      return "";
    }
    if (m) {
      fence = m[1];
      return "";
    }
    return line;
  });
}

/** Blank out inline code spans, keeping length so columns stay meaningful. */
function stripInlineCode(line) {
  return line.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, (s) => " ".repeat(s.length));
}

/** Anchors defined by a Markdown document: heading slugs and html anchors. */
function collectAnchors(text) {
  const anchors = new Set();
  const seen = new Map();
  for (const raw of stripFences(text)) {
    const h = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) {
      const base = slugify(h[1]);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const a of raw.matchAll(/<a\s[^>]*?(?:name|id)=["']([^"']+)["']/gi)) {
      anchors.add(a[1]);
    }
  }
  return anchors;
}

/** Read a link destination starting right after "](". Returns [dest, endIndex] or null. */
function readDestination(line, start) {
  let i = start;
  while (line[i] === " ") i++;
  if (line[i] === "<") {
    const end = line.indexOf(">", i);
    return end === -1 ? null : [line.slice(i + 1, end), end + 1];
  }
  let depth = 0;
  let j = i;
  for (; j < line.length; j++) {
    const c = line[j];
    if (c === "\\") { j++; continue; }
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (c === " " || c === "\t") break;
  }
  return [line.slice(i, j), j];
}

/** Every link destination in `text` as { line, target } (1-based line). */
function extractLinks(text) {
  const out = [];
  stripFences(text).forEach((raw, idx) => {
    const line = stripInlineCode(raw);
    for (const m of line.matchAll(/\]\(/g)) {
      const dest = readDestination(line, m.index + 2);
      if (dest && dest[0]) out.push({ line: idx + 1, target: dest[0] });
    }
    const def = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (def) out.push({ line: idx + 1, target: def[1].replace(/^<|>$/g, "") });
  });
  return out;
}

/** Does `rel` exist under `root` with exact (case-sensitive) segment names? */
function existsExact(root, rel) {
  let cur = root;
  for (const seg of rel.split("/").filter((s) => s && s !== ".")) {
    let names;
    try { names = fs.readdirSync(cur); } catch (e) { return false; }
    if (!names.includes(seg)) return false;
    cur = path.join(cur, seg);
  }
  return true;
}

/** Markdown files to scan, repo-relative with forward slashes. */
function collectMarkdown(root) {
  let files = null;
  if (fs.existsSync(path.join(root, ".git"))) {
    try {
      const out = execFileSync(
        "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.md"],
        { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
      );
      files = out.split("\0").filter(Boolean);
    } catch (e) { files = null; }
  }
  if (!files) {
    files = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (ent.isDirectory()) {
          if (!ALWAYS_SKIP.test(rel + "/")) walk(full);
        } else if (ent.name.endsWith(".md")) files.push(rel);
      }
    };
    walk(root);
  }
  return [...new Set(files)]
    .filter((f) => !ALWAYS_SKIP.test(f) && !ARCHIVE.test(f) && fs.existsSync(path.join(root, f)))
    .sort();
}

function checkDocLinks(options) {
  const root = (options && options.root) || ROOT;
  const reporter = new Reporter("Documentation links — relative Markdown links resolve");
  const files = collectMarkdown(root);
  const anchorCache = new Map();
  const anchorsOf = (rel) => {
    if (!anchorCache.has(rel)) {
      anchorCache.set(rel, collectAnchors(fs.readFileSync(path.join(root, rel), "utf8")));
    }
    return anchorCache.get(rel);
  };
  let checked = 0;

  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const { line, target } of extractLinks(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      checked++;
      const where = `${file}:${line}`;
      const hashAt = target.indexOf("#");
      const rawPath = (hashAt === -1 ? target : target.slice(0, hashAt)).split("?")[0];
      let anchor = hashAt === -1 ? "" : target.slice(hashAt + 1);
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(rawPath);
        anchor = decodeURIComponent(anchor);
      } catch (e) {
        reporter.fail(`${where} → ${target} (malformed URL encoding)`);
        continue;
      }

      let rel;
      if (!decodedPath) rel = file;
      else if (decodedPath.startsWith("/")) rel = path.posix.normalize(decodedPath.slice(1));
      else rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodedPath));
      rel = rel.replace(/\/$/, "");

      if (rel.startsWith("..") || !existsExact(root, rel)) {
        reporter.fail(`${where} → ${target} (target does not exist)`);
        continue;
      }
      if (anchor && rel.endsWith(".md") && fs.statSync(path.join(root, rel)).isFile()) {
        const set = anchorsOf(rel);
        if (!set.has(anchor.toLowerCase()) && !set.has(anchor)) {
          reporter.fail(`${where} → ${target} (no heading "#${anchor}" in ${rel})`);
        }
      }
    }
  }

  reporter.note(`${checked} relative link(s) checked across ${files.length} Markdown file(s)`);
  return reporter;
}

if (require.main === module) {
  runCli(checkDocLinks);
}

module.exports = checkDocLinks;
module.exports.checkDocLinks = checkDocLinks;
module.exports.slugify = slugify;
module.exports.extractLinks = extractLinks;
module.exports.collectAnchors = collectAnchors;
module.exports.collectMarkdown = collectMarkdown;
