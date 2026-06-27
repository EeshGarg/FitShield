/**
 * FitShield ambient background.
 *
 * A calm, Samsung-inspired time-of-day gradient that sits behind the page
 * content and drifts a little as you scroll. Entirely local (reads only the
 * device clock) — no network, no storage, no tracking.
 *
 * It injects one fixed, non-interactive layer behind everything (z-index -1) and
 * tints it based on the hour: a fresh morning, a warm afternoon, a deep night.
 * FitShield's green stays the accent color; these are low-opacity background
 * washes only. Respects prefers-reduced-motion (no scroll movement).
 */
(function () {
  "use strict";

  if (typeof document === "undefined" || !document.body) {
    return;
  }

  const reduceMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Low-opacity tints per period: { a } drifts from the top, { b } rises from
  // the bottom. Kept subtle so the UI stays calm and on-brand.
  const PALETTES = {
    morning: { a: "rgba(120, 200, 210, 0.13)", b: "rgba(255, 196, 140, 0.08)" },
    afternoon: { a: "rgba(245, 180, 100, 0.13)", b: "rgba(120, 160, 235, 0.07)" },
    night: { a: "rgba(96, 116, 210, 0.14)", b: "rgba(126, 240, 168, 0.06)" }
  };

  function periodFor(hour) {
    if (hour >= 5 && hour < 12) {
      return "morning";
    }
    if (hour >= 12 && hour < 18) {
      return "afternoon";
    }
    return "night";
  }

  let palette = PALETTES[periodFor(new Date().getHours())];

  let layer = document.getElementById("fs-ambient");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "fs-ambient";
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText =
      "position:fixed;inset:0;z-index:-1;pointer-events:none;";
    document.body.insertBefore(layer, document.body.firstChild);
  }

  function scrollProgress() {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (max <= 0) {
      return 0;
    }
    return Math.min(1, Math.max(0, (window.scrollY || doc.scrollTop || 0) / max));
  }

  function render() {
    const sp = reduceMotion ? 0 : scrollProgress();
    // The top wash drifts upward and the bottom wash rises as you scroll, so the
    // gradient "breathes" a little down the page without ever being distracting.
    const topPos = (18 - sp * 26).toFixed(1);
    const bottomPos = (116 - sp * 28).toFixed(1);

    layer.style.background =
      `radial-gradient(135% 80% at 50% ${topPos}%, ${palette.a}, transparent 60%),`
      + `radial-gradient(120% 70% at 50% ${bottomPos}%, ${palette.b}, transparent 55%)`;
  }

  render();

  if (!reduceMotion) {
    let rafId = 0;
    window.addEventListener("scroll", () => {
      if (rafId) {
        return;
      }
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        render();
      });
    }, { passive: true });
  }

  // Re-tint if the page stays open across a time-of-day boundary.
  setInterval(() => {
    const next = PALETTES[periodFor(new Date().getHours())];
    if (next !== palette) {
      palette = next;
      render();
    }
  }, 10 * 60 * 1000);
})();
