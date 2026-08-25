"use strict";
/**
 * A deliberately small YAML reader — Node built-ins only, no dependencies.
 *
 * FitShield ships zero dependencies and adds none for tooling, CI included, so
 * there is no `js-yaml` here to lean on. This parses the block-style subset
 * that GitHub Actions workflows are written in and REFUSES everything else:
 * flow mappings, flow sequences, anchors, aliases, tags, multi-document
 * streams, and tabs all raise.
 *
 * Refusing is the point. A permissive parser that shrugs at syntax it does not
 * understand would report "parses fine" for a file GitHub then rejects. By
 * erroring on anything outside the subset, a green run means the workflows are
 * written in the plain, checkable form this reader can actually reason about —
 * and check-workflows.js reasons about the resulting structure.
 *
 * What this is NOT: proof that GitHub's own parser accepts the file. Nothing
 * running off a runner can establish that. It is proof that the file is
 * well-formed block YAML carrying the structure a workflow requires.
 */

const BLOCK_STYLES = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

class YamlError extends Error {
  constructor(message, lineIndex) {
    super(`line ${lineIndex + 1}: ${message}`);
    this.line = lineIndex + 1;
  }
}

// YAML opens a comment at '#' only when it starts the line or follows
// whitespace, and never inside a quoted scalar. Anything looser would truncate
// a value such as `--bundle-identifier us.ushacorp.fitshield.nightly#1`.
function stripComment(text) {
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }

  return text;
}

function parseScalar(raw, lineIndex) {
  const text = raw.trim();

  if (text === "") {
    return "";
  }

  if (text[0] === '"') {
    if (text.length < 2 || text[text.length - 1] !== '"') {
      throw new YamlError("unterminated double-quoted scalar", lineIndex);
    }
    return text
      .slice(1, -1)
      .replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }

  if (text[0] === "'") {
    if (text.length < 2 || text[text.length - 1] !== "'") {
      throw new YamlError("unterminated single-quoted scalar", lineIndex);
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }

  if (text[0] === "{" || text[0] === "[") {
    throw new YamlError("flow style is outside this subset — write block style", lineIndex);
  }

  if (text[0] === "&" || text[0] === "*" || text[0] === "!") {
    throw new YamlError("anchors, aliases and tags are outside this subset", lineIndex);
  }

  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);

  return text;
}

// A key is a plain or quoted scalar followed by ':' plus whitespace or EOL.
// Scanning for that separator rather than regex-matching leaves a value like
// `run: echo a: b` intact.
function splitKey(text, lineIndex) {
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ":" && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return { key: parseScalar(text.slice(0, i), lineIndex), rest: text.slice(i + 1).trim() };
    }
  }

  return null;
}

function parse(source, label = "<yaml>") {
  const tab = source.indexOf("\t");

  if (tab !== -1) {
    throw new YamlError(`${label}: tab character — YAML forbids tabs in indentation`, source.slice(0, tab).split("\n").length - 1);
  }

  const lines = source.split(/\r?\n/).map((raw, index) => ({
    index,
    raw,
    indent: raw.search(/\S/)
  }));

  let cursor = 0;

  function skipBlank() {
    while (cursor < lines.length) {
      const line = lines[cursor];

      if (line.indent === -1 || stripComment(line.raw).trim() === "") {
        cursor++;
        continue;
      }

      const trimmed = line.raw.trim();

      if (trimmed === "---" || trimmed === "...") {
        throw new YamlError(`${label}: document markers are outside this subset`, line.index);
      }

      return;
    }
  }

  // Block scalar bodies are copied verbatim: a '#' inside a shell `run:` block
  // is a shell comment, and stripping it would silently rewrite the script.
  function readBlockScalar(style, parentIndent) {
    const collected = [];
    let bodyIndent = null;

    while (cursor < lines.length) {
      const line = lines[cursor];

      if (line.indent === -1) {
        collected.push("");
        cursor++;
        continue;
      }

      if (line.indent <= parentIndent) {
        break;
      }

      if (bodyIndent === null) {
        bodyIndent = line.indent;
      }

      if (line.indent < bodyIndent) {
        break;
      }

      collected.push(line.raw.slice(bodyIndent));
      cursor++;
    }

    while (collected.length && collected[collected.length - 1] === "") {
      collected.pop();
    }

    const body = style[0] === ">" ? collected.join(" ") : collected.join("\n");

    return style.length > 1 && style[1] === "-" ? body : body + "\n";
  }

  function isSequenceLine(line) {
    return /^-(\s|$)/.test(line.raw.slice(line.indent));
  }

  function parseNode(indent) {
    skipBlank();

    if (cursor >= lines.length || lines[cursor].indent < indent) {
      return null;
    }

    return isSequenceLine(lines[cursor]) ? parseSequence(lines[cursor].indent) : parseMapping(lines[cursor].indent);
  }

  function assignPair(target, pair, lineIndex, indent) {
    if (Object.prototype.hasOwnProperty.call(target, pair.key)) {
      throw new YamlError(`${label}: duplicate key "${pair.key}"`, lineIndex);
    }

    if (BLOCK_STYLES.has(pair.rest)) {
      target[pair.key] = readBlockScalar(pair.rest, indent);
      return;
    }

    if (pair.rest === "") {
      target[pair.key] = parseNode(indent + 1);
      return;
    }

    target[pair.key] = parseScalar(pair.rest, lineIndex);
  }

  function parseSequence(indent) {
    const out = [];

    for (;;) {
      skipBlank();

      if (cursor >= lines.length) break;

      const line = lines[cursor];

      if (line.indent !== indent || !isSequenceLine(line)) break;

      const afterDash = line.raw.slice(indent + 1);
      const inline = stripComment(afterDash).trim();
      cursor++;

      if (inline === "") {
        out.push(parseNode(indent + 1));
        continue;
      }

      const pair = splitKey(inline, line.index);

      if (pair) {
        // `- key: value` opens a mapping indented to the column the KEY starts
        // at, not the column of the dash.
        const keyIndent = indent + 1 + (afterDash.length - afterDash.replace(/^\s+/, "").length);
        const map = {};

        assignPair(map, pair, line.index, keyIndent);
        Object.assign(map, parseMapping(keyIndent) || {});
        out.push(map);
        continue;
      }

      out.push(parseScalar(inline, line.index));
    }

    return out;
  }

  function parseMapping(indent) {
    const out = {};
    let any = false;

    for (;;) {
      skipBlank();

      if (cursor >= lines.length) break;

      const line = lines[cursor];

      if (line.indent < indent) break;

      if (line.indent > indent) {
        throw new YamlError(`${label}: unexpected indentation (expected ${indent}, got ${line.indent})`, line.index);
      }

      if (isSequenceLine(line)) break;

      const body = stripComment(line.raw.slice(indent)).trimEnd();
      const pair = splitKey(body, line.index);

      if (!pair) {
        throw new YamlError(`${label}: not a key/value pair: ${JSON.stringify(body)}`, line.index);
      }

      cursor++;
      assignPair(out, pair, line.index, indent);
      any = true;
    }

    return any ? out : null;
  }

  const document = parseNode(0);

  skipBlank();

  if (cursor < lines.length) {
    throw new YamlError(`${label}: trailing content could not be parsed`, lines[cursor].index);
  }

  return document;
}

module.exports = { parse, YamlError };
