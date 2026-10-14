'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const result = spawnSync(process.execPath, ['--test', path.join(__dirname, '../tests/native/pty.test.js')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
