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
  
  // ── Project defaults ──
  { name: 'Install OpenCode AI', cmd: 'npm install -g opencode-ai', cat: 'AI Tools' },
  { name: 'GitHub TUI', cmd: 'npx github-tui', cat: 'Tools' },
  // Pinned to this repo (not a placeholder owner) and gated by the danger
  // dialog; inspect the script URL before confirming.
  { name: 'Colab Setup', cmd: 'curl -fsSL https://raw.githubusercontent.com/unn-Known1/webtun/main/colab_setup.sh | bash', cat: 'Setup', requiresConfirm: true },
];
