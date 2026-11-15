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
  free: { label: 'Free', postsPerMonth: 30, maxPending: 10, maxTargets: 2, recurring: false, maxNumbers: 1, maxMembers: 0 },
  pro: { label: 'Pro', postsPerMonth: 3000, maxPending: 1000, maxTargets: 50, recurring: true, maxNumbers: 1, maxMembers: 0 },
  // Business and Agency are only offered when their Stripe price id is set.
  // They add more WhatsApp numbers and team members on one account.
  business: { label: 'Business', postsPerMonth: 20000, maxPending: 5000, maxTargets: 250, recurring: true, maxNumbers: 5, maxMembers: 5 },
  agency: { label: 'Agency', postsPerMonth: 100000, maxPending: 20000, maxTargets: 1000, recurring: true, maxNumbers: 25, maxMembers: 25 },
};
const paidPlan = (p) => (p && p !== 'free' && PLANS[p] ? p : 'pro');
export const isPaid = (plan) => plan !== 'free';

// Subscription states that keep Pro on (past_due = card failed, Stripe is
// still retrying — don't cut people off mid-retry).
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

export const isPaying = (user) => PAID_STATUSES.has(user.subscription?.status);

export function planOf(user, cfg, now = Date.now()) {
  if (!cfg.billingEnabled) return 'pro';
  if (user.planOverride && PLANS[user.planOverride]) return user.planOverride; // set by an admin
  if (isPaying(user)) return paidPlan(user.subscription.plan);
  // A free trial after signing up, or free months earned by referring people.
  if (user.trialEndsAt > now || user.proUntil > now) return 'pro';
  return 'free';
}

export const limitsOf = (user, cfg, now) => PLANS[planOf(user, cfg, now)];

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
    checkout: ({ user, priceId, baseUrl, plan = 'pro' }) => call('checkout/sessions', {
      metadata: { plan },
      subscription_data: { metadata: { plan } },
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
// `priceMap` is { priceId: { plan, interval } } so a plan switched in the
// Stripe portal is picked up too.
export function applyStripeEvent(db, event, priceMap = {}) {
  const obj = event.data?.object ?? {};
  const users = Object.values(db.data.users);
  if (event.type === 'checkout.session.completed') {
    const user = db.data.users[obj.client_reference_id];
    if (!user) return null;
    user.stripeCustomerId = obj.customer ?? user.stripeCustomerId;
    // Pro right away; the subscription event that follows sets the real status.
    user.subscription = { id: obj.subscription, status: 'active', updatedAt: event.created, plan: paidPlan(obj.metadata?.plan) };
    return user;
  }
  if (event.type?.startsWith('customer.subscription.')) {
    const user = users.find((u) => u.stripeCustomerId && u.stripeCustomerId === obj.customer);
    if (!user) return null;
    // Events can arrive out of order: never let an older one undo a newer one.
    if (user.subscription?.updatedAt > event.created) return user;
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
    const price = obj.items?.data?.[0]?.price;
    const known = priceMap[price?.id];
    const plan = known?.plan ?? obj.metadata?.plan ?? user.subscription?.plan ?? 'pro';
    const interval = known?.interval ?? price?.recurring?.interval ?? user.subscription?.interval ?? 'month';
    user.subscription = { id: obj.id, status, updatedAt: event.created, periodEnd: obj.current_period_end ?? null, plan: paidPlan(plan), interval };
    return user;
  }
  return null;
}
