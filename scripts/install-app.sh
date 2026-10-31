#!/bin/sh
# Builds Demian.app, replaces the copy in /Applications and reopens it.
# If local/icons exists (your own icon art, kept out of git), the build uses it instead of the
# repo's default icon. Make it with: pnpm tauri icon local/app-icon.png --output local/icons
set -e
cd "$(dirname "$0")/.."
# The build signs its update bundle with the release key when it's on this machine
# (made with: pnpm tauri signer generate -w ~/.tauri/orb.key). Without it, skip the update bundle.
if [ -f ~/.tauri/orb.key ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/orb.key)"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/orb.key.password 2>/dev/null)"
  UPDATER='{}'
else
  UPDATER='{"bundle":{"createUpdaterArtifacts":false}}'
fi
# Homebrew's rustup doesn't put cargo on PATH.
command -v cargo >/dev/null || PATH="$(dirname "$(rustup which cargo)"):$PATH"
if [ -d local/icons ]; then
  ICONS='{"bundle":{"icon":["../local/icons/32x32.png","../local/icons/128x128.png","../local/icons/128x128@2x.png","../local/icons/icon.icns","../local/icons/icon.ico"]}}'
  pnpm tauri build --bundles app --config "$ICONS" --config "$UPDATER"
else
  pnpm tauri build --bundles app --config "$UPDATER"
fi
osascript -e 'quit app "Demian"' 2>/dev/null || true
# The app was called Orb Sees All before; quit that copy too and move it to the Trash.
osascript -e 'quit app "Orb Sees All"' 2>/dev/null || true
sleep 2
pkill -f "Demian.app/Contents/MacOS" 2>/dev/null || true
pkill -f "Orb Sees All.app/Contents/MacOS" 2>/dev/null || true
if [ -d "/Applications/Orb Sees All.app" ]; then
  osascript -e 'tell application "Finder" to delete POSIX file "/Applications/Orb Sees All.app"' >/dev/null 2>&1 || true
fi
sleep 1
ditto "src-tauri/target/release/bundle/macos/Demian.app" "/Applications/Demian.app"
open "/Applications/Demian.app"
