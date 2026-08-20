#!/usr/bin/env bash
# Installs the dsh-web-search-tavily-pool plugin into the DSH web profile.
# Usage: ./install.sh [profile]   (default profile: web)
set -euo pipefail

PROFILE="${1:-web}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST_DIR="$HOME/.dsh/profiles/node_modules/dsh-web-search-tavily-pool"
PATCH_FILE="$HOME/.dsh/profiles/$PROFILE/cordis.patch.yml"

if [ ! -f "$SRC/lib/index.js" ]; then
  echo "Plugin source not found at $SRC" >&2
  exit 1
fi

# 1. copy the package into the profile module fallback
rm -rf "$DST_DIR"
mkdir -p "$DST_DIR/lib"
cp "$SRC/package.json" "$DST_DIR/package.json"
cp "$SRC/lib/index.js" "$DST_DIR/lib/index.js"
cp "$SRC/lib/client.js" "$DST_DIR/lib/client.js"
cp "$SRC/lib/typert.host.js" "$DST_DIR/lib/typert.host.js"
echo "Installed plugin => $DST_DIR"

# 2. register the provider row in the profile patch layer (idempotent)
REG_BLOCK='# dsh-web-search-tavily-pool: tavily search provider (multi-key rotation) for ctx.web.
- insert:
    - id: web-search-tavily
      name: '"'"'dsh-web-search-tavily-pool'"'"''
# 3. point web_search at tavily (overrides the base row'"'"'s searchProvider)
SWITCH_BLOCK='# web_search primary provider -> tavily (was deepseek-official; revert this block to roll back)
- id: web
  config:
    searchProvider: tavily'

mkdir -p "$HOME/.dsh/profiles/$PROFILE"
touch "$PATCH_FILE"
if grep -q "web-search-tavily" "$PATCH_FILE"; then
  echo "Plugin already registered in $PATCH_FILE"
else
  printf '%s\n\n' "$REG_BLOCK" >> "$PATCH_FILE"
  echo "Registered plugin in $PATCH_FILE"
fi
if grep -q "searchProvider: tavily" "$PATCH_FILE"; then
  echo "Primary already switched to tavily"
else
  printf '%s\n' "$SWITCH_BLOCK" >> "$PATCH_FILE"
  echo "Switched web_search primary to tavily in $PATCH_FILE"
fi

echo "Done. Restart the DSH web app; web_search then goes through tavily with key rotation."
