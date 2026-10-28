import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, createApp } from '../server.js';
import { openDb } from '../lib/db.js';

const MIN = 60 * 1000;
const H = 60 * MIN;
const PNG = `data:image/png;base64,${Buffer.from('png!').toString('base64')}`;
const quiet = { log() {}, warn() {}, error() {} };

// A WhatsApp manager that records sends instead of touching the network.
function fakeWhatsApp() {
  const sent = [];
  let linked = true;
  let failing = null;
  const conn = (userId) => ({
    status: () => ({ state: linked ? 'connected' : 'needs_link', pairingCode: null, error: null, phone: '15550001111' }),
    requestPairingCode: async () => 'ABCD1234',
    listGroups: async () => [{ jid: '111@g.us', name: 'Family', announce: false }, { jid: '222@g.us', name: 'Work', announce: true }],
    resolve: async (ref) => {
      if (ref.includes('whatsapp.com/channel/')) return { jid: '999@newsletter', name: 'My Channel', kind: 'channel' };
      if (ref.endsWith('@g.us')) return { jid: ref, name: ref === '111@g.us' ? 'Family' : 'Work', kind: 'group' };
      throw Object.assign(new Error('bad link'), { status: 400 });
    },
    send: async (jid, msg) => {
      if (!linked) throw Object.assign(new Error('WhatsApp is not linked yet — link it first'), { status: 503 });
      if (failing === jid) throw new Error('send failed');
      sent.push({ userId, jid, ...msg });
    },
    logout: async () => { linked = false; },
  });
  const conns = new Map();
  return {
    sent,
    setLinked: (v) => { linked = v; },
    setFailing: (v) => { failing = v; },
    get: (id) => (conns.has(id) ? conns.get(id) : conns.set(id, conn(id)).get(id)),
    startAll: async () => 0,
    remove: async () => {},
  };
}

async function setup(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-28T12:00:00Z');
  const wa = fakeWhatsApp();
  const cfg = config({ DATA_DIR: dir, ...env });
  const app = await createApp(cfg, { wa, now: () => clock, log: quiet });
  await new Promise((r) => app.listen(0, r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;

  // One cookie jar per "browser".
  const client = () => {
    let cookie = '';
    return async (path, method = 'GET', body, headers = {}) => {
      const res = await fetch(`${base}/api/${path}`, {
        method,
        headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: method !== 'GET' ? (typeof body === 'string' ? body : JSON.stringify(body ?? {})) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
    };
  };
  return { app, wa, dir, client, advance: (ms) => { clock += ms; }, now: () => clock, base };
}

async function signedUp(client, email = 'max@example.com') {
  const c = client();
  const r = await c('signup', 'POST', { email, password: 'hunter2hunter2', name: 'Max', timeZone: 'UTC' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

test('sign up, log out, log in; wrong password is rejected', async (t) => {
  const { client } = await setup(t);
  const c = await signedUp(client);
  assert.equal((await c('me')).body.user.email, 'max@example.com');
  assert.equal((await c('me')).body.user.isAdmin, true, 'first account is the admin');

  assert.equal((await c('signup', 'POST', { email: 'MAX@example.com', password: 'whatever123' })).status, 409);
  await c('logout', 'POST');
  assert.equal((await c('me')).status, 401);
  assert.equal((await c('login', 'POST', { email: 'max@example.com', password: 'nope-nope' })).status, 401);
  assert.equal((await c('login', 'POST', { email: ' Max@Example.com ', password: 'hunter2hunter2' })).status, 200);
  assert.equal((await c('me')).status, 200);

  const second = await signedUp(client, 'other@example.com');
  assert.equal((await second('me')).body.user.isAdmin, false);
  assert.equal((await second('admin/users')).status, 403);
});

test('passwords are stored hashed, never in plain text', async (t) => {
  const { client, dir } = await setup(t);
  const c = await signedUp(client);
  await c('logout', 'POST');
  const db = await openDb(dir);
  const [user] = Object.values(db.data.users);
  assert.match(user.passHash, /^scrypt\$/);
  assert.ok(!JSON.stringify(db.data).includes('hunter2hunter2'));
});

test('state-changing calls need JSON from the same origin (CSRF)', async (t) => {
  const { client } = await setup(t);
  const c = await signedUp(client);
  assert.equal((await c('queue/settings', 'POST', 'paused=true', { 'content-type': 'application/x-www-form-urlencoded' })).status, 403);
  assert.equal((await c('queue/settings', 'POST', { paused: true }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c('queue/settings', 'POST', { paused: true })).status, 200);
});

test('accounts are isolated from each other', async (t) => {
  const { client } = await setup(t);
  const a = await signedUp(client, 'a@example.com');
  const b = await signedUp(client, 'b@example.com');
  const { user } = (await a('targets', 'POST', { ref: '111@g.us' })).body;
  const post = (await a('posts', 'POST', { text: 'hi', targets: [user.targets[0].id], when: { type: 'delay', delayMin: 60 } })).body;
  const id = post.scheduled[0].id;
  assert.equal((await b('posts')).body.scheduled.length, 0);
  assert.equal((await b(`posts/${id}`, 'DELETE')).status, 404);
  assert.equal((await b(`posts/${id}/send`, 'POST')).status, 404);
  assert.equal((await b('posts', 'POST', { text: 'x', targets: [user.targets[0].id], when: { type: 'now' } })).status, 400);
});

test('targets: pick a group, paste a channel link, no duplicates, list groups', async (t) => {
  const { client } = await setup(t);
  const c = await signedUp(client);
  assert.equal((await c('targets', 'POST', { ref: '111@g.us' })).status, 200);
  assert.equal((await c('targets', 'POST', { ref: '111@g.us' })).status, 409);
  const r = await c('targets', 'POST', { ref: 'https://whatsapp.com/channel/0029Vabc' });
  assert.deepEqual(r.body.user.targets.map((x) => [x.name, x.kind]), [['Family', 'group'], ['My Channel', 'channel']]);
  assert.equal((await c('targets', 'POST', { ref: 'hello' })).status, 400);
  const groups = (await c('whatsapp/groups')).body.groups;
  assert.deepEqual(groups.map((g) => [g.name, g.added]), [['Family', true], ['Work', false]]);
});

test('post now, in N minutes, at a time — to several targets, with footer + image', async (t) => {
  const { client, wa, app, advance, now } = await setup(t);
  const c = await signedUp(client);
  await c('me/settings', 'POST', { footer: '📲 Follow us' });
  await c('targets', 'POST', { ref: '111@g.us' });
  const { user } = (await c('targets', 'POST', { ref: 'https://whatsapp.com/channel/x' })).body;
  const both = user.targets.map((x) => x.id);

  const r = await c('posts', 'POST', { text: '*Hello*', image: PNG, targets: both, when: { type: 'now' } });
  assert.equal(r.body.sent, true);
  assert.deepEqual(wa.sent.map((s) => [s.jid, s.caption, s.image?.buf.toString()]), [
    ['111@g.us', '*Hello*\n\n📲 Follow us', 'png!'],
    ['999@newsletter', '*Hello*\n\n📲 Follow us', 'png!'],
  ]);
  assert.equal(r.body.history.length, 1);

  await c('posts', 'POST', { text: 'in 30', targets: [both[0]], when: { type: 'delay', delayMin: 30 } });
  await c('posts', 'POST', { text: 'at 2pm', targets: [both[0]], when: { type: 'at', at: now() + 2 * H } });
  const view = (await c('posts')).body;
  assert.deepEqual(view.scheduled.map((p) => [p.text, p.eta - now()]), [['in 30', 30 * MIN], ['at 2pm', 2 * H]]);

  advance(29 * MIN);
  await app.scheduler.tick();
  assert.equal(wa.sent.length, 2);
  advance(2 * MIN);
  await app.scheduler.tick();
  assert.equal(wa.sent.at(-1).caption.split('\n')[0], 'in 30');
  advance(2 * H);
  await app.scheduler.tick();
  assert.equal(wa.sent.at(-1).caption.split('\n')[0], 'at 2pm');
  assert.equal((await c('posts')).body.scheduled.length, 0);

  assert.equal((await c('posts', 'POST', { text: 'past', targets: [both[0]], when: { type: 'at', at: now() - H } })).status, 400);
});

test('daily repeat stays scheduled for the next day', async (t) => {
  const { client, wa, app, advance, now } = await setup(t);
  const c = await signedUp(client);
  const { user } = (await c('targets', 'POST', { ref: '111@g.us' })).body;
  await c('posts', 'POST', { text: 'daily', targets: [user.targets[0].id], when: { type: 'at', at: now() + H }, repeat: 'daily' });
  advance(H);
  await app.scheduler.tick();
  assert.equal(wa.sent.length, 1);
  const [p] = (await c('posts')).body.scheduled;
  assert.equal(p.eta, now() + 24 * H);
  assert.equal(p.repeat, 'daily');
});

test('queue drips one post per interval and can be reordered / paused', async (t) => {
  const { client, wa, app, advance } = await setup(t);
  const c = await signedUp(client);
  const { user } = (await c('targets', 'POST', { ref: '111@g.us' })).body;
  const target = [user.targets[0].id];
  await c('queue/settings', 'POST', { intervalMin: 60, startHour: 0, endHour: 0 });
  for (const n of ['A', 'B', 'C']) await c('posts', 'POST', { text: n, targets: target, when: { type: 'queue' } });

  let q = (await c('posts')).body.queue;
  await c(`posts/${q[2].id}/up`, 'POST'); // A, C, B
  await app.scheduler.tick();
  advance(30 * MIN);
  await app.scheduler.tick();
  assert.deepEqual(wa.sent.map((s) => s.caption), ['A']);
  advance(30 * MIN);
  await app.scheduler.tick();
  assert.deepEqual(wa.sent.map((s) => s.caption), ['A', 'C']);

  await c('queue/settings', 'POST', { paused: true });
  advance(5 * H);
  await app.scheduler.tick();
  assert.equal(wa.sent.length, 2);
  q = (await c('posts')).body.queue;
  assert.deepEqual(q.map((p) => p.text), ['B']);
});

test('a failed send retries in 5 minutes and only re-sends to targets it missed', async (t) => {
  const { client, wa, app, advance } = await setup(t);
  const c = await signedUp(client);
  await c('targets', 'POST', { ref: '111@g.us' });
  const { user } = (await c('targets', 'POST', { ref: '222@g.us' })).body;
  const ids = user.targets.map((x) => x.id);

  wa.setLinked(false);
  const r = await c('posts', 'POST', { text: 'hi', targets: ids, when: { type: 'now' } });
  assert.equal(r.body.sent, false);
  assert.match(r.body.scheduled[0].error, /not linked/);

  wa.setLinked(true);
  await app.scheduler.tick(); // still inside the retry delay
  assert.equal(wa.sent.length, 0);
  advance(5 * MIN);
  await app.scheduler.tick();
  assert.deepEqual(wa.sent.map((s) => s.jid), ['111@g.us', '222@g.us']);
  assert.equal((await c('posts')).body.scheduled.length, 0);

  // Second target fails: the first isn't sent twice on the retry.
  wa.setFailing('222@g.us');
  await c('posts', 'POST', { text: 'again', targets: ids, when: { type: 'now' } });
  assert.deepEqual(wa.sent.map((s) => s.jid), ['111@g.us', '222@g.us', '111@g.us']);
  wa.setFailing(null);
  advance(5 * MIN);
  await app.scheduler.tick();
  assert.deepEqual(wa.sent.map((s) => s.jid), ['111@g.us', '222@g.us', '111@g.us', '222@g.us']);
});

test('deleting a target removes posts that only went there; images are served to the owner only', async (t) => {
  const { client } = await setup(t);
  const c = await signedUp(client);
  await c('targets', 'POST', { ref: '111@g.us' });
  const { user } = (await c('targets', 'POST', { ref: '222@g.us' })).body;
  const [fam, work] = user.targets.map((x) => x.id);
  const r = await c('posts', 'POST', { text: 'only family', image: PNG, targets: [fam], when: { type: 'delay', delayMin: 60 } });
  await c('posts', 'POST', { text: 'both', targets: [fam, work], when: { type: 'delay', delayMin: 90 } });
  const imgId = r.body.scheduled[0].id;
  assert.equal((await c(`posts/${imgId}/image`)).body, 'png!');
  const other = await signedUp(client, 'x@example.com');
  assert.equal((await other(`posts/${imgId}/image`)).status, 404);

  const after = (await c(`targets/${fam}`, 'DELETE')).body;
  assert.deepEqual(after.scheduled.map((p) => [p.text, p.targets]), [['both', ['Work']]]);
});

test('billing off: no limits enforced beyond Pro; billing on: Free limits + upgrade', async (t) => {
  const off = await setup(t);
  const c1 = await signedUp(off.client);
  assert.equal((await c1('me')).body.user.plan, 'pro');

  const on = await setup(t, { BILLING_ENABLED: '1', STRIPE_WEBHOOK_SECRET: 'whsec_test' });
  const admin = await signedUp(on.client, 'admin@example.com');
  const c = await signedUp(on.client, 'free@example.com');
  const me = (await c('me')).body.user;
  assert.equal(me.plan, 'free');

  await c('targets', 'POST', { ref: '111@g.us' });
  const { user } = (await c('targets', 'POST', { ref: '222@g.us' })).body;
  assert.equal((await c('targets', 'POST', { ref: 'https://whatsapp.com/channel/x' })).status, 402, 'max 2 targets on Free');
  const target = [user.targets[0].id];
  const repeat = await c('posts', 'POST', { text: 'r', targets: target, when: { type: 'delay', delayMin: 5 }, repeat: 'daily' });
  assert.equal(repeat.status, 402, 'repeat is Pro-only');

  for (let i = 0; i < 10; i++) {
    assert.equal((await c('posts', 'POST', { text: `p${i}`, targets: target, when: { type: 'queue' } })).status, 200);
  }
  assert.equal((await c('posts', 'POST', { text: 'p11', targets: target, when: { type: 'queue' } })).status, 402, 'max 10 waiting on Free');

  // Upgrade via a (signed) Stripe webhook.
  const event = JSON.stringify({ type: 'checkout.session.completed', created: 1, data: { object: { client_reference_id: me.id, customer: 'cus_1', subscription: 'sub_1' } } });
  const ts = Math.floor(on.now() / 1000);
  const sig = `t=${ts},v1=${createHmac('sha256', 'whsec_test').update(`${ts}.${event}`).digest('hex')}`;
  const bad = await fetch(`${on.base}/api/billing/webhook`, { method: 'POST', body: event, headers: { 'stripe-signature': 'nope' } });
  assert.equal(bad.status, 400);
  const good = await fetch(`${on.base}/api/billing/webhook`, { method: 'POST', body: event, headers: { 'stripe-signature': sig } });
  assert.equal(good.status, 200);
  assert.equal((await c('me')).body.user.plan, 'pro');
  assert.equal((await c('posts', 'POST', { text: 'p11', targets: target, when: { type: 'queue' } })).status, 200);

  // Admin can force a plan either way.
  await admin(`admin/users/${me.id}`, 'POST', { planOverride: 'free' });
  assert.equal((await c('me')).body.user.plan, 'free');
  const list = (await admin('admin/users')).body.users;
  assert.equal(list.find((u) => u.email === 'free@example.com').pending, 11);
});

test('admin can disable an account and reset its password', async (t) => {
  const { client } = await setup(t);
  const admin = await signedUp(client, 'admin@example.com');
  const u = await signedUp(client, 'user@example.com');
  const { id } = (await u('me')).body.user;

  await admin(`admin/users/${id}`, 'POST', { disabled: true });
  assert.equal((await u('me')).status, 401);
  assert.equal((await client()('login', 'POST', { email: 'user@example.com', password: 'hunter2hunter2' })).status, 403);
  await admin(`admin/users/${id}`, 'POST', { disabled: false });

  const { tempPassword } = (await admin(`admin/users/${id}/reset-password`, 'POST')).body;
  const fresh = client();
  assert.equal((await fresh('login', 'POST', { email: 'user@example.com', password: 'hunter2hunter2' })).status, 401);
  assert.equal((await fresh('login', 'POST', { email: 'user@example.com', password: tempPassword })).status, 200);
});

test('delete account removes everything', async (t) => {
  const { client, app } = await setup(t);
  const c = await signedUp(client);
  const { user } = (await c('targets', 'POST', { ref: '111@g.us' })).body;
  await c('posts', 'POST', { text: 'x', targets: [user.targets[0].id], when: { type: 'queue' } });
  assert.equal((await c('me', 'DELETE', { password: 'wrong' })).status, 401);
  assert.equal((await c('me', 'DELETE', { password: 'hunter2hunter2' })).status, 200);
  assert.deepEqual(app.db.data.users, {});
  assert.deepEqual(app.db.data.posts, {});
  assert.equal((await c('me')).status, 401);
});

test('static page and health check', async (t) => {
  const { base } = await setup(t);
  assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<title>Auto Poster<\/title>/);
  assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 400);
});
