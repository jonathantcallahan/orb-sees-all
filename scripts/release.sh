#!/bin/sh
# Publishes a new version: `pnpm release 0.2.0`. Bumps the version everywhere, commits, tags and
# pushes. The tag starts the Release workflow on GitHub, which builds the app and publishes it;
# installed copies offer the update within a few hours (or at their next launch).
set -e
cd "$(dirname "$0")/.."
VERSION="$1"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Usage: pnpm release <major.minor.patch>, e.g. pnpm release 0.2.0" >&2; exit 1 ;;
esac
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first." >&2
  exit 1
fi
[ "$(git branch --show-current)" = main ] || { echo "Release from main." >&2; exit 1; }
git rev-parse "v$VERSION" >/dev/null 2>&1 && { echo "v$VERSION already exists." >&2; exit 1; }

pnpm test
command -v cargo >/dev/null || PATH="$(dirname "$(rustup which cargo)"):$PATH"
node -e '
  const fs = require("fs");
  const v = process.argv[1];
  for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = v;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
  const cargo = "src-tauri/Cargo.toml";
  fs.writeFileSync(cargo, fs.readFileSync(cargo, "utf8").replace(/^version = ".*"$/m, `version = "${v}"`));
' "$VERSION"
(cd src-tauri && cargo update -p day-planner --offline >/dev/null 2>&1 || cargo update -p day-planner >/dev/null)

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v$VERSION"
git tag "v$VERSION"
git push origin main "v$VERSION"
echo "Pushed v$VERSION. Follow the build: gh run watch"
