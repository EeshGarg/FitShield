/**
 * FitShield ambient background — a living, layered gradient field.
 *
 * Several large, soft color blobs (green / cyan / warm / yellow / neutral base)
 * drift slowly and independently — some horizontally, some vertically, some
 * diagonally, each at its own speed. As you scroll they gain parallax and a
 * little velocity-driven "lift", then ease back to their calm ambient motion
 * when you stop. Each page picks an energy level (lively / block / calm /
 * subtle) via `<script src="ambient.js" data-energy="...">`.
 *
 * Colors are recomputed on every load from HSL bases with small random offsets
 * (hue / saturation / lightness / alpha), so the background "rhymes" with itself
 * but never looks identical twice. Dark and light themes get their own ranges,
 * and a gentle time-of-day bias warms the palette toward evening.
 *
 * Entirely local — reads only the device clock, the page's background color, and
 * the scroll position. No network, no storage, no tracking. Self-contained: it
 * injects its own stylesheet and layers, so a page only needs the <script> tag.
 * Honors prefers-reduced-motion (static randomized gradient, no drift, no
 * parallax). Transform/opacity only; one passive scroll listener on a single
 * requestAnimationFrame loop that idles when nothing is moving.
 */
(function () {
  "use strict";

  if (typeof document === "undefined" || !document.body) {
    return;
  }

  const me = document.currentScript;
  const reduceMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- Per-page energy ---------------------------------------------------
  // amp:   drift amplitude multiplier (scales the keyframe travel)
  // dur:   duration multiplier (higher = slower, calmer)
  // parY:  scroll parallax strength (px of layer shift per px scrolled)
  // boost: how much scroll *velocity* adds on top (the "accelerate" feel)
  // scale: how far the whole field scales up while actively scrolling
  // alpha: opacity multiplier for the whole field
  // blobs: how many color fields are active (base wash is always first)
  const ENERGY = {
    lively: { amp: 1.30, dur: 0.95, parY: 0.10, boost: 1.7, scale: 1.05, alpha: 1.15, blobs: 5 },
    block:  { amp: 1.05, dur: 1.05, parY: 0.07, boost: 1.3, scale: 1.03, alpha: 1.00, blobs: 5 },
    calm:   { amp: 0.78, dur: 1.35, parY: 0.05, boost: 0.8, scale: 1.02, alpha: 0.92, blobs: 4 },
    subtle: { amp: 0.55, dur: 1.55, parY: 0.00, boost: 0.0, scale: 1.00, alpha: 0.82, blobs: 3 }
  };
  function pageEnergy() {
    const tag = (me && me.dataset && me.dataset.energy) || "";
    if (ENERGY[tag]) {
      return { name: tag, ...ENERGY[tag] };
    }
    // Fallback: guess from the filename so the system still works untagged.
    const path = (location.pathname || "").toLowerCase();
    if (path.includes("welcome") || path.includes("whats-new")) return { name: "lively", ...ENERGY.lively };
    if (path.includes("warning")) return { name: "block", ...ENERGY.block };
    if (path.includes("popup")) return { name: "subtle", ...ENERGY.subtle };
    return { name: "calm", ...ENERGY.calm };
  }
  const energy = pageEnergy();

  // ---- Color families (HSL bases + per-load jitter ranges) ---------------
  // FitShield green stays the anchor; the others keep the field varied so it
  // never reads as a single green haze. Ranges are deliberately small so each
  // reload only nudges the color.
  const FAMILIES = {
    neutral: { h: 218, s: 26, l: 58, a: 0.075, r: { h: 14, s: 8, l: 7, a: 0.02 } },
    green:   { h: 146, s: 56, l: 47, a: 0.150, r: { h: 8, s: 8, l: 7, a: 0.03 } },
    cyan:    { h: 190, s: 68, l: 56, a: 0.130, r: { h: 9, s: 8, l: 7, a: 0.03 } },
    warm:    { h: 26,  s: 84, l: 58, a: 0.120, r: { h: 9, s: 8, l: 6, a: 0.03 } },
    yellow:  { h: 47,  s: 86, l: 60, a: 0.110, r: { h: 6, s: 8, l: 6, a: 0.025 } }
  };

  // Layer composition: family, parallax factor (depth), drift keyframe,
  // size range [%], and base position [left%, top%]. The neutral base wash is
  // first (biggest, slowest, least parallax) so it reads as the backdrop.
  const LAYERS = [
    { fam: "neutral", f: 0.16, kf: "fsE", size: [96, 116], pos: [-8, 4],  baseDur: 64 },
    { fam: "green",   f: 0.46, kf: "fsC", size: [74, 90],  pos: [-12, -14], baseDur: 44 },
    { fam: "cyan",    f: 0.82, kf: "fsA", size: [66, 84],  pos: [54, -10], baseDur: 36 },
    { fam: "warm",    f: 1.18, kf: "fsD", size: [60, 78],  pos: [22, 52],  baseDur: 40 },
    { fam: "yellow",  f: 1.52, kf: "fsB", size: [52, 70],  pos: [68, 44],  baseDur: 32 }
  ];

  function periodFor(hour) {
    if (hour >= 5 && hour < 12) return "morning";
    if (hour >= 12 && hour < 17) return "afternoon";
    if (hour >= 17 && hour < 21) return "evening";
    return "night";
  }
  // Gentle daily rhythm: a per-family alpha bias by time of day. Mornings lean
  // cool (cyan/green), evenings/nights lean warm. Stays subtle.
  const PERIOD_BIAS = {
    morning:   { neutral: 1.0, green: 1.05, cyan: 1.15, warm: 0.85, yellow: 0.9 },
    afternoon: { neutral: 1.0, green: 1.0,  cyan: 1.0,  warm: 1.0,  yellow: 1.05 },
    evening:   { neutral: 1.05, green: 0.95, cyan: 0.85, warm: 1.2, yellow: 1.15 },
    night:     { neutral: 1.1, green: 0.95, cyan: 0.9,  warm: 1.05, yellow: 0.8 }
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function jitter(range) { return (Math.random() * 2 - 1) * range; }

  // Detect whether the page is rendering on a light or dark surface so the
  // blobs stay readable either way. Reads the actually-painted background
  // color (works regardless of how FitShield's theme is applied).
  function isLightSurface() {
    const probe = [document.body, document.documentElement];
    for (const el of probe) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg && bg.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const p = m[1].split(",").map((n) => parseFloat(n));
        const a = p.length > 3 ? p[3] : 1;
        if (a > 0.05) {
          const lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
          return lum > 0.5;
        }
      }
    }
    return typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-color-scheme: light)").matches;
  }

  function colorFor(fam, bias, light) {
    const base = FAMILIES[fam];
    const r = base.r;
    const h = Math.round(base.h + jitter(r.h));
    const s = clamp(base.s + jitter(r.s), 18, 96);
    // On light surfaces, darken and slightly desaturate so colored fields read
    // against a bright page without washing out the text above them.
    const lAdj = light ? -16 : 2;
    const l = clamp(base.l + lAdj + jitter(r.l), 22, 82);
    // Light surfaces also need a touch less alpha to preserve contrast.
    const aMul = (light ? 0.85 : 1) * energy.alpha * (bias || 1);
    const a = clamp(base.a * aMul + jitter(r.a), 0.03, 0.26);
    return `hsla(${h}, ${s}%, ${l}%, ${a.toFixed(3)})`;
  }

  // ---- Stylesheet (injected once) ----------------------------------------
  // Ambient drift lives on the .blob (its own transform). Scroll parallax lives
  // on the .layer (a separate transform). The scroll "lift" scale lives on the
  // container. Three nested elements => three independent transforms that never
  // fight. Keyframes scale their travel by --amp so energy controls amplitude.
  if (!document.getElementById("fs-ambient-style")) {
    const A = "calc(var(--amp,1) * ";
    const style = document.createElement("style");
    style.id = "fs-ambient-style";
    style.textContent = [
      ".fs-ambient-bg{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;",
      "transform:scale(var(--amb-cscale,1));transition:transform .8s cubic-bezier(.22,.61,.36,1);}",
      ".fs-ambient-layer{position:absolute;inset:-30%;",
      "transform:translate3d(calc(var(--amb-sx,0px)*var(--f,0)),calc(var(--amb-sy,0px)*var(--f,0)),0);",
      "will-change:transform;}",
      ".fs-ambient-blob{position:absolute;border-radius:50%;will-change:transform;}",
      // distinct drift directions ----------------------------------------
      "@keyframes fsA{from{transform:translate3d(" + A + "-7%)," + A + "-1%),0) scale(1);}",
      "to{transform:translate3d(" + A + "8%)," + A + "2%),0) scale(1.12);}}", // horizontal
      "@keyframes fsB{from{transform:translate3d(" + A + "1%)," + A + "7%),0) scale(1.08);}",
      "to{transform:translate3d(" + A + "-2%)," + A + "-8%),0) scale(1);}}", // vertical
      "@keyframes fsC{from{transform:translate3d(" + A + "-5%)," + A + "-4%),0) scale(1);}",
      "to{transform:translate3d(" + A + "6%)," + A + "7%),0) scale(1.14);}}", // diagonal ↘
      "@keyframes fsD{from{transform:translate3d(" + A + "5%)," + A + "5%),0) scale(1.1);}",
      "to{transform:translate3d(" + A + "-6%)," + A + "-5%),0) scale(1);}}", // diagonal ↖
      "@keyframes fsE{0%{transform:translate3d(" + A + "-3%)," + A + "2%),0) scale(1.04);}",
      "50%{transform:translate3d(" + A + "4%)," + A + "5%),0) scale(1.12);}",
      "100%{transform:translate3d(" + A + "-3%)," + A + "2%),0) scale(1.04);}}", // orbital
      "@media (prefers-reduced-motion: reduce){",
      ".fs-ambient-blob{animation:none !important;}",
      ".fs-ambient-layer{transform:none !important;}",
      ".fs-ambient-bg{transform:none !important;transition:none !important;}}"
    ].join("");
    document.head.appendChild(style);
  }

  // ---- Build / refresh the field -----------------------------------------
  let container = document.getElementById("fs-ambient");
  if (!container) {
    container = document.createElement("div");
    container.id = "fs-ambient";
    container.className = "fs-ambient-bg";
    container.setAttribute("aria-hidden", "true");
    document.body.insertBefore(container, document.body.firstChild);
  }
  container.style.setProperty("--amp", energy.amp.toFixed(2));

  function paint() {
    const light = isLightSurface();
    const bias = PERIOD_BIAS[periodFor(new Date().getHours())];
    const active = LAYERS.slice(0, energy.blobs);
    container.innerHTML = active.map((cfg) => {
      const size = cfg.size[0] + Math.random() * (cfg.size[1] - cfg.size[0]);
      const left = cfg.pos[0] + jitter(6);
      const top = cfg.pos[1] + jitter(6);
      const color = colorFor(cfg.fam, bias[cfg.fam], light);
      const dur = (cfg.baseDur * energy.dur * (0.9 + Math.random() * 0.2)).toFixed(1);
      const delay = (-Math.random() * cfg.baseDur).toFixed(1);
      const anim = reduceMotion
        ? ""
        : `animation:${cfg.kf} ${dur}s ease-in-out ${delay}s infinite alternate;`;
      const blob = `position:absolute;width:${size.toFixed(1)}%;height:${size.toFixed(1)}%;`
        + `left:${left.toFixed(1)}%;top:${top.toFixed(1)}%;border-radius:50%;`
        + `background:radial-gradient(closest-side, ${color}, transparent 72%);${anim}`;
      return `<div class="fs-ambient-layer" style="--f:${cfg.f}">`
        + `<div class="fs-ambient-blob" style="${blob}"></div></div>`;
    }).join("");
  }
  paint();

  // ---- Scroll-responsive parallax + velocity lift ------------------------
  // One passive scroll listener feeds a single rAF loop. The loop lerps a base
  // parallax toward the scroll position (per-layer factor => different speeds),
  // adds a decaying velocity "boost" (the accelerate-while-scrolling feel and a
  // little horizontal life), then idles itself once everything has settled.
  if (!reduceMotion && energy.parY > 0) {
    let rafId = 0;
    let idleTimer = 0;
    let scrolling = false;
    let lastY = window.scrollY || 0;
    let vel = 0;
    let baseCur = 0;

    const tick = () => {
      rafId = 0;
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      const baseTarget = -y * energy.parY;
      baseCur += (baseTarget - baseCur) * 0.12;
      vel *= 0.86;
      const boost = clamp(vel * energy.boost, -90, 90);
      const sy = clamp(baseCur + boost, -170, 170);
      const sx = clamp(boost * 0.5, -45, 45);
      container.style.setProperty("--amb-sy", sy.toFixed(1) + "px");
      container.style.setProperty("--amb-sx", sx.toFixed(1) + "px");
      container.style.setProperty("--amb-cscale", (scrolling ? energy.scale : 1).toFixed(3));
      if (scrolling || Math.abs(baseTarget - baseCur) > 0.3 || Math.abs(vel) > 0.25) {
        rafId = requestAnimationFrame(tick);
      }
    };

    window.addEventListener("scroll", () => {
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      vel += (y - lastY);
      lastY = y;
      scrolling = true;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        scrolling = false;
        if (!rafId) rafId = requestAnimationFrame(tick);
      }, 200);
      if (!rafId) rafId = requestAnimationFrame(tick);
    }, { passive: true });
  }

  // Repaint (fresh colors + time-of-day bias) only if the page lives long
  // enough to cross a time boundary; keeps a long-lived options page current.
  setInterval(paint, 12 * 60 * 1000);
})();
