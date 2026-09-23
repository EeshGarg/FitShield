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
  // A pass that could not be granted is reported here, beside the option that
  // was pressed. Same amber wash as .repeat-note and the same reason for the
  // sentence being --text: it has to survive a white panel.
  {
    page: "warning.html",
    what: "could-not-continue notice",
    fg: [".pass-note", "color"],
    layers: ["var(--bg)", "var(--panel)", [".pass-note", "background"]],
    min: 4.5
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
  // The "FitShield" wordmark is painted BY its gradient — the h1 sets
  // `color: transparent` and clips the background to the glyphs — so every stop
  // in that gradient is body text at 18.56px bold, just under the 18.66px
  // large-text line, and every stop needs 4.5:1. Two of them were fixed colours
  // chosen for the dark panel: raw --accent is 3.39:1 on white and the literal
  // #6fd6c0 was 1.74:1. Because the sheen animates over 13s, the washed-out band
  // travelled through the whole word rather than sitting on two letters.
  ...[1, 2, 3].map((stop) => ({
    page: "popup.html",
    what: `wordmark gradient stop ${stop}`,
    fg: ["h1", "background"],
    layers: ["var(--bg)", "var(--panel)"],
    min: 4.5,
    pick: (value) => {
      const inner = /linear-gradient\(([\s\S]*)\)/.exec(value);
      assert.ok(inner, "the wordmark must still be painted by a gradient");
      // [0] is the angle; the stops follow, each "<colour> <position>".
      const stops = splitTop(inner[1], ",").slice(1);
      assert.ok(stops[stop], `the wordmark gradient has no stop ${stop}`);
      return stops[stop].replace(/\s+[\d.]+%$/, "").trim();
    }
  })),

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
  // `.stat-value.on` / `.off` used to be measured here. Neither was ever applied
  // — buildStatCard's `valueClass` argument had no caller — so the pair was
  // removed along with the argument, and the live variant is measured instead:
  // #estimateValue, the one card that does carry a modifier.
  //
  // Its `color` is `transparent`: like the popup wordmark, the figure is painted
  // BY its gradient, so the ratio lives in the stops. Reading `color` here would
  // have measured nothing at all — which is how three stops chosen against the
  // dark panel (1.79-3.39:1 on white) survived under a passing contrast suite.
  ...[0, 1, 2, 3, 4].map((stop) => ({
    page: "settings.html",
    what: `estimate value gradient stop ${stop} (22.4px bold)`,
    fg: [".stat-value.savings", "background"],
    layers: ["var(--bg)", "var(--panel)", "var(--panel-soft)"],
    min: 3,
    pick: (value) => {
      const inner = /linear-gradient\(([\s\S]*)\)/.exec(value);
      assert.ok(inner, "the estimate value must still be painted by a gradient");
      const stops = splitTop(inner[1], ",").slice(1);
      assert.ok(stops[stop], `the estimate gradient has no stop ${stop}`);
      return stops[stop].replace(/\s+[\d.]+%$/, "").trim();
    }
  })),
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

/**
 * Load settings.html's whole script chain against a stub DOM.
 *
 * `absentIds` are the ids `getElementById` answers `null` for — the way the real
 * browser answers for markup a section no longer contains. Passing a list is how
 * a test proves settings.js survives a control being REMOVED from the page,
 * rather than proving it against a stub that conjures an element for every id
 * ever asked for.
 */
function settingsContext(absentIds) {
  const absent = new Set(absentIds || []);
  const document = {
    documentElement: stubElement("html"),
    body: stubElement("body"),
    head: stubElement("head"),
    currentScript: null, hidden: false, readyState: "complete",
    getElementById: (id) => (absent.has(id) ? null : stubElement("div")),
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

// ---------------------------------------------------------------------------
// 3b. The focus ring survives the CASCADE, not just a grep
// ---------------------------------------------------------------------------
//
// The test that used to live here asked "does some `:focus-visible` rule mention
// this element's base selector anywhere in the sheet?" and answered yes for
// settings.html while a real keyboard walk in Chromium found TWELVE stops that
// matched `:focus-visible` and painted no outline at all — every text, search,
// number and time field on the page, including the custom-URL box, all four
// search boxes and both duration fields.
//
// The reason a presence check cannot see it: `input[type="text"]` and
// `input:focus-visible` have the SAME specificity, (0,1,1). A reset declared
// below the focus rule therefore wins on source order and deletes the ring,
// while both selectors are still present in the file. `select` survived in the
// same declaration block purely because it was written unqualified, (0,0,1), and
// lost to `select:focus-visible`.
//
// So this resolves the cascade instead: for each control the sheet styles, take
// every rule that could match it in its focused state, rank by (specificity,
// source order) exactly as a browser does, and read the winner.

/** CSS specificity (a, b, c) for one compound selector. */
function specificity(selector) {
  let text = ` ${selector} `;
  let a = 0;
  let b = 0;
  let c = 0;

  text = text.replace(/#[\w-]+/g, () => { a += 1; return " "; });
  // Attribute selectors, classes and pseudo-CLASSES all count in column b.
  text = text.replace(/\[[^\]]*\]/g, () => { b += 1; return " "; });
  text = text.replace(/::[\w-]+/g, () => { c += 1; return " "; });
  text = text.replace(/:[\w-]+(\([^)]*\))?/g, () => { b += 1; return " "; });
  text = text.replace(/\.[\w-]+/g, () => { b += 1; return " "; });
  text.split(/[\s>+~]+/).forEach((part) => { if (/^[a-z][\w-]*$/i.test(part)) { c += 1; } });

  return [a, b, c];
}

const specLE = (x, y) => x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] <= y[2];

/**
 * The `outline` a browser would paint on `<tag type=... class=...>` while it
 * matches :focus-visible, given a flat rule list in source order.
 *
 * Only single-compound selectors are considered, which is every rule that
 * matters here; a descendant selector is skipped rather than guessed at.
 */
function winningOutline(rules, { tag, type, classes = [], id = "" }) {
  let winner = null;
  let winnerSpec = [-1, -1, -1];

  rules.forEach((rule) => {
    if (!("outline" in rule.decls)) { return; }

    splitTop(rule.prelude, ",").forEach((raw) => {
      const selector = raw.trim();
      if (/[\s>+~]/.test(selector)) { return; }

      // Peel the compound apart; anything left over means "does not match".
      let rest = selector;
      const take = (pattern) => {
        const found = [];
        rest = rest.replace(pattern, (match) => { found.push(match); return ""; });
        return found;
      };

      const ids = take(/#[\w-]+/g).map((s) => s.slice(1));
      const attrs = take(/\[[^\]]*\]/g);
      const pseudos = take(/:{1,2}[\w-]+(\([^)]*\))?/g);
      const cls = take(/\.[\w-]+/g).map((s) => s.slice(1));
      const element = rest.trim();

      if (element && element !== "*" && element.toLowerCase() !== tag) { return; }
      if (ids.some((value) => value !== id)) { return; }
      if (cls.some((value) => !classes.includes(value))) { return; }

      const attrOk = attrs.every((attr) => {
        const match = /^\[type\s*=\s*"?([\w-]+)"?\]$/.exec(attr);
        return match ? match[1] === type : false;
      });
      if (!attrOk) { return; }

      // The element is focused and focus-visible; nothing else is simulated.
      const stateOk = pseudos.every((p) => p === ":focus" || p === ":focus-visible");
      if (!stateOk) { return; }

      const spec = specificity(selector);
      if (specLE(winnerSpec, spec)) {
        winnerSpec = spec;
        winner = rule.decls.outline;
      }
    });
  });

  return winner;
}

// Every focusable control the shipped pages actually build. `via` names the
// element that is expected to carry the ring when the control itself is
// visually hidden (the switches paint theirs on the adjacent slider).
const FOCUS_CASES = [
  ["settings.html", { tag: "input", type: "text", label: "custom-URL / report / custom-alternative fields" }],
  ["settings.html", { tag: "input", type: "search", label: "blocklist, country, category and language search" }],
  ["settings.html", { tag: "input", type: "number", label: "pause seconds, pass minutes, meal cost" }],
  ["settings.html", { tag: "input", type: "time", label: "schedule window start/end" }],
  ["settings.html", { tag: "select", label: "diet, currency, report type, preview category" }],
  ["settings.html", { tag: "button", label: "every button, including Factory reset" }],
  ["settings.html", { tag: "textarea", label: "report body" }],
  ["settings.html", { tag: "a", label: "the support link" }],
  ["settings.html", { tag: "summary", label: "the advanced-schedule disclosure" }],
  ["popup.html", { tag: "input", type: "number", label: "custom seconds / minutes" }],
  ["popup.html", { tag: "input", type: "search", label: "the site search" }],
  ["popup.html", { tag: "input", type: "time", label: "schedule start/end" }],
  ["popup.html", { tag: "button", label: "Settings and the blocklist buttons" }],
  ["warning.html", { tag: "button", label: "every block-page control" }],
  ["warning.html", { tag: "a", label: "About FitShield" }],
  ["warning.html", { tag: "summary", label: "why was this interrupted" }],
  ["welcome.html", { tag: "select", label: "the language picker" }],
  ["welcome.html", { tag: "button", label: "the onboarding answers" }],
  ["whats-new.html", { tag: "button", label: "open settings / close" }]
];

test("every focusable control wins a visible focus ring in the real cascade", () => {
  const sheets = new Map();
  const offenders = [];

  FOCUS_CASES.forEach(([file, control]) => {
    if (!sheets.has(file)) { sheets.set(file, stylesheet(file)); }

    const outline = winningOutline(sheets.get(file), control);
    const drawn = outline && !/^(none|0(px)?)\b/.test(outline);

    if (!drawn) {
      offenders.push(
        `${file}: <${control.tag}${control.type ? ` type=${control.type}` : ""}> (${control.label}) ` +
        `resolves to outline: ${outline === null ? "<nothing>" : outline}`
      );
    }
  });

  assert.deepEqual(offenders, [], `no visible caret here:\n  ${offenders.join("\n  ")}`);
});

// The bug above was introduced by a reset sitting BELOW the focus rule with the
// same specificity. Nothing stops that being reintroduced except noticing it, so
// this states the rule directly: an `outline` reset may only be scoped to a
// state that is not focus.
test("no page resets an outline on a resting or focused control", () => {
  ["settings.html", "popup.html", "warning.html", "welcome.html", "whats-new.html"].forEach((file) => {
    stylesheet(file).forEach((rule) => {
      if (!/^(none|0(px)?)\b/.test(rule.decls.outline || "")) { return; }

      splitTop(rule.prelude, ",").forEach((selector) => {
        assert.ok(
          /:hover|:active|::/.test(selector),
          `${file}: \`${selector}\` clears the outline outside a hover/active state — ` +
          "it will out-order an equal-specificity :focus-visible rule and delete the caret"
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3c. The popup stays reachable at high zoom
// ---------------------------------------------------------------------------

// Chrome caps a browser-action popup at 800px and renders it at browser zoom, so
// an UNBOUNDED `min-width` floor pushes the right-hand column — master switch,
// three blocklist switches, Settings — off the edge above ~155% zoom. With
// `overflow-x: hidden` there was then no scrollbar to reach it with. Low-vision
// users are exactly the population running that zoom level.
//
// This test used to forbid a floor outright, and 0.57 found the other half of
// that trade: with nothing holding the layout up, a Chromium viewport narrow
// enough (a side panel, a narrow window) collapsed the popup to ~100px. The
// invariant is not "no floor" — it is "a floor low enough that zoom still fits,
// and nothing hidden when it does not".
//
// At 155% zoom the popup still has ~516 CSS px, comfortably above the 420px
// contract, so the case this test was written for never reaches the floor at all.
// The floor itself lives in extension/fitshield-layout.css and is exercised
// against real browsers in test/layout-contract.test.js.
test("the popup shrinks to the viewport and never hides horizontal overflow", () => {
  const rules = stylesheet("popup.html");

  // The page must not reintroduce a floor of its own: one contract, one place.
  const local = declared(rules, "body", "min-width");
  assert.equal(local, null, `the popup declares a page-local width floor (min-width: ${local})`);

  const contract = fs.readFileSync(path.join(EXT, "fitshield-layout.css"), "utf8");
  const floor = /--fs-min-layout-width:\s*(\d+)px/.exec(contract);
  assert.ok(floor, "the shared layout contract no longer declares a floor");

  // Bounded: a floor at or above the popup's own width could never shrink, which
  // is precisely the shape that broke high zoom.
  const defaultWidth = Number(/--popup-width:\s*(\d+)px/.exec(read("popup.html"))[1]);
  assert.ok(
    Number(floor[1]) < defaultWidth,
    `the floor (${floor[1]}px) must be below the popup's default width (${defaultWidth}px) or it cannot yield to zoom`
  );

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

// The block page's only link, and the only thing in its own paragraph. A real
// keyboard/pointer walk in Chromium measured it at 92x17 CSS px on a screen
// otherwise built to 44 — and WCAG 2.2's "inline" exemption from the 24x24
// minimum is for a target inside a sentence, which this is not.
test('the block page\'s "About FitShield" link is a real target', () => {
  const rules = stylesheet("warning.html");

  assert.equal(
    declared(rules, ".learn-more a", "display"),
    "inline-block",
    "an inline box takes no vertical padding, so the link cannot grow past its line box"
  );

  const padding = required(rules, ".learn-more a", "padding", "warning.html").split(/\s+/).map(parseFloat);
  const [vertical, horizontal] = padding.length > 1 ? padding : [padding[0], padding[0]];

  // 0.82rem/1.5 gives a ~17px line box; 24 - 17 leaves 7px to find, so >= 4px a
  // side clears the minimum with room for a font-size change.
  assert.ok(vertical >= 4, `.learn-more a has ${vertical}px vertical padding — the target stays ~17px tall`);
  assert.ok(horizontal >= 4, `.learn-more a has ${horizontal}px horizontal padding`);
});

// ---------------------------------------------------------------------------
// 5b. No rule in a shipped stylesheet may style nothing
// ---------------------------------------------------------------------------
//
// Three blocks were removed because their markup had gone: `.pref-row
// :first-of-type` (every .pref-row is a <div> among earlier <div> siblings, so
// it was never first OF ITS TYPE), `.stat-value.on` / `.off` (buildStatCard's
// `valueClass` argument had no caller), and welcome.html's whole `.toggle` /
// `.slider` / `.explainer` set, copied from Settings for an onboarding step that
// became four `.onboard-choices` buttons instead.
//
// A dead rule is not merely clutter. Each of those encoded an INTENTION — no
// hairline above the first row, a green/grey state for a live readout, a switch
// — and the reader of the file cannot tell a rule that is waiting for its markup
// from one whose markup silently stopped satisfying it. These tests state the
// facts that made each deletion safe, so if the markup comes back, so does the
// question.

test("every class a page's stylesheet styles is a class the page can actually produce", () => {
  // Classes applied by script as well as by markup, gathered from the page's own
  // JS: `x.className = "..."`, `classList.add/toggle("...")`.
  const PAGES = [
    "welcome.html", "popup.html", "warning.html", "whats-new.html",
    "settings.html", "diagnostics.html"
  ];

  // Comments first. An apostrophe inside prose ("the popup's timer") reads as
  // the start of a string literal and swallows everything up to the next one,
  // which silently hid four whole families of class name on the first attempt at
  // this scan. `://` is spared so a URL inside a real string survives.
  const stripComments = (js) => js
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  PAGES.forEach((page) => {
    const html = read(page);
    const produced = new Set();

    for (const match of html.matchAll(/\sclass="([^"]*)"/g)) {
      match[1].split(/\s+/).filter(Boolean).forEach((name) => produced.add(name));
    }

    // Class names are assembled at runtime in every shape JS allows —
    // `"chip strong"`, a ternary inside a template, a concatenation — so rather
    // than parsing the expression, every string literal in the page's OWN
    // scripts is taken apart and each token treated as a name it might apply.
    // Deliberately generous: this is a tripwire for a block whose markup has
    // gone, not a proof that one selector is reachable.
    //
    // The script list is read from the page rather than written here, so a page
    // that gains a builder (settings.html loads preferences.js as well as
    // settings.js) is covered without editing this test.
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((src) => fs.existsSync(path.join(EXT, src)));

    assert.ok(scripts.length > 0, `${page} declares no local scripts — the scan is reading the wrong thing`);

    scripts.forEach((script) => {
      const js = stripComments(read(script));
      for (const match of js.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        // Split on anything a class name cannot contain, so a nested ternary
        // inside a template (`mb-pill ${on ? "on" : "off"}`) yields both arms.
        match[2].split(/[^\w-]+/).filter(Boolean).forEach((name) => produced.add(name));
      }
    });

    const orphans = new Set();
    stylesheet(page).forEach((rule) => {
      for (const match of rule.prelude.matchAll(/\.([\w-]+)/g)) {
        if (!produced.has(match[1])) { orphans.add(match[1]); }
      }
    });

    assert.deepEqual(
      [...orphans].sort(),
      [],
      `${page} styles classes nothing in the page or its script produces: ${[...orphans].join(", ")}`
    );
  });
});

test("settings.html has no .pref-row that would want its top border suppressed", () => {
  // The deleted `.pref-row:first-of-type { border-top: 0 }` existed to stop a
  // hairline appearing directly under a card title. Every .pref-row follows real
  // content, so the border always separates two things — which is the fact that
  // made removing the rule safe rather than a silent visual regression.
  const html = read("settings.html").replace(/<!--[\s\S]*?-->/g, "");
  const body = html.slice(html.indexOf("<body>"));
  const VOID = new Set(["input", "img", "br", "hr", "meta", "link", "source", "area", "col"]);

  const stack = [];
  const firstInParent = [];

  for (const match of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, rawTag, attrs, selfClosing] = match;
    const tag = rawTag.toLowerCase();

    if (closing) { stack.pop(); continue; }

    const parent = stack[stack.length - 1];
    const classAttr = /class="([^"]*)"/.exec(attrs);
    const classes = classAttr ? classAttr[1].split(/\s+/) : [];

    if (parent && classes.includes("pref-row") && parent.childCount === 0) {
      firstInParent.push(`<${parent.tag}> starts with a .pref-row`);
    }

    if (parent) { parent.childCount += 1; }
    if (VOID.has(tag) || selfClosing) { continue; }

    stack.push({ tag, childCount: 0 });
  }

  assert.ok(
    (body.match(/class="pref-row"/g) || []).length >= 5,
    "the scan found almost no .pref-row — it is no longer reading the markup"
  );
  assert.deepEqual(
    firstInParent,
    [],
    "a .pref-row is now the first thing in its container, so it draws a hairline under the heading with nothing above it"
  );
});

test("buildStatCard builds one kind of value, and the sheet styles one kind", () => {
  const source = read("settings.js");
  const declaration = /function buildStatCard\(([^)]*)\)/.exec(source);

  assert.ok(declaration, "settings.js no longer declares buildStatCard");
  assert.deepEqual(
    declaration[1].split(",").map((s) => s.trim()).filter(Boolean),
    ["value", "label"],
    "a third variant argument is back; every caller must pass it or the variant styles nothing"
  );

  const variants = stylesheet("settings.html")
    .flatMap((rule) => splitTop(rule.prelude, ","))
    .filter((selector) => /^\.stat-value\.[\w-]+$/.test(selector.trim()))
    .map((selector) => selector.trim().replace(".stat-value.", ""));

  const markup = read("settings.html");
  variants.forEach((variant) => {
    assert.match(
      markup,
      new RegExp(`class="stat-value ${variant}"`),
      `.stat-value.${variant} is styled but no element in settings.html carries it`
    );
  });
});

// ---------------------------------------------------------------------------
// 6. One setting, one editable control
// ---------------------------------------------------------------------------

// Settings asked for the blocking schedule TWICE: a start/end pair plus a
// checkbox in "Blocking Options", and the preset list with a full multi-window
// editor in "When FitShield is on". They wrote the same storage, so whichever
// the user reached second silently overwrote the first, and the simple pair
// could not represent what the editor could — so it disabled itself and showed
// a note explaining that it was inert. A control the page has to apologise for
// is not a control.
//
// The rule this pins is structural rather than "id X is gone": every schedule
// affordance in the page must live in the section that owns the schedule.
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, " ");

/** [sectionId, [affordances]] for every <section> that can EDIT the schedule. */
function scheduleAffordancesBySection(html) {
  const out = [];

  stripComments(html).split(/<section\b/).slice(1).forEach((chunk) => {
    const openTag = chunk.slice(0, chunk.indexOf(">"));
    const id = (/id="([^"]+)"/.exec(openTag) || [])[1] || "(unnamed)";
    // Skip the section's own tag: `<section id="schedule">` would otherwise
    // count itself and make the assertion circular.
    const card = chunk.slice(chunk.indexOf(">") + 1, chunk.indexOf("</section>"));

    const found = [];
    for (const tag of card.matchAll(/<([a-z]+)\b[^>]*>/gi)) {
      const attrs = attributes(tag[0]);
      const name = attrs.id || attrs.for || "";
      if (/^schedule/i.test(name) || attrs.type === "time") {
        found.push(name || tag[0]);
      }
    }

    if (found.length > 0) { out.push([id, found]); }
  });

  return out;
}

test("settings.html asks for the blocking schedule in exactly one section", () => {
  const found = scheduleAffordancesBySection(read("settings.html"));

  assert.deepEqual(
    found.map(([id]) => id),
    ["schedule"],
    `two editable controls for one setting overwrite each other: ${
      found.map(([id, names]) => `${id} -> ${names.join(", ")}`).join(" | ")
    }`
  );

  // And that one section still really is the editor, not an empty shell.
  const [, names] = found[0];
  ["schedulePresets", "scheduleAdvanced", "scheduleWindows"].forEach((id) => {
    assert.ok(names.includes(id), `the surviving schedule editor lost #${id}`);
  });
});

// The popup keeps its own simple pair on purpose: it is the at-a-glance surface,
// one click from the toolbar, not a second editor for the settings page. Pinning
// it stops the de-duplication above from being "fixed" by deleting the wrong one.
test("the popup keeps its at-a-glance schedule pair", () => {
  const html = read("popup.html");

  ["scheduleEnabled", "scheduleStart", "scheduleEnd"].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`), `the popup lost #${id}`);
  });
});

// ---------------------------------------------------------------------------
// 6b. …and it only offers that pair for a schedule it can honestly hold
// ---------------------------------------------------------------------------

/**
 * Two time inputs can express exactly one window across all seven days. That is
 * a property of the PROJECTION, not of the times (`FitShieldCore.scheduleToLegacy`),
 * and both halves of it were wrong in the popup:
 *
 *   - `scheduleSimple` arrived from the worker, was destructured, and was then
 *     dropped, so the module-level guard stayed at its `true` default. Over a
 *     "Workday lunch" schedule the pair rendered ENABLED, took an edit, and the
 *     worker correctly refused the lossy rebuild — a control that accepts input
 *     and discards it, which is worse than a disabled one.
 *   - the "every day" suffix was appended when `scheduleStart === scheduleEnd`,
 *     which is the opposite of what equal times mean (one window covering the
 *     whole 24 hours). A plain seven-day 18:00–23:00 window — the only kind the
 *     pair can hold — was the one case that never got the suffix.
 *
 * These drive the real popup rather than reading its source, because both
 * defects were invisible to a grep: the names were all present and spelled
 * correctly.
 */
function popupContext(blockState, store = { uiLanguage: "en" }) {
  const ids = [...read("popup.html").matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const byId = new Map();
  const body = stubElement("body");

  ids.forEach((id) => {
    const element = stubElement("div");
    element.id = id;
    body.appendChild(element);
    byId.set(id, element);
  });

  const card = stubElement("main");
  const document = {
    documentElement: stubElement("html"),
    body,
    head: stubElement("head"),
    currentScript: null, hidden: false, readyState: "complete",
    getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
    querySelector: (selector) => (selector === ".card" ? card : null),
    querySelectorAll: () => [],
    createElement: (tag) => stubElement(tag),
    createTextNode: (value) => ({ textContent: String(value) }),
    createDocumentFragment: () => stubElement("fragment"),
    addEventListener() {}, removeEventListener() {}
  };

  const chrome = {
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "0.55" }),
      sendMessage: async (message) =>
        (message.type === "getBlockState" ? { ok: true, ...blockState } : { ok: true }),
      onMessage: { addListener() {} },
      lastError: null
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
            if (key in store) { out[key] = store[key]; }
          });
          return out;
        },
        set: async (object) => { Object.assign(store, object); }
      },
      onChanged: { addListener() {} }
    },
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    tabs: { create() {}, query: async () => [] }
  };

  const win = {
    location: { search: "", href: "", hash: "" },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    open() {}, history: { back() {}, length: 1 },
    addEventListener() {}, removeEventListener() {},
    setInterval: () => 0, clearInterval() {}
  };

  const sandbox = {
    chrome, document, window: win,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse(fs.readFileSync(path.join(EXT, String(url).replace("chrome-extension://test/", "")), "utf8"))
    }),
    console: { log() {}, warn() {}, error() {}, info() {} },
    URL, URLSearchParams, Intl,
    Math, Date, JSON, Promise, Number, String, Array, Object, Set, Map, Error, RegExp, Boolean,
    isNaN, parseInt, parseFloat,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    matchMedia: win.matchMedia, location: win.location
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  ["browser-shim.js", "i18n.js", "fitshield-core.js", "popup.js"].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), context, { filename: file });
  });

  return { sandbox, byId };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

// getBlockState is `{ ok: true, ...readSettings(stored) }`, so the fixtures are
// PROJECTED by the same code the worker runs rather than hand-written — a test
// that invented `scheduleSimple` itself would prove nothing about the schedule.
const blockStateFor = (schedule) => ({
  ...core.readSettings({ schedule }),
  scheduleActive: true,
  passes: [],
  bypassUntil: 0,
  recap: null
});

const SEVEN_DAY_EVENING = core.normalizeSchedule(
  core.scheduleFromLegacy({ scheduleEnabled: true, scheduleStart: "18:00", scheduleEnd: "23:00" })
);

// The "Workday lunch" preset: one window, five days. One time pair cannot say
// "not at the weekend".
const WORKDAY_LUNCH = core.normalizeSchedule({
  mode: "windows",
  windows: [{ days: [1, 2, 3, 4, 5], start: "11:30", end: "14:00" }],
  until: null
});

test("the popup's schedule fixtures really are the two cases the guard is about", () => {
  assert.equal(core.readSettings({ schedule: SEVEN_DAY_EVENING }).scheduleSimple, true);
  assert.equal(core.readSettings({ schedule: WORKDAY_LUNCH }).scheduleSimple, false);
});

test("the popup's time pair is read-only over a schedule it cannot express", async () => {
  const { byId } = popupContext(blockStateFor(WORKDAY_LUNCH));
  await settle();

  ["scheduleStart", "scheduleEnd", "scheduleEnabled"].forEach((id) => {
    assert.equal(
      byId.get(id).disabled,
      true,
      `#${id} still takes an edit that the worker will refuse — the control is dead, not disabled`
    );
  });
});

test("the popup does not present placeholder times as the user's schedule", async () => {
  const { byId } = popupContext(blockStateFor(WORKDAY_LUNCH));
  await settle();

  const summary = byId.get("scheduleSummary").textContent;

  assert.doesNotMatch(
    summary,
    /\d{1,2}:\d{2}/,
    `the two times shown are defaults, not this user's hours: "${summary}"`
  );
  assert.match(summary, /window/i, "so it says what IS stored instead");
});

test('the popup says "every day" for the only schedule shape its pair can hold', async () => {
  const { byId } = popupContext(blockStateFor(SEVEN_DAY_EVENING));
  await settle();

  const summary = byId.get("scheduleSummary").textContent;

  assert.match(summary, /\d{1,2}:\d{2}/, "a window it CAN express is stated as times");
  assert.match(
    summary,
    /every day/i,
    `the flat pair only ever means one window across all seven days: "${summary}"`
  );
  assert.equal(byId.get("scheduleStart").disabled, false, "and the pair stays editable for it");
});

test("with no schedule set the popup explains what the switch would do", async () => {
  const { byId } = popupContext(blockStateFor({ mode: "always", windows: [], until: null }));
  await settle();

  const summary = byId.get("scheduleSummary").textContent;

  assert.doesNotMatch(summary, /every day/i, "there is no window to repeat");
  assert.match(summary, /schedule/i);
});

// settings.js reads five ids the page no longer has. Every one of those reads is
// conditional; this proves it by answering `null` for exactly those ids, which
// is what the real browser does now. Before the guards went in, the top-level
// `scheduleEnabledInput.addEventListener(...)` threw here and took the entire
// settings page down with it — no theme, no blocklist, no reset.
test("settings.js loads with the simple schedule controls absent from the page", () => {
  const absent = ["scheduleEnabled", "scheduleStart", "scheduleEnd", "scheduleSummary", "simpleScheduleNote"];

  absent.forEach((id) => {
    assert.ok(
      !new RegExp(`id="${id}"`).test(read("settings.html")),
      `#${id} is back in settings.html; this test no longer describes the page`
    );
  });

  assert.doesNotThrow(
    () => settingsContext(absent),
    "settings.js dereferences a schedule control the page does not contain"
  );
});

// ---------------------------------------------------------------------------
// 7. Onboarding: secondary copy is spaced, not welded to the button above it
// ---------------------------------------------------------------------------

// Step 6 stacks button / paragraph / button / notice / paragraph. The only
// `.desc` rule in the sheet was scoped `.choice-row .desc`, a container the
// onboarding stopped building, so those paragraphs matched nothing but
// `.step p { margin: 0 0 16px }` — no TOP margin — and each one sat flush
// against the button above it.
test("welcome.html: step-6 secondary copy has real spacing above it", () => {
  const html = read("welcome.html");
  const rules = stylesheet("welcome.html");

  const step6 = /<section class="step" data-step="6">([\s\S]*?)<\/section>/.exec(html);
  assert.ok(step6, "welcome.html has no step 6");
  assert.match(
    stripComments(step6[1]),
    /<\/button>\s*<p class="desc"/,
    "the case this guards is a .desc paragraph directly after a button"
  );

  // The fallback it would otherwise inherit still has no top margin, so the
  // spacing genuinely has to come from a .desc rule.
  const stepP = required(rules, ".step p", "margin", "welcome.html").split(/\s+/);
  assert.equal(stepP[0], "0", "assumption changed: .step p now supplies its own top margin");

  // Any selector that reaches these paragraphs will do — `.step .desc`,
  // `.step p.desc`, a bare `.desc`. What is pinned is the resulting gap, not the
  // spelling of the rule that produces it.
  const gaps = rules
    .filter((rule) => splitTop(rule.prelude, ",").some((selector) => {
      const parts = selector.trim().split(/\s+/);
      return /\.desc$/.test(parts[parts.length - 1]) && parts.every((p) => !/\.choice-row/.test(p));
    }))
    .map((rule) => rule.decls["margin-top"])
    .filter(Boolean);

  assert.ok(
    gaps.length > 0,
    "no rule that reaches the step-6 `.desc` paragraphs sets a top margin, so they sit flush against the button above"
  );
  assert.ok(
    gaps.every((value) => parseFloat(value) > 0),
    `a .desc rule sets margin-top: ${gaps.join(" / ")} — zero is the flush layout this test exists for`
  );
});

// The bug underneath the bug: a live element styled by a rule scoped to a
// container that appears nowhere. Checked for `.desc` specifically, because that
// is the class it happened to, and a `.choice-row .desc` regression would
// otherwise read as a harmless tidy-up.
test("welcome.html: no .desc rule is scoped to a container the page never builds", () => {
  // Both sources, because a container can legitimately be added by script.
  const html = read("welcome.html") + read("welcome.js");
  const orphans = [];

  stylesheet("welcome.html").forEach((rule) => {
    splitTop(rule.prelude, ",").forEach((selector) => {
      const parts = selector.trim().split(/\s+/);
      if (!/\.desc$/.test(parts[parts.length - 1])) { return; }

      parts.slice(0, -1).forEach((ancestor) => {
        (ancestor.match(/\.([\w-]+)/g) || []).forEach((token) => {
          if (!html.includes(`class="${token.slice(1)}`) && !html.includes(`${token.slice(1)}"`)) {
            orphans.push(`${selector} (no .${token.slice(1)} in the markup)`);
          }
        });
      });
    });
  });

  assert.deepEqual(orphans, [], `these style nothing: ${orphans.join(", ")}`);
});

// ---------------------------------------------------------------------------
// 8. Diagnostics is a user-facing page, not a developer console
// ---------------------------------------------------------------------------

// Settings' "Check FitShield is working" opens diagnostics.html, so every locale
// reaches it. It shipped with zero data-i18n attributes and no i18n runtime, so
// ~90 locales got an English page. These two tests pin both halves: the strings
// are tagged, AND the module that resolves the tags is actually loaded — either
// one alone does nothing.

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);

/** Text runs in `html` whose innermost element carries no data-i18n. */
function untranslatedText(html) {
  const stripped = stripComments(html)
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "");

  const stack = [];
  const loose = [];

  for (const token of stripped.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>|[^<]+/gi)) {
    const text = token[0];

    if (text.startsWith("</")) { stack.pop(); continue; }

    if (text.startsWith("<")) {
      const name = token[1].toLowerCase();
      if (!VOID_ELEMENTS.has(name) && !text.endsWith("/>")) {
        stack.push({ name, attrs: attributes(text) });
      }
      continue;
    }

    // `…` and other punctuation-only placeholders are filled in by script.
    if (!/[A-Za-z]/.test(text)) { continue; }

    const owner = stack[stack.length - 1];
    if (!owner || !owner.attrs["data-i18n"]) {
      loose.push(`<${owner ? owner.name : "?"}>${text.trim().slice(0, 48)}`);
    }
  }

  return loose;
}

/** Localizable attributes present without their data-i18n-* twin. */
function untranslatedAttributes(html) {
  const pairs = [["placeholder", "data-i18n-placeholder"], ["aria-label", "data-i18n-aria-label"], ["alt", "data-i18n-alt"]];
  const loose = [];

  for (const tag of stripComments(html).matchAll(/<[a-z][\w-]*\b[^>]*>/gi)) {
    const attrs = attributes(tag[0]);
    pairs.forEach(([plain, tagged]) => {
      if (attrs[plain] && !attrs[tagged]) {
        loose.push(`${plain}="${attrs[plain]}"`);
      }
    });
  }

  return loose;
}

test("diagnostics.html leaves no static string untranslated", () => {
  const html = read("diagnostics.html");

  assert.deepEqual(
    untranslatedText(html),
    [],
    "these render in English in every locale; tag them with data-i18n"
  );
  assert.deepEqual(
    untranslatedAttributes(html),
    [],
    "a placeholder or aria-label is read aloud too; it needs its data-i18n-* twin"
  );
});

// The tagging above is inert on its own: nothing rewrites a data-i18n element
// unless i18n.js is on the page, and i18n.js needs the shim that publishes
// `fitshield.*` underneath it. The page shipped with neither.
test("diagnostics.html loads the i18n runtime its attributes depend on", () => {
  const scripts = [...read("diagnostics.html").matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

  assert.ok(scripts.includes("i18n.js"), "diagnostics.html tags strings but never loads i18n.js");
  assert.ok(
    scripts.indexOf("browser-shim.js") !== -1 && scripts.indexOf("browser-shim.js") < scripts.indexOf("i18n.js"),
    "i18n.js reads `fitshield.*` at load; browser-shim.js has to define it first"
  );
});

// The page reports asynchronously — a worker that never answers, and the result
// of "Check" — with focus left where it was. Without a live region a screen
// reader user presses Check and is told nothing at all.
test("diagnostics.html announces the answers it writes in place", () => {
  const html = read("diagnostics.html");

  ["banner", "test-result"].forEach((id) => {
    const tag = new RegExp(`<[a-z]+\\b[^>]*id="${id}"[^>]*>`, "i").exec(html);
    assert.ok(tag, `diagnostics.html has no #${id}`);
    assert.match(tag[0], /role="status"|aria-live=/, `#${id} is written after load with no focus move`);
  });
});

// ---------------------------------------------------------------------------
// 9. Inline i18n fallbacks say what English says
// ---------------------------------------------------------------------------

/**
 * `<h1 data-i18n="warningTitle">Take a Breath</h1>` has TWO copies of one
 * sentence, and the markup copy is not decoration:
 *
 *   - the browser paints it first and i18n.js replaces it a tick later, so a
 *     disagreement is a visible flash of retired copy on every load;
 *   - `t()` falls back to English for any key a locale has not translated, but
 *     it can only fall back to the message FILE. If the runtime never starts —
 *     a script error, a locale fetch that fails — the inline text is what the
 *     user is left reading, permanently;
 *   - it is what a reviewer reads when deciding whether the page says the right
 *     thing, so a stale one launders retired wording back into review.
 *
 * Nothing else in the suite could see it: the key still resolves perfectly, so
 * every locale check passes while the page ships two different sentences. One
 * terminology pass left 34 of these behind at once, four of which had survived
 * two releases ("Export settings" on a button whose label is "Export data &
 * settings"), plus three `aria-label` twins that only a screen reader would have
 * caught ("Language" for a control English calls "Display language").
 *
 * Data-driven over the shipped markup and the shipped English on purpose: this
 * is the durable half of that cleanup. Nothing here lists a page or a key, so a
 * newly tagged element is covered the moment it is written, and the next
 * wording change fails here instead of shipping.
 */

const EN_MESSAGES = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "en", "messages.json"), "utf8"));

const PAGES = fs.readdirSync(EXT).filter((name) => name.endsWith(".html")).sort();

const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decodeEntities = (text) => text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity]);

// `data-i18n-*` attribute -> the plain attribute i18n.js overwrites with it.
// Mirrors the TARGETS table in extension/i18n.js.
const ATTRIBUTE_TWINS = [
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-title", "title"],
  ["data-i18n-aria-label", "aria-label"],
  ["data-i18n-alt", "alt"]
];

/**
 * Elements whose ENTIRE content is one run of text, paired with their key.
 *
 * `[^<>]` spans newlines, so an open tag broken across lines is still read;
 * anything richer than a single text run (nested markup, a script-filled
 * placeholder) is skipped, because comparing those is a judgement about markup
 * rather than about wording.
 */
function inlineFallbacks(html) {
  const pattern = /<([a-z0-9]+)\b[^<>]*\bdata-i18n="([A-Za-z0-9_]+)"[^<>]*>([^<>]*)<\/\1\s*>/gi;
  const out = [];

  for (const match of stripComments(html).matchAll(pattern)) {
    const text = decodeEntities(match[3]).trim();
    if (text) { out.push({ key: match[2], text }); }
  }

  return out;
}

// Guards the scanner itself. Every assertion below is "no offenders", which a
// regex that silently stopped matching would also satisfy.
test("the inline-fallback scan actually reaches the shipped markup", () => {
  const counted = PAGES.map((page) => [page, inlineFallbacks(read(page)).length]);
  const silent = counted.filter(([page, found]) => found === 0 && read(page).includes('data-i18n="'));

  assert.deepEqual(silent.map(([page]) => page), [], "the scanner matched nothing on a page that tags strings");
  assert.ok(
    counted.reduce((sum, [, found]) => sum + found, 0) > 150,
    `only ${counted.map(([page, found]) => `${page}:${found}`).join(", ")} — the scan has stopped seeing the pages`
  );
});

// `t()` returns the KEY when nothing resolves, so a typo'd or renamed key does
// not degrade to English — it puts "alternativeFavoriteLabel" on screen.
test("every data-i18n key in the markup exists in English", () => {
  const dangling = [];

  PAGES.forEach((page) => {
    for (const tag of stripComments(read(page)).matchAll(/<[a-z][\w-]*\b[^>]*>/gi)) {
      const attrs = attributes(tag[0]);
      Object.keys(attrs)
        .filter((name) => name === "data-i18n" || name.startsWith("data-i18n-"))
        .forEach((name) => {
          if (!EN_MESSAGES[attrs[name]]) { dangling.push(`${page}: ${name}="${attrs[name]}"`); }
        });
    }
  });

  assert.deepEqual(dangling, [], `these render the key name at the user:\n  ${dangling.join("\n  ")}`);
});

test("every inline data-i18n fallback is byte-identical to its English message", () => {
  const drift = [];

  PAGES.forEach((page) => {
    inlineFallbacks(read(page)).forEach(({ key, text }) => {
      const english = EN_MESSAGES[key] && EN_MESSAGES[key].message;
      if (english !== undefined && text !== english) {
        drift.push(`${page}: "${key}" markup says ${JSON.stringify(text)}, English says ${JSON.stringify(english)}`);
      }
    });
  });

  assert.deepEqual(drift, [], `the page paints this before i18n.js runs:\n  ${drift.join("\n  ")}`);
});

// The tab title is the one string on a page that no reviewer looks at, which is
// how the onboarding and what's-new tabs shipped hardcoded English titles while
// every heading beneath them was tagged. The product name is the only text that
// is the same in every language, so it is the only allowed exception.
test("every page tags its document title for translation", () => {
  const untagged = PAGES
    .map((page) => [page, /<title\b([^>]*)>([\s\S]*?)<\/title>/i.exec(read(page))])
    .filter(([, match]) => match && !/\bdata-i18n=/.test(match[1]) && match[2].trim() !== "FitShield")
    .map(([page, match]) => `${page}: <title>${match[2].trim()}</title>`);

  assert.deepEqual(untagged, [], `these show English in every locale: ${untagged.join(", ")}`);
});

// `title="Favourite"` sat on the block page's star for as long as the button
// existed: no key, no translation, and British spelling in a product whose copy
// is American. Nothing on screen changes when one of these is wrong, so only a
// scan finds them.
test("every localizable attribute in the shipped markup has its data-i18n twin", () => {
  const loose = PAGES
    .flatMap((page) => untranslatedAttributes(read(page)).map((entry) => `${page}: ${entry}`));

  assert.deepEqual(loose, [], `hardcoded English, read aloud or shown on hover: ${loose.join(", ")}`);
});

// The same defect one layer down, and the one nobody sees: a stale `aria-label`
// beside a correct `data-i18n-aria-label` is invisible on screen in every case.
test("every inline i18n attribute fallback matches its English message", () => {
  const drift = [];

  PAGES.forEach((page) => {
    for (const tag of stripComments(read(page)).matchAll(/<[a-z][\w-]*\b[^>]*>/gi)) {
      const attrs = attributes(tag[0]);

      ATTRIBUTE_TWINS.forEach(([tagged, plain]) => {
        if (!attrs[tagged] || attrs[plain] === undefined) { return; }

        const english = EN_MESSAGES[attrs[tagged]] && EN_MESSAGES[attrs[tagged]].message;
        const inline = decodeEntities(attrs[plain]).trim();

        if (english !== undefined && inline !== english) {
          drift.push(`${page}: ${plain} says ${JSON.stringify(inline)}, English says ${JSON.stringify(english)}`);
        }
      });
    }
  });

  assert.deepEqual(drift, [], `read aloud before i18n.js runs:\n  ${drift.join("\n  ")}`);
});
