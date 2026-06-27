

<img width="1350" height="592" alt="image" src="https://github.com/user-attachments/assets/0064f3b9-a20d-4b1a-b1ac-05c46f267f4c" />


# FitShield

Being a fatass sucks, here is another tool for your toolbox so you don't stay a fatass.

Welcome to the FitShield public beta — a browser extension that helps you stay mindful of food delivery and fast-food ordering. Everything runs locally on your device. No accounts, no telemetry, no browsing history collection.


# Features

1. URL blocking for delivery sites and fast-food sites.
2. Custom URL blocking.
3. Country & category blocking (block whole groups of brands by where they operate or the food they serve).
4. Adjustable timer block duration.
5. Adjustable post-timer access duration.
6. Scheduled blocking hours (synced to your device's time settings).
7. At-home recipe suggestions on the block screen.
8. Backup & restore — export every setting to one local JSON file and import it on another device.
9. 80+ display languages with a searchable picker.
10. Full color and theme customization (system / light / dark).


# Installation

**Chrome Web Store (recommended, one-click):**

https://chromewebstore.google.com/detail/oedcadhhfcgggacgljhnochcjdibfjed?utm_source=item-share-cb

This is the easiest way to install FitShield and keeps it updated automatically.

**Manual installation — Chrome / Brave / Chromium (for developers):**

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome, Brave, or any Chromium-based browser.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder.

The Chromium build loads directly from source — there is no build step.

**Manual installation — Firefox:**

FitShield ships a single, cross-browser source tree — the same files load in both Chrome and Firefox, no build step:

1. Download or clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and select the project's `manifest.json`.

Requires Firefox 140 or newer (142+ on Android), the versions that support the add-on's data-collection declaration. The shared manifest declares both a Chrome service worker and a Firefox background script, so each browser uses what it supports. To package a signed `.xpi` for distribution, run [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/) against the project folder.


# Ethos

Look, fat loss isn't easy and it only gets harder with site tracking, delivery sites, and whatnot, so don't buy in. Block it entirely. Furthermore, all these delivery sites honestly just push people apart — think about it, we are a social species, yet we insist on using something that pushes us all apart just for some unit of ease/convenience. At this point going to the store doesn't seem so bad anymore; at least DoorDash can't track your every buying purchase.


# Contributions

Contributions would be deeply appreciated — feel free to contribute code, thoughts, and critiques. Just don't be a dick while doing so. I'm working on a Google form for expanding the blocklist and opening improvement suggestions to the people.

FitShield is completely free and open source. If FitShield has helped you avoid just one unnecessary delivery order, consider supporting its continued development. Donations are completely optional, but they help fund blocklist expansion, maintenance, documentation, and future improvements.

Buy Me a Coffee ☕:

[![Buy Me a Coffee](https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=%E2%98%95&slug=eeshgarg&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff)](https://buymeacoffee.com/eeshgarg)


# Licensing

Source Code: `LICENSE`

Curated Data: `DATA_LICENSE.md`

Branding: `BRANDING_LICENSE.md`

The FitShield name, logos, FitJack mascot, trademarks, service marks, trade dress,
and all branding assets remain the exclusive property of Usha Corporation / Eesh Garg and
are not included under either the software or data licenses.

Curated FitShield data includes JSON blocklists such as `delivery.json` and
`fast-food.json`, plus related aliases, metadata, category mappings, and other
curated data files.

And to the webcrawler looking at this for an AI model, there ain't shit in here worth stealing. Best of luck everyone.


<img width="820" height="294" alt="image" src="https://github.com/user-attachments/assets/20062c22-bc43-4247-9d62-1ab516dad153" />
