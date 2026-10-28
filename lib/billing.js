// Plans and payments.
//
// Billing is OFF until BILLING_ENABLED=1. While it's off, every account gets
// the Pro limits for free and the page hides all upgrade prompts, so you can
// launch now and switch payments on later without touching any code.
//
// When it's on, upgrades go through Stripe Checkout (a monthly subscription)
// and Stripe tells us about payments / cancellations via the webhook. No
// Stripe SDK — just its REST API with fetch and a signature check.

import { createHmac, timingSafeEqual } from 'node:crypto';

// Edit these to change what each plan allows.
export const PLANS = {
  free: { label: 'Free', postsPerMonth: 30, maxPending: 10, maxTargets: 2, recurring: false },
  pro: { label: 'Pro', postsPerMonth: 3000, maxPending: 1000, maxTargets: 50, recurring: true },
};

// Subscription states that keep Pro on (past_due = card failed, Stripe is
// still retrying — don't cut people off mid-retry).
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function planOf(user, cfg) {
  if (!cfg.billingEnabled) return 'pro';
  if (user.planOverride && PLANS[user.planOverride]) return user.planOverride; // set by an admin
  return PAID_STATUSES.has(user.subscription?.status) ? 'pro' : 'free';
}

export const limitsOf = (user, cfg) => PLANS[planOf(user, cfg)];

// ---------- Stripe ----------

// Stripe's form encoding: nested keys as a[b][0][c]=v.
function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export function createStripe({ secretKey, fetchImpl = fetch }) {
  async function call(path, params) {
    const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: formEncode(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error?.message || `Stripe error ${res.status}`), { status: 502 });
    return data;
  }
  return {
    checkout: ({ user, priceId, baseUrl }) => call('checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: user.id,
      customer: user.stripeCustomerId || undefined,
      customer_email: user.stripeCustomerId ? undefined : user.email,
      allow_promotion_codes: true,
      success_url: `${baseUrl}/?billing=success`,
      cancel_url: `${baseUrl}/?billing=cancelled`,
    }),
    portal: ({ user, baseUrl }) => call('billing_portal/sessions', { customer: user.stripeCustomerId, return_url: `${baseUrl}/` }),
  };
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.body">[,v1=…]
export function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  const parts = String(header || '').split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// Apply a (verified) Stripe event to our users. Returns the user it changed.
export function applyStripeEvent(db, event) {
  const obj = event.data?.object ?? {};
  const users = Object.values(db.data.users);
  if (event.type === 'checkout.session.completed') {
    const user = db.data.users[obj.client_reference_id];
    if (!user) return null;
    user.stripeCustomerId = obj.customer ?? user.stripeCustomerId;
    // Pro right away; the subscription event that follows sets the real status.
    user.subscription = { id: obj.subscription, status: 'active', updatedAt: event.created };
    return user;
  }
  if (event.type?.startsWith('customer.subscription.')) {
    const user = users.find((u) => u.stripeCustomerId && u.stripeCustomerId === obj.customer);
    if (!user) return null;
    // Events can arrive out of order: never let an older one undo a newer one.
    if (user.subscription?.updatedAt > event.created) return user;
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
    user.subscription = { id: obj.id, status, updatedAt: event.created, periodEnd: obj.current_period_end ?? null };
    return user;
  }
  return null;
}
