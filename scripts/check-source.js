'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname,'..');
let checked = 0;
function check(relative) {
  const filename = path.join(root,relative);
  const source = fs.readFileSync(filename,'utf8').replace(/^#![^\n]*\n/,'');
  new vm.Script(relative.startsWith('public/') ? source : '(function(require,module,exports,__dirname,__filename){\n'+source+'\n})',{ filename:relative });
  checked++;
}
function walk(relative) {
  for (const entry of fs.readdirSync(path.join(root,relative),{ withFileTypes:true })) {
    const file=path.join(relative,entry.name);
    if(entry.isDirectory()) walk(file);
    else if(file.endsWith('.js')) check(file);
  }
}
for (const directory of ['lib','bin','electron','scripts','public/js','tests']) walk(directory);
for (const file of ['server.js','verify-version.js','playwright.config.js','public/sw.js','public/commands.js']) check(file);
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const localScripts=[...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]).filter(src=>!src.startsWith('https:'));
const frontend=localScripts.map(src=>fs.readFileSync(path.join(root,'public',src.replace(/^\//,'')),'utf8')).join('\n;\n');
new vm.Script(frontend,{ filename:'combined frontend' });
if (/<[^>]*\son(?:click|change|input|keydown|keyup)\s*=/i.test(html + frontend)) {
  throw new Error('Inline UI handlers found; name an action and register it in the feature script');
}
const precache=fs.readFileSync(path.join(root,'public/sw.js'),'utf8');
for (const src of localScripts) {
  const absolute='/'+src.replace(/^\//,'');
  if(!precache.includes("'"+absolute+"'")) throw new Error('Missing precache entry: '+absolute);
}
const registeredActions = new Set();
for (const regMatch of frontend.matchAll(/uiActions\.register\s*\(\s*['"][a-z]+['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
  for (const keyMatch of regMatch[1].matchAll(/['"]([a-z0-9-]+)['"]\s*:/gi)) {
    registeredActions.add(keyMatch[1]);
  }
}
const htmlActions = new Set();
for (const m of html.matchAll(/\bdata-(?:change-|input-|keydown-)?action="([^"]+)"/g)) {
  htmlActions.add(m[1]);
}
const missingActions = [...htmlActions].filter(a => !registeredActions.has(a));
if (missingActions.length > 0) {
  throw new Error('Unregistered data-action(s) in public/index.html: ' + missingActions.join(', '));
}
console.log('Source check: '+checked+' files parse; frontend declarations and precache agree');
