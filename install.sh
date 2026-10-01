#!/usr/bin/env bash
# Install (or reinstall) the Quarto run buttons into Positron.
#
# Positron reads extensions from ~/.positron/extensions at startup, so this copies the three
# files there and tells you to reload. Idempotent: run it any time, including when the buttons
# have gone missing after a Positron update cleared the folder.
#
#   ./install.sh            install / reinstall
#   ./install.sh --check    report whether it is installed and current, change nothing
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VER=$(node -e "process.stdout.write(require('$SRC/package.json').version)")
DEST="$HOME/.positron/extensions/wing-lab.qmd-run-buttons-$VER"
FILES=(package.json extension.js README.md)

if [[ "${1:-}" == "--check" ]]; then
  if [[ ! -d "$DEST" ]]; then
    echo "NOT INSTALLED — no $DEST"
    echo "  fix: $SRC/install.sh"
    exit 1
  fi
  drift=0
  for f in "${FILES[@]}"; do
    cmp -s "$SRC/$f" "$DEST/$f" || { echo "differs: $f"; drift=1; }
  done
  if [[ $drift -eq 0 ]]; then
    echo "installed and current -> $DEST"
  else
    echo "  fix: $SRC/install.sh   (then reload the window)"
    exit 1
  fi
  exit 0
fi

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  cp "$SRC/$f" "$DEST/$f"
done

# Other versions of this extension left behind confuse Positron's extension scan: it may load
# the older one. Report them rather than deleting anything.
others=$(find "$HOME/.positron/extensions" -maxdepth 1 -name 'wing-lab.qmd-run-buttons-*' ! -name "$(basename "$DEST")" 2>/dev/null || true)
if [[ -n "$others" ]]; then
  echo "note: other versions are also present — remove them by hand if the buttons misbehave:"
  echo "$others" | sed 's/^/  /'
fi

echo "installed -> $DEST"
echo "now: Cmd+Shift+P -> Developer: Reload Window   (or quit and reopen Positron)"
