'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Feature scripts remain plain scripts. Evaluate an actual top-level function
// with explicit dependencies rather than copy its implementation into tests.
function sourceFunction(file, name) {
  const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  if (!match) throw new Error('Function not found: ' + name);
  const end = source.indexOf('\n}', match.index);
  if (end < 0) throw new Error('Function boundary not found: ' + name);
  return source.slice(match.index, end + 2);
}
function clientFunction(file, name, globals = {}) {
  return vm.runInNewContext('(' + sourceFunction(file, name) + ')', globals, { filename: file + ':' + name });
}
module.exports = { sourceFunction, clientFunction };
