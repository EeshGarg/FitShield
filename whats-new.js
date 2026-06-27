// Renders the local changelog.json. No network calls.

const DEFAULT_THEME = {
  bg: "#0d1117",
  panel: "rgba(21, 27, 35, 0.92)",
  border: "rgba(126, 240, 168, 0.18)",
  text: "#f3f8fb",
  muted: "#a8b4c3",
  accent: "#7ef0a8",
  radius: 20
};

function applyTheme(theme = {}) {
  const merged = { ...DEFAULT_THEME, ...theme };
  const root = document.documentElement;
  root.style.setProperty("--bg", merged.bg);
  root.style.setProperty("--panel", merged.panel);
  root.style.setProperty("--border", merged.border);
  root.style.setProperty("--text", merged.text);
  root.style.setProperty("--muted", merged.muted);
  root.style.setProperty("--accent", merged.accent);
}

const currentVersion = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch (error) {
    return "";
  }
})();

function renderReleases(entries) {
  const container = document.getElementById("releases");
  container.replaceChildren();

  if (!Array.isArray(entries) || entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No release notes yet.";
    container.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const release = document.createElement("section");
    release.className = "release";
    if (entry.version === currentVersion) {
      release.classList.add("current");
    }

    const head = document.createElement("div");
    head.className = "release-head";

    const versionWrap = document.createElement("div");
    const version = document.createElement("span");
    version.className = "release-version";
    version.textContent = `Version ${entry.version}`;
    versionWrap.appendChild(version);

    if (entry.version === currentVersion) {
      const badge = document.createElement("span");
      badge.className = "release-badge";
      badge.textContent = "New";
      badge.style.marginLeft = "8px";
      versionWrap.appendChild(badge);
    }

    const date = document.createElement("span");
    date.className = "release-date";
    date.textContent = entry.date || "";

    head.append(versionWrap, date);
    release.appendChild(head);

    if (entry.title) {
      const title = document.createElement("p");
      title.className = "release-title";
      title.textContent = entry.title;
      release.appendChild(title);
    }

    const list = document.createElement("ul");
    (Array.isArray(entry.changes) ? entry.changes : []).forEach((change) => {
      const item = document.createElement("li");
      item.textContent = change;
      list.appendChild(item);
    });
    release.appendChild(list);

    container.appendChild(release);
  });
}

async function init() {
  try {
    const { theme } = await chrome.storage.local.get(["theme"]);
    applyTheme(theme);
  } catch (error) {
    console.error("Failed to load theme:", error);
  }

  try {
    const response = await fetch(chrome.runtime.getURL("changelog.json"));
    const data = await response.json();
    renderReleases(data && data.entries);
  } catch (error) {
    console.error("Failed to load changelog:", error);
    renderReleases([]);
  }

  // Mark this version as seen so it does not re-open on the next launch.
  try {
    await chrome.storage.local.set({ lastSeenVersion: currentVersion });
  } catch (error) {
    console.error("Failed to record seen version:", error);
  }
}

document.getElementById("openSettings").addEventListener("click", () => {
  window.location.href = chrome.runtime.getURL("settings.html");
});

document.getElementById("close").addEventListener("click", () => {
  window.close();
});

init();
