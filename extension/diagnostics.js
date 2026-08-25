/**
 * FitShield diagnostics page controller.
 *
 * Asks the background service worker for a runtime snapshot (getDiagnostics) and
 * renders it. This is the fast answer to "why isn't blocking working?": it shows
 * whether the background service responded at all, whether the blocking engine
 * loaded, how many brands are in the blocklist, how many redirect rules are live
 * in Chrome right now, the last blocking decision, and the last error.
 *
 * WHO READS THIS PAGE. Settings' "Check FitShield is working" opens it, so the
 * reader is whoever installed FitShield — from a store, with no repository, no
 * Node, and no dist/ folder. Every sentence here is written for that person: it
 * says what is wrong and what they can do about it. It must never name a
 * repository file, a build command, or an internal module. It did: for several
 * releases the "not responding" banner told customers to "run `node build.js`,
 * then Load unpacked from dist/chrome", and the block-page row rendered as
 * "open warning.html".
 *
 * The two rows that still show text verbatim from the worker — "Last blocking
 * decision" and "Last error" — are evidence rather than copy: they are whatever
 * the engine or the browser reported, shown so it can be quoted in a support
 * message, and neither is an instruction.
 *
 * Classic script (no ES modules, no inline code) to stay within the MV3 CSP.
 */
"use strict";

// Localization. browser-shim.js and i18n.js load before this file, so the page
// speaks the user's language like every other FitShield surface.
const t = (key, subs) =>
  (typeof FitShieldI18n !== "undefined" ? FitShieldI18n.t(key, subs) : key);

// Positional substitutions, resolved exactly as i18n.js resolves them, so a
// fallback sentence reads the same as the translated one.
function fill(text, subs) {
  if (subs == null) {
    return String(text);
  }

  const list = Array.isArray(subs) ? subs : [subs];

  return String(text).replace(/\$([1-9])/g, (match, index) => {
    const value = list[Number(index) - 1];
    return value == null ? "" : String(value);
  });
}

/**
 * A message, with the English text beside it.
 *
 * `t` returns the raw KEY when a message is missing — which is right for a label
 * (the gap is obvious) and wrong for a sentence, because the user reads
 * "diagWorkerDown" at the exact moment they are trying to find out why blocking
 * stopped. settings.js established this fallback for the same reason; the one
 * addition here is that the fallback takes the substitutions too, so a
 * parameterized sentence is still complete when its message is missing.
 */
function tOr(key, fallback, subs) {
  const value = t(key, subs);
  return value === key ? fill(fallback, subs) : value;
}

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
  if (!banner) {
    return;
  }

  banner.className = "banner " + kind;

  // Unhidden BEFORE it is written. #banner is a live region (role="status"), and
  // a live region mutated while it is still `hidden` is announced
  // inconsistently: some screen readers never see the change, some announce the
  // previous text. Making it visible first means the write itself is the change
  // that gets announced.
  banner.hidden = false;
  banner.textContent = message;

  if (detail) {
    const code = document.createElement("code");
    code.textContent = detail;
    banner.appendChild(code);
  }
}

function hideBanner() {
  const banner = el("banner");
  if (banner) {
    banner.hidden = true;
  }
}

// What a customer can actually do when FitShield is not answering or did not
// load. Shared by both failure banners because the remedy is the same one, and
// it is the only one available to someone who installed from a store.
function recoveryAdvice() {
  return tOr(
    "diagWorkerDownFix",
    "Turn FitShield off and back on from your browser's extensions page. If that does not help, restart your browser."
  );
}

// The raw text the browser or the engine reported, labelled as the technical
// evidence it is. Empty when there is nothing to quote.
function detailsLine(reported) {
  const text = String(reported || "").trim();
  return text ? tOr("diagDetails", "Details: $1", [text]) : "";
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
    // Guard against a worker that never calls back. This one is OUR deadline
    // rather than something the browser reported, so it is marked as carrying
    // nothing worth showing: the banner already says the service is not
    // responding, and a hand-written English "timed out" underneath it would be
    // the only untranslated line on the page.
    setTimeout(() => {
      if (!settled) {
        const timeout = new Error("getDiagnostics timed out");
        timeout.fsNothingToShow = true;
        reject(timeout);
      }
    }, 4000);
  });
}

function renderError(error) {
  const reported = error && error.fsNothingToShow ? "" : (error && error.message ? error.message : "");
  const details = detailsLine(reported);

  showBanner(
    "error",
    tOr("diagWorkerDown", "FitShield's background service is not responding, so nothing is being blocked."),
    details ? `${recoveryAdvice()} ${details}` : recoveryAdvice()
  );

  ["v-manifest", "v-sw", "v-engine", "v-blockurl", "v-brands", "v-buckets", "v-rules", "v-decision", "v-error"]
    .forEach((id) => setText(id, "—", "bad"));
  setText("v-sw", tOr("diagValueNotResponding", "Not responding"), "bad");
}

function render(d) {
  if (!d || !d.ok) {
    // A worker that answered with a failure has something to quote; one that
    // answered with nothing at all does not, and an invented sentence would be
    // worse than none.
    const reported = d && d.error ? String(d.error) : "";
    const error = new Error(reported);
    error.fsNothingToShow = !reported;
    renderError(error);
    return;
  }

  // The worker responded, so it is registered and alive.
  setText("v-sw", tOr("diagValueResponding", "Responding"), "ok");
  setText("v-manifest", `${d.manifestName || "FitShield"} v${d.manifestVersion}`);

  // Whether this snapshot is allowed to claim "everything is fine". Collected as
  // it is read and answered once, at the end of render().
  let healthy = true;

  if (d.engineLoaded) {
    setText("v-engine", tOr("diagValueLoaded", "Loaded"), "ok");
    hideBanner();
  } else {
    healthy = false;
    const details = detailsLine(d.bootError);
    setText("v-engine", tOr("diagValueMissing", "Missing"), "bad");
    showBanner(
      "error",
      tOr("diagEngineDown", "Part of FitShield did not load, so nothing will be blocked."),
      details ? `${recoveryAdvice()} ${details}` : recoveryAdvice()
    );
  }

  const blockUrlNode = el("v-blockurl");
  blockUrlNode.className = "value";
  blockUrlNode.replaceChildren();
  if (d.blockPageUrl) {
    const link = document.createElement("a");
    link.href = d.blockPageUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = tOr("diagOpenBlockPage", "Open the block page");
    blockUrlNode.appendChild(link);
  } else {
    blockUrlNode.textContent = "—";
  }

  const brands = Number(d.blocklistCount) || 0;
  setText("v-brands", String(brands), brands > 0 ? "ok" : "warn");
  setText("v-buckets", `${Number(d.deliveryCount) || 0} / ${Number(d.fastFoodCount) || 0}`);

  // `blocklistCount` deliberately does NOT gate the verdict. It is populated as
  // a side effect of the worker loading its datasets, and an MV3 worker is torn
  // down when idle — so on a perfectly healthy install this row reads 0 whenever
  // the page happens to be the thing that woke the worker, and the real count
  // whenever it does not. Hanging "is FitShield working?" on it would make the
  // answer flicker with worker lifecycle rather than with anything about the
  // install. The row still shows what it shows.

  if (d.dynamicRuleError) {
    healthy = false;
    setText("v-rules", tOr("diagValueError", "Error: $1", [String(d.dynamicRuleError)]), "bad");
  } else {
    const rules = Number(d.dynamicRuleCount);
    setText("v-rules", Number.isFinite(rules) ? String(rules) : "—", rules > 0 ? "ok" : "warn");
  }

  setText("v-decision", d.lastDecision || "—", (d.lastDecision || "").startsWith("active") ? "ok" : "");

  if (d.lastError && d.lastError.message) {
    healthy = false;
    const detail = d.lastError.detail ? ` (${d.lastError.detail})` : "";
    setText("v-error", d.lastError.message + detail, "bad");
  } else {
    setText("v-error", tOr("diagValueNone", "None"), "ok");
  }

  /**
   * The verdict.
   *
   * This page exists to answer one question — "is this working?" — and it only
   * ever answered it when the answer was NO. A healthy install produced a page
   * of rows and a hidden banner, so the reader had to assemble a conclusion out
   * of eight values, and "no banner" was indistinguishable from "the banner
   * failed to render". For a screen-reader user it was worse than that: #banner
   * is the page's role="status", so the failure paths announce a verdict and the
   * healthy path announced nothing at all.
   *
   * What it may claim is bounded by what the snapshot proves. Zero live redirect
   * rules is NOT a fault — it is the correct state with blocking switched off or
   * outside a schedule window — so the sentence says the extension is installed
   * and running and points at the rows for what it is doing, rather than
   * promising protection that the user may have deliberately paused.
   *
   * Anything less than fully healthy leaves the banner where it was: the failure
   * paths above have already spoken, and the remaining cases are marked on the
   * individual rows. Silence is never used to mean "fine".
   */
  if (healthy) {
    showBanner(
      "good",
      tOr(
        "diagAllGood",
        "FitShield is installed and running. The rows below show what it is doing right now."
      )
    );
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
  out.textContent = tOr("diagChecking", "Checking…");
  out.className = "test-result";
  try {
    const d = await ask({ type: "getDiagnostics", domain: input });
    const test = d && d.test;
    if (!test) {
      out.textContent = tOr("diagNoResult", "No result.");
      return;
    }
    if (test.error) {
      out.textContent = tOr("diagCheckFailed", "Could not check “$1”: $2", [test.input, test.error]);
      out.className = "test-result bad";
      return;
    }
    if (test.blocked) {
      // The glyph is the non-colour half of the answer — the class alone would
      // leave a colour-blind reader with two identically shaped sentences.
      out.textContent = `✓ ${tOr(
        "diagTestBlocked",
        "“$1” would be interrupted — FitShield would show the block page instead.",
        [test.host]
      )}`;
      out.className = "test-result ok";
    } else {
      out.textContent = `✕ ${tOr(
        "diagTestOpen",
        "“$1” is not on the blocklist — it would open normally.",
        [test.host]
      )}`;
      out.className = "test-result warn";
    }
  } catch (error) {
    out.textContent = error && error.fsNothingToShow
      ? tOr("diagWorkerDown", "FitShield's background service is not responding, so nothing is being blocked.")
      : tOr(
          "diagTestNoAnswer",
          "FitShield's background service did not respond: $1",
          [error && error.message ? error.message : String(error)]
        );
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

// i18n.js rewrites the static data-i18n markup on its own, but every value and
// banner on this page is written by script — so the first render has to wait for
// the stored language, or a user who pinned a language reads the browser default
// until they press Refresh. Same gate the popup and Settings use.
const i18nReady = (typeof FitShieldI18n !== "undefined" && FitShieldI18n.ready)
  ? FitShieldI18n.ready
  : Promise.resolve();

i18nReady.then(refresh);

// A language change in another tab rewrites the tagged markup; these values are
// re-read so the whole page ends up in one language rather than two.
if (typeof FitShieldI18n !== "undefined" && FitShieldI18n.onChange) {
  FitShieldI18n.onChange(() => {
    refresh();
  });
}
