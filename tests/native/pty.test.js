'use strict';
// Opt-in OS integration tests. Only a disposable Node/Python fixture is spawned,
// never a user's shell, tmux session, SSH daemon or other live host process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function checkPty(t, driver, executable, args) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webtun-native-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const proc = driver.spawn(executable, args, { name: 'xterm-256color', cwd: root, cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color' } });
  t.after(() => proc.kill());
  let output = '', waiters = [];
  proc.onData(chunk => { output += chunk; for (const waiter of [...waiters]) if (output.includes(waiter.text)) { clearTimeout(waiter.timer); waiters = waiters.filter(w => w !== waiter); waiter.resolve(); } });
  const wait = text => new Promise((resolve, reject) => {
    if (output.includes(text)) return resolve();
    const waiter = { text, resolve, timer: setTimeout(() => reject(new Error('PTY did not emit ' + text + ': ' + output.slice(-500))), 3000) }; waiters.push(waiter);
  });
  await wait('READY');
  // The Python bridge applies resizes via a separate control pipe polled on a
  // 50ms loop; under load a single 100ms pause is racy. Poll the size query
  // until the bridge reports the new dimensions (max ~5s) before asserting.
  proc.resize(120, 40);
  let sized = false;
  for (let i = 0; i < 25 && !sized; i++) {
    proc.write('size\r');
    try { await wait('SIZE:120,40'); sized = true; }
    catch { output = ''; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(sized, 'PTY did not report resized dimensions: ' + output.slice(-500));
  output = '';
  proc.write('echo\r'); await wait('ECHO:echo');
  const exit = new Promise(resolve => proc.onExit(resolve)); proc.write('quit\r');
  let exitTimer;
  const result = await Promise.race([exit, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('PTY fixture did not exit')), 3000); })]);
  clearTimeout(exitTimer); assert.equal(result.exitCode, 0);
}
test('native node-pty input, resize and exit work without a real shell', { timeout: 10000 }, async t => {
  let pty;
  try {
    pty = require('node-pty');
    const probe = pty.spawn(process.execPath, ['-e', 'process.exit(0)'], { cols: 80, rows: 24 });
    probe.kill();
  } catch (e) {
    if (e && (e.code === 'MODULE_NOT_FOUND' || /Failed to load native module/.test(String(e.message)))) {
      t.skip('node-pty native binary is not built');
      return;
    }
    throw e;
  }
  const code = "console.log('READY');let s='';process.stdin.on('data',b=>{s+=b;let i;while((i=s.indexOf('\\n'))>=0){const x=s.slice(0,i).trim();s=s.slice(i+1);if(x==='quit')process.exit(0);if(x==='size'){const z=process.stdout.getWindowSize();console.log('SIZE:'+z[0]+','+z[1])}else console.log('ECHO:'+x)}})";
  await checkPty(t, pty, process.execPath, ['-e', code]);
});
test('Python PTY fallback propagates resize through its control pipe', { timeout: 10000 }, async t => {
  if (process.platform === 'win32') { t.skip('Python POSIX bridge is not used on Windows'); return; }
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); } catch { t.skip('Python is not installed'); return; }
  const code = "import os,sys\nprint('READY',flush=True)\nfor s in sys.stdin:\n s=s.strip()\n if s=='quit': sys.exit(0)\n if s=='size':\n  z=os.get_terminal_size(1);print('SIZE:%d,%d'%(z.columns,z.lines),flush=True)\n else: print('ECHO:'+s,flush=True)";
  await checkPty(t, require('../../lib/pty-fallback'), 'python3', ['-c', code]);
});
