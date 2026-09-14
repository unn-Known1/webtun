// WebTun — default Command Library (Command Library panel → "Library" tab).
//
// Merged live into the panel on every render (`renderCmdLib()` in public/index.html reads
// `window.DEFAULT_CMDS` each time rather than seeding it into storage), so edits here reach
// existing installs too — only commands a user adds themselves are persisted (`wt-cmdlib`).
//
// `cat` becomes the section header in the panel, so groups are shown in source order.
// `requiresConfirm: true` pops a danger dialog before running (see `runCmdLib()`).
//
// Platform note: Git, Node/npm and Docker behave the same on Linux, macOS and Windows, so
// those groups are safe everywhere. The "Files & system" group is Linux/macOS shell syntax —
// Windows defaults to PowerShell (see WEBTUN_SHELL) and needs its own equivalents.
window.DEFAULT_CMDS = [

  // ── Docker ── (cross-platform)
  { name: 'Running containers', cmd: 'docker ps', cat: 'Docker' },
  { name: 'All containers', cmd: 'docker ps -a', cat: 'Docker' },
  { name: 'Images', cmd: 'docker images', cat: 'Docker' },
  { name: 'Disk used by Docker', cmd: 'docker system df', cat: 'Docker' },
  { name: 'Compose up (detached)', cmd: 'docker compose up -d', cat: 'Docker' },
  { name: 'Compose status', cmd: 'docker compose ps', cat: 'Docker' },
  { name: 'Compose logs (last 100)', cmd: 'docker compose logs --tail=100', cat: 'Docker' },

  // ── Network ──
  { name: 'Check a URL (headers)', cmd: 'curl -I https://example.com', cat: 'Network' },
  { name: 'Ping host (4 packets)', cmd: 'ping -c 4 1.1.1.1', cat: 'Network' },
  { name: 'Listening ports', cmd: 'ss -tulpn', cat: 'Network' },

  // ── Files & system ── (Linux/macOS shell syntax)
  { name: 'List files (detailed)', cmd: 'ls -lah', cat: 'Files & system' },
  { name: 'Current directory', cmd: 'pwd', cat: 'Files & system' },
  { name: 'Recently modified files', cmd: 'ls -lt | head -20', cat: 'Files & system' },
  { name: 'Disk usage by folder', cmd: 'du -sh *', cat: 'Files & system' },
  { name: 'Disk free', cmd: 'df -h', cat: 'Files & system' },
  { name: 'Memory & load', cmd: 'free -h && uptime', cat: 'Files & system' },
  { name: 'Top processes by CPU', cmd: 'ps aux --sort=-%cpu | head -15', cat: 'Files & system' },

  // ── Project defaults ──
  { name: 'Install OpenCode AI', cmd: 'npm install -g opencode-ai', cat: 'AI Tools' },
  { name: 'GitHub TUI', cmd: 'npx github-tui', cat: 'Tools' },
  { name: 'Colab Setup', cmd: 'curl -fsSL https://raw.githubusercontent.com/unn-Known1/unn-Known1/main/colab_setup.sh | bash', cat: 'Setup', requiresConfirm: true },
];
