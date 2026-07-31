#!/bin/bash
#
# FitShield — one-click Safari (macOS / iOS / iPadOS) NIGHTLY installer.
#
# What it does, in order:
#   1. Checks you're on macOS with Node.js and Xcode's converter.
#   2. Builds + validates the Safari nightly payload and, via Apple's
#      safari-web-extension-converter, generates the Xcode project.
#   3. Opens that project in Xcode, ready to Run.
#
# HOW TO RUN (either works):
#   • Double-click this file in Finder (it opens in Terminal).  ← one click
#   • Or from the repo root:  bash scripts/install-safari.command
#
# NOTE: Safari's security model means the last two steps are yours to click:
# press Run in Xcode (macOS or an iPhone/iPad simulator), then enable
# "FitShield Nightly" in Safari > Settings > Extensions. Nightly / experimental —
# unsigned and not from the App Store. See docs/SAFARI.md.

set -euo pipefail

# Resolve the repo root from this script's location so double-clicking works
# regardless of the current directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "──────────────────────────────────────────────"
echo " FitShield · Safari (macOS/iOS/iPadOS) — NIGHTLY"
echo "──────────────────────────────────────────────"

fail() { echo ""; echo "✗ $1"; echo ""; read -n 1 -s -r -p "Press any key to close…"; echo ""; exit 1; }

# 1a. macOS only — Safari Web Extensions need Apple's converter + Xcode.
if [ "$(uname)" != "Darwin" ]; then
  fail "This installer only runs on macOS (Safari Web Extensions require Xcode). See docs/SAFARI.md for the manual steps."
fi

# 1b. Node.js.
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is required. Install it from https://nodejs.org (or: brew install node), then re-run."
fi

# 1c. Xcode + the Safari converter.
if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  fail "Xcode + Command Line Tools are required. Install Xcode from the App Store, then run: xcode-select --install"
fi

echo "✓ macOS · Node $(node --version) · Xcode converter found"
echo ""

# 2. Build + validate + convert (build-safari runs the converter on macOS).
echo "▸ Building the Safari nightly payload and Xcode project…"
node tools/build-safari.js

# 3. Open the generated Xcode project.
PROJECT="$(ls -d dist/apple/xcode/*/*.xcodeproj 2>/dev/null | head -n1 || true)"
if [ -z "$PROJECT" ]; then
  fail "Xcode project not found under dist/apple/xcode/. See dist/apple/BUILD.txt."
fi

echo ""
echo "▸ Opening $PROJECT in Xcode…"
open "$PROJECT"

echo ""
echo "✓ Done. Two clicks left (Safari requires them):"
echo "   1. In Xcode, press Run ▶ — pick the macOS app, or an iPhone/iPad simulator."
echo "   2. Enable 'FitShield Nightly' in Safari > Settings > Extensions"
echo "      (macOS: also turn on Develop > Allow Unsigned Extensions for local runs)."
echo ""
echo "   Full details + known limitations: docs/SAFARI.md"
echo ""
