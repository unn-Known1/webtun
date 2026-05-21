#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

REPO="https://github.com/unn-Known1/webtun.git"
DIR="${HOME:-/root}/webtun"

echo ""
echo "  Installing WebTun..."

if ! command -v git &>/dev/null; then
  echo "  Error: git is required but not installed"
  exit 1
fi

# Clone or pull
if [ -d "$DIR" ]; then
  if [ ! -d "$DIR/.git" ]; then
    echo "  Error: $DIR exists but is not a git repository"
    exit 1
  fi
  echo "  Updating existing installation..."
  cd "$DIR" && git pull || { echo "  Error: Update failed"; exit 1; }
else
  if [ -e "$DIR" ]; then
    echo "  Error: $DIR exists but is not a directory"
    exit 1
  fi
  git clone "$REPO" "$DIR" || { echo "  Error: Clone failed"; exit 1; }
  cd "$DIR"
fi

# Run setup
if [ ! -f "$DIR/setup.sh" ]; then
  echo "  Error: setup.sh not found in $DIR"
  exit 1
fi
chmod +x "$DIR/setup.sh"
exec "$DIR/setup.sh"
