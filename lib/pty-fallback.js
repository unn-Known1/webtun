const cp = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const fs = require('fs');

class FallbackPty extends EventEmitter {
  constructor(file, args, options = {}) {
    super();
    this._dataListeners = [];
    this._exitListeners = [];
    this.cols = options.cols || 80;
    this.rows = options.rows || 24;
    this.process = file;

    const env = Object.assign({}, process.env, options.env, {
      TERM: options.name || 'xterm-256color',
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
    });

    const shellArgs = Array.isArray(args) ? args : [];

    let hasPython = false;
    try {
      cp.execSync('which python3', { stdio: 'ignore' });
      hasPython = true;
    } catch {}

    let proc;
    const bridgeScript = path.join(__dirname, 'pty-bridge.py');
    if (hasPython && os.platform() !== 'win32' && fs.existsSync(bridgeScript)) {
      proc = cp.spawn('python3', [
        bridgeScript,
        String(this.cols),
        String(this.rows),
        options.cwd || process.cwd(),
        file,
        ...shellArgs
      ], {
        cwd: options.cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } else {
      proc = cp.spawn(file, shellArgs, {
        cwd: options.cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    }

    this._proc = proc;
    this.pid = proc.pid;

    if (proc.stdout) {
      proc.stdout.on('data', data => {
        const str = data.toString('utf8');
        this.emit('data', str);
        for (const fn of this._dataListeners) {
          try { fn(str); } catch {}
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', data => {
        const str = data.toString('utf8');
        this.emit('data', str);
        for (const fn of this._dataListeners) {
          try { fn(str); } catch {}
        }
      });
    }

    proc.on('exit', (code, signal) => {
      const exitObj = { exitCode: code ?? 0, signal };
      this.emit('exit', exitObj);
      for (const fn of this._exitListeners) {
        try { fn(exitObj); } catch {}
      }
    });

    proc.on('error', err => {
      const msg = `\r\n[pty error: ${err.message}]\r\n`;
      this.emit('data', msg);
      for (const fn of this._dataListeners) {
        try { fn(msg); } catch {}
      }
    });
  }

  write(data) {
    if (this._proc && this._proc.stdin && !this._proc.stdin.destroyed) {
      try {
        this._proc.stdin.write(data);
      } catch {}
    }
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
  }

  pause() {
    if (this._proc && this._proc.stdout) this._proc.stdout.pause();
    if (this._proc && this._proc.stderr) this._proc.stderr.pause();
  }

  resume() {
    if (this._proc && this._proc.stdout) this._proc.stdout.resume();
    if (this._proc && this._proc.stderr) this._proc.stderr.resume();
  }

  kill(signal) {
    if (this._proc) {
      try {
        this._proc.kill(signal || 'SIGTERM');
      } catch {}
    }
  }

  onData(fn) {
    this._dataListeners.push(fn);
    return {
      dispose: () => {
        this._dataListeners = this._dataListeners.filter(f => f !== fn);
      }
    };
  }

  onExit(fn) {
    this._exitListeners.push(fn);
    return {
      dispose: () => {
        this._exitListeners = this._exitListeners.filter(f => f !== fn);
      }
    };
  }

  removeAllListeners(event) {
    super.removeAllListeners(event);
    if (!event || event === 'data') this._dataListeners = [];
    if (!event || event === 'exit') this._exitListeners = [];
    return this;
  }
}

function spawn(file, args, options) {
  return new FallbackPty(file, args, options);
}

module.exports = { spawn };
