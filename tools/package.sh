#!/bin/sh
# Builds dist/exterminator.zip with only the files the extension needs
# (no .git, node_modules, tests or tools). Usage: sh tools/package.sh
set -eu
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
mkdir -p dist
rm -f "dist/exterminator-$VERSION.zip"
zip -qr "dist/exterminator-$VERSION.zip" manifest.json _locales icons lib \
  background.js detector.js detector-extended.js offscreen.html offscreen.js \
  popup.html popup.js options.html options.js styles.css
echo "dist/exterminator-$VERSION.zip"
