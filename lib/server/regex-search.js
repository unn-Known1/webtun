'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const regex = new RegExp(workerData.pattern, 'gi');
  const matches = [];
  const lines = workerData.content.split('\n');
  for (let i = 0; i < lines.length && matches.length < workerData.limit; i++) {
    regex.lastIndex = 0;
    const match = regex.exec(lines[i]);
    if (match) matches.push({ line: i + 1, column: match.index, content: lines[i].slice(0, 500) });
  }
  parentPort.postMessage(matches);
} else {
  function matchRegex(pattern, content, limit, timeout = 1000) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { pattern, content, limit }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 } });
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        worker.terminate().catch(() => {});
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('Regex search exceeded its time budget; use a literal search or simplify the pattern'), { code: 'REGEX_TIMEOUT', status: 408 })), timeout);
      worker.once('message', result => finish(null, result));
      worker.once('error', error => finish(error));
      worker.once('exit', code => { if (!settled) finish(new Error('Regex search worker stopped (' + code + ')')); });
    });
  }
  module.exports = { matchRegex };
}
