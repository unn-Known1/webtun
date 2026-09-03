#!/usr/bin/env bash
set -euo pipefail
# Stop WebTun server
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/webtun.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && [[ "$PID" =~ ^[0-9]+$ ]]; then
    if kill -- "$PID" 2>/dev/null; then
      echo "✓ WebTun stopped (PID $PID)"
    elif kill -0 -- "$PID" 2>/dev/null; then
      echo "⚠ Could not stop process $PID (permission denied)"
      exit 1
    else
      echo "⚠ Process $PID not running"
    fi
    rm -f "$PID_FILE"
  else
    echo "⚠ Invalid PID in $PID_FILE"
    rm -f "$PID_FILE"
  fi
elif command -v pkill &>/dev/null; then
  # Scoped to this checkout (setup.sh uses the same pattern) + our tunnels
  if pkill -f "$SCRIPT_DIR/server\.js" 2>/dev/null; then
    echo "✓ WebTun stopped"
  else
    echo "⚠ Not running"
  fi
  # Also stop tunnel children for this instance
  pkill -f "cloudflared tunnel.*localhost:" 2>/dev/null || true
else
  echo "⚠ pkill not found and no PID file — try: kill \$(pgrep -f \"$SCRIPT_DIR/server.js\")"
fi
