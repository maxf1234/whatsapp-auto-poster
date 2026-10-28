// WhatsApp Auto Poster: a multi-user version of the NBA channel poster.
//
// Anyone can sign up, link their own WhatsApp number with a pairing code,
// add the groups / channels they post to, and schedule posts in advance:
// send now, in N minutes, at an exact time (optionally every day / week),
// or drip them out through a queue (one every N hours inside active hours).
//
// Billing is built in but off until BILLING_ENABLED=1 (lib/billing.js).
//
// `npm start`

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { openDb } from './lib/db.js';
import {
  createRateLimiter, createSession, endAllSessions, endSession, hashPassword, normalizeEmail, pruneSessions,
  readCookie, sessionCookie, sessionUser, validEmail, verifyPassword, COOKIE,
} from './lib/auth.js';
import { applyStripeEvent, createStripe, limitsOf, planOf, PLANS, verifyStripeSignature } from './lib/billing.js';
import { createWhatsAppManager } from './lib/whatsapp.js';
import { createScheduler, DEFAULT_QUEUE, etas, queueOf } from './lib/scheduler.js';
import { isTimeZone, monthKey, REPEATS } from './lib/time.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = new URL('./public/', import.meta.url);
const MAX_BODY = 12 * 1024 * 1024; // base64 image + fields
const MAX_TEXT = 4000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const yes = (v) => /^(1|true|yes|on)$/i.test(v || '');

export function config(env = process.env) {
  // Railway volume mounted at /data keeps accounts, WhatsApp logins and
  // scheduled posts across deploys.
  const dataDir = env.DATA_DIR || (env.RAILWAY_ENVIRONMENT ? '/data' : './data');
  return {
    appName: env.APP_NAME || 'Auto Poster',
    dataDir,
    baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''),
    adminEmails: (env.ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean),
    signupsOpen: !/^(0|false|no|off|closed)$/i.test(env.SIGNUPS_OPEN || ''),
    defaultTimeZone: env.DEFAULT_TIMEZONE || 'America/New_York',
    dryRun: yes(env.DRY_RUN),
    billingEnabled: yes(env.BILLING_ENABLED),
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripePriceId: env.STRIPE_PRICE_ID || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    proPriceLabel: env.PRO_PRICE_LABEL || '$9 / month',
  };
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json' : 'text/plain',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readRaw(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw fail('Too large (images max ~8 MB)', 413);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  try {
    return JSON.parse((await readRaw(req)) || '{}');
  } catch (err) {
    throw err.status ? err : fail('Invalid JSON');
  }
}

function parseDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m || !IMAGE_TYPES.has(m[1])) return null;
  return { type: m[1], buf: Buffer.from(m[2], 'base64') };
}

export async function createApp(cfg = config(), { db, wa, now = Date.now, stripe, log = console } = {}) {
  db ??= await openDb(cfg.dataDir);
  wa ??= createWhatsAppManager({ dir: join(cfg.dataDir, 'wa') });
  stripe ??= cfg.stripeSecretKey ? createStripe({ secretKey: cfg.stripeSecretKey }) : null;
  const loginLimit = createRateLimiter({ now });
  const dummyHash = await hashPassword(randomBytes(16).toString('hex'));

  // The one place a post actually leaves: WhatsApp, or the log in dry-run.
  async function deliver(user, target, { caption, image }) {
    if (cfg.dryRun) {
      log.log(`[dry-run] ${user.email} → ${target.name}${image ? ' (+ image)' : ''}\n${caption}\n`);
      return;
    }
    await wa.get(user.id).send(target.jid, { caption, image });
  }
  const scheduler = createScheduler({ db, deliver, now, log, gapMs: cfg.dryRun ? 0 : undefined });

  // ---------- views ----------

  const isAdmin = (user) => Boolean(user.isAdmin || cfg.adminEmails.includes(user.email));

  function usage(user) {
    const month = monthKey(now(), user.timeZone);
    if (user.usage?.month !== month) user.usage = { month, created: 0 };
    return user.usage;
  }

  function userView(user) {
    const plan = planOf(user, cfg);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      timeZone: user.timeZone,
      footer: user.footer,
      isAdmin: isAdmin(user),
      plan,
      limits: PLANS[plan],
      usage: usage(user),
      subscription: user.subscription?.status ?? null,
      canManageBilling: Boolean(user.stripeCustomerId),
      queue: (({ intervalMin, startHour, endHour, paused, error }) => ({ intervalMin, startHour, endHour, paused, error }))(user.queue),
      targets: user.targets.map(({ id, name, kind }) => ({ id, name, kind })),
    };
  }

  function postView(user, post, eta) {
    return {
      id: post.id,
      text: post.text,
      hasImage: Boolean(post.imageType),
      targets: post.targets.map((id) => user.targets.find((t) => t.id === id)?.name).filter(Boolean),
      mode: post.mode,
      repeat: post.repeat,
      status: post.status,
      error: post.mode === 'queue' ? null : post.error,
      eta,
      createdAt: post.createdAt,
    };
  }

  function postsView(user) {
    const t = now();
    const eta = etas(db, user, t);
    const scheduled = db.postsOf(user.id).filter((p) => p.mode === 'at')
      .sort((a, b) => a.sendAt - b.sendAt)
      .map((p) => postView(user, p, eta.get(p.id)));
    const queue = queueOf(db, user).map((p) => postView(user, p, eta.get(p.id)));
    return { scheduled, queue, queueSettings: userView(user).queue, history: user.history ?? [], timeZone: user.timeZone };
  }

  // ---------- helpers ----------

  function ownPost(user, id) {
    const post = db.data.posts[id];
    if (!post || post.userId !== user.id) throw fail('Post not found', 404);
    return post;
  }

  function baseUrl(req) {
    if (cfg.baseUrl) return cfg.baseUrl;
    const proto = req.headers['x-forwarded-proto']?.split(',')[0] || 'http';
    return `${proto}://${req.headers.host}`;
  }
  const secure = (req) => cfg.baseUrl.startsWith('https:') || req.headers['x-forwarded-proto']?.startsWith('https');

  function newUser({ email, name, timeZone, passHash }) {
    const first = Object.keys(db.data.users).length === 0;
    return {
      id: randomUUID(),
      email,
      name: String(name ?? '').trim().slice(0, 80),
      passHash,
      createdAt: now(),
      timeZone: isTimeZone(timeZone) ? timeZone : cfg.defaultTimeZone,
      footer: '',
      isAdmin: first, // the very first account runs the place
      targets: [],
      queue: { ...DEFAULT_QUEUE },
      usage: null,
      history: [],
    };
  }

  async function login(req, user) {
    const token = createSession(db, user.id, now());
    user.lastLoginAt = now();
    await db.save();
    return { 'set-cookie': sessionCookie(token, { secure: secure(req) }) };
  }

  // ---------- routes ----------

  // Public (no login).
  const open = {
    'GET /api/config': () => ({
      appName: cfg.appName,
      signupsOpen: cfg.signupsOpen,
      billingEnabled: cfg.billingEnabled,
      proPriceLabel: cfg.proPriceLabel,
      plans: PLANS,
      dryRun: cfg.dryRun,
      repeats: Object.keys(REPEATS),
    }),

    'POST /api/signup': async (req) => {
      if (!cfg.signupsOpen) throw fail('Sign-ups are closed right now', 403);
      const { email: rawEmail, password, name, timeZone } = await readJson(req);
      const email = normalizeEmail(rawEmail);
      if (!validEmail(email)) throw fail('Enter a valid email');
      if (String(password ?? '').length < 8) throw fail('Password must be at least 8 characters');
      if (!loginLimit(`signup:${req.socket.remoteAddress}`)) throw fail('Too many attempts — try again later', 429);
      if (db.userByEmail(email)) throw fail('That email already has an account — log in instead', 409);
      const user = newUser({ email, name, timeZone, passHash: await hashPassword(password) });
      db.data.users[user.id] = user;
      return [{ ok: true, user: userView(user) }, await login(req, user)];
    },

    'POST /api/login': async (req) => {
      const { email: rawEmail, password } = await readJson(req);
      const email = normalizeEmail(rawEmail);
      if (!loginLimit(`login:${email}`) || !loginLimit(`ip:${req.socket.remoteAddress}`)) {
        throw fail('Too many attempts — wait 15 minutes and try again', 429);
      }
      const user = db.userByEmail(email);
      // Hash even when the user doesn't exist, so timing doesn't reveal accounts.
      const ok = await verifyPassword(password, user?.passHash ?? dummyHash);
      if (!user || !ok) throw fail('Wrong email or password', 401);
      if (user.disabled) throw fail('This account is disabled', 403);
      return [{ ok: true, user: userView(user) }, await login(req, user)];
    },

    'POST /api/logout': async (req) => {
      endSession(db, readCookie(req, COOKIE));
      await db.save();
      return [{ ok: true }, { 'set-cookie': sessionCookie(null, { secure: secure(req) }) }];
    },

    // Stripe → us. Authenticated by its signature, not a session.
    'POST /api/billing/webhook': async (req) => {
      const raw = await readRaw(req);
      if (!cfg.stripeWebhookSecret || !verifyStripeSignature(raw, req.headers['stripe-signature'], cfg.stripeWebhookSecret, { now: now() })) {
        throw fail('Bad signature', 400);
      }
      const user = applyStripeEvent(db, JSON.parse(raw));
      if (user) {
        await db.save();
        log.log(`Billing: ${user.email} is now ${planOf(user, cfg)} (${user.subscription?.status})`);
      }
      return { received: true };
    },
  };

  // Logged in.
  const authed = {
    'GET /api/me': (req, user) => ({ user: userView(user) }),

    'POST /api/me/settings': async (req, user) => {
      const { name, footer, timeZone } = await readJson(req);
      if (name !== undefined) user.name = String(name).trim().slice(0, 80);
      if (footer !== undefined) user.footer = String(footer).slice(0, 500);
      if (timeZone !== undefined) {
        if (!isTimeZone(timeZone)) throw fail('Unknown time zone');
        user.timeZone = timeZone;
      }
      await db.save();
      return { user: userView(user) };
    },

    'POST /api/me/password': async (req, user) => {
      const { current, next } = await readJson(req);
      if (!(await verifyPassword(current, user.passHash))) throw fail('Current password is wrong', 401);
      if (String(next ?? '').length < 8) throw fail('New password must be at least 8 characters');
      user.passHash = await hashPassword(next);
      endAllSessions(db, user.id);
      return [{ ok: true }, await login(req, user)];
    },

    'DELETE /api/me': async (req, user) => {
      const { password } = await readJson(req);
      if (!(await verifyPassword(password, user.passHash))) throw fail('Password is wrong', 401);
      for (const p of db.postsOf(user.id)) {
        delete db.data.posts[p.id];
        if (p.imageType) await db.removeImage(p.id);
      }
      endAllSessions(db, user.id);
      delete db.data.users[user.id];
      await db.save();
      await wa.remove(user.id).catch(() => {});
      return [{ ok: true }, { 'set-cookie': sessionCookie(null, { secure: secure(req) }) }];
    },

    // ----- WhatsApp -----

    'GET /api/whatsapp': (req, user) => ({ ...wa.get(user.id).status(), dryRun: cfg.dryRun }),

    'POST /api/whatsapp/pair': async (req, user) => ({
      pairingCode: await wa.get(user.id).requestPairingCode((await readJson(req)).phone),
    }),

    'POST /api/whatsapp/unlink': async (req, user) => {
      await wa.get(user.id).logout();
      return { ok: true };
    },

    'GET /api/whatsapp/groups': async (req, user) => {
      const groups = await wa.get(user.id).listGroups();
      const have = new Set(user.targets.map((t) => t.jid));
      return { groups: groups.map((g) => ({ ...g, added: have.has(g.jid) })) };
    },

    // ----- Targets (groups / channels to post to) -----

    'POST /api/targets': async (req, user) => {
      const { ref } = await readJson(req);
      if (!String(ref ?? '').trim()) throw fail('Paste a link or pick a group');
      if (user.targets.length >= limitsOf(user, cfg).maxTargets) {
        throw fail(`Your plan allows ${limitsOf(user, cfg).maxTargets} groups/channels${cfg.billingEnabled ? ' — upgrade for more' : ''}`, 402);
      }
      const resolved = cfg.dryRun && wa.get(user.id).status().state !== 'connected'
        ? { jid: String(ref).trim(), name: String(ref).trim().slice(0, 60), kind: 'test' }
        : await wa.get(user.id).resolve(ref);
      if (user.targets.some((t) => t.jid === resolved.jid)) throw fail(`${resolved.name} is already added`, 409);
      const target = { id: randomUUID(), ...resolved, addedAt: now() };
      user.targets.push(target);
      await db.save();
      return { user: userView(user) };
    },

    // ----- Posts -----

    'GET /api/posts': (req, user) => postsView(user),

    'POST /api/posts': async (req, user) => {
      const body = await readJson(req);
      const limits = limitsOf(user, cfg);
      const text = String(body.text ?? '').trim();
      if (text.length > MAX_TEXT) throw fail(`Text is too long (max ${MAX_TEXT} characters)`);
      let image;
      if (body.image) {
        image = parseDataUrl(body.image);
        if (!image) throw fail('Image must be JPEG, PNG or WebP');
      }
      if (!text && !image) throw fail('Write something or add an image');

      const targets = [...new Set(Array.isArray(body.targets) ? body.targets : [])];
      if (!targets.length) throw fail('Pick at least one group or channel');
      if (targets.some((id) => !user.targets.some((t) => t.id === id))) throw fail('Unknown group/channel — reload the page');

      const when = body.when ?? {};
      const t = now();
      let mode = 'at';
      let sendAt = t;
      if (when.type === 'delay') {
        const min = Number(when.delayMin);
        if (!(min >= 1 && min <= 60 * 24 * 60)) throw fail('Delay must be 1 minute – 60 days');
        sendAt = t + Math.round(min * 60 * 1000);
      } else if (when.type === 'at') {
        sendAt = Number(when.at);
        if (!Number.isFinite(sendAt)) throw fail('Pick a date and time');
        if (sendAt < t - 60 * 1000) throw fail('That time has already passed');
        if (sendAt > t + 366 * 864e5) throw fail('Pick a time within the next year');
      } else if (when.type === 'queue') {
        mode = 'queue';
      } else if (when.type !== 'now') {
        throw fail('Pick when to send it');
      }

      const repeat = mode === 'at' && when.type !== 'now' ? (body.repeat || 'none') : 'none';
      if (!(repeat in REPEATS)) throw fail('Unknown repeat');
      if (repeat !== 'none' && !limits.recurring) throw fail('Repeating posts are a Pro feature — upgrade to use them', 402);

      const u = usage(user);
      if (u.created >= limits.postsPerMonth) {
        throw fail(`You've used all ${limits.postsPerMonth} posts for this month${cfg.billingEnabled ? ' — upgrade for more' : ''}`, 402);
      }
      if (when.type !== 'now' && db.postsOf(user.id).length >= limits.maxPending) {
        throw fail(`You can have ${limits.maxPending} posts waiting at once${cfg.billingEnabled ? ' — upgrade for more' : ''}`, 402);
      }

      const id = randomUUID();
      if (image) await db.writeImage(id, image.buf);
      const queue = queueOf(db, user);
      const post = {
        id, userId: user.id, text, imageType: image?.type ?? null, targets,
        mode, sendAt: mode === 'at' ? sendAt : null, repeat,
        order: mode === 'queue' ? (queue.at(-1)?.order ?? 0) + 1 : null,
        status: 'scheduled', sentTo: [], error: null, retryAt: 0, createdAt: t,
      };
      db.data.posts[id] = post;
      u.created += 1;
      await db.save();

      if (when.type === 'now') {
        try {
          await scheduler.sendNow(user, post);
          return { ok: true, sent: true, ...postsView(user) };
        } catch (err) {
          return { ok: true, sent: false, error: err.message, ...postsView(user) };
        }
      }
      return { ok: true, id, eta: etas(db, user, now()).get(id), ...postsView(user) };
    },

    'POST /api/queue/settings': async (req, user) => {
      const patch = await readJson(req);
      const q = { ...user.queue };
      if (patch.intervalMin !== undefined) {
        const m = Number(patch.intervalMin);
        if (!(m >= 5 && m <= 24 * 60)) throw fail('Interval must be 5 min – 24 h');
        q.intervalMin = m;
      }
      for (const k of ['startHour', 'endHour']) {
        if (patch[k] === undefined) continue;
        const h = Number(patch[k]);
        if (!Number.isInteger(h) || h < 0 || h > 23) throw fail('Hours are 0–23');
        q[k] = h;
      }
      if (patch.paused !== undefined) q.paused = Boolean(patch.paused);
      user.queue = q;
      await db.save();
      return postsView(user);
    },

    // ----- Billing -----

    'POST /api/billing/checkout': async (req, user) => {
      if (!cfg.billingEnabled) throw fail('Billing is not switched on', 404);
      if (!stripe || !cfg.stripePriceId) throw fail('Payments are not set up yet — try again later', 503);
      if (planOf(user, cfg) === 'pro') throw fail('You are already on Pro', 409);
      const session = await stripe.checkout({ user, priceId: cfg.stripePriceId, baseUrl: baseUrl(req) });
      return { url: session.url };
    },

    'POST /api/billing/portal': async (req, user) => {
      if (!stripe || !user.stripeCustomerId) throw fail('No billing account yet', 404);
      const session = await stripe.portal({ user, baseUrl: baseUrl(req) });
      return { url: session.url };
    },

    // ----- Admin -----

    'GET /api/admin/users': (req, user) => {
      requireAdmin(user);
      const users = Object.values(db.data.users).sort((a, b) => b.createdAt - a.createdAt).map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt ?? null,
        plan: planOf(u, cfg),
        planOverride: u.planOverride ?? null,
        subscription: u.subscription?.status ?? null,
        pending: db.postsOf(u.id).length,
        postsThisMonth: usage(u).created,
        targets: u.targets.length,
        whatsapp: wa.get(u.id).status().state,
        disabled: Boolean(u.disabled),
        isAdmin: isAdmin(u),
      }));
      return { users, billingEnabled: cfg.billingEnabled };
    },
  };

  function requireAdmin(user) {
    if (!isAdmin(user)) throw fail('Admins only', 403);
  }

  // Routes with an id in the path.
  async function dynamic(req, user, path) {
    let m = /^\/api\/targets\/([\w-]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      const i = user.targets.findIndex((t) => t.id === m[1]);
      if (i < 0) throw fail('Not found', 404);
      user.targets.splice(i, 1);
      // Drop it from waiting posts; posts left with nowhere to go are deleted.
      for (const p of db.postsOf(user.id)) {
        p.targets = p.targets.filter((id) => id !== m[1]);
        if (!p.targets.length) {
          delete db.data.posts[p.id];
          if (p.imageType) await db.removeImage(p.id);
        }
      }
      await db.save();
      return { user: userView(user), ...postsView(user) };
    }

    m = /^\/api\/posts\/([\w-]+)(?:\/(image|send|up|down))?$/.exec(path);
    if (m) {
      const [, id, action] = m;
      const post = ownPost(user, id);
      if (req.method === 'GET' && action === 'image') {
        if (!post.imageType) throw fail('No image', 404);
        return { raw: await db.readImage(id), type: post.imageType };
      }
      if (req.method === 'DELETE' && !action) {
        delete db.data.posts[id];
        if (post.imageType) await db.removeImage(id);
        await db.save();
        return postsView(user);
      }
      if (req.method === 'POST' && action === 'send') {
        await scheduler.sendNow(user, post);
        return { ok: true, ...postsView(user) };
      }
      if (req.method === 'POST' && (action === 'up' || action === 'down') && post.mode === 'queue') {
        const queue = queueOf(db, user);
        const i = queue.findIndex((p) => p.id === id);
        const j = i + (action === 'up' ? -1 : 1);
        if (j >= 0 && j < queue.length) {
          [queue[i].order, queue[j].order] = [queue[j].order, queue[i].order];
          await db.save();
        }
        return postsView(user);
      }
    }

    m = /^\/api\/admin\/users\/([\w-]+)(?:\/(reset-password))?$/.exec(path);
    if (m && req.method === 'POST') {
      requireAdmin(user);
      const target = db.data.users[m[1]];
      if (!target) throw fail('Not found', 404);
      if (m[2] === 'reset-password') {
        const temp = randomBytes(6).toString('base64url');
        target.passHash = await hashPassword(temp);
        endAllSessions(db, target.id);
        await db.save();
        return { ok: true, tempPassword: temp };
      }
      const { planOverride, disabled } = await readJson(req);
      if (planOverride !== undefined) {
        if (planOverride !== null && !PLANS[planOverride]) throw fail('Unknown plan');
        target.planOverride = planOverride;
      }
      if (disabled !== undefined) {
        if (target.id === user.id) throw fail('You can’t disable your own account');
        target.disabled = Boolean(disabled);
        if (target.disabled) endAllSessions(db, target.id);
      }
      await db.save();
      return { ok: true };
    }
    return undefined;
  }

  // Cross-site requests can't send application/json without a CORS
  // preflight (which we never allow), so requiring it blocks CSRF on every
  // state-changing call. The Stripe webhook is the one exception.
  function sameOrigin(req, path) {
    if (req.method === 'GET' || req.method === 'HEAD' || path === '/api/billing/webhook') return true;
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    try {
      if (path === '/health') return send(res, 200, 'ok');

      if (path.startsWith('/api/')) {
        if (!sameOrigin(req, path)) return send(res, 403, { error: 'Bad request origin' });
        const key = `${req.method} ${path}`;
        let out;
        if (open[key]) {
          out = await open[key](req);
        } else {
          const user = sessionUser(db, readCookie(req, COOKIE), now());
          if (!user || user.disabled) return send(res, 401, { error: 'Please log in' });
          out = authed[key] ? await authed[key](req, user) : await dynamic(req, user, path);
        }
        if (out === undefined) return send(res, 404, { error: 'Not found' });
        if (out?.raw) return send(res, 200, out.raw, { 'content-type': out.type, 'cache-control': 'private, max-age=3600' });
        const [body, headers] = Array.isArray(out) ? out : [out, {}];
        return send(res, 200, body, { 'cache-control': 'no-store', ...headers });
      }

      if (req.method === 'GET') {
        const file = path === '/' ? 'index.html' : path.slice(1);
        if (file.includes('..') || file.includes('\\')) return send(res, 400, 'Bad path');
        const buf = await readFile(new URL(file, PUBLIC_DIR)).catch(() => null);
        if (!buf) return send(res, 404, 'Not found');
        return send(res, 200, buf, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      }

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!err.status) log.error(err);
      send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong' });
    }
  });

  server.db = db;
  server.scheduler = scheduler;
  server.wa = wa;
  server.pruneSessions = () => pruneSessions(db, now());
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  const app = await createApp(cfg);
  app.scheduler.start();
  setInterval(() => app.pruneSessions(), 6 * 60 * 60 * 1000).unref();
  app.listen(PORT, () => {
    console.log(`${cfg.appName} on http://localhost:${PORT}`);
    if (cfg.dryRun) console.log('DRY_RUN is on — posts are logged, not sent');
    if (!cfg.signupsOpen) console.log('Sign-ups are closed (SIGNUPS_OPEN=0)');
    console.log(cfg.billingEnabled
      ? `Billing ON${cfg.stripeSecretKey && cfg.stripePriceId && cfg.stripeWebhookSecret ? '' : ' — ⚠️ STRIPE_SECRET_KEY / STRIPE_PRICE_ID / STRIPE_WEBHOOK_SECRET missing'}`
      : 'Billing off — everyone gets Pro for free (BILLING_ENABLED=1 to charge)');
    console.log(`${Object.keys(app.db.data.users).length} accounts · ${Object.keys(app.db.data.posts).length} posts waiting`);
  });
  const linked = await app.wa.startAll(Object.keys(app.db.data.users));
  if (linked) console.log(`Reconnecting ${linked} linked WhatsApp account(s)…`);
}
