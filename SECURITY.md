# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| Earlier than 1.0 | No |

FitShield is in maintenance mode. Security fixes are accepted and prioritised.

## Reporting a vulnerability

Report privately using GitHub private vulnerability reporting: on the repository
page open **Security**, then **Report a vulnerability** (Security Advisories).
Please do not open a public issue or pull request for a vulnerability.

Include the affected component and version, steps to reproduce, and the impact
you expect. Replies come through the advisory thread.

## In scope

- The browser extension (Chrome and Firefox), including its service worker, block page and storage handling.
- The Android app, including its accessibility service, block screen and WebView bridge.
- The data pipeline: curated data under `data/`, the generated blocklists, and the build tooling (for example, crafted data that could execute code).

Out of scope: the behaviour of third-party delivery apps or sites, and
circumvention that requires the user to disable FitShield themselves (FitShield
is a friction tool, not a lock).

## Security model in brief

- Local-first. There are no accounts, no telemetry, no analytics and no server. Nothing is sent off the device.
- Extension data lives in `chrome.storage.local` only (no `storage.sync`); the full key list is in [docs/STORAGE.md](docs/STORAGE.md).
- Extension permissions are exactly `storage`, `declarativeNetRequest` and `alarms`, plus an `<all_urls>` host permission so blocking rules can apply to any domain, including ones you add yourself. `storage` holds your settings, `declarativeNetRequest` redirects blocked sites to the pause page, and `alarms` handles schedules and pass expiry.
- Android blocking uses an opt-in AccessibilityService configured with `canRetrieveWindowContent="false"` and only the `typeWindowStateChanged` event, so it learns only which app (package name) came to the foreground. It does not read screen content, messages or passwords.
- The Android manifest declares no `INTERNET` permission. It declares `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, and an optional `SYSTEM_ALERT_WINDOW` (used only to show the block screen over a blocked app). `allowBackup` is off. Usage access, `QUERY_ALL_PACKAGES` and device admin are deliberately not requested.
- The accessibility service is enabled only by the user in system settings, after an in-app disclosure and recorded consent.
