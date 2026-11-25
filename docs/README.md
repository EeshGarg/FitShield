# FitShield documentation

The hub for everything written down about FitShield. Pick the row that matches
what you are here to do.

FitShield 1.0 is the final feature release; the project is in maintenance mode
(fixes and policy compliance only).

## Using FitShield

| Doc | What it is for |
| --- | --- |
| [`../CONSUMERS.md`](../CONSUMERS.md) | Install, set up and use FitShield (end-user guide) |
| [`../README.md`](../README.md) | The project front page |
| [`../SUPPORT.md`](../SUPPORT.md) | Getting help, and what maintenance mode accepts |

## Learning the codebase

| Doc | What it is for |
| --- | --- |
| [`GETTING_STARTED.md`](GETTING_STARTED.md) | From clone to a first verified change: prerequisites, tests, build, loading the extension, building the APK |
| [`GLOSSARY.md`](GLOSSARY.md) | What "brand", "pass", "needs_review", "catalog" and the rest mean here, with the file that defines each |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | How the pieces fit together |
| [`../FS%20Engine/README.md`](../FS%20Engine/README.md) | The blocking engine and its API (the folder name contains a space) |
| [`../data/README.md`](../data/README.md) | The curated datasets and how generated files relate to their sources |

## Contributing

| Doc | What it is for |
| --- | --- |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | What changes are accepted, how to propose one, the coding rules, and the data/locale/category recipes |
| [`../tools/README.md`](../tools/README.md) | Every validator, generator and packager, by `npm run` command |
| [`../test/README.md`](../test/README.md) | How the test suite is organised and how to run part of it |
| [`LOCALIZATION.md`](LOCALIZATION.md) | Adding and extending locales |

## Maintaining and releasing

| Doc | What it is for |
| --- | --- |
| [`MAINTAINING.md`](MAINTAINING.md) | Running the project in maintenance mode, and cutting a release |
| [`../changelog/README.md`](../changelog/README.md) | The canonical release history (one file per version); the roadmap is [`../changelog/ROADMAP.md`](../changelog/ROADMAP.md) |
| [`../SECURITY.md`](../SECURITY.md) | How to report a vulnerability privately |
| [`ACCEPTANCE.md`](ACCEPTANCE.md) | The four human judgements no machine can make, and how to review them quickly |

## Platform deep-dives

| Doc | What it is for |
| --- | --- |
| [`EXTENSION.md`](EXTENSION.md) | The Chrome/Firefox extension: build targets, packaging, surfaces (there is no separate README in `extension/`) |
| [`ANDROID.md`](ANDROID.md) | The native Android app: accessibility-based app blocking, what it does and does not do |
| [`../android/README.md`](../android/README.md) | Working inside the `android/` folder |
| [`STORAGE.md`](STORAGE.md) | What is stored on the device, its schema, and how migrations work |
| [`../brand/README.md`](../brand/README.md) | Logos and store imagery, and where each is used |

## Store and Play publication

| Doc | What it is for |
| --- | --- |
| [`PLAY_1.0_RESUBMISSION.md`](PLAY_1.0_RESUBMISSION.md) | The 1.0 Google Play resubmission after the VpnService rejection |
| [`PLAY_STORE_RELEASE_CHECKLIST.md`](PLAY_STORE_RELEASE_CHECKLIST.md) | Step-by-step Play release checklist, including release signing |
| [`STORE_LISTING_DRAFT.md`](STORE_LISTING_DRAFT.md) | Draft store listing copy |
| [`PRIVACY_POLICY_ANDROID_NOTES.md`](PRIVACY_POLICY_ANDROID_NOTES.md) | Notes for the Android privacy policy and Play data-safety form |

## History

| Doc | What it is for |
| --- | --- |
| [`history/README.md`](history/README.md) | Index of archived one-off reports (audits, verification rounds, handoffs). Records of what was true at the time, not current instructions |

## Working with AI agents

| Doc | What it is for |
| --- | --- |
| [`../CLAUDE.md`](../CLAUDE.md) | The governance rules for automated and assisted sessions. Where any other file disagrees, this one wins |
| [`../AGENTS.md`](../AGENTS.md) | Short pointer for non-Claude coding agents |
| [`../.claude/agents/`](../.claude/agents/) | The specialist agent definitions, partitioned by file ownership |
| [`../development-policy.json`](../development-policy.json) | The machine-readable form of the rules, enforced by `npm run validate:policy` |

## Legal

[`../LICENSE`](../LICENSE) (code), [`../DATA_LICENSE.md`](../DATA_LICENSE.md)
(curated data), [`../BRANDING_LICENSE.md`](../BRANDING_LICENSE.md) (names and
artwork).
