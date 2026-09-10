#!/usr/bin/env bash
# test/check-dom-ids.sh
#
# Checks that every static id= declared in index.html has a matching
# getElementById() call somewhere in public/js/*.js.
#
# Catches the "renamed an id in one file and forgot the other" class of bug.
# Only checks HTML → JS (not JS → HTML) because ids created dynamically via
# innerHTML are legitimately absent from index.html.
#
# FALSE-POSITIVE ALLOWLIST: ids that exist in index.html for structural /
# styling purposes only and are intentionally never looked up via getElementById.
# Add an id here when the script flags it and you've confirmed it's deliberate.
ALLOWLIST=(
  "audit-panel"
)

HTML="${HTML:-public/index.html}"
JS_DIR="${JS_DIR:-public/js}"

html_ids=$(grep -oP ' id="\K[^"]+' "$HTML" | sort -u)
js_ids=$(grep -ohP "getElementById\('\K[^']+" "$JS_DIR"/*.js | sort -u)

missing=()
while IFS= read -r id; do
  [[ -z "$id" ]] && continue

  # Skip allowlisted ids
  for a in "${ALLOWLIST[@]}"; do
    [[ "$id" == "$a" ]] && continue 2
  done

  # Flag if not found in JS
  echo "$js_ids" | grep -qxF "$id" || missing+=("$id")

done <<< "$html_ids"

if [[ ${#missing[@]} -eq 0 ]]; then
  echo "✅ DOM id check passed — all static ids in index.html have a matching getElementById in public/js/*.js"
  exit 0
else
  echo "❌ DOM id mismatch — ids declared in index.html but never looked up in public/js/*.js:"
  for id in "${missing[@]}"; do
    echo "   • $id"
  done
  echo ""
  echo "Fix: add getElementById('ID') in the relevant public/js/*.js module, remove the id"
  echo "from index.html, or add it to ALLOWLIST in test/check-dom-ids.sh if it's intentionally JS-free."
  exit 1
fi
