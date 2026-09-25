#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
# Restore normal IFS for read commands
READ_IFS=$' \t\n'

# ─────────────────────────────────────────────────────────────
#  WebTun Setup Script
# ─────────────────────────────────────────────────────────────
BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
BLUE=$'\033[34m'; CYAN=$'\033[36m'; RESET=$'\033[0m'

print_banner() {
cat << 'BANNER'
██╗    ██╗███████╗██████╗ ████████╗██╗   ██╗███╗   ██╗
██║    ██║██╔════╝██╔══██╗╚══██╔══╝██║   ██║████╗  ██║
██║ █╗ ██║█████╗  ██████╔╝   ██║   ██║   ██║██╔██╗ ██║
██║███╗██║██╔══╝  ██╔══██╗   ██║   ██║   ██║██║╚██╗██║
╚███╔███╔╝███████╗██████╔╝   ██║   ╚██████╔╝██║ ╚████║
 ╚══╝╚══╝ ╚══════╝╚═════╝    ╚═╝    ╚═════╝ ╚═╝  ╚═══╝
BANNER
echo ""
echo "  ${BOLD}${CYAN}WebTun — Web Terminal + Cloudflare Tunnel${RESET}"
echo "  ─────────────────────────────────"
echo ""
}

info()    { echo "  ${BLUE}▶${RESET} $*"; }
success() { echo "  ${GREEN}✓${RESET} $*"; }
warn()    { echo "  ${YELLOW}⚠${RESET} $*"; }
error()   { echo "  ${RED}✗${RESET} $*" >&2; }
die()     { error "$*"; exit 1; }

print_banner

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Detect OS ────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
info "Detected: $OS / $ARCH"

# Run one of NodeSource's setup scripts as root.
# Previously this piped the response straight into `sudo bash` with all output
# discarded: a fetch failure (proxy, offline, MITM'd 200) became a cryptic apt
# error, and nothing about the script was ever inspected. Now it is downloaded to
# a temp file over HTTPS, sanity-checked for the expected content, then run with
# its output visible.
install_nodesource() {
  local url="$1" tmp
  tmp="$(mktemp)" || die "mktemp failed"
  info "Fetching NodeSource setup script ($url)…"
  if ! curl -fsSL --proto '=https' --tlsv1.2 --max-filesize 262144 "$url" -o "$tmp"; then
    rm -f "$tmp"
    die "Could not download $url — check your network, then install Node.js ≥18 manually: https://nodejs.org"
  fi
  # Sanity-check the payload before running it as root: a bare `grep nodesource`
  # passes any file containing that word. Require the repo-setup markers too —
  # a tampered/generic script still fails closed here.
  if ! grep -qi nodesource "$tmp" || ! grep -qE 'deb\.nodesource\.com|rpm\.nodesource\.com' "$tmp" || ! grep -qE 'apt-get|dnf|yum' "$tmp"; then
    rm -f "$tmp"
    die "Downloaded setup script does not look like NodeSource's — refusing to run it as root"
  fi
  info "Running NodeSource setup as root (adds their apt/dnf repository)…"
  if ! sudo -E bash "$tmp"; then
    rm -f "$tmp"
    die "NodeSource setup failed"
  fi
  rm -f "$tmp"
}

# ── Node.js ──────────────────────────────────────────────────
install_node() {
  if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    MAJOR=${NODE_VER//v/}; MAJOR=${MAJOR%%.*}
    if [ "$MAJOR" -ge 18 ]; then
      success "Node.js $NODE_VER already installed"
      return
    fi
    warn "Node.js $NODE_VER is too old (need ≥18), upgrading..."
  else
    info "Installing Node.js LTS..."
  fi

  case "$OS" in
    Linux)
      if command -v apt-get &>/dev/null; then
        install_nodesource https://deb.nodesource.com/setup_lts.x
        sudo apt-get install -y nodejs &>/dev/null
      elif command -v dnf &>/dev/null; then
        install_nodesource https://rpm.nodesource.com/setup_lts.x
        sudo dnf install -y nodejs &>/dev/null
      elif command -v yum &>/dev/null; then
        install_nodesource https://rpm.nodesource.com/setup_lts.x
        sudo yum install -y nodejs &>/dev/null
      elif command -v pacman &>/dev/null; then
        sudo pacman -Sy --noconfirm nodejs npm &>/dev/null
      else
        die "Cannot auto-install Node.js. Please install Node.js ≥18 manually: https://nodejs.org"
      fi
      ;;
    Darwin)
      if command -v brew &>/dev/null; then
        brew install node &>/dev/null
      else
        die "Please install Node.js ≥18 from https://nodejs.org or install Homebrew first"
      fi
      ;;
    *)
      die "Unsupported OS: $OS. Install Node.js ≥18 manually."
      ;;
  esac
  success "Node.js $(node --version) installed"
}

install_node

# ── python3-build-tools for node-pty ─────────────────────────
if [[ "$OS" == "Linux" ]] && command -v apt-get &>/dev/null; then
  NEED_BUILD=false
  for pkg in python3-dev make g++; do
    dpkg -s "$pkg" &>/dev/null 2>&1 || { NEED_BUILD=true; break; }
  done
  if [ "$NEED_BUILD" = true ]; then
    info "Installing build tools for node-pty..."
    sudo apt-get install -y python3-dev make g++ &>/dev/null || true
  fi
fi

# ── npm dependencies ─────────────────────────────────────────
info "Installing npm dependencies..."
# Reproducible: `npm install` could silently mutate package-lock.json on user
# machines, drifting from the lockfile CI verified.
npm ci --loglevel=error 2>&1 | grep -v "^npm warn" || [ "${PIPESTATUS[0]}" -eq 0 ]
success "Dependencies installed"

# ── Configuration ─────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"
PORT=3000

if [ -f "$ENV_FILE" ]; then
  warn ".env already exists. Edit it to change settings."
  # Parse .env without executing it (avoids shell injection, handles = in value, preserves spaces)
  while IFS= read -r line || [ -n "$line" ]; do
    # Trim leading/trailing whitespace
    line="$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "$line" ] || [[ "$line" == \#* ]] && continue
    # Strip trailing inline comments, respecting quotes: `PIN=abc # x` must
    # read as `abc`, but `PIN="a # b"` keeps the `#`. (The server loader keeps
    # everything to end-of-line, so prefer no inline comments in values.)
    line="$(awk '{ out=""; q=""; n=length($0);
      for (i=1; i<=n; i++) { c=substr($0,i,1);
        if (q == "") { if (c == "\"" || c == "\x27") q=c; else if (c == "#" && substr($0,i-1,1) ~ /[ \t]/) break; }
        else if (c == q) q="";
        out=out c; } print out; }' <<<"$line")"
    line="$(echo "$line" | sed -e 's/[[:space:]]*$//')"
    # Split on first =
    key="${line%%=*}"
    val="${line#*=}"
    key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    # Trim only leading/trailing spaces from val, preserve internal spaces, then strip outer quotes
    val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ "$val" == \"*\" && "$val" == *\" ]]; then val="${val#\"}"; val="${val%\"}"
    elif [[ "$val" == \'*\' && "$val" == *\' ]]; then val="${val#\'}"; val="${val%\'}"; fi
    case "$key" in
      PORT) PORT="${val:-3000}" ;;
    esac
  done < "$ENV_FILE"
  PORT="${PORT:-3000}"
  # Fail closed like stop.sh: a garbage PORT used to build a garbage healthcheck URL.
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    warn "Invalid PORT in .env — using 3000"
    PORT=3000
  fi
else
  echo ""
  echo "  ${BOLD}Configuration${RESET}"
  echo "  ─────────────"
  
  IFS=$READ_IFS read -rp "  Port [3000]: " INPUT_PORT
  PORT="${INPUT_PORT:-3000}"

  echo ""
  echo "  ${BOLD}PIN Protection${RESET}"
  echo "  Add a PIN to prevent unauthorized access."
  echo "  Leave blank for no PIN (NOT recommended if exposed to the internet)."
  echo ""
  IFS=$READ_IFS read -rsp "  PIN (hidden, press Enter for none): " INPUT_PIN
  echo ""

  # Use printf with %s to avoid heredoc expansion (prevents $(cmd) execution) (F84)
  # The PIN is a secret: the default umask (022) left this file world-readable
  # at 0644, unlike the 0600 atomic writes the runtime uses for rotation.
  #
  # PIN quoting mirrors server.js envValue(): the startup loader strips ONE
  # layer of surrounding quotes but never unescapes, so backslash-escaping
  # quotes/backslashes here corrupted the round-trip (a PIN containing " or \
  # never matched after restart). Write the PIN raw, quoting with double
  # quotes only when it contains whitespace/#/ AND no quotes/backslashes —
  # exactly the values the loader can return verbatim. A PIN mixing both
  # (e.g. `a b"c`) is written raw and works for the server, but systemd's
  # EnvironmentFile will truncate it — avoid such PINs under systemd.
  _pin_needs_quotes=false
  if [[ "$INPUT_PIN" == *[[:space:]#]* ]] && [[ "$INPUT_PIN" != *['"'\'\\]* ]]; then
    _pin_needs_quotes=true
  fi
  (
    umask 077
    {
      printf 'PORT=%s\n' "$PORT"
      printf 'HOST=0.0.0.0\n'
      if [ "$_pin_needs_quotes" = true ]; then
        printf 'PIN="%s"\n' "$INPUT_PIN"
      else
        printf 'PIN=%s\n' "$INPUT_PIN"
      fi
      printf '# SHELL=/bin/bash  # override shell if needed\n'
    } > "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  success "Config saved to .env (mode 600)"
fi

# ── Cloudflared ───────────────────────────────────────────────
# Validate a downloaded cloudflared binary before installing it: the old path
# trusted any bytes curl returned (no size floor, no magic check, no checksum,
# no retries) — a truncated/proxied download became the tunnel binary.
# Honors CLOUDFLARED_SHA256 when set (same pin the server-side downloader uses).
verify_cloudflared_bin() {
  local bin="$1" expect_magic="$2" fsize
  fsize="$(wc -c < "$bin" 2>/dev/null | tr -d ' ' || echo 0)"
  if [ -z "$fsize" ] || [ "$fsize" -lt 1000000 ]; then
    error "Downloaded cloudflared is suspiciously small (${fsize:-0} bytes) — refusing to install"
    return 1
  fi
  if [ -n "$expect_magic" ]; then
    local magic
    magic="$(head -c 4 "$bin" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' || true)"
    if [ "$magic" != "$expect_magic" ]; then
      error "Downloaded cloudflared has unexpected magic bytes ($magic) — refusing to install"
      return 1
    fi
  fi
  if [ -n "${CLOUDFLARED_SHA256:-}" ]; then
    local actual
    if ! command -v sha256sum &>/dev/null; then
      error "CLOUDFLARED_SHA256 is set but sha256sum is missing — refusing to install"
      return 1
    fi
    actual="$(sha256sum "$bin" | awk '{print $1}')"
    if [ "$actual" != "$CLOUDFLARED_SHA256" ]; then
      error "cloudflared SHA256 mismatch (expected $CLOUDFLARED_SHA256, got $actual) — refusing to install"
      return 1
    fi
  fi
  return 0
}

install_cloudflared() {
  if command -v cloudflared &>/dev/null; then
    success "cloudflared already installed ($(cloudflared --version 2>&1 | head -1))"
    return
  fi

  info "Installing cloudflared..."
  CF_BASE="https://github.com/cloudflare/cloudflared/releases/latest/download"
  # Installed to /usr/local/bin (system path) — never ./CWD, where the server's
  # binary discovery would execute a planted file with user privileges.

  case "$OS" in
    Linux)
      case "$ARCH" in
        x86_64)  CF_FILE="cloudflared-linux-amd64" ;;
        aarch64|arm64) CF_FILE="cloudflared-linux-arm64" ;;
        armv7l)  CF_FILE="cloudflared-linux-arm" ;;
        *)        warn "Unknown arch $ARCH, trying amd64"; CF_FILE="cloudflared-linux-amd64" ;;
      esac
      # Private temp dir, not a fixed /tmp path a local user could pre-plant
      # (symlink redirection before the sudo mv). HTTPS-only on the wire.
      CF_TMP="$(mktemp -d)"
      if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 "$CF_BASE/$CF_FILE" -o "$CF_TMP/cloudflared"; then
        rm -rf "$CF_TMP"
        die "cloudflared download failed after retries"
      fi
      verify_cloudflared_bin "$CF_TMP/cloudflared" "7f454c46" || { rm -rf "$CF_TMP"; die "cloudflared validation failed"; }
      chmod +x "$CF_TMP/cloudflared"
      sudo mv "$CF_TMP/cloudflared" /usr/local/bin/cloudflared
      rm -rf "$CF_TMP"
      ;;
    Darwin)
      if command -v brew &>/dev/null; then
        brew install cloudflare/cloudflare/cloudflared &>/dev/null
      else
        case "$ARCH" in
          arm64) CF_FILE="cloudflared-darwin-arm64.tgz" ;;
          *)     CF_FILE="cloudflared-darwin-amd64.tgz" ;;
        esac
        CF_TMP="$(mktemp -d)"
        if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 "$CF_BASE/$CF_FILE" -o "$CF_TMP/cf.tgz"; then
          rm -rf "$CF_TMP"
          die "cloudflared download failed after retries"
        fi
        # Refuse HTML error pages / truncated archives before extracting.
        if ! tar tzf "$CF_TMP/cf.tgz" 2>/dev/null | grep -qx "cloudflared"; then
          rm -rf "$CF_TMP"
          die "Downloaded archive does not contain a cloudflared binary"
        fi
        tar xzf "$CF_TMP/cf.tgz" -C "$CF_TMP"
        if [ ! -f "$CF_TMP/cloudflared" ]; then
          rm -rf "$CF_TMP"
          die "Archive did not contain a cloudflared binary"
        fi
        # Size floor (+ optional SHA256 pin) via verify; Mach-O magic varies
        # (thin vs fat binary), so rely on `file` as a best-effort type check.
        if command -v file &>/dev/null && ! file -b "$CF_TMP/cloudflared" 2>/dev/null | grep -qi "Mach-O"; then
          rm -rf "$CF_TMP"
          die "Downloaded cloudflared is not a Mach-O binary"
        fi
        verify_cloudflared_bin "$CF_TMP/cloudflared" "" || { rm -rf "$CF_TMP"; die "cloudflared validation failed"; }
        sudo mv "$CF_TMP/cloudflared" /usr/local/bin/cloudflared
        rm -rf "$CF_TMP"
      fi
      ;;
    *)
      warn "Cannot auto-install cloudflared on $OS. Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
      return
      ;;
  esac
  success "cloudflared installed"
}

install_cloudflared

# ── Systemd service (optional, Linux only) ────────────────────
setup_systemd() {
  if [[ "$OS" != "Linux" ]] || ! command -v systemctl &>/dev/null; then return; fi
  
  echo ""
  IFS=$READ_IFS read -rp "  Install as systemd service (auto-start on boot)? [y/N]: " INSTALL_SERVICE
  local lower; lower="$(echo "$INSTALL_SERVICE" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower" != "y" ]]; then return; fi

  SERVICE_FILE="/etc/systemd/system/webtun.service"
  NODE_PATH="$(command -v node)"
  
  # Under `sudo ./setup.sh` $USER is root, which would run the whole server as
  # root; prefer the invoking user.
  SVC_USER="${SUDO_USER:-$USER}"
  if ! id -u "$SVC_USER" &>/dev/null; then SVC_USER="$USER"; fi

  sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=WebTun - Web Terminal Server
After=network.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_PATH $SCRIPT_DIR/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable webtun
  sudo systemctl start webtun
  SYSTEMD_INSTALLED=true
  success "Systemd service installed and started"
  echo "  ${CYAN}Manage with:${RESET} sudo systemctl {start|stop|restart|status} webtun"
}

# ── Start & Launch ─────────────────────────────────────────────
echo ""
echo "  ${BOLD}${GREEN}Setup complete!${RESET}"
echo ""
echo "  Starting WebTun server..."

# A box already managed by systemd must not get a second server: the old flow
# killed the systemd-managed process here (systemd revived it via
# Restart=on-failure) and then launched a nohup duplicate on the same port.
SYSTEMD_ACTIVE=false
if [[ "$OS" == "Linux" ]] && command -v systemctl &>/dev/null \
  && [ -f "/etc/systemd/system/webtun.service" ] \
  && systemctl is-active --quiet webtun 2>/dev/null; then
  SYSTEMD_ACTIVE=true
  info "systemd service 'webtun' is already active — leaving it in charge (no second server started)"
fi

# Kill old instance if running — guard PID reuse by checking cmdline.
# Skipped when the active systemd service owns the server (killing it just
# triggers a Restart=on-failure revive and races the healthcheck below).
if [ "$SYSTEMD_ACTIVE" != "true" ]; then
if [ -f "$SCRIPT_DIR/webtun.pid" ]; then
  OLD_PID=$(cat "$SCRIPT_DIR/webtun.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && [[ "$OLD_PID" =~ ^[0-9]+$ ]]; then
    if ps -p "$OLD_PID" -o command= 2>/dev/null | grep -q "webtun\|server\.js"; then
      kill -- "$OLD_PID" 2>/dev/null || true
    fi
  fi
fi
# Narrow pkill to this dir to avoid killing other users' server.js (F85)
# Whole seconds only: macOS /bin/sleep rejects fractional arguments, and with
# `set -e` a `sleep 0.5` aborted the entire setup on Darwin.
pkill -f "node.*$SCRIPT_DIR/server\.js" 2>/dev/null || true
sleep 1
fi

# ── Systemd offer — BEFORE starting, deliberately ───────────────
# The offer used to live after the nohup start below: installing the service
# then launched a SECOND `node server.js` on the same port, which crash-looped
# on EADDRINUSE (the old guard passed because our own just-started server was
# answering the health probe).
SYSTEMD_INSTALLED=false
USE_SYSTEMD=false
if [[ "$OS" == "Linux" ]] && command -v systemctl &>/dev/null && [ ! -f "/etc/systemd/system/webtun.service" ]; then
  setup_systemd
  if [ "$SYSTEMD_INSTALLED" = "true" ]; then USE_SYSTEMD=true; fi
fi
# Upgrade path: a service file exists but the offer above was skipped. If that
# service is enabled yet stopped, revive it via systemd instead of adding a
# nohup duplicate that fights it over the port on next boot.
if [ "$SYSTEMD_ACTIVE" != "true" ] && [ "$USE_SYSTEMD" != "true" ] \
  && [[ "$OS" == "Linux" ]] && command -v systemctl &>/dev/null \
  && [ -f "/etc/systemd/system/webtun.service" ] \
  && systemctl is-enabled --quiet webtun 2>/dev/null; then
  if sudo systemctl start webtun 2>/dev/null; then
    USE_SYSTEMD=true
    success "Existing systemd service started (no duplicate server launched)"
  fi
fi

# Start server in background, log to file.
# When the active systemd service already owns the server (re-run upgrade),
# there is nothing to start — skip straight to the healthcheck below.
LOG_FILE="$SCRIPT_DIR/webtun.log"
if [ "$SYSTEMD_ACTIVE" = "true" ]; then
  USE_SYSTEMD=true
  SERVER_PID="systemd"
elif [ "$USE_SYSTEMD" != "true" ]; then
  NODE_CMD="$(command -v node)"
  nohup "$NODE_CMD" "$SCRIPT_DIR/server.js" >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$SCRIPT_DIR/webtun.pid"
else
  SERVER_PID="systemd"
fi

# Wait for server — verify pid alive to avoid hitting old instance (F85)
SERVER_UP=false
for _ in {1..10}; do
  sleep 1
  # The systemd path has no $! to probe.
  if [ "$USE_SYSTEMD" != "true" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if command -v curl &>/dev/null; then
    if curl -sf "http://localhost:$PORT/api/auth/required" &>/dev/null; then
      # Double-check that our pid still owns the port (lsof/ss check not fatal)
      SERVER_UP=true
      break
    fi
  elif command -v wget &>/dev/null; then
    if wget -q "http://localhost:$PORT/api/auth/required" -O /dev/null 2>/dev/null; then
      SERVER_UP=true
      break
    fi
  else
    # No curl or wget — try a basic TCP check
    if (echo > "/dev/tcp/localhost/$PORT") 2>/dev/null; then
      SERVER_UP=true
      break
    fi
  fi
done

if [ "$SERVER_UP" != "true" ]; then
  echo "  ${RED}${BOLD}Server failed to start. Check $LOG_FILE for details.${RESET}"
  echo "  ${YELLOW}Run manually: node server.js${RESET}"
  exit 1
fi

echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │  ${GREEN}${BOLD}WebTun is running!${RESET}                        │"
echo "  │                                         │"
echo "  │  Local:  ${CYAN}http://localhost:$PORT${RESET}           │"
LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}' \
  || ipconfig getifaddr en0 2>/dev/null \
  || ifconfig 2>/dev/null | awk '/inet / && !/127\.0\.0\.1/{print $2; exit}' \
  || echo "YOUR_IP")"
echo "  │  Network: ${CYAN}http://${LOCAL_IP}:$PORT${RESET}          │"
echo "  │                                         │"
echo "  │  Log:    $LOG_FILE"
echo "  │  PID:    $SERVER_PID                               │"
echo "  └─────────────────────────────────────────┘"
echo ""

if [ "$USE_SYSTEMD" = "true" ]; then
  echo "  ${CYAN}Systemd service active — WebTun will start on boot.${RESET}"
fi

# ── Cloudflare Tunnel ──────────────────────────────────────────
if command -v cloudflared &>/dev/null; then
  echo ""
  IFS=$READ_IFS read -rp "  Start Cloudflare Tunnel for remote access? [Y/n]: " START_TUNNEL
  if [[ "$(echo "$START_TUNNEL" | tr '[:upper:]' '[:lower:]')" != "n" ]]; then
    # Start tunnel in background, suppress output
    TUNNEL_LOG="$SCRIPT_DIR/cloudflared.log"
    rm -f "$TUNNEL_LOG"
    nohup cloudflared tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &

    echo ""
    echo "  ${BOLD}Starting Cloudflare Tunnel...${RESET}"

    # Wait up to 5 seconds for the tunnel URL, then exit
    echo "  ${YELLOW}Waiting for Cloudflare Tunnel URL...${RESET}"
    for _ in {1..5}; do
      TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.(trycloudflare\.com|cfargotunnel\.com)' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
      if [ -n "$TUNNEL_URL" ]; then
        echo ""
        echo "  ┌─────────────────────────────────────────────────────┐"
        echo "  │  ${GREEN}${BOLD}Public URL (share this!):${RESET}   │"
        echo "  │  ${CYAN}${BOLD}$TUNNEL_URL${RESET}                  │"
        echo "  └─────────────────────────────────────────────────────┘"
        break
      fi
      sleep 1
    done
  else
    echo ""
    echo "  ${YELLOW}To start the tunnel later, run:${RESET}"
    echo "  cloudflared tunnel --url http://localhost:$PORT"
  fi
else
  echo "  ${YELLOW}Cloudflared not found. To get a public URL:${RESET}"
  echo "  Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/"
  echo "  Then run: cloudflared tunnel --url http://localhost:$PORT"
fi

echo ""
echo "  ${GREEN}Done.${RESET} WebTun server running (PID $SERVER_PID)."
if [ "$USE_SYSTEMD" = "true" ]; then
  echo "  ${GREEN}To stop:${RESET} sudo systemctl stop webtun"
else
  echo "  ${GREEN}To stop:${RESET} kill \$(cat webtun.pid)"
fi
echo ""
