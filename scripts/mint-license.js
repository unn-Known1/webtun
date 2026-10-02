#!/usr/bin/env node
'use strict';

// Mint WebTun license keys (owner use only — keep the private key secret).
//
//   node scripts/mint-license.js --gen
//     Prints a fresh Ed25519 pair. Put the public half in the server env as
//     WEBTUN_LICENSE_PUBLIC_KEY and keep the private half offline.
//
//   node scripts/mint-license.js --plan pro --seats 1 --days 365
//     Signs a key with LICENSE_PRIVATE_KEY from the env (or --key <file>).
//     Team needs --plan team --seats 3..10.
//
// No new deps: uses lib/license.js plus node:crypto.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const licenseLib = require('../lib/license');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

if (process.argv.includes('--gen')) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  console.log('# Server env (safe to store on the box):');
  console.log('WEBTUN_LICENSE_PUBLIC_KEY=' + JSON.stringify(publicKey));
  console.log('# Private key (OFFLINE ONLY — never put this on the server):');
  console.log(privateKey);
  process.exit(0);
}

const plan = (arg('--plan') || 'pro').toLowerCase();
const seats = parseInt(arg('--seats') || (plan === 'team' ? '3' : '1'), 10);
const days = parseInt(arg('--days') || '365', 10);
if (plan !== 'pro' && plan !== 'team') { console.error('plan must be pro or team'); process.exit(1); }
if (!Number.isInteger(seats) || seats < 1 || seats > 10 || (plan === 'team' && seats < 3)) {
  console.error('seats must be 1-10 (team minimum 3)'); process.exit(1);
}
if (!Number.isInteger(days) || days < 1 || days > 1825) { console.error('days must be 1-1825'); process.exit(1); }

let priv = process.env.LICENSE_PRIVATE_KEY || '';
const keyFile = arg('--key');
if (!priv && keyFile) {
  try { priv = fs.readFileSync(path.resolve(keyFile), 'utf8'); } catch (e) {
    console.error('cannot read key file: ' + e.message); process.exit(1);
  }
}
priv = priv.replace(/\\n/g, '\n').trim();
if (!priv) { console.error('set LICENSE_PRIVATE_KEY or pass --key <file>'); process.exit(1); }

const now = Date.now();
const key = licenseLib.signLicense({ v: 1, plan, seats, exp: now + days * 24 * 3600 * 1000, iat: now }, priv);
console.log(key);
