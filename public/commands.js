// WebTun — default Command Library (Command Library panel → "Library" tab).
//
// Merged live into the panel on every render (`renderCmdLib()` in public/index.html reads
// `window.DEFAULT_CMDS` each time rather than seeding it into storage), so edits here reach
// existing installs too — only commands a user adds themselves are persisted (`wt-cmdlib`).
//
// `cat` becomes the section header in the panel, so groups are shown in source order.
// `requiresConfirm: true` pops a danger dialog before running (see `runCmdLib()`).
//
// Platform note: Docker behaves the same on Linux, macOS and Windows, so that group is safe
// everywhere. "Network" and "Files & system" are POSIX shell syntax — a couple of entries are
// Linux-only (`free`, `ss`) — so Windows, which defaults to PowerShell (see WEBTUN_SHELL),
// needs its own equivalents for those two groups.
window.DEFAULT_CMDS = [
  // ── AI Tools ──
  { name: 'Install OpenCode AI', cmd: 'npm install -g opencode-ai', cat: 'AI Tools' },
  { name: 'Run OpenCode', cmd: 'opencode', cat: 'AI Tools' },
  { name: 'Install Claude Code', cmd: 'npm install -g @anthropic-ai/claude-code', cat: 'AI Tools' },

  // ── CLI Tools ──
  { name: 'GitHub TUI', cmd: 'npx github-tui', cat: 'Tools' },
  { name: 'LazyGit', cmd: 'lazygit', cat: 'Tools' },
  { name: 'Htop Monitor', cmd: 'htop', cat: 'Tools' },
  { name: 'Disk Usage (ncdu)', cmd: 'ncdu', cat: 'Tools' },

  // ── Git & VCS ──
  { name: 'Git Status (Short)', cmd: 'git status -s', cat: 'Git' },
  { name: 'Git Log Graph', cmd: 'git log --oneline --graph --decorate -n 15', cat: 'Git' },
  { name: 'Git Branch List', cmd: 'git branch -a', cat: 'Git' },
  { name: 'Git Stash List', cmd: 'git stash list', cat: 'Git' },
  { name: 'Git Diff Summary', cmd: 'git diff --stat', cat: 'Git' },

  // ── System & Performance ──
  { name: 'Disk Free (Human)', cmd: 'df -h', cat: 'System' },
  { name: 'Memory Usage', cmd: 'free -h 2>/dev/null || vm_stat', cat: 'System' },
  { name: 'Top Processes by CPU', cmd: 'ps aux --sort=-%cpu | head -n 10', cat: 'System' },
  { name: 'Top Processes by Mem', cmd: 'ps aux --sort=-%mem | head -n 10', cat: 'System' },
  { name: 'System Uptime & Load', cmd: 'uptime', cat: 'System' },

  // ── Network & Ports ──
  { name: 'Listening Ports', cmd: 'ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null || lsof -iTCP -sTCP:LISTEN', cat: 'Network' },
  { name: 'Public IP', cmd: 'curl -s https://ifconfig.me/ip', cat: 'Network' },
  { name: 'Ping Test (Cloudflare)', cmd: 'ping -c 4 1.1.1.1', cat: 'Network' },

  // ── Docker & Containers ──
  { name: 'Docker Running Containers', cmd: 'docker ps', cat: 'Docker' },
  { name: 'Docker Container Stats', cmd: 'docker stats --no-stream', cat: 'Docker' },
  { name: 'Docker Images', cmd: 'docker images', cat: 'Docker' },
  { name: 'Docker Compose Up', cmd: 'docker compose up -d', cat: 'Docker' },
  { name: 'Docker Compose Down', cmd: 'docker compose down', cat: 'Docker' },

  // ── Node & Web Dev ──
  { name: 'NPM Outdated Packages', cmd: 'npm outdated', cat: 'Node & Dev' },
  { name: 'Run Dev Server', cmd: 'npm run dev', cat: 'Node & Dev' },
  { name: 'Kill Port 3000 Process', cmd: 'npx kill-port 3000', cat: 'Node & Dev' },

  // ── Project Setup ──
  { name: 'Colab Setup', cmd: 'curl -fsSL https://raw.githubusercontent.com/unn-Known1/webtun/main/colab_setup.sh | bash', cat: 'Setup', requiresConfirm: true },
];
