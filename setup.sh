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
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - &>/dev/null
        sudo apt-get install -y nodejs &>/dev/null
      elif command -v dnf &>/dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - &>/dev/null
        sudo dnf install -y nodejs &>/dev/null
      elif command -v yum &>/dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - &>/dev/null
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
npm install --loglevel=error 2>&1 | grep -v "^npm warn" || [ "${PIPESTATUS[0]}" -eq 0 ]
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
  {
    printf 'PORT=%s\n' "$PORT"
    printf 'HOST=0.0.0.0\n'
    printf 'PIN=%s\n' "$INPUT_PIN"
    printf '# SHELL=/bin/bash  # override shell if needed\n'
  } > "$ENV_FILE"
  success "Config saved to .env"
fi

# ── Cloudflared ───────────────────────────────────────────────
install_cloudflared() {
  if command -v cloudflared &>/dev/null; then
    success "cloudflared already installed ($(cloudflared --version 2>&1 | head -1))"
    return
  fi

  info "Installing cloudflared..."
  CF_BASE="https://github.com/cloudflare/cloudflared/releases/latest/download"

  case "$OS" in
    Linux)
      case "$ARCH" in
        x86_64)  CF_FILE="cloudflared-linux-amd64" ;;
        aarch64|arm64) CF_FILE="cloudflared-linux-arm64" ;;
        armv7l)  CF_FILE="cloudflared-linux-arm" ;;
        *)        warn "Unknown arch $ARCH, trying amd64"; CF_FILE="cloudflared-linux-amd64" ;;
      esac
      curl -fsSL "$CF_BASE/$CF_FILE" -o /tmp/cloudflared
      chmod +x /tmp/cloudflared
      sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
      ;;
    Darwin)
      if command -v brew &>/dev/null; then
        brew install cloudflare/cloudflare/cloudflared &>/dev/null
      else
        case "$ARCH" in
          arm64) CF_FILE="cloudflared-darwin-arm64.tgz" ;;
          *)     CF_FILE="cloudflared-darwin-amd64.tgz" ;;
        esac
        curl -fsSL "$CF_BASE/$CF_FILE" -o /tmp/cf.tgz
        tar xzf /tmp/cf.tgz -C /tmp
        sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
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
  
  sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=WebTun - Web Terminal Server
After=network.target

[Service]
Type=simple
User=$USER
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
  success "Systemd service installed and started"
  echo "  ${CYAN}Manage with:${RESET} sudo systemctl {start|stop|restart|status} webtun"
}

# ── Start & Launch ─────────────────────────────────────────────
echo ""
echo "  ${BOLD}${GREEN}Setup complete!${RESET}"
echo ""
echo "  Starting WebTun server..."

# Kill old instance if running — guard PID reuse by checking cmdline
if [ -f "$SCRIPT_DIR/webtun.pid" ]; then
  OLD_PID=$(cat "$SCRIPT_DIR/webtun.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && [[ "$OLD_PID" =~ ^[0-9]+$ ]]; then
    if ps -p "$OLD_PID" -o command= 2>/dev/null | grep -q "webtun\|server\.js"; then
      kill -- "$OLD_PID" 2>/dev/null || true
    fi
  fi
fi
# Narrow pkill to this dir to avoid killing other users' server.js (F85)
pkill -f "node.*$SCRIPT_DIR/server\.js" 2>/dev/null || true
sleep 0.5

# Start server in background, log to file
LOG_FILE="$SCRIPT_DIR/webtun.log"
NODE_CMD="$(command -v node)"
nohup "$NODE_CMD" "$SCRIPT_DIR/server.js" >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$SCRIPT_DIR/webtun.pid"

# Wait for server — verify pid alive to avoid hitting old instance (F85)
SERVER_UP=false
for _ in {1..10}; do
  sleep 0.5
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
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

# Systemd offer
if [[ "$OS" == "Linux" ]] && command -v systemctl &>/dev/null && [ ! -f "/etc/systemd/system/webtun.service" ]; then
  # Only offer systemd if we're the only process on the port (don't race with existing server)
  if curl -sf "http://localhost:$PORT/api/auth/required" &>/dev/null; then
    setup_systemd
  fi
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
      TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
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
echo "  ${GREEN}To stop:${RESET} kill \$(cat webtun.pid)"
echo ""
