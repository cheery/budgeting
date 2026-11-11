#!/usr/bin/env bash
# Build the API Lambda zip: server/handler.mjs + core.js (the same parser the app uses).
# Prints the zip path and its content-hash key (api/<sha>.zip). Usage: scripts/package-api.sh [outdir]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-$(mktemp -d)}"
STAGE="$OUT/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE/server"
cp core.js "$STAGE/"; cp server/handler.mjs "$STAGE/server/"
echo '{ "type": "module" }' > "$STAGE/package.json"
touch -d '2000-01-01' "$STAGE"/* "$STAGE/server"/*      # stable timestamps = stable hash
(cd "$STAGE" && rm -f ../api.zip && zip -qX -r ../api.zip package.json core.js server)
SHA=$(sha256sum "$OUT/api.zip" | cut -c1-16)
echo "$OUT/api.zip api/$SHA.zip"
