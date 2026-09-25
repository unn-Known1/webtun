#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

REPO="https://github.com/unn-Known1/webtun.git"
DIR="${HOME:-/root}/webtun"

echo ""
echo "  Installing WebTun..."

# Every tool used below is checked up-front: a missing git/curl used to surface
# much later as a cryptic failure inside setup.sh. Node.js is NOT required
# here — setup.sh's install_node() installs/upgrades it when missing.
missing=()
command -v git  &>/dev/null || missing+=("git")
command -v curl &>/dev/null || missing+=("curl")
if [ ${#missing[@]} -gt 0 ]; then
  echo "  Error: required command(s) not found: ${missing[*]}"
  echo "         Install them first (git and curl)."
  exit 1
fi
if ! command -v node &>/dev/null; then
  echo "  Node.js not found — setup.sh will install Node.js >= 18."
fi

# Clone or pull
if [ -d "$DIR" ]; then
  if [ ! -d "$DIR/.git" ]; then
    echo "  Error: $DIR exists but is not a git repository"
    exit 1
  fi
  echo "  Updating existing installation..."
  cd "$DIR"
  # A dirty tree makes `git pull` fail with an opaque merge error; say so plainly
  # and leave the working copy untouched rather than half-merging it.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "  Error: $DIR has uncommitted changes — refusing to update."
    echo "         Commit or stash them, then re-run this script."
    exit 1
  fi
  # --ff-only: never create a surprise merge commit on the user's checkout.
  git pull --ff-only || { echo "  Error: Update failed (not a fast-forward)"; exit 1; }
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
