'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const license = require('../lib/license');
const { createBillingService } = require('../lib/server/billing');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webtun-billing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pair = crypto.generateKeyPairSync('ed25519');
  process.env.WEBTUN_LICENSE_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' });
  t.after(() => { delete process.env.WEBTUN_LICENSE_PUBLIC_KEY; });
  license.initLicense(root);
  const config = { STRIPE_SECRET_KEY: 'dummy', STRIPE_WEBHOOK_SECRET: 'dummy-signature-secret', LICENSE_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  for (const plan of ['PRO', 'TEAM']) for (const term of ['MONTHLY', 'YEARLY']) config['STRIPE_PRICE_' + plan + '_' + term] = 'price_' + plan + '_' + term;
  const requests = [];
  const service = createBillingService({ license, config, statusJson: () => license.status(), fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/dummy' }) }; } });
  const response = () => ({ code: 200, body: null, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  async function event(type, obj, id = 'evt_fixture') {
    const body = Buffer.from(JSON.stringify({ id, type, data: { object: obj } }));
    const time = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', config.STRIPE_WEBHOOK_SECRET).update(time + '.').update(body).digest('hex');
    const res = response(); await service.webhook({ body, headers: { 'stripe-signature': `t=${time},v1=${signature}` } }, res); return res;
  }
  const sub = (plan, annual, seats) => ({ id: 'sub_fixture', current_period_end: Math.floor(Date.now() / 1000) + (annual ? 365 : 30) * 86400, items: { data: [{ price: { id: config['STRIPE_PRICE_' + plan.toUpperCase() + '_' + (annual ? 'YEARLY' : 'MONTHLY')] }, quantity: seats }] }, metadata: { seats: String(seats) } });
  return { root, config, service, requests, response, event, sub };
}
test('monthly/yearly Pro/Team keys use verified prices, seats and actual period ends', async t => {
  const f = await fixture(t);
  for (const plan of ['pro', 'team']) for (const annual of [false, true]) {
    const subscription = f.sub(plan, annual, plan === 'team' ? 6 : 1);
    const id = 'cs_test_' + plan + (annual ? 'Yearly' : 'Monthly');
    assert.equal((await f.event('checkout.session.completed', { id, payment_status: 'paid', subscription })).code, 200);
    const saved = license.loadPending()[id], payload = license.verifyKey(saved.key).payload;
    assert.equal(payload.plan, plan); assert.equal(payload.seats, plan === 'team' ? 6 : 1);
    assert.equal(payload.exp, subscription.current_period_end * 1000);
  }
});
test('checkout claim is consumed exactly once and replay cannot resurrect it', async t => {
  const f = await fixture(t), obj = { id: 'cs_test_once', payment_status: 'paid', subscription: f.sub('pro', false, 1) };
  await f.event('checkout.session.completed', obj);
  const a = f.response(); f.service.claim({ query: { session: obj.id } }, a); assert.match(a.body.key, /^wt1\./);
  await f.event('checkout.session.completed', obj);
  const b = f.response(); f.service.claim({ query: { session: obj.id } }, b); assert.equal(b.code, 410);
  assert.equal(license.loadPending()[obj.id].key, undefined);
});
test('invoice retries and alternate event ids create one renewal, activation consumes it', async t => {
  const f = await fixture(t), sub = f.sub('team', true, 6), price = sub.items.data[0].price;
  const obj = { id: 'in_once', paid: true, billing_reason: 'subscription_cycle', subscription: sub, lines: { data: [{ price, period: { end: sub.current_period_end } }] } };
  await f.event('invoice.payment_succeeded', obj); await f.event('invoice.payment_succeeded', obj, 'evt_duplicate');
  const keys = Object.keys(license.loadPending()); assert.equal(keys.length, 1); assert.match(keys[0], /^renew_/);
  const r = f.response(); f.service.renewalClaim({ body: { id: keys[0] } }, r);
  assert.equal(r.body.plan, 'team'); assert.equal(r.body.seats, 6); assert.equal(r.body.expiry, sub.current_period_end * 1000);
  const again = f.response(); f.service.renewalClaim({ body: { id: keys[0] } }, again); assert.equal(again.code, 404);
});
test('unpaid checkout, initial invoice and invalid signature do not mint licenses', async t => {
  const f = await fixture(t);
  await f.event('checkout.session.completed', { id: 'cs_test_unpaid', payment_status: 'unpaid', subscription: f.sub('pro', false, 1) });
  await f.event('invoice.payment_succeeded', { id: 'in_initial', paid: true, billing_reason: 'subscription_create' });
  const r = f.response(); await f.service.webhook({ body: Buffer.from('{}'), headers: { 'stripe-signature': 'bad' } }, r);
  assert.equal(r.code, 400); assert.deepEqual(license.loadPending(), {});
});
test('checkout carries term and seat quantity; older renewal cannot downgrade a newer key', async t => {
  const f = await fixture(t), response = f.response();
  await f.service.checkout({ body: { plan: 'team', seats: 6, annual: true }, protocol: 'https', get: () => 'example.invalid' }, response);
  const params = new URLSearchParams(f.requests[0].opts.body);
  assert.equal(params.get('line_items[0][quantity]'), '6'); assert.equal(params.get('subscription_data[metadata][annual]'), 'true');
  const sub = f.sub('pro', false, 1);
  await f.event('checkout.session.completed', { id: 'cs_test_new', payment_status: 'paid', subscription: f.sub('team', true, 6) });
  license.saveLicenseKey(license.claimPending('cs_test_new').key);
  await f.event('invoice.payment_succeeded', { id: 'in_old', paid: true, subscription: sub, lines: { data: [{ price: sub.items.data[0].price, period: { end: sub.current_period_end } }] } });
  const id = Object.keys(license.loadPending()).find(k => k.startsWith('renew_'));
  const r = f.response(); f.service.renewalClaim({ body: { id } }, r);
  assert.equal(r.code, 409); assert.ok(license.loadPending()[id].key); assert.equal(license.status().plan, 'team');
});
test('a license copied after init is visible after the post-migration reload', async t => {
  const f = await fixture(t), key = license.signLicense({ v: 1, plan: 'pro', seats: 1, iat: Date.now(), exp: Date.now() + 86400000 }, f.config.LICENSE_PRIVATE_KEY);
  await fs.writeFile(path.join(f.root, 'license.json'), JSON.stringify({ key }));
  license.loadLicense(); assert.equal(license.status().plan, 'pro');
});
test('customer billing portal uses customer id persisted from checkout webhook', async t => {
  const f = await fixture(t);
  await f.event('checkout.session.completed', { id: 'cs_test_portal', customer: 'cus_test_123', payment_status: 'paid', subscription: f.sub('pro', false, 1) });
  const res = f.response();
  await f.service.portal({ body: {}, protocol: 'https', get: () => 'example.invalid' }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.url, 'https://checkout.stripe.com/dummy');
  const portalCall = f.requests.find(r => r.url.includes('/v1/billing_portal/sessions'));
  assert.ok(portalCall);
  assert.equal(new URLSearchParams(portalCall.opts.body).get('customer'), 'cus_test_123');
});

