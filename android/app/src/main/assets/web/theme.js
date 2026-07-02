/**
 * FitShield shared theme helpers — one implementation of the glass-preserving
 * color application, used by BOTH the dashboard (app.js) and the block screen
 * (block.js). Panels stay translucent (tinted from the chosen panel color) so the
 * living gradient still shows through; the lit edges, focus rings and accent
 * bloom track the chosen accent. Exposes `self.FitShieldTheme`.
 */
(function (global) {
  "use strict";

  const PRESETS = {
    dark: { bg: "#0d1117", panel: "#161c25", text: "#f3f8fb", accent: "#7ef0a8", radius: 16 },
    light: { bg: "#f5f7fa", panel: "#ffffff", text: "#0d1117", accent: "#7ef0a8", radius: 16 }
  };

  function hexToRgb(hex) {
    let h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16) || 0, g: parseInt(h.slice(2, 4), 16) || 0, b: parseInt(h.slice(4, 6), 16) || 0 };
  }
  function hexToRgba(hex, a) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
  function isLightColor(hex) { const { r, g, b } = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6; }

  function resolveMode(mode) {
    if (mode === "light" || mode === "dark") return mode;
    return (global.matchMedia && global.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  }
  function presetFor(mode) { return { ...PRESETS[resolveMode(mode)] }; }

  function applyThemeColors(c) {
    const s = document.documentElement.style;
    const light = isLightColor(c.bg);
    s.setProperty("--bg", c.bg);
    s.setProperty("--text", c.text);
    s.setProperty("--accent", c.accent);
    s.setProperty("--panel", hexToRgba(c.panel, light ? 0.70 : 0.58));
    s.setProperty("--panel-soft", hexToRgba(c.panel, light ? 0.62 : 0.50));
    s.setProperty("--border", hexToRgba(c.text, 0.12));
    s.setProperty("--muted", hexToRgba(c.text, 0.62));
    s.setProperty("--accent-ink", isLightColor(c.accent) ? "#07120b" : "#f3f8fb");
    s.setProperty("--radius", (Number(c.radius) || 16) + "px");
    s.setProperty("--accent-soft", hexToRgba(c.accent, 0.28));
    s.setProperty("--glass-hi", light ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.10)");
    s.setProperty("--glass-bloom", light ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)");
  }

  // Read stored theme (mode + optional custom colors) and apply it to <html>.
  async function applyStored(storage) {
    const s = await storage.get(["themeMode", "themeColors"]);
    document.documentElement.setAttribute("data-theme", s.themeMode || "system");
    const colors = (s.themeColors && s.themeColors.bg) ? { ...presetFor(s.themeMode), ...s.themeColors } : presetFor(s.themeMode);
    applyThemeColors(colors);
    return colors;
  }

  global.FitShieldTheme = { PRESETS, hexToRgb, hexToRgba, isLightColor, resolveMode, presetFor, applyThemeColors, applyStored };
})(typeof self !== "undefined" ? self : globalThis);
