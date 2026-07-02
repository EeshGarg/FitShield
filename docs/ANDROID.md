# FitShield on Android

_Accurate as of FitShield 0.52. Update this file in the same change as any
behavior it describes._

FitShield is **one product** with **one canonical dataset** and **one separated
engine**. Browsers and Android are **platform adapters** on top of that shared
core — not separate products and not forks:

```
                 canonical data  (blocklists/*.json)
                          │
              separated engine  (blocklist.js)
                          │
        ┌─────────────────┼──────────────────────────┐
        ▼                 ▼                           ▼
  browser adapter   browser adapter            android adapter
  (background.js,   (Firefox for Android,      (native APK:
   Chrome/Brave/    same extension via          VpnService local
   Edge via DNR)    declarativeNetRequest)      DNS filtering)
```

FitShield reaches Android **two** ways, both riding the same engine/data:

| Path | What it is | Blocking mechanism | Status |
| --- | --- | --- | --- |
| **A. Extension on Firefox for Android** | the exact same WebExtension as desktop | `declarativeNetRequest` (in-browser) | declared (manifest `gecko_android` 142+); on-device DNR not yet verified |
| **B. Native Android APK** | a thin native adapter | local `VpnService` DNS filtering (in this app) | **PREVIEW** — scaffolding generated + validated; not built/run on a device here |

> **The single most important rule:** Android does **not** have its own
> blocklist or matcher. Its rules are **generated from the canonical data via
> the separated engine** and validated to match it (`tools/android-audit.js`).
> Any drift fails the build.

---

## 1. Shared engine & canonical data (no fork)

- **Canonical data:** `blocklists/fast-food.json`, `blocklists/delivery.json`.
- **Separated engine:** `blocklist.js` — dataset loading + the matching
  semantics (`normalizeHostname`, `domainMatches`, `getEntryDomains`,
  `getEnabledEntries`, `isBlockedHost`). It runs unchanged in the browser
  (service worker / event page) **and** in Node (tools/tests).
- **Browser adapter:** `background.js` turns the engine's output into
  `declarativeNetRequest` redirect rules.
- **Android adapter:** the native app consumes a **generated** host list (below)
  and applies the engine's exact match rule.

Because the APK is native (Kotlin) it cannot execute the JavaScript engine
directly. The canonical pipeline bridges this **without** duplicating logic:

```
blocklists/*.json ──▶ blocklist.js (engine) ──▶ tools/generate-android-rules.js
                                                        │
                                                        ▼
                              android/app/src/main/assets/fitshield-rules.json
                                          (GENERATED — do not hand-edit)
                                                        │
                                                        ▼
                              RuleEngine.kt  (apex/subdomain match,
                                              identical to domainMatches)
```

- `tools/generate-android-rules.js` calls the **engine** (`getEnabledEntries` +
  `getEntryDomains`) over the **canonical data** and emits a deterministic,
  hash-stamped asset of every blockable apex/alias host (2,585 hosts at 0.52).
- `RuleEngine.kt` loads **only** that generated asset and implements the same
  contract as `blocklist.js` `domainMatches`: a host is blocked iff it equals an
  apex or is a subdomain of one. No second semantics.
- **Rule consistency is enforced, not hoped for:** `tools/android-audit.js`
  re-derives the host set from the engine and fails if the committed asset's
  hash/host-list differs. A generated `semantics-fixture.json` (also engine-
  produced) is checked on-device by `SemanticsParityTest.kt` so the Kotlin
  matcher must agree with the engine's block/allow decisions.
- **No duplicated blocklist, no Android-only data fork, no hand-maintained
  rules** — all three are blocked by the audit and the tests.

---

## 2. Native APK adapter

Repository layout (`android/`, tracked; build output gitignored):

```
android/
  settings.gradle, build.gradle, gradle.properties
  app/build.gradle
  app/src/main/AndroidManifest.xml
  app/src/main/assets/fitshield-rules.json          (GENERATED from canonical data)
  app/src/main/java/com/usha/fitshield/
      RuleEngine.kt             (asset-only matcher, engine semantics)
      FitShieldVpnService.kt    (local DNS filter — PREVIEW)
      MainActivity.kt           (minimal UI: consent + start/stop)
  app/src/main/res/...          (strings, theme, layout)
  app/src/androidTest/.../SemanticsParityTest.kt
  app/src/androidTest/assets/semantics-fixture.json (GENERATED)
```

**What the adapter adds (only what the browser cannot):** Android project
scaffolding, the `VpnService` DNS adapter, a minimal UI, the manifest, the
build/export step, Android-specific validation, and this documentation.
Everything else is shared.

**Preview status:** the smallest working DNS filter is now implemented — tunnel
setup, the engine-backed block/allow decision, IPv4/UDP DNS QNAME parsing,
**NXDOMAIN synthesis for blocked domains**, and **upstream forwarding for allowed
domains** (over a `protect()`-ed socket). It is reviewable but **has NOT been
built or run on a device in this repository** (no Android SDK here). IPv6 and
DNS-over-HTTPS/TLS are intentionally out of scope. This is a test-quality
foundation, not Android 1.0 — see the limitations in §7.

---

## 2b. UI architecture — one web UI, `fitshield.*` platform abstraction

The Android app's UI is the **same web codebase** as the browser extension,
loaded in a WebView. To keep a single UI without Android-only hacks, the UI is
migrating off `chrome.*` onto a platform-agnostic **`fitshield.*`** API:

```
        web UI (HTML/CSS/JS, i18n, currency, engine)
                         │  calls fitshield.*
        ┌────────────────┴─────────────────┐
        ▼                                   ▼
  browser-shim.js                     android-shim.js
  (delegates to chrome.*)             (delegates to the native bridge)
        ▼                                   ▼
  Chrome / Firefox APIs        WebAppBridge (@JavascriptInterface)
                                 ├─ SharedPreferences  (fitshield.storage / stats)
                                 ├─ FitShieldVpnService (fitshield.blocking)
                                 └─ assets / engine     (i18n, hostCount, check)
```

- **`fitshield.*` contract** (same on both shims): `platform`; `storage`
  (get/set/remove/clear/onChanged); `i18n` (getMessage/getUILanguage);
  `blocking` (isEnabled/enable/disable/rulesVersion/hostCount/check); `stats`
  (get); plus supporting `runtime` (getURL/getManifest/sendMessage) and `tabs`.
  The narrow native bridge exposes **only** these — no file system, no arbitrary
  commands, no broad native APIs.
- **One UI, one engine, one dataset.** Only the two shims + the native
  `WebAppBridge` are platform-specific; everything else is shared.
- **WebView serving:** assets load from `https://appassets.androidplatform.net/`
  via `WebViewAssetLoader`, so `fetch()` of the bundled `_locales` works under a
  normal https origin.
- **No fork:** the reused web files (`i18n.js`, `currency.js`, the `_locales`
  strings, `android-shim.js`) are **copied from canonical** into the APK at build
  time (`tools/build-android.js` → `bundleWeb`), and `tools/android-audit.js`
  fails the build if any copy drifts. (Note: `androidResources.ignoreAssetsPattern`
  is overridden so `_locales` — an underscore dir aapt ignores by default — ships.)

**0.53 is shipped in steps:**

- **Step 1 — UI first (this pass):** the Android UI shell, the shared
  `fitshield.*` platform abstraction, and an installable APK preview.
- **Step 2 — DNS later:** DNS behavior hardening, Private DNS / NextDNS
  compatibility research, a DNS-provider abstraction, and on-device testing.
  *No DNS-provider work is done in step 1.*

**Step 1 status:**

- ✅ `fitshield.*` abstraction (`platform/storage/i18n/blocking/stats` + supporting
  `runtime/tabs`) + `browser-shim.js` + `android-shim.js`.
- ✅ `i18n.js` migrated to `fitshield.*` (public `FitShieldI18n` API unchanged), so
  the **real localization runs verbatim on both platforms**.
- ✅ Polished Android entry (`assets/web/index.html` + `app.js`) reusing `i18n.js`,
  `currency.js`, the real string keys, the bundled icon, and the FitShield visual
  language. Shows branding, enable/disable + status, rules version + domain count,
  live stats, a "how it works"/privacy explanation, an on-device domain tester,
  and a neutral limitations section. Talks to the VpnService via
  `fitshield.blocking` and reads counters via `fitshield.stats`.
- ✅ **Neutral Private DNS messaging.** The UI does **not** detect, pressure, or
  open Private DNS settings. It only notes neutrally that some providers (e.g.
  NextDNS) or Private DNS may bypass local filtering and that FitShield won't
  interfere — provider compatibility is a step-2 item.
- ⏭️ **Next (needs a browser smoke test):** migrate the remaining page scripts
  (`settings.js`, `popup.js`, `warning.js`, `welcome.js`, `whats-new.js`,
  `backup.js`) from `chrome.*` to `fitshield.*`, then load those pages verbatim in
  the WebView.

> Why incremental: the browser extension is mature and can't be runtime-tested in
> this environment, so the UI is migrated piece-by-piece behind `fitshield.*`
> (browser behavior preserved 1:1 by `browser-shim.js`) and verified on each
> platform, rather than risking a big-bang rewrite.

## 2c. Feature parity (0.53 UI + visual pass)

The Android UI is an **adapted** reuse of the shared building blocks (engine,
all 83 locales, recipes data, currency, `ambient.js`, visual language), not the
verbatim DNR-coupled desktop `settings.js`. Status legend: **shared** (same
canonical output), **ported** (works on Android now), **adapted** (Android
equivalent), **saved/pending** (UI + storage now; not yet wired into the
connection filter), **deferred**, **N/A**.

| Extension feature | Android status |
| --- | --- |
| Blocking engine | **shared** — rules generated from the one engine/dataset |
| Enable / disable | **ported** — local VpnService + consent |
| Enforcement (web) | **ported** — system-wide **TLS SNI / HTTP Host** connection filter (works with Private DNS on) |
| App blocking (native apps) | **ported** — AccessibilityService detects blocked apps → native BlockActivity intervention (opt-in); dataset generated from the blocklists |
| Timer duration | **saved/pending** (not yet wired into the filter) |
| Schedule | **saved/pending** (not yet wired into the filter) |
| Post-timer window | **saved/pending** (not yet wired into the filter) |
| Whitelist | **adapted** — "always-allow domains" list (saved/pending) |
| Custom blocklist | **adapted** — add/remove domains (saved/pending) |
| Country filter | **adapted** — searchable picker, selection saved (pending) |
| Category filter | **adapted** — searchable picker, selection saved (pending) |
| Searchable picker | **ported** — touch search (filters + language) |
| Recipes | **ported** — browse the canonical recipe catalog |
| Statistics | **ported** — visits, currency-aware savings, calories, and most-blocked **sites + categories + countries**, all recorded on-device by the VpnService (no fake data) |
| Currency picker | **shared** — reuses `currency.js` (follow-language default + all currencies; per-currency cost/calorie seeds) |
| Import / Export | **ported** — export via share sheet; **import via Storage Access Framework document picker** (no storage permission) |
| Themes | **ported** — system / light / dark **+ full color customization** (background / panel / text / accent) and corner radius, glass-preserving, with reset |
| Visual identity | **ported** — living `ambient.js` gradient background, translucent Aero/One-UI glass panels, animated gradient title + savings sheen, press-tilt "tiles" (all reduced-motion aware) |
| Support link | **ported** — optional Buy Me a Coffee button (opens via the bridge; no in-app purchase, no pressure) |
| First-run welcome | **ported** — one-time on-device welcome overlay (dismissal stored locally) |
| Localization | **shared** — all 83 locales reused via i18n.js |
| Privacy text | **ported** — neutral, local-first |
| Help / about | **adapted** — about + privacy panel |
| Changelog / roadmap | **deferred** — not embedded on-device yet |
| Notifications | **adapted** — Android foreground VPN notification |
| Warning/blocked page | **ported for apps** — native BlockActivity intervention screen; for HTTPS *websites* there is no block page without MITM (connection is reset) |

Most-blocked category/country recording reuses the extension's exact heuristic
(category excludes the delivery/fast_food/custom buckets; country is the brand's
**primary/first-listed** market). It is driven by a per-host `meta` map in the
generated rules asset (host → `{c: primaryCountry, k: category}`), produced by
`tools/generate-android-rules.js` from the same engine — no second data source.

## 2d. Manual UI test checklist (device)

- [ ] APK installs; app launches; dashboard renders with the living gradient +
      glass panels + animated gradient title/savings.
- [ ] First run shows the welcome overlay once; "Get started" dismisses it and
      it does not reappear on restart.
- [ ] Localization loads (device language or English fallback).
- [ ] Theme mode (system/light/dark) applies; color pickers + radius live-update
      and persist; "Reset theme" restores the preset.
- [ ] Currency picker changes the savings currency + cost/calorie seeds; manual
      meal cost/calories override and persist.
- [ ] Enable → VPN consent → status flips to On; Disable works.
- [ ] Timer / schedule / post-timer inputs persist after app restart.
- [ ] Whitelist (always-allow) + custom blocklist add/remove persist.
- [ ] Country + category + language pickers search and toggle; selections persist.
- [ ] Recipes display and expand; readable on a phone.
- [ ] With FitShield on, doordash.com / ubereats.com fail to load
      (ERR_CONNECTION_RESET) while normal sites (e.g. wikipedia.org) load fine —
      **works with Private DNS / NextDNS still on**.
- [ ] Internet and DNS are unaffected; the Private DNS setting is unchanged.
- [ ] Stats show honest local counts (no fake numbers); blocked visits + most-
      blocked sites, categories and countries populate after real blocks.
- [ ] Export opens the share sheet; Import opens the document picker, merges a
      backup, and reloads with the imported values.
- [ ] Buy Me a Coffee button opens the link in the browser.
- [ ] Domain tester reports doordash.com blocked, example.com not.
- [ ] Scrolling works; sections are touch-friendly; back button behaves.
- [ ] No permission prompts beyond the one-time VPN consent.
- [ ] No telemetry / unexpected network; no visited hostnames in logcat.
- [ ] Browser extension still works (smoke-test a localized screen).

## 3. VPN design — local connection filtering (TLS SNI)

The native app uses Android's `VpnService` as a **local, on-device connection
filter**. It blocks by the destination host the client already sends **in the
clear** — the **TLS SNI** in the ClientHello (port 443) or the **HTTP Host**
header (port 80) — **not** by DNS. See `Tun2Filter.kt`.

### Why SNI, not DNS (Private DNS coexistence)

Strict **Private DNS** (DNS-over-TLS to a provider such as NextDNS, mode
`hostname`) encrypts **all** DNS and sends it straight to the provider, so a
local DNS filter never sees it — DNS-layer blocking is impossible there without
breaking the user's setup. FitShield instead reads the destination host from the
**connection itself**, which works regardless of how DNS is resolved.

Consequences (verified on-device with NextDNS strict `hostname`):

- **DNS is never intercepted or changed** (no `addDnsServer`). The system
  resolver / Private DNS keeps working exactly as configured; the encrypted DNS
  connection simply flows **through** the relay as an opaque TCP stream to the
  provider. NextDNS/Private DNS is completely untouched.
- Blocking works **with Private DNS on or off** — DoorDash and Uber Eats are
  blocked while normal browsing (and the internet) is unaffected.
- `Settings.Global.private_dns_mode` is still read, only to show a neutral note
  that DNS is untouched (`fitshield.blocking.privateDnsActive()`).

It **does**:

- ✅ run a **local, on-device** VPN that routes traffic through a userspace filter.
- ✅ read the **plaintext SNI / HTTP Host** (already sent unencrypted by the client).
- ✅ check it against the engine-derived rules and **reset** blocked connections.
- ✅ relay **allowed** connections byte-for-byte to the same IP the client chose,
  via **`protect()`ed** sockets (so they leave over the real network, not the VPN).

It **does not**:

- ❌ act as a commercial VPN.
- ❌ tunnel browsing through FitShield (or any) servers — there are none.
- ❌ **decrypt, inspect, or proxy** TLS/HTTPS payloads — only the cleartext SNI
  is read; allowed bytes are relayed opaquely.
- ❌ install or trust any certificate / root CA (**no MITM**).
- ❌ intercept, alter, or log DNS.
- ❌ send any data off the device or log visited hostnames (not even to logcat).

**Connection lifecycle:**

1. **Captured** — all traffic is routed to the local VPN. For each new TCP flow,
   FitShield terminates the client side locally (the app↔TUN path is lossless and
   in-order, so no congestion control is needed on that side).
2. **Host peeked** — the first client payload is parsed for the TLS SNI (443) or
   HTTP Host (80). `RuleEngine.blockedApex(host)` walks the domain's suffixes
   against the apex set (engine semantics). Look-alikes (`fake-doordash.com`) and
   suffix tricks (`doordash.com.evil.com`) do **not** match.
3. **Blocked** — FitShield sends a TCP **RST**; the browser/app shows a connection
   reset (`ERR_CONNECTION_RESET`) and cannot reach the site. There is **no custom
   block page** for HTTPS (that would require MITM, which FitShield refuses).
4. **Allowed** — a `protect()`ed socket is opened to the same destination IP and
   the connection is relayed transparently, exactly as if FitShield were absent.

**QUIC / IPv6:** QUIC (UDP/443) is dropped so browsers fall back to TCP where the
SNI is visible; other UDP is relayed. IPv6 is currently captured and dropped
(forcing IPv4 fallback) — a documented preview limitation; IPv6-only networks are
not yet supported.

**Scope difference from the browser path:** the VPN-based filter is **system-
wide** (any app/browser on the device), whereas the Firefox-for-Android
extension only blocks inside Firefox.

---

## 3b. Native app blocking (AccessibilityService)

The VPN handles *network* traffic (websites, in-app requests). A separate,
independent **AccessibilityService** handles *native apps*: when a blocked
food-delivery / fast-food app comes to the foreground, FitShield shows a native
intervention screen ([BlockActivity]) that mirrors the browser block page. Both
run together; neither depends on the other.

**Data pipeline (one source of truth, no duplication):**

```
blocklists/*.json  (canonical brands: name, domain, type, countries, …)
        +
data/android/delivery-apps.json + fast-food-apps.json
        (minimal: brandId → packageIds only; NO duplicated metadata)
        │  tools/generate-android-packages.js  (deterministic)
        ▼
data/generated/android-packages.json  ── bundled ──▶  assets/android-packages.json
        │                                                       │
        │ tools/validate-android-packages.js                    │ PackageBlocklist.kt
        ▼ (in validate-all: schema, orphans, dup brand/package, ▼ (packageId → brand,
          packageStatus, determinism, drift)                       O(1) lookup)
```

- Each app entry references a brand by its **canonical source domain** (`brandId`,
  e.g. `doordash.com`), so every package maps back to exactly one blocklist brand.
  All display metadata is generated from the blocklists — never re-authored.
- Package IDs that are not confidently known use `packageStatus:"needs_review"`
  with empty `packageIds` (**never guessed**); the validator enforces this.
- Designed to scale to thousands of packages: add entries to the app files and
  rebuild; everything flows through the generated dataset (no hardcoded checks).
- **Additive port:** `tools/port-android-apps.js` (`npm run port:android-apps`)
  mirrors EVERY enabled brand from the blocklists into the app files (one entry
  per brand), preserving confirmed package IDs across runs. The full ported
  record (all ~2.5k brands + metadata) lives in `data/generated/`; only the small
  package map is bundled into the APK.
- **Categories** are derived from each brand's authoritative source `category`
  (coffee / dessert / grocery / convenience / meal_kit, else the file default —
  delivery / fast_food), never guessed from specialties. They drive the
  per-category Settings toggles and the block-screen messaging.
- On-device parity is asserted by an instrumented test (`PackageMatcherTest`):
  every package in the bundled dataset must resolve to the same brand through the
  Kotlin `PackageBlocklist`, and an unlisted package must not match.

**Runtime flow:**

1. `FitShieldAccessibilityService` receives a `TYPE_WINDOW_STATE_CHANGED` event
   and reads **only the foreground package name** (config
   `canRetrieveWindowContent="false"` — no screen content, ever).
2. `PackageBlocklist.match(pkg)` looks up the brand; `AppBlockPolicy` checks the
   opt-in enable flag, the per-category toggle, the schedule window, and any
   active temporary unlock.
3. If it should block, the service first sends the blocked app to the background
   (`performGlobalAction(GLOBAL_ACTION_HOME)`) and then launches `BlockActivity`.
   This is essential: a blocked app that is already running re-launches its own
   activity (`BAL_ALLOW_FOREGROUND`) the instant a block screen covers it and
   steals the foreground back — so the screen would just flash and vanish. A
   backgrounded app can't win that race, so the pause screen stays put.
4. `BlockActivity` (a WebView on the shared design system) shows the pause screen —
   mirroring the extension's block page: FitShield branding, the blocked brand
   name, a **block reason**, category-aware message, **schedule status**,
   savings/calories stats, a quick recipe, a reflection countdown, a localized
   **"Learn more" link to fitshield.net** (opens in an external browser), and
   **Not now** / **Open anyway** / **Open FitShield**.
5. **Not now** sends the user to the launcher (never back into the app) and
   records an avoided open (blocked visits, calories, and the private
   "most-blocked apps" breakdown). **Open anyway** grants a temporary unlock
   (minutes) and **re-opens the app by its launch intent** (it was sent to the
   background in step 3, so it is no longer behind the screen) — recording
   nothing (they proceeded). A narrowly scoped `<queries>` (MAIN/LAUNCHER only,
   **not** `QUERY_ALL_PACKAGES`) lets `getLaunchIntentForPackage` resolve the app
   to re-open; it grants no access to any app's data.

**Controls:** per-category toggles (Delivery / Fast food / Restaurant / Coffee /
Dessert / Grocery / Convenience / Meal kit), a searchable **per-app** allow list
(opt a specific app out even when its category is on), temporary-unlock duration,
and schedule awareness (shared with the VPN's schedule). All stored locally; the
service reads them fresh each event.

**Loop / battery safety:** own-package events are ignored; a per-package cooldown
debounces repeat window events; the service exits early when app blocking is off;
BlockActivity is its own task + excluded from recents so dismissing it can't bounce
back into the app.

**Permissions:** `BIND_ACCESSIBILITY_SERVICE` (declared on the service; the OS
grants it, and the user must opt in from system Accessibility settings) and the
optional `SYSTEM_ALERT_WINDOW` ("display over other apps"). No
`QUERY_ALL_PACKAGES` — the foreground package comes from the event itself. The
`tools/android-audit.js` guardrail deliberately allows this one accessibility
service (read-only, foreground-package-name only) while still forbidding
usage-access, package-visibility, boot receivers, and device admin.

**Overlay permission + status (opt-in):** `SYSTEM_ALERT_WINDOW` lets the block
screen launch reliably over a blocked app (background-activity-launch exemption).
It is **optional** — blocking still works without it on most devices, and the
launch is wrapped so a missing permission never crashes or loops. The dashboard's
app-blocking panel shows three live **status indicators** — Accessibility service,
Site blocking (VPN), and Display over other apps — and, when overlay is missing,
a card that explains (privacy: *used only to show the block screen for the food
apps you choose; never reads screen or message content*) with a button that opens
`ACTION_MANAGE_OVERLAY_PERMISSION`. Status refreshes when returning from settings.

**Background protection (opt-in hardening, OFF by default):** the accessibility
service is system-bound and self-recovering (it survives its process being killed —
the OS rebinds it), so app blocking already runs in the background without help.
For phones that aggressively freeze idle apps, the app-blocking panel offers an
opt-in **"Extra reliability"** toggle that starts `AppBlockKeepAliveService` — a
`START_STICKY` `specialUse` foreground service that runs only a quiet
`IMPORTANCE_MIN` notification to keep the process resident. It does no work and
reads nothing. The same card surfaces the **battery-optimization** status and an
"Allow unrestricted battery" button that opens
`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` (the permission-free settings list —
never the one-tap `ACTION_REQUEST_…` dialog, which would need an extra permission).
No new manifest permission is added (the service reuses `FOREGROUND_SERVICE` /
`FOREGROUND_SERVICE_SPECIAL_USE` / `POST_NOTIFICATIONS`).

**Cross-platform "Learn more":** both the extension block page (`warning.html`)
and the Android block screen (`block.html`) show a localized "Learn more" pointer
to **fitshield.net** (privacy, blocking behavior, setup) — opened in a browser tab
on the extension, via an external `ACTION_VIEW` intent on Android.

---

## 4. Privacy

Identical posture to the rest of FitShield — local-first, on both Android paths.

- ✅ No telemetry, analytics, crash/usage reporting, accounts, cloud, sync, ads,
  or tracking.
- ✅ App blocking reads **only the foreground package name** (never screen
  content — `canRetrieveWindowContent="false"`); the package name is never logged
  or transmitted. It is an opt-in the user enables in Accessibility settings.
- ✅ No browsing-history upload. **DNS is never intercepted, altered, or logged.**
  Filtering decisions are made on-device from the cleartext SNI/Host and are never
  transmitted, persisted off-device, or written to logcat (visited hostnames are
  never logged). Allowed traffic is relayed opaquely; TLS payloads are never read.
- ✅ No hidden background services beyond the foreground `VpnService` the user
  explicitly starts (with the system VPN-consent dialog).
- ✅ **No data sent to FitShield.** There are no FitShield servers. The native
  adapter forwards *allowed* DNS queries to a **public resolver
  (`1.1.1.1`, Cloudflare) in this preview** — never to FitShield, and never any
  data beyond the DNS query itself. (A future version may use the system
  resolver instead; that would require `ACCESS_NETWORK_STATE`.) The browser
  extension makes zero network requests. No analytics dependency is allowed in
  the Android build (enforced by `tools/android-audit.js`).

---

## 5. Permissions

### Native APK (Android OS permissions)

| Permission | Why it exists | Depends on it | If denied |
| --- | --- | --- | --- |
| `INTERNET` | forward **allowed** DNS queries to the upstream resolver | DNS pass-through | allowed lookups fail |
| `FOREGROUND_SERVICE` | a VPN runs as a foreground service | the filter staying active | service can't run |
| `POST_NOTIFICATIONS` | the required ongoing VPN notification (Android 13+) | user-visible "filtering on" state | no status notification |
| `BIND_VPN_SERVICE` (on the `<service>`) | the OS gate for any `VpnService` | starting the filter at all | (OS-enforced; not user-grantable) |

Plus the runtime **VPN consent dialog** Android shows before any VpnService
starts — the user must explicitly approve.

**Intentionally NOT requested (enforced by `tools/android-audit.js`):**
`RECEIVE_BOOT_COMPLETED` (no boot startup), `BIND_ACCESSIBILITY_SERVICE` (no
accessibility service), `PACKAGE_USAGE_STATS` (no usage access),
`QUERY_ALL_PACKAGES` (no package visibility), device admin. There is no boot
receiver and no accessibility service.

### Browser path
The Firefox-for-Android extension uses only WebExtension permissions
(`declarativeNetRequest`, `storage`, `alarms`, `host_permissions: <all_urls>`,
`web_accessible_resources: warning.html`) — no Android OS permissions.

---

## 6. Build

### Browser (Chrome / Firefox / Firefox for Android extension)
- Requirements: Node.js 18+, no dependencies.
- `node build.js` → `dist/chrome/`, `dist/firefox/`, and the store zips. The
  build is validation-gated (includes the Android audit, so the browser build
  fails if the Android ruleset drifts from canonical data).

### Native Android APK
- **Generate rules:** `npm run generate:android` (engine → generated asset).
- **Validate:** `npm run validate:android` (or `npm run validate` / `npm test`).
- **Build/export:** `npm run build:android` →
  - always regenerates + validates and stages `dist/android/` (rules +
    `BUILD.txt` with the exact local command + a device-test checklist);
  - **if the Android SDK + Gradle are present**, builds a **debug** APK and
    copies it to `dist/android/FitShield-<version>-debug.apk`. It never fakes
    success when tooling is absent.
- **Requirements for the APK:** Android SDK (compileSdk 34, minSdk 26) and Gradle
  (AGP 8.5.x, Kotlin 1.9.x). No Gradle wrapper is committed (the wrapper jar is a
  binary); create one once with a system Gradle, then build:
  ```
  cd android
  gradle wrapper            # one-time, needs a system Gradle
  ./gradlew :app:assembleDebug
  ```
  Or, with Gradle on PATH, just `npm run build:android`.
- **Install on a device** (USB debugging on):
  ```
  adb install -r dist/android/FitShield-<version>-debug.apk
  ```
- **Output structure:**
  ```
  dist/
    FitShield-<version>-chrome.zip
    FitShield-<version>-firefox.zip
    android/
      fitshield-rules.json
      BUILD.txt
      FitShield-<version>-debug.apk   (only when built with the SDK/Gradle)
  ```
- **Version:** all outputs use the single `manifest.json` version (`build-android`
  injects `-PfitshieldVersionName`), so the three platforms never diverge.
- **Debug signing only** — uses Android's default debug keystore. No release
  signing/keystores are configured or committed.

### Manual device test checklist (native APK)
A copy of this ships in `dist/android/BUILD.txt`:
- [ ] APK installs (`adb install -r …`); app opens and shows the loaded host count
- [ ] Enable triggers the VPN-consent dialog; after consent the VPN starts and
      the OS VPN indicator + foreground notification appear
- [ ] `doordash.com`, `ubereats.com`, `grubhub.com` are blocked (don't resolve)
- [ ] Normal sites still resolve (e.g. `wikipedia.org`, `github.com`)
- [ ] Disabling stops filtering; uninstalling stops filtering
- [ ] No boot startup; no accessibility / usage-access / location / contacts /
      phone / SMS / storage permission requested
- [ ] Small-screen UI is usable; no unexpected network calls beyond DNS forwarding
- [ ] (optional) `./gradlew connectedAndroidTest` passes `SemanticsParityTest`
      (Kotlin matcher == engine fixture)

---

## 7. Security

**Threat model.** FitShield is a self-control / mindfulness tool, not an
adversarial blocker. It assumes a cooperative user on their own device. It is
not designed to stop a determined user.

**Trust assumptions.** The OS enforces `VpnService` correctly; the device/profile
are the user's; the curated datasets are accurate (validated) but not exhaustive.

**DNS interception model (native path).** A local `VpnService` reads only DNS
queries, decides via engine-derived rules, sinkholes blocked names, and forwards
the rest. No traffic is tunnelled to a server; nothing but DNS is read.

**Limitations — be honest.**

- **Native path is PREVIEW and unverified on-device** — the IPv4/UDP DNS filter
  (NXDOMAIN + upstream forwarding) is implemented but has not been built or run
  on a device here; do not ship it as working until verified. The outbound UDP
  checksum is set to 0 (valid for IPv4) rather than computed.
- **Cooperative, not enforced** — a user can stop the VPN, uninstall, or change
  DNS; DoH/DoT or hardcoded resolvers can bypass a DNS filter.
- **Curated coverage** — only domains the engine derives are blocked.
- **No traffic protection** — FitShield provides no encryption/anonymity; it is
  not a privacy VPN and makes no such claim.
- **Browser path** blocks only inside Firefox for Android, and its on-device DNR
  behavior is not yet verified.

**Android platform limitations.** Only one active VPN at a time (FitShield
conflicts with another VPN app); foreground-service and notification policies
vary by OS version; encrypted DNS can route around a local filter.

**Known unsupported / unverified cases.** IPv6 and DNS-over-HTTPS/TLS handling in
the preview filter; on-device DNR on Firefox for Android; any non-Firefox Android
browser for the extension path.

**Future improvements.** Complete and harden the VpnService I/O (response
synthesis, upstream forwarding, IPv6, DoH handling), add a signed release/wrapper,
and verify both paths on real devices.

---

## 8. Release documentation

Every release is recorded in [`../changelog/`](../changelog/) (canonical) and
summarized in `changelog.json`. For Android, each release should answer:

- **What changed?** — the per-release `changelog/<version>.md`.
- **Why?** — rationale / design notes alongside the change.
- **How was it validated?** — `npm test`, `npm run validate` (incl. the Android
  audit), `node build.js`, `npm run build:android`, plus any on-device notes.
- **What platforms were tested?** — state Chrome/Firefox desktop, and explicitly
  whether Firefox for Android (extension) and the native APK were tested
  **on-device** or only built/validated.
- **What still requires manual verification?** — currently: native VpnService DNS
  filtering on-device, and on-device DNR on Firefox for Android.

> Maintainer note: the Android rules asset is **generated** — never hand-edit it.
> If canonical data changes, run `npm run generate:android` (and the audit/tests
> will fail until you do). Keep code and docs evolving together.
