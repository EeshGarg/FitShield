"use strict";
/**
 * Accessibility contracts for the shipped pages.
 *
 * These are DATA-DRIVEN on purpose: every assertion reads the real stylesheet,
 * the real markup, or the real palette out of fitshield-core.js and recomputes
 * the answer. Nothing is a snapshot of a hex value, so the tests keep working
 * when the design moves and still fail when the guarantee breaks.
 *
 * What is pinned here, and the defect each one exists for:
 *
 *   1. CONTRAST, in BOTH themes. FitShield ships two palettes, and the pages
 *      that follow the stored one (block page, welcome, what's-new) get it as
 *      inline custom properties with no `.theme-light` class to key a rule off.
 *      Light used to be simply unimplemented on those pages: "Show another" and
 *      "Never mind" rendered at 1.21:1, the repeat-friction explanation at
 *      1.30:1, and the accent-coloured readouts (the pause timer, the pass
 *      duration, the most-blocked counts) at 3.2-3.4:1. Every text/background
 *      pair below is composited from the live variables and must clear 4.5:1
 *      for body text, 3:1 for large text and non-text indicators.
 *   2. Every switch has an accessible NAME. The popup had four consecutive
 *      nameless checkboxes, one of which is the master kill switch, and the
 *      settings blocklist built one per site.
 *   3. Country/category pills say WHAT they block, and expose state through
 *      aria-pressed rather than a colour class.
 *   4. One heading convention: a card's title is h2, everything nested in it is
 *      h3. Two cards used to disagree, so the outline was wrong either way.
 *   5. The block page's 44px tap target is real. Its own comment claimed every
 *      interactive element used it while three controls opted out, the smallest
 *      being a ~28x36px "Skip".
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const core = require("../extension/fitshield-core.js");

const read = (file) => fs.readFileSync(path.join(EXT, file), "utf8");

// ---------------------------------------------------------------------------
// Colour: sRGB compositing and WCAG 2.x contrast
// ---------------------------------------------------------------------------

const NAMED = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1] };

function parseColor(value) {
  const text = String(value).trim().toLowerCase();

  if (NAMED[text]) {
    const [r, g, b, a] = NAMED[text];
    return { r, g, b, a };
  }

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((d) => d + d).join("");
    }
    const int = (at) => parseInt(digits.slice(at, at + 2), 16);
    return { r: int(0), g: int(2), b: int(4), a: digits.length === 8 ? int(6) / 255 : 1 };
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  throw new Error(`cannot parse colour: ${value}`);
}

// Split on `sep` at paren depth 0 — `color-mix(in srgb, a, b)` nests.
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let buf = "";

  for (const ch of text) {
    if (ch === "(") { depth += 1; }
    if (ch === ")") { depth -= 1; }
    if (ch === sep && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

// CSS color-mix() in sRGB is a premultiplied mix, which is what makes mixing
// against `transparent` produce "this colour at N% alpha" rather than a wash of
// black. The pages rely on that, so the test has to model it the same way.
function mixColors(a, b, weightA) {
  const wa = weightA;
  const wb = 1 - weightA;
  const alpha = a.a * wa + b.a * wb;

  if (alpha === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const channel = (key) => (a[key] * a.a * wa + b[key] * b.a * wb) / alpha;
  return { r: channel("r"), g: channel("g"), b: channel("b"), a: alpha };
}

// Paint `fg` over `bg` (source-over).
function over(fg, bg) {
  const alpha = fg.a + bg.a * (1 - fg.a);

  if (alpha === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const channel = (key) => (fg[key] * fg.a + bg[key] * bg.a * (1 - fg.a)) / alpha;
  return { r: channel("r"), g: channel("g"), b: channel("b"), a: alpha };
}

/** Resolve a CSS colour expression against a map of custom properties. */
function resolve(expression, vars, seen = new Set()) {
  const text = String(expression).trim();

  const varCall = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]+))?\)$/.exec(text);
  if (varCall) {
    const [, name, fallback] = varCall;
    assert.ok(!seen.has(name), `circular custom property ${name}`);

    if (name in vars) {
      return resolve(vars[name], vars, new Set([...seen, name]));
    }
    assert.ok(fallback, `${name} is used but never defined`);
    return resolve(fallback, vars, seen);
  }

  const mixCall = /^color-mix\(([\s\S]+)\)$/.exec(text);
  if (mixCall) {
    const args = splitTop(mixCall[1], ",");
    assert.equal(args[0], "in srgb", `only "in srgb" mixes are modelled, got: ${args[0]}`);

    const parseOperand = (operand) => {
      const pct = /\s([\d.]+)%$/.exec(operand);
      return {
        color: resolve(pct ? operand.slice(0, pct.index) : operand, vars, seen),
        weight: pct ? Number(pct[1]) / 100 : null
      };
    };

    const first = parseOperand(args[1]);
    const second = parseOperand(args[2]);
    const weightA = first.weight !== null ? first.weight : (second.weight !== null ? 1 - second.weight : 0.5);
    return mixColors(first.color, second.color, weightA);
  }

  return parseColor(text);
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return Math.round(ratio * 100) / 100;
}

// ---------------------------------------------------------------------------
// CSS: enough of a parser to read declarations out of the page's <style> block
// ---------------------------------------------------------------------------

function declarations(body) {
  const out = {};

  splitTop(body, ";").forEach((entry) => {
    const at = entry.indexOf(":");
    if (at === -1) { return; }
    out[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
  });

  return out;
}

/** Flatten a stylesheet to [{ prelude, decls }], descending into @media. */
function parseRules(css) {
  const out = [];
  let prelude = "";

  for (let i = 0; i < css.length; i += 1) {
    if (css[i] !== "{") {
      prelude += css[i];
      continue;
    }

    let depth = 1;
    let j = i + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") { depth += 1; }
      if (css[j] === "}") { depth -= 1; }
      j += 1;
    }

    const body = css.slice(i + 1, j - 1);
    const selector = prelude.trim();

    if (selector.startsWith("@")) {
      if (/^@(media|supports|layer)/.test(selector)) {
        out.push(...parseRules(body));
      }
    } else if (selector) {
      out.push({ prelude: selector, decls: declarations(body) });
    }

    prelude = "";
    i = j - 1;
  }

  return out;
}

function stylesheet(file) {
  const html = read(file);
  const block = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(block, `${file} has no <style> block`);
  return parseRules(block[1].replace(/\/\*[\s\S]*?\*\//g, " "));
}

/** The winning value of `prop` for the exact selector text, in source order. */
function declared(rules, selector, prop) {
  let value = null;

  rules.forEach((rule) => {
    if (!splitTop(rule.prelude, ",").includes(selector)) { return; }
    if (prop in rule.decls) { value = rule.decls[prop]; }
  });

  return value;
}

function required(rules, selector, prop, file) {
  const value = declared(rules, selector, prop);
  assert.ok(value, `${file}: \`${selector}\` declares no ${prop}`);
  return value;
}

/**
 * The custom properties in effect on a page for one theme.
 *
 * The pages write the palette onto the root element as an INLINE style, so a
 * preset key always beats the stylesheet's :root default — exactly the cascade
 * the browser applies. Everything else (the derived --surface / --accent-text /
 * tint tokens) comes from the stylesheet itself, so this test measures the
 * design rather than a copy of it.
 */
function variablesFor(rules, theme, extra = {}) {
  const vars = {};

  rules.forEach((rule) => {
    if (!splitTop(rule.prelude, ",").includes(":root")) { return; }
    Object.entries(rule.decls).forEach(([prop, value]) => {
      if (prop.startsWith("--")) { vars[prop] = value; }
    });
  });

  Object.entries(theme).forEach(([key, value]) => { vars[`--${key}`] = value; });
  Object.entries(extra).forEach(([key, value]) => { vars[key] = value; });
  return vars;
}

const THEMES = core.THEME_MODE_PRESETS;

test("the two shipped palettes are the ones these tests measure", () => {
  assert.deepEqual(Object.keys(THEMES).sort(), ["dark", "light"]);
  ["bg", "panel", "border", "text", "muted", "accent"].forEach((key) => {
    Object.entries(THEMES).forEach(([name, preset]) => {
      assert.ok(preset[key], `the ${name} preset has no ${key}`);
    });
  });
});

// ---------------------------------------------------------------------------
// 1. Contrast
// ---------------------------------------------------------------------------

// Layers are painted bottom-first, so each entry reads as the real stacking
// context: page background, then panel, then whatever tint the element adds.
// `min` is 4.5 for body text and 3 where WCAG allows it (>=18.66px bold, and
// non-text indicators such as a focus ring).
const CONTRAST_CASES = [
  // --- block page: the two controls that were invisible in Light -----------
  {
    page: "warning.html",
    what: '"Never mind" / "Show another" label',
    fg: [".secondary", "color"],
    layers: ["var(--bg)", "var(--panel)", [".secondary", "background"]],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "repeat-friction explanation",
    fg: [".repeat-note", "color"],
    layers: ["var(--bg)", "var(--panel)", [".repeat-note", "background"]],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "why-this-alternative line",
    fg: [".alt-why", "color"],
    layers: ["var(--bg)", "var(--panel)"],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "eyebrow pill",
    fg: [".eyebrow", "color"],
    layers: ["var(--bg)", "var(--panel)", [".eyebrow", "background"]],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "selected recipe filter",
    fg: ['.filters button[aria-pressed="true"]', "color"],
    layers: ["var(--bg)", "var(--panel)", ['.filters button[aria-pressed="true"]', "background"]],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "chosen-an-alternative note",
    fg: [".chosen-note", "color"],
    layers: ["var(--bg)", "var(--panel)", [".chosen-note", "background"]],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "preview banner",
    fg: [".preview-banner", "color"],
    layers: ["var(--bg)", [".preview-banner", "background"]],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "About FitShield link",
    fg: [".learn-more a", "color"],
    layers: ["var(--bg)", "var(--panel)"],
    min: 4.5
  },
  {
    page: "warning.html",
    what: '"Go back" primary label',
    fg: [".primary", "color"],
    layers: ["var(--bg)", "var(--panel)", [".primary", "background"]],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "body copy",
    fg: ["p", "color"],
    layers: ["var(--bg)", "var(--panel)"],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "countdown number",
    fg: ["body", "color"],
    layers: ["var(--bg)", "var(--panel)"],
    min: 4.5
  },
  {
    page: "warning.html",
    what: "keyboard focus ring",
    fg: [":focus-visible", "outline"],
    layers: ["var(--bg)", "var(--panel)"],
    min: 3,
    pick: (value) => value.split(/\s+solid\s+/)[1]
  },

  // --- popup ---------------------------------------------------------------
  {
    page: "popup.html",
    what: "timer / pass duration value chip",
    fg: [".value-chip", "color"],
    layers: ["var(--bg)", "var(--panel)", "var(--panel-soft)", [".value-chip", "background"]],
    min: 4.5
  },
  {
    page: "popup.html",
    what: "status sentence",
    fg: [".status", "color"],
    layers: ["var(--bg)", "var(--panel)", [".status", "background"]],
    min: 4.5
  },
  {
    page: "popup.html",
    what: "secondary button label",
    fg: [".button.secondary", "color"],
    layers: ["var(--bg)", "var(--panel)", [".button.secondary", "background"]],
    min: 4.5,
    lightOnly: { ".button.secondary": "html.theme-light .button.secondary" }
  },

  // --- settings ------------------------------------------------------------
  {
    page: "settings.html",
    what: "timer / pass duration value chip",
    fg: [".value-chip", "color"],
    layers: ["var(--bg)", "var(--panel)", "var(--panel-soft)", [".value-chip", "background"]],
    min: 4.5
  },
  {
    page: "settings.html",
    what: "most-blocked count",
    fg: [".mb-count", "color"],
    layers: ["var(--bg)", "var(--panel)", "var(--panel-soft)"],
    min: 4.5
  },
  {
    page: "settings.html",
    what: "protection-status ON value (22.4px bold)",
    fg: [".stat-value.on", "color"],
    layers: ["var(--bg)", "var(--panel)", "var(--panel-soft)"],
    min: 3
  },
  {
    page: "settings.html",
    what: "quick-access chip OFF label",
    fg: [".mb-chip-toggle.off", "color"],
    layers: ["var(--bg)", "var(--panel)", "var(--panel-soft)", [".mb-chip-toggle.off", "background"]],
    min: 4.5,
    lightOnly: { ".mb-chip-toggle.off": "html.theme-light .mb-chip-toggle.off" }
  },
  {
    page: "settings.html",
    what: "quick-access chip ON label",
    fg: [".mb-chip-toggle.on", "color"],
    layers: ["var(--bg)", "var(--panel)", "var(--panel-soft)", [".mb-chip-toggle.on", "background"]],
    min: 4.5
  },
  {
    page: "settings.html",
    what: "country/category pill, blocking",
    fg: [".mb-pill.on", "color"],
    layers: ["var(--bg)", "var(--panel)", [".mb-pill.on", "background"]],
    min: 4.5
  },
  {
    page: "settings.html",
    what: "country/category pill, not blocking",
    fg: [".mb-pill.off", "color"],
    layers: ["var(--bg)", "var(--panel)", [".mb-pill.off", "background"]],
    min: 4.5,
    lightOnly: { ".mb-pill.off": "html.theme-light .mb-pill.off" }
  },
  {
    page: "settings.html",
    what: "keyboard focus ring",
    fg: ["button:focus-visible", "outline"],
    layers: ["var(--bg)", "var(--panel)"],
    min: 3,
    pick: (value) => value.split(/\s+solid\s+/)[1]
  },

  // --- onboarding + what's new (same stored palette, same exposure) --------
  {
    page: "welcome.html",
    what: "secondary/Back button label",
    fg: ["button.btn.secondary", "color"],
    layers: ["var(--bg)", "var(--panel)", ["button.btn.secondary", "background"]],
    min: 4.5
  },
  {
    page: "welcome.html",
    what: "selected theme option",
    fg: [".theme-options button.active", "color"],
    layers: ["var(--bg)", "var(--panel)", [".theme-options button", "background"]],
    min: 4.5
  },
  {
    page: "welcome.html",
    what: "eyebrow pill",
    fg: [".eyebrow", "color"],
    layers: ["var(--bg)", "var(--panel)", [".eyebrow", "background"]],
    min: 4.5
  },
  {
    page: "whats-new.html",
    what: "release badge",
    fg: [".release-badge", "color"],
    layers: ["var(--bg)", "var(--panel)", [".release-badge", "background"]],
    min: 4.5
  },
  {
    page: "whats-new.html",
    what: "secondary button label",
    fg: ["button.secondary", "color"],
    layers: ["var(--bg)", "var(--panel)", ["button.secondary", "background"]],
    min: 4.5
  }
];

// popup.js / settings.js derive the soft panel from the palette's text colour,
// so the test derives it the same way instead of hard-coding a translucent white
// that would only ever be right in dark.
function extraVarsFor(page, preset) {
  if (page !== "popup.html" && page !== "settings.html") { return {}; }
  return {
    "--panel-soft": core.hexToRgba(preset.text, 0.03),
    "--panel-strong": core.hexToRgba(preset.text, 0.045)
  };
}

CONTRAST_CASES.forEach((testCase) => {
  Object.entries(THEMES).forEach(([themeName, preset]) => {
    test(`${testCase.page} (${themeName}): ${testCase.what} clears ${testCase.min}:1`, () => {
      const rules = stylesheet(testCase.page);
      const vars = variablesFor(rules, preset, extraVarsFor(testCase.page, preset));

      // A page with a real .theme-light class may restate a rule for Light. The
      // case says so explicitly rather than the test guessing.
      const selectorFor = (selector) => {
        const swap = testCase.lightOnly && testCase.lightOnly[selector];
        return themeName === "light" && swap && declared(rules, swap, "color") !== null ? swap : selector;
      };
      const layerSelectorFor = (selector) => {
        const swap = testCase.lightOnly && testCase.lightOnly[selector];
        return themeName === "light" && swap && declared(rules, swap, "background") !== null ? swap : selector;
      };

      const rawForeground = required(rules, selectorFor(testCase.fg[0]), testCase.fg[1], testCase.page);
      const foreground = resolve(testCase.pick ? testCase.pick(rawForeground) : rawForeground, vars);

      const background = testCase.layers.reduce((beneath, layer) => {
        const expression = Array.isArray(layer)
          ? required(rules, layerSelectorFor(layer[0]), layer[1], testCase.page)
          : layer;
        const painted = resolve(expression, vars);
        return beneath ? over(painted, beneath) : painted;
      }, null);

      assert.equal(background.a, 1, "the bottom layer must be opaque or the ratio is a guess");

      const ratio = contrast(foreground, background);
      assert.ok(
        ratio >= testCase.min,
        `${testCase.page} ${themeName}: ${testCase.what} is ${ratio}:1, needs ${testCase.min}:1`
      );
    });
  });
});

// The structural half of the same guarantee: a page whose palette can go light
// must not paint TEXT in the raw accent, because the light accent is only
// 3.2-3.4:1 on its own panel. --accent-text exists for that and is what these
// pages use. (diagnostics.html is excluded: nothing ever themes it, so it is
// dark-only by construction.)
const THEME_FOLLOWING_PAGES = ["warning.html", "popup.html", "settings.html", "welcome.html", "whats-new.html"];

THEME_FOLLOWING_PAGES.forEach((page) => {
  test(`${page} never uses the raw accent as a text colour`, () => {
    const offenders = stylesheet(page)
      .filter((rule) => /var\(\s*--accent\s*[,)]/.test(rule.decls.color || ""))
      .map((rule) => rule.prelude);

    assert.deepEqual(
      offenders,
      [],
      `use var(--accent-text) for text: ${offenders.join(", ")}`
    );
  });

  test(`${page} defines --accent-text from the live accent and text`, () => {
    const vars = variablesFor(stylesheet(page), THEMES.dark);
    assert.ok(vars["--accent-text"], `${page} has no --accent-text token`);
    assert.match(vars["--accent-text"], /var\(--accent\)/);
    assert.match(vars["--accent-text"], /var\(--text\)/);
  });
});

// The block page cannot key a rule off the theme (warning.js sets custom
// properties but adds no class), so nothing in it may hard-code a colour that
// only reads on one palette. Literals are allowed only where they sit on a
// fixed backdrop.
test("the block page paints no literal surface colour", () => {
  const allowed = new Set([
    "#102016", // label on the accent button — the accent is a known backdrop
    "rgba(0, 0, 0, 0.16)", "rgba(0, 0, 0, 0.28)", // shadows
    "rgba(255, 196, 120, 0.12)", "rgba(214, 138, 40, 0.42)" // the amber repeat-note wash + border
  ]);

  const offenders = [];
  stylesheet("warning.html").forEach((rule) => {
    if (splitTop(rule.prelude, ",").includes(":root")) { return; }

    ["color", "background", "background-color", "border", "border-color"].forEach((prop) => {
      const value = rule.decls[prop];
      if (!value) { return; }

      const literals = value.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || [];
      literals
        .filter((literal) => !allowed.has(literal))
        .forEach((literal) => offenders.push(`${rule.prelude} { ${prop}: ${literal} }`));
    });
  });

  assert.deepEqual(offenders, [], `hard-coded colours cannot follow the theme:\n  ${offenders.join("\n  ")}`);
});

// ---------------------------------------------------------------------------
// 2. Every switch has an accessible name
// ---------------------------------------------------------------------------

function attributes(tag) {
  const out = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    out[match[1]] = match[2];
  }
  return out;
}

/**
 * Ids of inputs a wrapping <label> already names.
 *
 * `<label class="toggle"><input><span class="slider"></span></label>` is the
 * pattern this whole test exists for: the label wraps the control but its only
 * content is an empty decorative span, so it contributes no name. A label with
 * real text — `<label class="toggle-inline"><input><span>Show this summary</span></label>`
 * — does. The difference is whether anything is left after stripping the tags.
 */
function implicitlyLabelledIds(html) {
  const named = new Set();

  for (const match of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
    const inner = match[1];
    const text = inner.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, " ").trim();
    if (!text) { continue; }

    for (const input of inner.matchAll(/<input\b[^>]*>/g)) {
      const id = attributes(input[0]).id;
      if (id) { named.add(id); }
    }
  }

  return named;
}

["popup.html", "settings.html", "welcome.html"].forEach((page) => {
  test(`${page}: every checkbox has an accessible name`, () => {
    const html = read(page);
    const labelledIds = new Set([...html.matchAll(/\bfor="([^"]+)"/g)].map((m) => m[1]));
    const wrapped = implicitlyLabelledIds(html);
    const nameless = [];

    for (const match of html.matchAll(/<input\b[^>]*>/g)) {
      const attrs = attributes(match[0]);
      if (attrs.type !== "checkbox") { continue; }

      const named = attrs["aria-label"]
        || attrs["aria-labelledby"]
        || attrs["data-i18n-aria-label"]
        || (attrs.id && (labelledIds.has(attrs.id) || wrapped.has(attrs.id)));

      if (!named) { nameless.push(attrs.id || match[0]); }
    }

    assert.deepEqual(nameless, [], `checkboxes with no accessible name: ${nameless.join(", ")}`);
  });

  test(`${page}: every aria-labelledby points at an element that exists`, () => {
    const html = read(page);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const dangling = [];

    for (const match of html.matchAll(/\baria-labelledby="([^"]+)"/g)) {
      match[1].split(/\s+/).filter(Boolean).forEach((token) => {
        if (!ids.has(token)) { dangling.push(token); }
      });
    }

    assert.deepEqual(dangling, [], `aria-labelledby references nothing: ${dangling.join(", ")}`);
  });
});

// A live region that is rewritten on a timer reads the whole sentence out again
// on every tick. The block page documents the rule for its countdown; the popup
// status is on a 1s interval and must therefore not be one.
test("the popup status is not a live region", () => {
  const html = read("popup.html");
  const tag = /<div\b[^>]*id="status"[^>]*>/.exec(html);

  assert.ok(tag, "popup.html has no #status element");
  assert.ok(!/aria-live|role="(status|alert)"/.test(tag[0]), "#status is rewritten every second; it must not announce");
  assert.match(html, /aria-describedby="status"/, "#status should still describe the control it is about");
});

// The failure path of "continue" writes into #hint, which is in a different card
// from the button that was pressed. If it does not announce, nothing does.
test("the block page announces a hint change", () => {
  const html = read("warning.html");
  const tag = /<p\b[^>]*id="hint"[^>]*>/.exec(html);

  assert.ok(tag, "warning.html has no #hint element");
  assert.match(tag[0], /role="status"|aria-live=/, "#hint carries the unlock and pass-failure messages");
});

// ---------------------------------------------------------------------------
// 3. The generated blocklist / country / category controls
// ---------------------------------------------------------------------------

// A stub DOM just deep enough for settings.js to load and for the three row
// builders to run. Only createElement / append / setAttribute are exercised.
function stubElement(tag) {
  const element = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    hidden: false, disabled: false, checked: false, value: "", textContent: "", innerHTML: "",
    addEventListener() {}, removeEventListener() {},
    appendChild(node) { element.children.push(node); return node; },
    append(...nodes) { element.children.push(...nodes); },
    replaceChildren() { element.children = []; },
    insertBefore(node) { element.children.push(node); return node; },
    remove() {},
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return name in element.attributes ? element.attributes[name] : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, click() {}, reset() {},
    get firstChild() { return element.children[0] || null; },
    get childElementCount() { return element.children.length; }
  };
  return element;
}

function settingsContext() {
  const document = {
    documentElement: stubElement("html"),
    body: stubElement("body"),
    head: stubElement("head"),
    currentScript: null, hidden: false, readyState: "complete",
    getElementById: () => stubElement("div"),
    querySelector: () => stubElement("div"),
    querySelectorAll: () => [],
    createElement: (tag) => stubElement(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    createDocumentFragment: () => stubElement("fragment"),
    addEventListener() {}, removeEventListener() {}
  };

  const win = {
    location: { search: "", href: "", hash: "", reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} }),
    history: { back() {}, length: 1 },
    open() {}, addEventListener() {}, removeEventListener() {},
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" })
  };

  const sandbox = {
    chrome: {
      runtime: {
        getURL: (p) => "chrome-extension://test/" + p,
        getManifest: () => ({ version: "0.55" }),
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener() {} },
        lastError: null
      },
      storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} },
        onChanged: { addListener() {} }
      },
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      tabs: { create() {}, query: async () => [], onRemoved: { addListener() {} } }
    },
    document, window: win,
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    navigator: { language: "en-US", clipboard: { writeText: async () => {} } },
    URL, URLSearchParams, Blob: class {},
    Math, Date, JSON, Promise, Number, String, Array, Object, Set, Map, Intl, Error, RegExp,
    isNaN, parseInt, parseFloat,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    matchMedia: win.matchMedia, location: win.location, getComputedStyle: win.getComputedStyle
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const html = read("settings.html");
  const chain = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

  chain.forEach((script) => {
    const file = path.join(EXT, script);
    if (!fs.existsSync(file)) { return; }
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: script });
  });

  return sandbox;
}

function descendants(node, out = []) {
  (node.children || []).forEach((child) => {
    out.push(child);
    descendants(child, out);
  });
  return out;
}

const settings = settingsContext();

test("settings.js exposes the row builders these tests exercise", () => {
  ["createSiteRow", "buildResultRow", "buildQuickChip"].forEach((name) => {
    assert.equal(typeof settings[name], "function", `settings.js no longer declares ${name}`);
  });
});

test("every generated site switch is named by its site", () => {
  const row = settings.createSiteRow({ label: "DoorDash", domain: "doordash.com", enabled: true }, "delivery");
  const input = descendants(row).find((node) => node.tagName === "INPUT");

  assert.ok(input, "createSiteRow built no checkbox");
  assert.equal(
    input.getAttribute("aria-label"),
    "DoorDash",
    "a blocklist hundreds of rows long cannot announce every switch as just \"checkbox\""
  );
});

test("a country/category pill names what it blocks and exposes its state", () => {
  [true, false].forEach((enabled) => {
    const row = settings.buildResultRow("United States", "412 sites", enabled, () => {}, {
      onLabel: "Blocking",
      offLabel: "Block"
    });
    const button = descendants(row).find((node) => node.tagName === "BUTTON");

    assert.ok(button, "buildResultRow built no button");
    const name = button.getAttribute("aria-label");

    assert.ok(name, "the pill has no accessible name");
    assert.match(name, /United States/, `the pill never says what it blocks: "${name}"`);
    // WCAG 2.5.3: the visible word has to be part of the accessible name.
    assert.ok(name.includes(button.textContent), `"${name}" does not contain the visible label "${button.textContent}"`);
    assert.equal(button.getAttribute("aria-pressed"), String(enabled), "state is otherwise carried by a colour class alone");
  });
});

test("a quick-access chip toggle names its country or category", () => {
  [true, false].forEach((enabled) => {
    const chip = settings.buildQuickChip("Japan", enabled, () => {}, () => {});
    const toggle = descendants(chip).find(
      (node) => node.tagName === "BUTTON" && (node.attributes["aria-pressed"] !== undefined)
    );

    assert.ok(toggle, "buildQuickChip built no state toggle");
    assert.match(toggle.getAttribute("aria-label") || "", /Japan/, "On/Off alone never said on or off WHAT");
    assert.equal(toggle.getAttribute("aria-pressed"), String(enabled));
  });
});

// ---------------------------------------------------------------------------
// 3b. Keyboard focus stays visible
// ---------------------------------------------------------------------------

// The regression: a component rule wrote `outline: none` into a selector list it
// shared with :focus-visible, and won on specificity. The caret then vanished at
// the theme picker and the donation link on the page that owns Factory reset.
// A hover rule may clear the outline; a :focus-visible rule may never.
["popup.html", "settings.html", "welcome.html", "whats-new.html", "warning.html"].forEach((page) => {
  test(`${page}: no :focus-visible rule removes its own outline`, () => {
    const offenders = stylesheet(page)
      .filter((rule) => splitTop(rule.prelude, ",").some((selector) => selector.includes(":focus-visible")))
      .filter((rule) => /^(none|0)\b/.test(rule.decls.outline || ""))
      .map((rule) => rule.prelude);

    assert.deepEqual(offenders, [], `these leave a keyboard user with no caret: ${offenders.join(", ")}`);
  });
});

// Any control whose native outline the sheet resets has to get one back.
test("settings.html restores a focus ring on every control it resets", () => {
  const rules = stylesheet("settings.html");

  // `input:focus-visible` really does cover `input[type="text"]`, so compare on
  // the base selector: an attribute-qualified selector is a subset of it.
  const base = (selector) => selector.replace(/\[[^\]]*\]/g, "").trim();

  const reset = new Set();
  rules.forEach((rule) => {
    if (!/^(none|0)\b/.test(rule.decls.outline || "")) { return; }
    splitTop(rule.prelude, ",").forEach((selector) => {
      if (selector.includes(":hover") || selector.includes(":focus")) { return; }
      reset.add(base(selector));
    });
  });

  const restored = new Set();
  rules.forEach((rule) => {
    if (!rule.decls.outline || /^(none|0)\b/.test(rule.decls.outline)) { return; }
    splitTop(rule.prelude, ",").forEach((selector) => {
      if (!selector.includes(":focus-visible")) { return; }
      restored.add(base(selector.replace(":focus-visible", "")));
    });
  });

  assert.ok(reset.size > 0, "expected the sheet to reset some native outlines");

  const orphans = [...reset].filter((selector) => !restored.has(selector));
  assert.deepEqual(
    orphans,
    [],
    `these clear the native outline and never draw one: ${orphans.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// 3c. The popup stays reachable at high zoom
// ---------------------------------------------------------------------------

// Chrome caps a browser-action popup at 800px and renders it at browser zoom, so
// a hard `min-width` floor pushes the right-hand column — master switch, three
// blocklist switches, Settings — off the edge above ~155% zoom. With
// `overflow-x: hidden` there was then no scrollbar to reach it with. Low-vision
// users are exactly the population running that zoom level.
test("the popup shrinks to the viewport and never hides horizontal overflow", () => {
  const rules = stylesheet("popup.html");

  const floor = declared(rules, "body", "min-width");
  assert.equal(floor, null, `the popup must not have a hard width floor (found min-width: ${floor})`);

  const width = required(rules, "body", "width", "popup.html");
  assert.match(width, /min\(\s*var\(--popup-width\)\s*,\s*100vw\s*\)/, "the popup width must yield to the viewport");

  assert.notEqual(
    declared(rules, "body", "overflow-x"),
    "hidden",
    "clipped controls must stay scrollable"
  );

  assert.notEqual(
    declared(rules, ".button", "white-space"),
    "nowrap",
    "a long localized button label must wrap rather than widen the row"
  );

  assert.equal(declared(rules, ".row", "flex-wrap"), "wrap", "rows must reflow instead of overflowing");
});

// ---------------------------------------------------------------------------
// 4. Heading levels
// ---------------------------------------------------------------------------

test("settings.html uses one heading convention: card title h2, everything inside h3", () => {
  const html = read("settings.html");
  const problems = [];

  assert.equal((html.match(/<h1\b/g) || []).length, 1, "the page needs exactly one h1");

  // Sections are siblings in settings.html, never nested, so splitting on the
  // opening tag gives one card per chunk.
  html.split(/<section\b/).slice(1).forEach((chunk) => {
    const openTag = chunk.slice(0, chunk.indexOf(">"));
    const card = chunk.slice(0, chunk.indexOf("</section>"));
    const id = (/id="([^"]+)"/.exec(openTag) || [])[1] || "(unnamed)";
    const levels = [...card.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));

    if (levels.length === 0) { return; }

    // The hero is the page banner and owns the single h1; every other card is a
    // section of the page and starts at h2.
    const isHero = /class="[^"]*\bhero\b/.test(openTag);
    const expectedFirst = isHero ? 1 : 2;

    if (levels[0] !== expectedFirst) {
      problems.push(`${id}: card title is h${levels[0]}, expected h${expectedFirst}`);
    }

    levels.slice(1).forEach((level) => {
      if (level !== expectedFirst + 1) {
        problems.push(`${id}: nested heading is h${level}, expected h${expectedFirst + 1}`);
      }
    });
  });

  assert.deepEqual(problems, [], problems.join("; "));
});

test("settings.html has no heading-shaped div left standing in for a heading", () => {
  const html = read("settings.html");
  const fakes = [...html.matchAll(/<div\b[^>]*class="[^"]*\b(mb-quick-head|most-blocked-title)\b/g)].map((m) => m[1]);

  assert.deepEqual(fakes, [], `these label a group and must be real headings: ${fakes.join(", ")}`);
});

// ---------------------------------------------------------------------------
// 5. Tap targets on the block page
// ---------------------------------------------------------------------------

test("the block page's 44px tap-target comment is true", () => {
  const rules = stylesheet("warning.html");
  const vars = variablesFor(rules, THEMES.dark);
  const tap = vars["--tap"];

  assert.equal(tap, "44px", "the documented minimum target is --tap");

  assert.equal(
    declared(rules, "button", "min-height"),
    "var(--tap)",
    "every button must inherit the documented minimum"
  );

  // Which selectors are interactive is read out of the MARKUP, not listed here,
  // so a new control added to the block page is covered without editing this
  // test — and `body { min-height: 100vh }` is correctly ignored.
  const markup = read("warning.html");
  const interactiveClasses = new Set();
  for (const tag of markup.matchAll(/<(button|summary|a)\b[^>]*>/g)) {
    (attributes(tag[0]).class || "").split(/\s+/).filter(Boolean).forEach((name) => interactiveClasses.add(name));
  }

  const isInteractive = (prelude) => splitTop(prelude, ",").some((selector) =>
    /\b(button|summary)\b/.test(selector)
    || [...interactiveClasses].some((name) => selector.includes(`.${name}`))
  );

  const undersized = [];
  rules.forEach((rule) => {
    const value = rule.decls["min-height"];
    if (!value) { return; }
    if (value === "var(--tap)") { return; }
    if (!isInteractive(rule.prelude)) { return; }

    const px = /^([\d.]+)px$/.exec(value);
    if (!px || Number(px[1]) < parseFloat(tap)) {
      undersized.push(`${rule.prelude} { min-height: ${value} }`);
    }
  });

  assert.deepEqual(
    undersized,
    [],
    `the comment claims every interactive element uses --tap:\n  ${undersized.join("\n  ")}`
  );
});

test('the block page\'s "Skip" is a real target, not a bare word', () => {
  const rules = stylesheet("warning.html");
  const padding = required(rules, ".intent-skip", "padding", "warning.html").split(/\s+/);
  const horizontal = padding.length > 1 ? padding[1] : padding[0];

  assert.ok(
    parseFloat(horizontal) > 0,
    `.intent-skip has ${horizontal} horizontal padding, so its target is only as wide as the word`
  );
  assert.equal(declared(rules, ".intent-skip", "min-height"), null, ".intent-skip must not opt out of --tap");
});
