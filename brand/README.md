# brand/ — logo and store imagery

Static brand assets. Nothing here is loaded at runtime by the extension or the
app; the packaged icons live in `extension/icons/` and
`android/app/src/main/res/`.

**License:** these are brand assets of Usha Corporation, all rights reserved —
see [`../BRANDING_LICENSE.md`](../BRANDING_LICENSE.md). The code licence does not
cover them.

| File | Size | Purpose / where used |
| --- | --- | --- |
| `fitshield-f-512.png` | 512 × 512 | **Master "F" mark.** Input of `tools/make-android-icon.js` (`npm run icon:android`), which renders the Android adaptive-icon foreground and monochrome layers; `test/android-release-hardening.test.js` re-runs the generator and compares bytes. Also the artwork for the Play listing icon. |
| `fitshield-f-128.png` | 128 × 128 | Small version of the same mark, for docs and listings. Not read by any tool. |
| `store/fitshield-logo-1400x560.png` | 1400 × 560 | Wordmark banner used at the top of the root [`README.md`](../README.md). |
| `store/fitshield-logo-2700x1184.png` | 2700 × 1184 | High-resolution wordmark for store and marketing use. |
| `store/fitshield-logo.png` | 1536 × 864 | Wordmark on a 16:9 canvas for listings and presentations. |
| `store/fitshield-promo-1280x800.png` | 1280 × 800 | Promotional image at the Chrome Web Store promo/screenshot size. |

Store text and screenshots checklists: [`docs/STORE_LISTING_DRAFT.md`](../docs/STORE_LISTING_DRAFT.md)
and [`docs/PLAY_STORE_RELEASE_CHECKLIST.md`](../docs/PLAY_STORE_RELEASE_CHECKLIST.md).
`tools/assets-check.js` only warns if this folder is missing or empty. The
extension's toolbar icons (`extension/icons/icon-{16,32,48,128}.png`) are
separate files and are *not* generated from these.
