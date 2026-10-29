#!/bin/sh
# Builds Orb Sees All.app, replaces the copy in /Applications and reopens it.
set -e
cd "$(dirname "$0")/.."
pnpm tauri build --bundles app
osascript -e 'quit app "Orb Sees All"' 2>/dev/null || true
sleep 2
pkill -f "Orb Sees All.app/Contents/MacOS" 2>/dev/null || true
sleep 1
ditto "src-tauri/target/release/bundle/macos/Orb Sees All.app" "/Applications/Orb Sees All.app"
open "/Applications/Orb Sees All.app"
