#!/bin/sh
# Build the installable zip in dist/: runtime files only, no docs or tools.
set -e
cd "$(dirname "$0")"
mkdir -p dist
gnome-extensions pack --force --out-dir=dist \
    --extra-source=deck.js \
    --extra-source=backdrop.js \
    --extra-source=look.js \
    --extra-source=rules.js \
    --extra-source=options.js \
    --extra-source=LICENSE \
    .
echo "dist/better-gnome-notifications@idogr.shell-extension.zip"
