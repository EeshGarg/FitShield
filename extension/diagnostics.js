/**
 * FitShield diagnostics page controller.
 *
 * Asks the background service worker for a runtime snapshot (getDiagnostics) and
 * renders it. This is the fast answer to "why isn't blocking working?": it shows
 * whether the service worker responded at all, whether the FS Engine bundle
 * loaded, how many brands are in the blocklist, how many redirect rules are live
 * in Chrome right now, the last blocking decision, and the last error.
 *
 * If the service worker does not respond, that itself is the diagnosis — almost
 * always a SOURCE folder loaded instead of the built dist/chrome, which stops
 * the worker from registering. We say so explicitly.
 *
 * Classic script (no ES modules, no inline code) to stay within the MV3 CSP.
 */
"use strict";

const el = (id) => document.getElementById(id);

function setText(id, text, cls) {
  const node = el(id);
  if (!node) {
    return;
  }
  node.textContent = text;
  node.className = "value" + (cls ? " " + cls : "");
}

function showBanner(kind, message, detail) {
  const banner = el("banner");
  banner.className = "banner " + kind;
  banner.textContent = message;
  if (detail) {
    const code = document.createElement("code");
    code.textContent = detail;
    banner.appendChild(code);
  }
  banner.hidden = false;
}

function hideBanner() {
  el("banner").hidden = true;
}

// Promise wrapper around sendMessage that rejects on a dead worker / lastError.
function ask(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      chrome.runtime.sendMessage(message, (response) => {
        settled = true;
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
    // Guard against a worker that never calls back.
    setTimeout(() => {
      if (!settled) {
        reject(new Error("No response from the service worker (timed out)."));
      }
    }, 4000);
  });
}

function renderError(error) {
  hideBanner();
  showBanner(
    "error",
    "The service worker did not respond — blocking is NOT running.",
    "Most likely a source folder was loaded. Fix: run `node build.js`, then Load " +
      "unpacked from dist/chrome (not the repo root or extension/). Details: " +
      (error && error.message ? error.message : String(error))
  );
  ["v-manifest", "v-sw", "v-engine", "v-blockurl", "v-brands", "v-buckets", "v-rules", "v-decision", "v-error"]
    .forEach((id) => setText(id, "—", "bad"));
  setText("v-sw", "not responding", "bad");
}

function render(d) {
  if (!d || !d.ok) {
    renderError(new Error(d && d.error ? d.error : "diagnostics unavailable"));
    return;
  }

  // The worker responded, so it is registered and alive.
  setText("v-sw", "responding", "ok");
  setText("v-manifest", `${d.manifestName || "FitShield"} v${d.manifestVersion}`);

  if (d.engineLoaded) {
    setText("v-engine", "loaded", "ok");
    hideBanner();
  } else {
    setText("v-engine", "MISSING", "bad");
    showBanner("error", "The FS Engine bundle did not load — nothing will block.", d.bootError || "");
  }

  const blockUrlNode = el("v-blockurl");
  blockUrlNode.className = "value";
  blockUrlNode.replaceChildren();
  if (d.blockPageUrl) {
    const link = document.createElement("a");
    link.href = d.blockPageUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "open warning.html";
    blockUrlNode.appendChild(link);
  } else {
    blockUrlNode.textContent = "—";
  }

  const brands = Number(d.blocklistCount) || 0;
  setText("v-brands", String(brands), brands > 0 ? "ok" : "warn");
  setText("v-buckets", `${Number(d.deliveryCount) || 0} / ${Number(d.fastFoodCount) || 0}`);

  if (d.dynamicRuleError) {
    setText("v-rules", "error: " + d.dynamicRuleError, "bad");
  } else {
    const rules = Number(d.dynamicRuleCount);
    setText("v-rules", Number.isFinite(rules) ? String(rules) : "—", rules > 0 ? "ok" : "warn");
  }

  setText("v-decision", d.lastDecision || "—", (d.lastDecision || "").startsWith("active") ? "ok" : "");

  if (d.lastError && d.lastError.message) {
    const detail = d.lastError.detail ? ` (${d.lastError.detail})` : "";
    setText("v-error", d.lastError.message + detail, "bad");
  } else {
    setText("v-error", "none", "ok");
  }
}

async function refresh() {
  try {
    const d = await ask({ type: "getDiagnostics" });
    render(d);
  } catch (error) {
    renderError(error);
  }
}

async function testDomain() {
  const input = el("domain").value.trim();
  const out = el("test-result");
  if (!input) {
    out.textContent = "";
    return;
  }
  out.textContent = "Checking…";
  out.className = "test-result";
  try {
    const d = await ask({ type: "getDiagnostics", domain: input });
    const test = d && d.test;
    if (!test) {
      out.textContent = "No result.";
      return;
    }
    if (test.error) {
      out.textContent = `Could not check "${test.input}": ${test.error}`;
      out.className = "test-result bad";
      return;
    }
    if (test.blocked) {
      out.textContent = `✓ "${test.host}" WOULD be blocked → redirected to the FitShield block page.`;
      out.className = "test-result ok";
    } else {
      out.textContent = `✕ "${test.host}" is not on the blocklist — it would load normally.`;
      out.className = "test-result warn";
    }
  } catch (error) {
    out.textContent = "Service worker did not respond: " + (error && error.message ? error.message : error);
    out.className = "test-result bad";
  }
}

el("refresh").addEventListener("click", refresh);
el("test").addEventListener("click", testDomain);
el("domain").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    testDomain();
  }
});

refresh();
