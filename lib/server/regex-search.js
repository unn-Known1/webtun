'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  parentPort.on('message', (msg) => {
    const { id, pattern, content, limit } = msg || {};
    const matches = [];
    try {
      const regex = new RegExp(pattern, 'gi');
      const lines = String(content).split('\n');
      for (let i = 0; i < lines.length && matches.length < (limit || 100); i++) {
        regex.lastIndex = 0;
        const match = regex.exec(lines[i]);
        if (match) matches.push({ line: i + 1, column: match.index, content: lines[i].slice(0, 500) });
      }
    } catch (e) {
      parentPort.postMessage({ id, error: String(e && e.message || e) });
      return;
    }
    parentPort.postMessage({ id, matches });
  });
} else {
  let worker = null;
  const pending = new Map();
  let nextId = 1;

  function getWorker() {
    if (worker) return worker;
    const w = new Worker(__filename, { resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 } });
    worker = w;
    try { w.unref(); } catch {}
    w.on('message', (msg) => {
      const p = pending.get(msg.id);
      if (!p || p.worker !== w) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.matches);
    });
    w.on('error', (err) => {
      for (const [id, p] of [...pending.entries()]) {
        if (p.worker !== w) continue;
        pending.delete(id); p.reject(err);
      }
      try { w.terminate(); } catch {}
      if (worker === w) worker = null;
    });
    w.on('exit', (code) => {
      if (code !== 0) {
        const err = new Error('Regex worker exited (' + code + ')');
        for (const [id, p] of [...pending.entries()]) {
          if (p.worker !== w) continue;
          pending.delete(id); p.reject(err);
        }
      }
      if (worker === w) worker = null;
    });
    return worker;
  }

  function matchRegex(pattern, content, limit, timeout = 1000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const w = getWorker();
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        try { w.terminate(); } catch {}
        worker = null;
        reject(Object.assign(new Error('Regex search exceeded its time budget; use a literal search or simplify the pattern'), { code: 'REGEX_TIMEOUT', status: 408 }));
      }, timeout);
      pending.set(id, {
        worker: w,
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { w.postMessage({ id, pattern, content, limit }); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  module.exports = { matchRegex };
}