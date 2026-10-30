#!/bin/sh
# Builds Orb Sees All.app, replaces the copy in /Applications and reopens it.
# If local/icons exists (your own icon art, kept out of git), the build uses it instead of the
# repo's default icon. Make it with: pnpm tauri icon local/app-icon.png --output local/icons
set -e
cd "$(dirname "$0")/.."
if [ -d local/icons ]; then
  ICONS='{"bundle":{"icon":["../local/icons/32x32.png","../local/icons/128x128.png","../local/icons/128x128@2x.png","../local/icons/icon.icns","../local/icons/icon.ico"]}}'
  pnpm tauri build --bundles app --config "$ICONS"
else
  pnpm tauri build --bundles app
fi
osascript -e 'quit app "Orb Sees All"' 2>/dev/null || true
sleep 2
pkill -f "Orb Sees All.app/Contents/MacOS" 2>/dev/null || true
sleep 1
ditto "src-tauri/target/release/bundle/macos/Orb Sees All.app" "/Applications/Orb Sees All.app"
open "/Applications/Orb Sees All.app"
