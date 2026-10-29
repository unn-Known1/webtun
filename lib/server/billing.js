'use strict';

const crypto = require('crypto');
const { sendErr } = require('./errors');

function createBillingService({ license, statusJson, config = process.env, fetch: request = globalThis.fetch, now = Date.now }) {
  const configured = () => !!(config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET);
  const error = (message, status = 502) => Object.assign(new Error(message), { status });
  async function stripe(route, params) {
    const response = await request('https://api.stripe.com/v1/' + route, {
      method: params ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + config.STRIPE_SECRET_KEY, ...(params && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
      ...(params && { body: params.toString() }), signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw error('Billing provider request failed; retry or contact the server owner');
    return data;
  }
  function signatureOk(raw, header) {
    if (!Buffer.isBuffer(raw) || typeof header !== 'string') return false;
    const parts = header.split(',').map(v => v.trim().split('='));
    const t = Number(parts.find(p => p[0] === 't')?.[1]);
    if (!Number.isSafeInteger(t) || Math.abs(now() / 1000 - t) > 300) return false;
    const want = crypto.createHmac('sha256', config.STRIPE_WEBHOOK_SECRET).update(String(t) + '.').update(raw).digest();
    return parts.filter(p => p[0] === 'v1').some(p => {
      if (!/^[0-9a-f]{64}$/.test(p[1] || '')) return false;
      return crypto.timingSafeEqual(Buffer.from(p[1], 'hex'), want);
    });
  }
  async function subscriptionFor(value) {
    if (value && typeof value === 'object' && value.items?.data) return value;
    const id = typeof value === 'string' ? value : value?.id;
    if (!/^sub_[a-zA-Z0-9]{1,240}$/.test(id || '')) throw error('Paid subscription is missing');
    return stripe('subscriptions/' + encodeURIComponent(id));
  }
  function entitlement(subscription, invoice) {
    let selected;
    for (const item of subscription.items?.data || []) {
      const price = typeof item.price === 'string' ? item.price : item.price?.id;
      for (const plan of ['pro', 'team']) for (const term of ['MONTHLY', 'YEARLY']) {
        if (price && price === config['STRIPE_PRICE_' + plan.toUpperCase() + '_' + term]) {
          if (selected) throw error('Subscription has multiple WebTun prices');
          selected = { plan, item, price, annual: term === 'YEARLY' };
        }
      }
    }
    if (!selected) throw error('Subscription price is not configured for WebTun');
    const { plan, item, price, annual } = selected;
    // Existing flat-quantity subscriptions retain their verified metadata seat
    // count; new Team checkouts bill a quantity per seat.
    const seats = plan === 'pro' ? 1 : Number(item.quantity > 1 ? item.quantity : subscription.metadata?.seats);
    if (!Number.isInteger(seats) || seats < (plan === 'team' ? 3 : 1) || seats > 10) throw error('Subscription seats are invalid');
    const lines = invoice?.lines?.data || [];
    const line = lines.find(l => (typeof l.price === 'string' ? l.price : l.price?.id || l.pricing?.price_details?.price) === price);
    const end = invoice ? line?.period?.end : item.current_period_end || subscription.current_period_end;
    if (!Number.isSafeInteger(end) || end <= 0) throw error('Paid billing period is missing; no license was issued');
    return { plan, seats, annual, expiry: end * 1000 };
  }
  function publish(id, ent, email, resource, customer) {
    const prior = license.loadPending()[id];
    if (prior) return; // includes consumed records; never resurrect a claim
    const privateKey = (config.LICENSE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!privateKey) throw error('License signing is not configured', 501);
    const key = license.signLicense({ v: 1, plan: ent.plan, seats: ent.seats, exp: ent.expiry, iat: now() }, privateKey);
    const custId = typeof customer === 'string' ? customer : customer?.id;
    license.storePending(id, { key, ...ent, email: String(email || '').slice(0, 254), resource, ...(custId ? { customer: String(custId).slice(0, 120) } : {}), createdAt: now() });
  }
  async function checkout(req, res) {
    try {
      if (!configured()) throw error('Billing not configured — contact the server owner', 501);
      const { plan, seats: inputSeats, annual = false } = req.body || {};
      if (!['pro', 'team'].includes(plan) || typeof annual !== 'boolean') throw error('Choose Pro or Team and a monthly or yearly term', 400);
      const seats = inputSeats === undefined ? (plan === 'team' ? 3 : 1) : Number(inputSeats);
      if (!Number.isInteger(seats) || (plan === 'pro' ? seats !== 1 : seats < 3 || seats > 10)) throw error('Pro has one license; Team needs 3–10 seats', 400);
      const price = config['STRIPE_PRICE_' + plan.toUpperCase() + '_' + (annual ? 'YEARLY' : 'MONTHLY')];
      if (!price) throw error('Price not configured for this plan and term', 501);
      const base = req.protocol + '://' + req.get('host');
      const params = new URLSearchParams({ mode: 'subscription', success_url: base + '/billing-success.html?session={CHECKOUT_SESSION_ID}', cancel_url: base + '/' });
      params.set('line_items[0][price]', price);
      params.set('line_items[0][quantity]', String(plan === 'team' ? seats : 1));
      for (const prefix of ['metadata', 'subscription_data[metadata]']) {
        params.set(prefix + '[plan]', plan); params.set(prefix + '[seats]', String(seats)); params.set(prefix + '[annual]', String(annual));
      }
      const session = await stripe('checkout/sessions', params);
      if (typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) throw error('Billing provider did not return a checkout URL');
      res.json({ success: true, url: session.url });
    } catch (e) { sendErr(res, e); }
  }
  async function portal(req, res) {
    try {
      if (!config.STRIPE_SECRET_KEY) throw error('Billing not configured — contact the server owner', 501);
      let customer = typeof req.body?.customer === 'string' ? req.body.customer.trim() : '';
      if (!customer) {
        const all = license.loadPending ? license.loadPending() : {};
        const entries = Object.values(all || {}).filter(e => e && typeof e.customer === 'string').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (entries.length) customer = entries[0].customer;
      }
      if (!/^cus_[a-zA-Z0-9_]{1,240}$/.test(customer)) {
        throw error('No Stripe customer record found for this server — complete a checkout first or pass customer ID', 404);
      }
      const base = req.protocol + '://' + req.get('host');
      const params = new URLSearchParams({ customer, return_url: base + '/' });
      const session = await stripe('billing_portal/sessions', params);
      if (typeof session.url !== 'string' || (!session.url.startsWith('https://billing.stripe.com/') && !session.url.startsWith('https://checkout.stripe.com/'))) {
        throw error('Billing provider did not return a portal URL');
      }
      res.json({ success: true, url: session.url });
    } catch (e) { sendErr(res, e); }
  }
  function claim(req, res) {
    try {
      const id = req.query.session;
      if (!license.validClaim(id) || !id.startsWith('cs_')) throw error('Valid checkout session required', 400);
      const prior = license.loadPending()[id];
      if (prior?.claimedAt) return res.status(410).json({ error: 'This license was already claimed; use your saved key' });
      const entry = license.claimPending(id);
      if (!entry) return res.json({ success: true, pending: true });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, key: entry.key, plan: entry.plan, seats: entry.seats, expiry: entry.expiry });
    } catch (e) { sendErr(res, e); }
  }
  function renewals(_req, res) {
    try {
      const all = license.loadPending();
      const list = Object.entries(all).filter(([id, e]) => id.startsWith('renew_') && e.key && !e.claimedAt)
        .map(([id, e]) => ({ id, email: e.email || '', plan: e.plan, seats: e.seats, createdAt: e.createdAt, expiry: e.expiry }));
      res.json({ success: true, renewals: list.sort((a, b) => b.createdAt - a.createdAt) });
    } catch (e) { sendErr(res, e); }
  }
  function renewalClaim(req, res) {
    try {
      const id = req.body?.id;
      if (!license.validClaim(id) || !id.startsWith('renew_')) throw error('Valid renewal id required', 400);
      const entry = license.claimPending(id, e => {
        const verified = license.verifyKey(e.key);
        if (!verified.ok) throw error(verified.error, 400);
        if (verified.payload.exp < license.status().expiry) throw error('A newer license is already active; this renewal was kept', 409);
        license.saveLicenseKey(e.key);
      });
      if (!entry) throw error('Renewal not found or already claimed', 404);
      res.json(statusJson());
    } catch (e) { sendErr(res, e); }
  }
  async function webhook(req, res) {
    try {
      if (!configured()) throw error('Billing not configured', 501);
      if (!signatureOk(req.body, req.headers['stripe-signature'])) throw error('Invalid webhook signature', 400);
      let event;
      try { event = JSON.parse(req.body.toString('utf8')); } catch { throw error('Invalid webhook payload', 400); }
      const obj = event.data?.object;
      if (!obj || !/^evt_[a-zA-Z0-9_]{1,240}$/.test(event.id || '')) throw error('Invalid webhook event', 400);
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        if (obj.payment_status !== 'paid') return res.json({ received: true });
        if (!license.validClaim(obj.id) || !obj.id.startsWith('cs_')) throw error('Invalid checkout session', 400);
        if (!license.loadPending()[obj.id]) {
          const sub = await subscriptionFor(obj.subscription);
          publish(obj.id, entitlement(sub), obj.customer_details?.email, obj.id, obj.customer || sub.customer);
        }
      } else if (event.type === 'invoice.payment_succeeded') {
        // Initial invoices are delivered separately from Checkout completion.
        // Checkout owns that claim, so do not also enqueue a renewal for it.
        if (obj.billing_reason === 'subscription_create') return res.json({ received: true });
        if (!/^in_[a-zA-Z0-9_]{1,240}$/.test(obj.id || '') || obj.paid !== true) throw error('Paid invoice required', 400);
        const id = 'renew_' + crypto.createHash('sha256').update(obj.id).digest('hex');
        if (!license.loadPending()[id]) {
          const sub = await subscriptionFor(obj.subscription || obj.parent?.subscription_details?.subscription);
          publish(id, entitlement(sub, obj), obj.customer_email, obj.id, obj.customer || sub.customer);
        }
      }
      res.json({ received: true });
    } catch (e) { sendErr(res, e); }
  }
  return { checkout, portal, claim, renewals, renewalClaim, webhook, signatureOk, entitlement };
}

module.exports = { createBillingService };
