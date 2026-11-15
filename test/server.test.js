import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
    statusAudience: async ({ contacts, groups = [], numbers = [] }) => [
      ...(contacts ? ['1000@s.whatsapp.net', '1001@s.whatsapp.net'] : []),
      ...groups.flatMap((g) => (g === '111@g.us' ? ['2000@s.whatsapp.net'] : [])),
      ...numbers.map((n) => `${n}@s.whatsapp.net`),
      '15550001111@s.whatsapp.net',
    ],
    send: async (jid, msg, opts) => {
      if (!linked) throw Object.assign(new Error('WhatsApp is not linked yet — link it first'), { status: 503 });
      if (failing === jid) throw new Error('send failed');
      sent.push({ userId, jid, ...msg, ...(opts ? { opts } : {}) });
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

async function setup(t, env = {}, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-28T12:00:00Z');
  const wa = fakeWhatsApp();
  const cfg = config({ DATA_DIR: dir, ...env });
  const mails = [];
  const mailer = { enabled: true, send: async (m) => { mails.push(m); return true; } };
  const app = await createApp(cfg, { wa, now: () => clock, log: quiet, mailer, ...extra });
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
  return { mails, app, wa, dir, client, advance: (ms) => { clock += ms; }, now: () => clock, base };
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

  const on = await setup(t, { BILLING_ENABLED: '1', STRIPE_WEBHOOK_SECRET: 'whsec_test', TRIAL_DAYS: '0' });
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

test('Status: needs an audience, sends with the audience list and colour', async (t) => {
  const { client, wa } = await setup(t);
  const c = await signedUp(client);
  assert.equal((await c('targets', 'POST', { ref: 'status', audience: {} })).status, 400, 'nobody chosen');
  const r = await c('targets', 'POST', { ref: 'status', audience: { contacts: true, groups: ['111@g.us', 'junk'], numbers: '+1 (555) 222-3333\n12' }, color: '#7c4dff' });
  assert.equal(r.status, 200);
  const status = r.body.user.targets[0];
  assert.deepEqual([status.kind, status.name, status.color], ['status', 'My Status', '#7c4dff']);
  assert.deepEqual(status.audience, { contacts: true, groups: ['111@g.us'], numbers: ['15552223333'] });
  assert.equal(status.audienceSummary, 'your contacts, 1 group, 1 number');
  assert.equal((await c('targets', 'POST', { ref: 'status', audience: { contacts: true } })).status, 409, 'only one Status');

  const { user } = (await c('targets', 'POST', { ref: '111@g.us' })).body;
  await c('posts', 'POST', { text: 'Hello status', targets: user.targets.map((x) => x.id), when: { type: 'now' } });
  const [toStatus, toGroup] = wa.sent;
  assert.equal(toStatus.jid, 'status@broadcast');
  assert.equal(toStatus.opts.backgroundColor, '#7c4dff');
  assert.deepEqual(toStatus.opts.statusJidList.sort(), ['1000@s.whatsapp.net', '1001@s.whatsapp.net', '15550001111@s.whatsapp.net', '15552223333@s.whatsapp.net', '2000@s.whatsapp.net']);
  assert.equal(toGroup.jid, '111@g.us');
  assert.equal(toGroup.opts, undefined);

  // Edit the audience; an audience that resolves to nobody but you fails the send.
  const edited = await c(`targets/${status.id}`, 'POST', { audience: { groups: ['999@g.us'] }, color: 'not-a-colour' });
  assert.equal(edited.body.user.targets[0].color, '#128c7e', 'unknown colours fall back to the default');
  const fail = await c('posts', 'POST', { text: 'x', targets: [status.id], when: { type: 'now' } });
  assert.equal(fail.body.sent, false);
  assert.match(fail.body.error, /Nobody would see/);
  assert.equal((await c(`targets/${user.targets[1].id}`, 'POST', { audience: { contacts: true } })).status, 400, 'groups have no audience');
});

test('account: preferences, email change, stats and export', async (t) => {
  const { client, wa } = await setup(t);
  const c = await signedUp(client);
  const first = (await c('me')).body.user;
  assert.deepEqual(first.prefs, { theme: 'system', confirmNow: true, defaultWhen: 'last', compact: false });
  assert.deepEqual(first.stats, { pending: 0, sentTotal: 0 });

  const saved = (await c('me/settings', 'POST', { prefs: { theme: 'dark', confirmNow: false, defaultWhen: 'queue' } })).body.user;
  assert.deepEqual(saved.prefs, { theme: 'dark', confirmNow: false, defaultWhen: 'queue', compact: false });
  assert.equal((await c('me/settings', 'POST', { prefs: { theme: 'neon' } })).status, 400);
  assert.equal((await c('me/settings', 'POST', { prefs: { defaultWhen: 'someday' } })).status, 400);
  assert.equal((await c('me')).body.user.prefs.theme, 'dark', 'a rejected change leaves the old value');

  // Email: needs the password, must be valid and unused.
  await signedUp(client, 'taken@example.com');
  assert.equal((await c('me/email', 'POST', { email: 'new@example.com', password: 'wrong' })).status, 401);
  assert.equal((await c('me/email', 'POST', { email: 'not-an-email', password: 'hunter2hunter2' })).status, 400);
  assert.equal((await c('me/email', 'POST', { email: 'TAKEN@example.com', password: 'hunter2hunter2' })).status, 409);
  assert.equal((await c('me/email', 'POST', { email: ' New@Example.com ', password: 'hunter2hunter2' })).body.user.email, 'new@example.com');
  assert.equal((await client()('login', 'POST', { email: 'max@example.com', password: 'hunter2hunter2' })).status, 401);
  assert.equal((await client()('login', 'POST', { email: 'new@example.com', password: 'hunter2hunter2' })).status, 200);

  // Stats count what was sent and what is waiting.
  const { user } = (await c('targets', 'POST', { ref: '111@g.us' })).body;
  const tid = user.targets[0].id;
  await c('posts', 'POST', { text: 'sent one', targets: [tid], when: { type: 'now' } });
  await c('posts', 'POST', { text: 'waiting one', targets: [tid], when: { type: 'queue' } });
  assert.equal(wa.sent.length, 1);
  assert.deepEqual((await c('me')).body.user.stats, { pending: 1, sentTotal: 1 });

  // Export holds the account's data and none of its secrets.
  const exp = await c('me/export');
  assert.equal(exp.status, 200);
  assert.equal(exp.body.account.email, 'new@example.com');
  assert.equal(exp.body.posts.length, 1);
  assert.equal(exp.body.posts[0].text, 'waiting one');
  assert.equal(exp.body.history[0].text, 'sent one');
  assert.ok(!JSON.stringify(exp.body).includes('scrypt$'), 'no password hash in the export');
  assert.ok(!('passHash' in exp.body.account));
});

test('sessions: list devices, log out one, log out all others', async (t) => {
  const { client } = await setup(t);
  const laptop = client();
  const ua = (s) => ({ 'user-agent': s });
  const chromeWin = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const safariPhone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  await laptop('signup', 'POST', { email: 'max@example.com', password: 'hunter2hunter2' }, ua(chromeWin));
  const phone = client();
  await phone('login', 'POST', { email: 'max@example.com', password: 'hunter2hunter2' }, ua(safariPhone));
  const tablet = client();
  await tablet('login', 'POST', { email: 'max@example.com', password: 'hunter2hunter2' });

  const list = (await laptop('me/sessions')).body.sessions;
  assert.equal(list.length, 3);
  assert.equal(list.filter((s) => s.current).length, 1);
  assert.equal(list.find((s) => s.current).device, 'Chrome on Windows');
  assert.ok(list.some((s) => s.device === 'Safari on iOS'));
  assert.ok(!JSON.stringify(list).includes('userAgent'), 'raw user agents are not sent');

  // Another account can't see or end these.
  const other = await signedUp(client, 'other@example.com');
  const phoneId = list.find((s) => s.device === 'Safari on iOS').id;
  assert.equal((await other(`me/sessions/${phoneId}`, 'DELETE')).status, 404);
  assert.equal((await phone('me')).status, 200);

  assert.equal((await laptop(`me/sessions/${phoneId}`, 'DELETE')).status, 200);
  assert.equal((await phone('me')).status, 401, 'the phone is logged out');
  assert.equal((await tablet('me')).status, 200);

  assert.equal((await laptop('me/sessions/revoke-others', 'POST')).body.ended, 1);
  assert.equal((await tablet('me')).status, 401);
  assert.equal((await laptop('me')).status, 200, 'the device that asked stays logged in');
  assert.equal((await other('me')).status, 200, 'other accounts are untouched');
});

test('admin: make and remove admins, delete accounts, see totals', async (t) => {
  const { client, app } = await setup(t, { ADMIN_EMAILS: 'boss@example.com' });
  const owner = await signedUp(client, 'owner@example.com');
  const u = await signedUp(client, 'user@example.com');
  const boss = await signedUp(client, 'boss@example.com');
  const ownerId = (await owner('me')).body.user.id;
  const userId = (await u('me')).body.user.id;
  const bossId = (await boss('me')).body.user.id;

  // A regular account can do none of this.
  assert.equal((await u(`admin/users/${ownerId}`, 'POST', { isAdmin: false })).status, 403);
  assert.equal((await u(`admin/users/${ownerId}`, 'DELETE')).status, 403);
  assert.equal((await u(`admin/users/${userId}`, 'POST', { isAdmin: true })).status, 403, 'nobody can promote themselves');
  assert.equal((await u('me')).body.user.isAdmin, false);

  // Promote, then demote.
  assert.equal((await owner(`admin/users/${userId}`, 'POST', { isAdmin: true })).status, 200);
  assert.equal((await u('me')).body.user.isAdmin, true);
  assert.equal((await u('admin/users')).status, 200);
  assert.equal((await owner(`admin/users/${userId}`, 'POST', { isAdmin: false })).status, 200);
  assert.equal((await u('admin/users')).status, 403);

  // Guards: not yourself, and not an admin named in ADMIN_EMAILS.
  assert.equal((await owner(`admin/users/${ownerId}`, 'POST', { isAdmin: false })).status, 400);
  assert.equal((await owner('me')).body.user.isAdmin, true);
  assert.equal((await owner(`admin/users/${bossId}`, 'POST', { isAdmin: false })).status, 400);
  assert.equal((await boss('me')).body.user.isAdmin, true);
  assert.equal((await owner(`admin/users/${ownerId}`, 'DELETE')).status, 400);

  const { users, stats } = (await owner('admin/users')).body;
  assert.equal(stats.accounts, 3);
  assert.equal(stats.newThisWeek, 3);
  assert.equal(users.find((x) => x.id === ownerId).isYou, true);
  assert.equal(users.find((x) => x.id === bossId).adminByConfig, true);

  // Deleting an account removes its posts and logs it out.
  const { user } = (await u('targets', 'POST', { ref: '111@g.us' })).body;
  await u('posts', 'POST', { text: 'bye', targets: [user.targets[0].id], when: { type: 'queue' } });
  assert.equal((await owner(`admin/users/${userId}`, 'DELETE')).status, 200);
  assert.equal((await u('me')).status, 401);
  assert.equal(app.db.data.users[userId], undefined);
  assert.equal(Object.values(app.db.data.posts).filter((p) => p.userId === userId).length, 0);
  assert.equal((await owner('admin/users')).body.stats.accounts, 2);
  assert.equal((await owner(`admin/users/${userId}`, 'DELETE')).status, 404);
});

// ---------- growth, pricing and feature additions ----------

const DAYMS = 24 * H;
async function stripeEvent(env, event) {
  const body = JSON.stringify(event);
  const ts = Math.floor(env.now() / 1000);
  const sig = `t=${ts},v1=${createHmac('sha256', 'whsec_test').update(`${ts}.${body}`).digest('hex')}`;
  const res = await fetch(`${env.base}/api/billing/webhook`, { method: 'POST', body, headers: { 'stripe-signature': sig } });
  assert.equal(res.status, 200);
}
const BILLING = { BILLING_ENABLED: '1', STRIPE_WEBHOOK_SECRET: 'whsec_test', BASE_URL: 'https://app.test' };

test('free trial: Pro for 7 days, then Free with a "Sent with" line', async (t) => {
  const env = await setup(t, BILLING);
  const c = await signedUp(env.client);
  let me = (await c('me')).body.user;
  assert.equal(me.plan, 'pro');
  assert.ok(me.trialEndsAt > env.now());
  assert.equal(me.branding, '');
  assert.match(env.mails[0].subject, /Welcome/);
  const { user } = (await c('targets', 'POST', { ref: '111@g.us' })).body;

  env.advance(5.5 * DAYMS);
  await env.app.runJobs();
  assert.ok(env.mails.some((m) => /trial ends soon/.test(m.subject)));
  env.advance(2 * DAYMS);
  me = (await c('me')).body.user;
  assert.equal(me.plan, 'free');
  assert.equal(me.trialEndsAt, null);
  const r = await c('posts', 'POST', { text: 'hello', targets: [user.targets[0].id], when: { type: 'now' } });
  assert.equal(r.body.sent, true);
  assert.equal(env.wa.sent.at(-1).caption, 'hello\n\n_Sent with Auto Poster_');
});

test('forgot password: emailed link works once', async (t) => {
  const env = await setup(t);
  const c = await signedUp(env.client);
  const anon = env.client();
  assert.equal((await anon('forgot', 'POST', { email: 'nobody@example.com' })).status, 200, 'does not reveal accounts');
  assert.equal(env.mails.filter((m) => /Reset/.test(m.subject)).length, 0);
  await anon('forgot', 'POST', { email: 'max@example.com' });
  const token = /#\/reset\/([\w-]+)/.exec(env.mails.at(-1).text)[1];
  assert.equal((await anon('reset', 'POST', { token: 'wrong', password: 'newpassword1' })).status, 400);
  assert.equal((await anon('reset', 'POST', { token, password: 'newpassword1' })).status, 200);
  assert.equal((await anon('me')).body.user.email, 'max@example.com', 'logged in after reset');
  assert.equal((await c('me')).status, 401, 'old sessions ended');
  assert.equal((await anon('reset', 'POST', { token, password: 'another12345' })).status, 400, 'single use');
  assert.equal((await env.client()('login', 'POST', { email: 'max@example.com', password: 'newpassword1' })).status, 200);
});

test('plans: Business + yearly checkout, plan switch, failed-payment email, referral reward, revenue', async (t) => {
  const calls = [];
  const stripe = { checkout: async (o) => { calls.push(o); return { url: 'https://stripe.test/pay' }; }, portal: async () => ({ url: 'x' }) };
  const env = await setup(t, { ...BILLING, TRIAL_DAYS: '0', STRIPE_SECRET_KEY: 'sk', STRIPE_PRICE_ID: 'price_pro', STRIPE_PRICE_ID_BUSINESS: 'price_biz', STRIPE_PRICE_ID_BUSINESS_YEARLY: 'price_biz_y', BUSINESS_YEARLY_LABEL: '$240 / year' }, { stripe });
  const admin = await signedUp(env.client, 'admin@example.com');
  const code = (await admin('me')).body.user.referral.code;
  const c = env.client();
  await c('signup', 'POST', { email: 'friend@example.com', password: 'hunter2hunter2', ref: code });
  const me = (await c('me')).body.user;
  assert.ok((await c('../api/config')).body.plans.business);
  assert.equal((await c('billing/checkout', 'POST', { plan: 'business', interval: 'year' })).body.url, 'https://stripe.test/pay');
  assert.equal(calls[0].priceId, 'price_biz_y');
  assert.equal(calls[0].plan, 'business');
  assert.equal((await c('billing/checkout', 'POST', { plan: 'pro', interval: 'year' })).status, 503, 'no yearly Pro price set');

  await stripeEvent(env, { type: 'checkout.session.completed', created: 1, data: { object: { client_reference_id: me.id, customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'business' } } } });
  assert.equal((await c('me')).body.user.plan, 'business');
  assert.equal((await c('me')).body.user.limits.maxTargets, 250);
  const ref = (await admin('me')).body.user;
  assert.equal(ref.referral.signups, 1);
  assert.equal(ref.referral.paid, 1);
  assert.ok(ref.proUntil > env.now() + 29 * DAYMS, 'referrer earned a month');
  assert.equal(ref.plan, 'pro');

  await stripeEvent(env, { type: 'customer.subscription.updated', created: 2, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_biz_y' } }] } } } });
  let stats = (await admin('admin/users')).body.stats;
  assert.equal(stats.paying, 1);
  assert.equal(stats.mrr, 20, '$240 a year = $20 a month');
  assert.equal(stats.conversion, 50);

  await stripeEvent(env, { type: 'customer.subscription.updated', created: 3, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'past_due', items: { data: [{ price: { id: 'price_pro' } }] } } } });
  assert.equal((await c('me')).body.user.plan, 'pro', 'switched plan in the portal; still on while Stripe retries');
  assert.ok(env.mails.some((m) => m.to === 'friend@example.com' && /payment didn/.test(m.subject)));
  assert.equal((await admin('admin/users')).body.stats.pastDue, 1);
});

test('bulk upload, templates, polls, PDF attachments', async (t) => {
  const env = await setup(t);
  const c = await signedUp(env.client);
  const { user } = (await c('targets', 'POST', { ref: '111@g.us' })).body;
  const targets = [user.targets[0].id];
  const at = env.now() + 2 * H;
  const bulk = await c('posts/bulk', 'POST', { targets, items: [{ text: 'one', at }, { text: 'two' }, { text: 'three' }] });
  assert.equal(bulk.body.added, 3);
  assert.equal(bulk.body.scheduled.length, 1);
  assert.equal(bulk.body.queue.length, 2);
  const bad = await c('posts/bulk', 'POST', { targets, items: [{ text: 'ok' }, { text: '', at }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Row 2/);
  assert.equal((await c('posts')).body.queue.length, 2, 'all or nothing');

  const tpl = (await c('templates', 'POST', { name: 'Promo', text: 'Big sale *today*' })).body.user.templates;
  assert.equal(tpl[0].name, 'Promo');
  assert.equal((await c(`templates/${tpl[0].id}`, 'DELETE')).body.user.templates.length, 0);

  const poll = await c('posts', 'POST', { text: 'Pizza or pasta?', targets, when: { type: 'now' }, poll: { options: ['Pizza', 'Pasta', 'Pizza'] } });
  assert.equal(poll.body.sent, true);
  assert.deepEqual(env.wa.sent.at(-1).poll, { options: ['Pizza', 'Pasta'], multi: false });
  assert.equal((await c('posts', 'POST', { text: 'q', targets, when: { type: 'now' }, poll: { options: ['only one'] } })).status, 400);

  const pdf = `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}`;
  const doc = await c('posts', 'POST', { text: 'menu', image: pdf, fileName: 'menu.pdf', targets, when: { type: 'now' } });
  assert.equal(doc.body.sent, true);
  assert.equal(env.wa.sent.at(-1).image.type, 'application/pdf');
  assert.equal(env.wa.sent.at(-1).image.name, 'menu.pdf');
  assert.equal((await c('posts', 'POST', { text: 'x', image: 'data:text/html;base64,AAAA', targets, when: { type: 'now' } })).status, 400);
});

test('tracked links count clicks; AI writer and feeds are paid features', async (t) => {
  const feed = { items: [{ id: 'a', title: 'Old deal', link: 'https://shop.test/a' }] };
  const env = await setup(t, { ...BILLING, TRIAL_DAYS: '0' }, {
    captioner: async ({ prompt, tone }) => `AI(${tone}): ${prompt}`,
    feedFetcher: async (url) => { if (!url.startsWith('https://')) throw Object.assign(new Error('bad'), { status: 400 }); return feed.items; },
  });
  const admin = await signedUp(env.client, 'admin@example.com');
  const c = await signedUp(env.client, 'u@example.com');
  const me = (await c('me')).body.user;
  const { user } = (await c('targets', 'POST', { ref: '111@g.us' })).body;
  const targets = [user.targets[0].id];
  assert.equal((await c('posts', 'POST', { text: 'see https://shop.test/x', targets, when: { type: 'queue' }, track: true })).status, 402);
  assert.equal((await c('ai/caption', 'POST', { prompt: 'summer sale' })).status, 402);
  assert.equal((await c('feeds', 'POST', { url: 'https://shop.test/feed', targets })).status, 402);

  await admin(`admin/users/${me.id}`, 'POST', { planOverride: 'pro' });
  assert.equal((await c('ai/caption', 'POST', { prompt: 'summer sale', tone: 'excited' })).body.text, 'AI(excited): summer sale');

  const r = await c('posts', 'POST', { text: 'see https://shop.test/x?y=1 now', targets, when: { type: 'queue' }, track: true });
  const short = /https:\/\/app\.test\/l\/([\w-]+)/.exec(r.body.queue[0].text);
  assert.ok(short, r.body.queue[0].text);
  const hit = await fetch(`${env.base}/l/${short[1]}`, { redirect: 'manual' });
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get('location'), 'https://shop.test/x?y=1');
  const links = (await c('links')).body;
  assert.equal(links.total, 1);
  assert.equal(links.links[0].clicks, 1);
  assert.equal((await fetch(`${env.base}/l/nope`)).status, 404);

  const added = await c('feeds', 'POST', { url: 'https://shop.test/feed', targets, template: '🔥 {title}\n{link}' });
  assert.equal(added.body.user.feeds.length, 1);
  await env.app.runJobs();
  assert.equal((await c('posts')).body.queue.length, 1, 'items already in the feed are not posted');
  feed.items.unshift({ id: 'b', title: 'New deal', link: 'https://shop.test/b' });
  env.advance(16 * MIN);
  await env.app.runJobs();
  const q = (await c('posts')).body.queue;
  assert.equal(q.length, 2);
  assert.equal(q[1].text, '🔥 New deal\nhttps://shop.test/b');
  env.advance(16 * MIN);
  await env.app.runJobs();
  assert.equal((await c('posts')).body.queue.length, 2, 'no duplicates');
  assert.equal((await c(`feeds/${added.body.user.feeds[0].id}`, 'DELETE')).body.user.feeds.length, 0);
});

test('jobs: daily backup, unlink alert, link-WhatsApp reminder; daily send cap', async (t) => {
  const env = await setup(t, { DAILY_SEND_CAP: '2' });
  const c = await signedUp(env.client);
  const { user } = (await c('targets', 'POST', { ref: '111@g.us' })).body;
  const targets = [user.targets[0].id];
  await env.app.runJobs();
  assert.deepEqual(await readdir(join(env.dir, 'backups')), ['db-2026-10-28.json']);
  assert.match((await c('admin/backup')).body.users[user.id].email, /max@/);

  env.wa.setLinked(false);
  await env.app.runJobs();
  assert.ok(env.mails.some((m) => /WhatsApp was unlinked/.test(m.subject)));
  const count = env.mails.length;
  await env.app.runJobs();
  assert.equal(env.mails.length, count, 'only once');
  env.wa.setLinked(true);

  for (let i = 0; i < 2; i++) assert.equal((await c('posts', 'POST', { text: `p${i}`, targets, when: { type: 'now' } })).body.sent, true);
  const over = await c('posts', 'POST', { text: 'p3', targets, when: { type: 'now' } });
  assert.equal(over.body.sent, false);
  assert.match(over.body.error, /Daily safety limit/);

  const env2 = await setup(t);
  env2.wa.setLinked(false);
  await signedUp(env2.client);
  env2.advance(25 * H);
  await env2.app.runJobs();
  assert.ok(env2.mails.some((m) => /link your WhatsApp/.test(m.subject)));
});

test('public pages: terms, privacy, landing pages, robots and sitemap', async (t) => {
  const env = await setup(t, { APP_NAME: 'PostPilot', BASE_URL: 'https://app.test' });
  for (const path of ['terms', 'privacy', 'schedule-whatsapp-messages', 'for/deal-channels']) {
    const res = await fetch(`${env.base}/${path}`);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /PostPilot/);
  }
  assert.match(await (await fetch(`${env.base}/robots.txt`)).text(), /Sitemap: https:\/\/app\.test\/sitemap\.xml/);
  assert.match(await (await fetch(`${env.base}/sitemap.xml`)).text(), /https:\/\/app\.test\/for\/real-estate/);
});
