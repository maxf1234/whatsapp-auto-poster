import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { applyStripeEvent, createStripe, planOf, verifyStripeSignature } from '../lib/billing.js';

const sign = (body, secret, t) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('billing off = everyone is Pro', () => {
  assert.equal(planOf({}, { billingEnabled: false }), 'pro');
  assert.equal(planOf({}, { billingEnabled: true }), 'free');
  assert.equal(planOf({ subscription: { status: 'active' } }, { billingEnabled: true }), 'pro');
  assert.equal(planOf({ subscription: { status: 'canceled' } }, { billingEnabled: true }), 'free');
  assert.equal(planOf({ subscription: { status: 'canceled' }, planOverride: 'pro' }, { billingEnabled: true }), 'pro');
});

test('Stripe signature check', () => {
  const now = 1_800_000_000_000;
  const t = now / 1000;
  const body = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature(body, sign(body, 'whsec_x', t), 'whsec_x', { now }), true);
  assert.equal(verifyStripeSignature(body, sign(body, 'whsec_other', t), 'whsec_x', { now }), false);
  assert.equal(verifyStripeSignature(`${body} `, sign(body, 'whsec_x', t), 'whsec_x', { now }), false);
  assert.equal(verifyStripeSignature(body, sign(body, 'whsec_x', t - 3600), 'whsec_x', { now }), false, 'too old');
  assert.equal(verifyStripeSignature(body, '', 'whsec_x', { now }), false);
});

test('Stripe events turn Pro on and off, ignoring stale ones', () => {
  const user = { id: 'u1', email: 'a@b.c' };
  const db = { data: { users: { u1: user } } };
  const cfg = { billingEnabled: true };

  applyStripeEvent(db, { type: 'checkout.session.completed', created: 10, data: { object: { client_reference_id: 'u1', customer: 'cus_1', subscription: 'sub_1' } } });
  assert.equal(user.stripeCustomerId, 'cus_1');
  assert.equal(planOf(user, cfg), 'pro');

  applyStripeEvent(db, { type: 'customer.subscription.deleted', created: 30, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
  assert.equal(planOf(user, cfg), 'free');

  // An older "active" update arriving late must not switch Pro back on.
  applyStripeEvent(db, { type: 'customer.subscription.updated', created: 20, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active' } } });
  assert.equal(planOf(user, cfg), 'free');
});

test('checkout request is form-encoded for Stripe', async () => {
  let sent;
  const stripe = createStripe({
    secretKey: 'sk_test',
    fetchImpl: async (url, init) => { sent = { url, init }; return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/x' }) }; },
  });
  const out = await stripe.checkout({ user: { id: 'u1', email: 'a@b.c' }, priceId: 'price_1', baseUrl: 'https://site' });
  assert.equal(out.url, 'https://checkout.stripe.com/x');
  assert.equal(sent.url, 'https://api.stripe.com/v1/checkout/sessions');
  const form = new URLSearchParams(sent.init.body.toString());
  assert.equal(form.get('line_items[0][price]'), 'price_1');
  assert.equal(form.get('client_reference_id'), 'u1');
  assert.equal(form.get('customer_email'), 'a@b.c');
  assert.equal(form.get('customer'), null);
});
