#!/usr/bin/env bash
set -euo pipefail
# Stop WebTun server
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/webtun.pid"

# Port this instance is meant to be running on (for scoping the tunnel kill).
PORT="$(grep -E '^[[:space:]]*(export[[:space:]]+)?PORT[[:space:]]*=' "$SCRIPT_DIR/.env" 2>/dev/null \
  | tail -1 | sed -E 's/^[[:space:]]*(export[[:space:]]+)?PORT[[:space:]]*=[[:space:]]*//; s/^["'\'']//; s/["'\'']$//' || true)"
PORT="${PORT:-3000}"

stopped=false

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && [[ "$PID" =~ ^[0-9]+$ ]]; then
    # Verify the PID is still OUR server before signalling it. A stale pidfile
    # plus PID reuse used to signal whatever process had inherited that number.
    if kill -0 -- "$PID" 2>/dev/null; then
      CMDLINE="$(ps -p "$PID" -o command= 2>/dev/null || true)"
      if [[ "$CMDLINE" == *"server.js"* ]]; then
        if kill -- "$PID" 2>/dev/null; then
          echo "✓ WebTun stopped (PID $PID)"
          stopped=true
        else
          echo "⚠ Could not stop process $PID (permission denied)"
          exit 1
        fi
      else
        echo "⚠ PID $PID is not a WebTun server (stale pidfile) — not killing it"
      fi
    else
      echo "⚠ Process $PID not running"
    fi
  else
    echo "⚠ Invalid PID in $PID_FILE"
  fi
  # Always clear the pidfile: leaving it behind made a later run target a
  # recycled PID.
  rm -f "$PID_FILE"
elif command -v pkill &>/dev/null; then
  # Scoped to this checkout (setup.sh uses the same pattern)
  if pkill -f "$SCRIPT_DIR/server\\.js" 2>/dev/null; then
    echo "✓ WebTun stopped"
    stopped=true
  else
    echo "⚠ Not running"
  fi
  rm -f "$PID_FILE"
else
  echo "⚠ pkill not found and no PID file — try: kill \$(pgrep -f \"$SCRIPT_DIR/server.js\")"
fi

# Tunnel children: scoped to THIS instance's port. The old pattern
# ("cloudflared tunnel.*localhost:") killed every localhost tunnel on the box,
# including ones belonging to other WebTun installs.
if command -v pkill &>/dev/null; then
  if pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null; then
    echo "✓ Tunnel for port $PORT stopped"
  fi
fi
