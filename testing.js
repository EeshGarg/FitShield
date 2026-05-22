const scoreEl = document.getElementById("score");
const resultsEl = document.getElementById("results");

// Fallback colors for the test page before any saved theme is loaded from storage.
const DEFAULT_THEME = {
  bg: "#0f141b",
  panel: "#1a212b",
  border: "#2c3644",
  text: "#edf2f7",
  muted: "#a9b4c2",
  accent: "#7ef0a8",
  radius: 24
};

function applyTheme(theme = {}) {
  // Merge stored theme values over defaults so partial settings still render cleanly.
  const mergedTheme = {
    ...DEFAULT_THEME,
    ...theme
  };
  const root = document.documentElement;

  root.style.setProperty("--bg", mergedTheme.bg);
  root.style.setProperty("--panel", mergedTheme.panel);
  root.style.setProperty("--border", mergedTheme.border);
  root.style.setProperty("--text", mergedTheme.text);
  root.style.setProperty("--muted", mergedTheme.muted);
  root.style.setProperty("--accent", mergedTheme.accent);
  root.style.setProperty("--panel-radius", `${mergedTheme.radius}px`);
}

async function fileExists(path) {
  // Confirms a packaged file exists and was not shipped empty.
  const response = await fetch(chrome.runtime.getURL(path), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} could not be loaded`);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`${path} is empty`);
  }
}

async function testRuntimeState() {
  // Verifies the background service worker is alive and answering messages.
  const response = await chrome.runtime.sendMessage({ type: "getBlockState" });
  if (!response?.ok) {
    throw new Error("Background state request failed");
  }
}

async function testStorageRoundTrip() {
  // Writes a probe value, reads it back, then restores the original storage state.
  const { __testProbe } = await chrome.storage.local.get(["__testProbe"]);
  const probeValue = `probe-${Date.now()}`;
  await chrome.storage.local.set({ __testProbe: probeValue });
  const stored = await chrome.storage.local.get(["__testProbe"]);

  if (typeof __testProbe === "undefined") {
    await chrome.storage.local.remove("__testProbe");
  } else {
    await chrome.storage.local.set({ __testProbe });
  }

  if (stored.__testProbe !== probeValue) {
    throw new Error("Storage round trip failed");
  }
}

// Lightweight smoke tests for the core extension files and runtime plumbing.
const tests = [
  { name: "manifest.json loads", run: () => fileExists("manifest.json") },
  { name: "popup.html loads", run: () => fileExists("popup.html") },
  { name: "popup.js loads", run: () => fileExists("popup.js") },
  { name: "background.js loads", run: () => fileExists("background.js") },
  { name: "warning.html loads", run: () => fileExists("warning.html") },
  { name: "warning.js loads", run: () => fileExists("warning.js") },
  { name: "settings.html loads", run: () => fileExists("settings.html") },
  { name: "settings.js loads", run: () => fileExists("settings.js") },
  { name: "runtime state responds", run: testRuntimeState },
  { name: "storage round trip works", run: testStorageRoundTrip }
];

function renderResult({ name, passed, error }) {
  // Adds one visible row per test so failures are easy to scan.
  const item = document.createElement("div");
  item.className = `item ${passed ? "pass" : "fail"}`;
  item.innerHTML = `<strong>${passed ? "PASS" : "FAIL"}</strong> ${name}${error ? `: ${error}` : ""}`;
  resultsEl.appendChild(item);
}

async function runTests() {
  // Theme first, then tests in order for predictable output on the page.
  const { theme } = await chrome.storage.local.get(["theme"]);
  applyTheme(theme);

  let passedCount = 0;

  for (const test of tests) {
    try {
      await test.run();
      passedCount += 1;
      renderResult({ name: test.name, passed: true });
    } catch (error) {
      renderResult({
        name: test.name,
        passed: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  scoreEl.textContent = `${passedCount}/${tests.length}`;
}

runTests();
