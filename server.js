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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { openDb } from './lib/db.js';
import {
  createRateLimiter, createSession, endAllSessions, endOtherSessions, endSession, hashPassword, normalizeEmail,
  pruneSessions, readCookie, sessionCookie, sessionId, sessionOf, sessionsOf, validEmail, verifyPassword, COOKIE,
} from './lib/auth.js';
import { applyStripeEvent, createStripe, isPaid, isPaying, planOf, PLANS, verifyStripeSignature } from './lib/billing.js';
import { createMailer } from './lib/mail.js';
import { AI_TONES, createCaptioner } from './lib/ai.js';
import { fetchFeed, renderItem } from './lib/feeds.js';
import { PAGE_PATHS, renderPage, sitemap } from './lib/pages.js';
import { createWhatsAppManager, numberJid, STATUS_JID } from './lib/whatsapp.js';
import { createScheduler, DEFAULT_QUEUE, etas, queueOf, withFooter } from './lib/scheduler.js';
import { isTimeZone, monthKey, REPEATS } from './lib/time.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = new URL('./public/', import.meta.url);
const MAX_BODY = 24 * 1024 * 1024; // base64 attachment (≈16 MB file) + fields
const MAX_TEXT = 4000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MEDIA_TYPES = new Set([...IMAGE_TYPES, 'video/mp4', 'application/pdf']);
const DAY = 864e5;
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const off = (v) => /^(0|false|no|off)$/i.test(v || '');
const STATUS_COLORS = ['#128c7e', '#25d366', '#2f6fec', '#7c4dff', '#e5486c', '#d98a00', '#0f9fa8', '#243137'];
const yes = (v) => /^(1|true|yes|on)$/i.test(v || '');

// Per-account preferences, edited on the Account page.
const THEMES = ['system', 'light', 'dark'];
const WHEN_DEFAULTS = ['last', 'now', 'delay', 'at', 'queue'];
const DEFAULT_PREFS = { theme: 'system', confirmNow: true, defaultWhen: 'last', compact: false };
const prefsOf = (user) => ({ ...DEFAULT_PREFS, ...(user.prefs ?? {}) });

// "Chrome on Windows" from a User-Agent header, for the list of devices.
export function describeAgent(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' on ') || 'Unknown device';
}

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
    // Stripe price ids per plan and billing period. Business and yearly are
    // only offered when their id is set.
    prices: {
      pro: { month: env.STRIPE_PRICE_ID || '', year: env.STRIPE_PRICE_ID_YEARLY || '' },
      business: { month: env.STRIPE_PRICE_ID_BUSINESS || '', year: env.STRIPE_PRICE_ID_BUSINESS_YEARLY || '' },
    },
    priceLabels: {
      pro: { month: env.PRO_PRICE_LABEL || '$9 / month', year: env.PRO_YEARLY_LABEL || '$90 / year' },
      business: { month: env.BUSINESS_PRICE_LABEL || '$29 / month', year: env.BUSINESS_YEARLY_LABEL || '$290 / year' },
    },
    trialDays: env.TRIAL_DAYS === undefined || env.TRIAL_DAYS === '' ? 7 : Math.max(0, Number(env.TRIAL_DAYS) || 0),
    freeBranding: !off(env.FREE_BRANDING), // "Sent with …" under Free-plan posts
    promoText: (env.PROMO_TEXT || '').slice(0, 200),
    demoVideoUrl: /^https:\/\//.test(env.DEMO_VIDEO_URL || '') ? env.DEMO_VIDEO_URL : '',
    supportEmail: env.SUPPORT_EMAIL || '',
    dailySendCap: Number(env.DAILY_SEND_CAP) || 300, // sends per account per day, to stay clear of WhatsApp bans
    smtp: { host: env.SMTP_HOST || '', port: Number(env.SMTP_PORT) || 587, user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.MAIL_FROM || '' },
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    aiModel: env.AI_MODEL || 'claude-opus-5-5',
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
    if (size > MAX_BODY) throw fail('Too large (attachments max ~16 MB)', 413);
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
  if (!m || !MEDIA_TYPES.has(m[1])) return null;
  return { type: m[1], buf: Buffer.from(m[2], 'base64') };
}

export async function createApp(cfg = config(), { db, wa, now = Date.now, stripe, log = console, mailer, captioner, feedFetcher = fetchFeed } = {}) {
  db ??= await openDb(cfg.dataDir);
  wa ??= createWhatsAppManager({ dir: join(cfg.dataDir, 'wa') });
  stripe ??= cfg.stripeSecretKey ? createStripe({ secretKey: cfg.stripeSecretKey }) : null;
  mailer ??= createMailer(cfg, log);
  captioner ??= createCaptioner({ apiKey: cfg.anthropicKey, model: cfg.aiModel });
  db.data.links ??= {};
  db.data.meta ??= {};
  const planFor = (user) => planOf(user, cfg, now());
  const limitsFor = (user) => PLANS[planFor(user)];
  const dayKey = (user) => new Date(now()).toLocaleDateString('en-CA', { timeZone: user.timeZone });
  const loginLimit = createRateLimiter({ now });
  const dummyHash = await hashPassword(randomBytes(16).toString('hex'));

  // The one place a post actually leaves: WhatsApp, or the log in dry-run.
  async function deliver(user, target, { caption, image, poll }) {
    // A daily ceiling per account: bursts of hundreds of sends are what gets
    // numbers banned. Posts over the limit wait and go out the next day.
    const day = dayKey(user);
    if (user.sends?.day !== day) user.sends = { day, count: 0 };
    if (user.sends.count >= cfg.dailySendCap) {
      throw fail(`Daily safety limit reached (${cfg.dailySendCap} sends) — the rest go out tomorrow`, 429);
    }
    user.sends.count += 1;
    if (cfg.dryRun) {
      const who = target.kind === 'status' ? ` (seen by: ${audienceSummary(target.audience)})` : '';
      log.log(`[dry-run] ${user.email} → ${target.name}${who}${image ? ' (+ image)' : ''}\n${caption}\n`);
      return;
    }
    const conn = wa.get(user.id);
    if (target.kind !== 'status') return conn.send(target.jid, { caption, image, ...(poll ? { poll } : {}) });
    // Status: WhatsApp only shows it to the people listed with it.
    const statusJidList = await conn.statusAudience(target.audience);
    if (statusJidList.length < 2) { // just yourself
      throw fail('Nobody would see this Status — add contacts, groups or numbers to its audience', 400);
    }
    await conn.send(STATUS_JID, { caption, image }, { statusJidList, backgroundColor: target.color });
  }

  const audienceSummary = (a = {}) => [
    a.contacts && 'your contacts',
    a.groups?.length && `${a.groups.length} group${a.groups.length === 1 ? '' : 's'}`,
    a.numbers?.length && `${a.numbers.length} number${a.numbers.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join(', ') || 'nobody yet';

  // { contacts, groups: [jid], numbers: [..] | "one per line" } → clean audience.
  function parseAudience(raw = {}) {
    const groups = [...new Set((Array.isArray(raw.groups) ? raw.groups : []).map(String).filter((g) => /^[\w.-]+@g\.us$/.test(g)))];
    const list = Array.isArray(raw.numbers) ? raw.numbers : String(raw.numbers ?? '').split(/[\n,;]+/);
    const numbers = [...new Set(list.map(numberJid).filter(Boolean).map((j) => j.split('@')[0]))];
    if (groups.length > 100) throw fail('Pick at most 100 groups');
    if (numbers.length > 5000) throw fail('At most 5,000 numbers');
    const audience = { contacts: Boolean(raw.contacts), groups, numbers };
    if (!audience.contacts && !groups.length && !numbers.length) {
      throw fail('Choose who sees your Status: your contacts, members of some groups, or a list of numbers');
    }
    return audience;
  }
  const parseColor = (c) => (STATUS_COLORS.includes(String(c).toLowerCase()) ? String(c).toLowerCase() : STATUS_COLORS[0]);
  // What actually goes out: the post, the account's footer, and on the Free
  // plan a small "Sent with …" line.
  const branding = (user) => (cfg.billingEnabled && cfg.freeBranding && planFor(user) === 'free' ? `_Sent with ${cfg.appName}_` : '');
  const captionOf = (user, post) => withFooter(withFooter(post.text, user.footer), branding(user));
  const scheduler = createScheduler({ db, deliver, now, log, captionOf, gapMs: cfg.dryRun ? 0 : undefined });

  // ---------- views ----------

  const isAdmin = (user) => Boolean(user.isAdmin || cfg.adminEmails.includes(user.email));

  function usage(user) {
    const month = monthKey(now(), user.timeZone);
    if (user.usage?.month !== month) user.usage = { month, created: 0 };
    return user.usage;
  }

  function userView(user) {
    const plan = planFor(user);
    const t = now();
    const referred = Object.values(db.data.users).filter((u) => u.referredBy === user.id);
    return {
      paid: isPaid(plan),
      trialEndsAt: !isPaying(user) && user.trialEndsAt > t ? user.trialEndsAt : null,
      proUntil: user.proUntil > t ? user.proUntil : null,
      billing: user.subscription && isPaying(user) ? { plan: user.subscription.plan ?? 'pro', interval: user.subscription.interval ?? 'month' } : null,
      branding: branding(user),
      templates: user.templates ?? [],
      feeds: (user.feeds ?? []).map(({ id, url, targets, template, error }) => ({ id, url, targets, template, error: error ?? null })),
      referral: { code: refCode(user), signups: referred.length, paid: referred.filter((u) => u.referralRewarded).length },
      id: user.id,
      email: user.email,
      name: user.name,
      timeZone: user.timeZone,
      footer: user.footer,
      isAdmin: isAdmin(user),
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt ?? null,
      prefs: prefsOf(user),
      stats: { pending: db.postsOf(user.id).length, sentTotal: user.sentTotal ?? 0 },
      plan,
      limits: PLANS[plan],
      usage: usage(user),
      subscription: user.subscription?.status ?? null,
      canManageBilling: Boolean(user.stripeCustomerId),
      queue: (({ intervalMin, startHour, endHour, paused, error }) => ({ intervalMin, startHour, endHour, paused, error }))(user.queue),
      targets: user.targets.map(({ id, name, kind, audience, color }) => (kind === 'status'
        ? { id, name, kind, audience, color, audienceSummary: audienceSummary(audience) }
        : { id, name, kind })),
    };
  }

  function postView(user, post, eta) {
    return {
      id: post.id,
      text: post.text,
      hasImage: IMAGE_TYPES.has(post.imageType),
      media: !post.imageType ? null : IMAGE_TYPES.has(post.imageType) ? 'image' : post.imageType.startsWith('video/') ? 'video' : 'file',
      fileName: post.fileName ?? null,
      poll: post.poll ?? null,
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

  // A short code for the account's referral link.
  function refCode(user) {
    user.refCode ??= randomBytes(5).toString('hex');
    return user.refCode;
  }

  const admins = () => Object.values(db.data.users).filter((u) => isAdmin(u) && !u.disabled).map((u) => u.email);
  const mail = (to, subject, lines) => mailer.send({ to, subject, text: `${lines.filter((l) => l !== null).join('\n\n')}\n\n— ${cfg.appName}` });

  // Swap each link in the text for a short one of ours that counts clicks.
  function trackLinks(user, text, base) {
    return text.replace(/https?:\/\/[^\s<>"]+/g, (url) => {
      if (url.startsWith(`${base}/l/`)) return url;
      const code = randomBytes(5).toString('base64url');
      db.data.links[code] = { userId: user.id, url, clicks: 0, hours: new Array(24).fill(0), createdAt: now(), label: text.slice(0, 80) };
      return `${base}/l/${code}`;
    });
  }

  // Validates and stores one post. Used by the composer, bulk upload and
  // feeds. The caller saves the database.
  async function addPost(user, body, { base = cfg.baseUrl } = {}) {
    const limits = limitsFor(user);
    let text = String(body.text ?? '').trim();
    if (text.length > MAX_TEXT) throw fail(`Text is too long (max ${MAX_TEXT} characters)`);
    let image;
    if (body.image) {
      image = parseDataUrl(body.image);
      if (!image) throw fail('Attachments must be a JPEG, PNG or WebP image, an MP4 video or a PDF');
    }
    let poll = null;
    if (body.poll) {
      const options = [...new Set((Array.isArray(body.poll.options) ? body.poll.options : []).map((o) => String(o).trim()).filter(Boolean))];
      if (options.length < 2 || options.length > 12) throw fail('A poll needs 2 to 12 different options');
      if (options.some((o) => o.length > 100)) throw fail('Poll options can be up to 100 characters');
      if (image) throw fail('A poll can’t have an attachment');
      if (!text) throw fail('Write the poll question');
      if (text.length > 255) throw fail('A poll question can be up to 255 characters');
      poll = { options, multi: Boolean(body.poll.multi) };
    }
    if (!text && !image) throw fail('Write something or add an image');

    const targets = [...new Set(Array.isArray(body.targets) ? body.targets : [])];
    if (!targets.length) throw fail('Pick at least one group or channel');
    if (targets.some((id) => !user.targets.some((t) => t.id === id))) throw fail('Unknown group/channel — reload the page');
    if (poll && targets.some((id) => user.targets.find((t) => t.id === id).kind === 'status')) throw fail('Polls can’t be posted to Status');

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
    if (body.track && text) {
      if (!isPaid(planFor(user))) throw fail('Link tracking is a Pro feature — upgrade to use it', 402);
      if (!base) throw fail('Link tracking needs BASE_URL to be set', 503);
      text = trackLinks(user, text, base);
    }

    const id = randomUUID();
    if (image) await db.writeImage(id, image.buf);
    const queue = queueOf(db, user);
    const post = {
      id, userId: user.id, text, imageType: image?.type ?? null, targets,
      fileName: image && !IMAGE_TYPES.has(image.type) ? String(body.fileName || '').replace(/[\\/\r\n]/g, '').slice(0, 120) || null : null,
      poll,
      mode, sendAt: mode === 'at' ? sendAt : null, repeat,
      order: mode === 'queue' ? (queue.at(-1)?.order ?? 0) + 1 : null,
      status: 'scheduled', sentTo: [], error: null, retryAt: 0, createdAt: t,
    };
    db.data.posts[id] = post;
    u.created += 1;
    return post;
  }

  function newUser({ email, name, timeZone, passHash }) {
    const first = Object.keys(db.data.users).length === 0;
    return {
      trialEndsAt: cfg.billingEnabled && cfg.trialDays ? now() + cfg.trialDays * DAY : null,
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

  // Deletes an account with its posts, images, sessions and WhatsApp link.
  async function removeUser(user) {
    for (const p of db.postsOf(user.id)) {
      delete db.data.posts[p.id];
      if (p.imageType) await db.removeImage(p.id);
    }
    for (const [code, link] of Object.entries(db.data.links)) if (link.userId === user.id) delete db.data.links[code];
    endAllSessions(db, user.id);
    delete db.data.users[user.id];
    await db.save();
    await wa.remove(user.id).catch(() => {});
  }

  async function login(req, user) {
    const token = createSession(db, user.id, now(), { userAgent: req.headers['user-agent'] });
    user.lastLoginAt = now();
    await db.save();
    return { 'set-cookie': sessionCookie(token, { secure: secure(req) }) };
  }

  // ---------- routes ----------

  // Public (no login).
  const open = {
    'GET /api/config': () => ({
      appName: cfg.appName,
      statusColors: STATUS_COLORS,
      signupsOpen: cfg.signupsOpen,
      billingEnabled: cfg.billingEnabled,
      proPriceLabel: cfg.proPriceLabel,
      plans: Object.fromEntries(Object.entries(PLANS).filter(([id]) => id !== 'business' || cfg.prices.business.month)),
      priceLabels: cfg.priceLabels,
      yearly: { pro: Boolean(cfg.prices.pro.year), business: Boolean(cfg.prices.business.year) },
      trialDays: cfg.billingEnabled ? cfg.trialDays : 0,
      freeBranding: cfg.billingEnabled && cfg.freeBranding,
      promoText: cfg.promoText,
      demoVideoUrl: cfg.demoVideoUrl,
      mailEnabled: mailer.enabled,
      aiEnabled: Boolean(captioner),
      aiTones: AI_TONES,
      dryRun: cfg.dryRun,
      repeats: Object.keys(REPEATS),
    }),

    'POST /api/signup': async (req) => {
      if (!cfg.signupsOpen) throw fail('Sign-ups are closed right now', 403);
      const { email: rawEmail, password, name, timeZone, ref } = await readJson(req);
      const email = normalizeEmail(rawEmail);
      if (!validEmail(email)) throw fail('Enter a valid email');
      if (String(password ?? '').length < 8) throw fail('Password must be at least 8 characters');
      if (!loginLimit(`signup:${req.socket.remoteAddress}`)) throw fail('Too many attempts — try again later', 429);
      if (db.userByEmail(email)) throw fail('That email already has an account — log in instead', 409);
      const user = newUser({ email, name, timeZone, passHash: await hashPassword(password) });
      const referrer = ref ? Object.values(db.data.users).find((u) => u.refCode === String(ref)) : null;
      if (referrer) user.referredBy = referrer.id;
      db.data.users[user.id] = user;
      mail(email, `Welcome to ${cfg.appName}`, [
        `Hi${user.name ? ` ${user.name}` : ''}, your account is ready.`,
        'Three steps to your first scheduled post:\n1. Link your WhatsApp with a pairing code\n2. Add a group, channel or your Status\n3. Write a post and pick a time',
        user.trialEndsAt ? `You have every Pro feature free for ${cfg.trialDays} days.` : null,
        baseUrl(req),
      ]).catch(() => {});
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

    // Forgot password: emails a link that works once, for an hour. Always
    // answers the same way, so it doesn't reveal which emails have accounts.
    'POST /api/forgot': async (req) => {
      const { email: rawEmail } = await readJson(req);
      if (!mailer.enabled) throw fail('Password emails are not set up here — ask the site owner to reset it', 503);
      if (!loginLimit(`forgot:${req.socket.remoteAddress}`)) throw fail('Too many attempts — try again later', 429);
      const user = db.userByEmail(normalizeEmail(rawEmail));
      if (user && !user.disabled) {
        const token = randomBytes(32).toString('base64url');
        user.reset = { hash: sha256(token), expiresAt: now() + 60 * 60 * 1000 };
        await db.save();
        await mail(user.email, `Reset your ${cfg.appName} password`, [
          'Use this link to choose a new password. It works once, for one hour:',
          `${baseUrl(req)}/#/reset/${token}`,
          'If you didn’t ask for this, you can ignore this email.',
        ]);
      }
      return { ok: true };
    },

    'POST /api/reset': async (req) => {
      const { token, password } = await readJson(req);
      if (String(password ?? '').length < 8) throw fail('Password must be at least 8 characters');
      const hash = sha256(token);
      const user = Object.values(db.data.users).find((u) => u.reset?.hash === hash && u.reset.expiresAt > now());
      if (!user || user.disabled) throw fail('This reset link is no longer valid — ask for a new one', 400);
      user.passHash = await hashPassword(password);
      delete user.reset;
      endAllSessions(db, user.id);
      return [{ ok: true, user: userView(user) }, await login(req, user)];
    },

    // Stripe → us. Authenticated by its signature, not a session.
    'POST /api/billing/webhook': async (req) => {
      const raw = await readRaw(req);
      if (!cfg.stripeWebhookSecret || !verifyStripeSignature(raw, req.headers['stripe-signature'], cfg.stripeWebhookSecret, { now: now() })) {
        throw fail('Bad signature', 400);
      }
      const event = JSON.parse(raw);
      const before = new Map(Object.values(db.data.users).map((u) => [u.id, u.subscription?.status]));
      const user = applyStripeEvent(db, event, priceMap);
      if (user) {
        const was = before.get(user.id);
        const status = user.subscription?.status;
        // A friend they referred started paying: a free month for the referrer.
        if (event.type === 'checkout.session.completed' && user.referredBy && !user.referralRewarded) {
          const referrer = db.data.users[user.referredBy];
          user.referralRewarded = true;
          if (referrer) {
            referrer.proUntil = Math.max(referrer.proUntil ?? 0, now()) + 30 * DAY;
            mail(referrer.email, 'You earned a free month', [`Someone you referred just upgraded, so you have 30 days of Pro on us. Thank you for spreading the word.`]).catch(() => {});
          }
        }
        if (status === 'past_due' && was !== 'past_due') {
          mail(user.email, 'Your payment didn’t go through', [
            `We couldn’t charge your card for ${cfg.appName}. Your plan is still active while we retry over the next few days.`,
            `To avoid losing it, update your card under Account → Plan & billing → Manage billing:\n${baseUrl(req)}/#/account/plan`,
          ]).catch(() => {});
        }
        await db.save();
        log.log(`Billing: ${user.email} is now ${planFor(user)} (${status})`);
      }
      return { received: true };
    },
  };

  // Logged in.
  const authed = {
    'GET /api/me': (req, user) => ({ user: userView(user) }),

    'POST /api/me/settings': async (req, user) => {
      const { name, footer, timeZone, prefs } = await readJson(req);
      if (name !== undefined) user.name = String(name).trim().slice(0, 80);
      if (footer !== undefined) user.footer = String(footer).slice(0, 500);
      if (timeZone !== undefined) {
        if (!isTimeZone(timeZone)) throw fail('Unknown time zone');
        user.timeZone = timeZone;
      }
      if (prefs !== undefined) {
        const next = prefsOf(user);
        if (prefs.theme !== undefined) {
          if (!THEMES.includes(prefs.theme)) throw fail('Unknown theme');
          next.theme = prefs.theme;
        }
        if (prefs.defaultWhen !== undefined) {
          if (!WHEN_DEFAULTS.includes(prefs.defaultWhen)) throw fail('Unknown default');
          next.defaultWhen = prefs.defaultWhen;
        }
        if (prefs.confirmNow !== undefined) next.confirmNow = Boolean(prefs.confirmNow);
        if (prefs.compact !== undefined) next.compact = Boolean(prefs.compact);
        user.prefs = next;
      }
      await db.save();
      return { user: userView(user) };
    },

    'POST /api/me/email': async (req, user) => {
      const { email: rawEmail, password } = await readJson(req);
      if (!(await verifyPassword(password, user.passHash))) throw fail('Password is wrong', 401);
      const email = normalizeEmail(rawEmail);
      if (!validEmail(email)) throw fail('Enter a valid email');
      if (email === user.email) throw fail('That is already your email');
      if (db.userByEmail(email)) throw fail('That email already has an account', 409);
      user.email = email;
      await db.save();
      return { user: userView(user) };
    },

    // The devices this account is logged in on.
    'GET /api/me/sessions': (req, user) => {
      const current = sessionOf(db, readCookie(req, COOKIE), now())?.key;
      return {
        sessions: sessionsOf(db, user.id, now()).map((s) => ({
          id: sessionId(s.key),
          device: describeAgent(s.userAgent),
          createdAt: s.createdAt ?? null,
          lastSeenAt: s.lastSeenAt ?? null,
          current: s.key === current,
        })),
      };
    },

    'POST /api/me/sessions/revoke-others': async (req, user) => {
      const current = sessionOf(db, readCookie(req, COOKIE), now())?.key;
      const ended = endOtherSessions(db, user.id, current);
      await db.save();
      return { ok: true, ended };
    },

    // Everything we hold about the account, as a download. No password hash,
    // no session tokens.
    'GET /api/me/export': (req, user) => {
      const view = userView(user);
      const body = {
        exportedAt: new Date(now()).toISOString(),
        account: { email: view.email, name: view.name, timeZone: view.timeZone, footer: view.footer, createdAt: view.createdAt, plan: view.plan, prefs: view.prefs },
        targets: view.targets,
        queue: view.queue,
        posts: db.postsOf(user.id).map((p) => ({
          text: p.text, hasImage: Boolean(p.imageType), mode: p.mode, sendAt: p.sendAt, repeat: p.repeat, status: p.status, createdAt: p.createdAt,
          targets: p.targets.map((id) => user.targets.find((t) => t.id === id)?.name).filter(Boolean),
        })),
        history: user.history ?? [],
      };
      return [body, { 'content-disposition': 'attachment; filename="auto-poster-export.json"' }];
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
      await removeUser(user);
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
      const { ref, audience, color } = await readJson(req);
      if (!String(ref ?? '').trim()) throw fail('Paste a link or pick a group');
      const isStatus = String(ref).trim() === 'status';
      if (user.targets.length >= limitsFor(user).maxTargets) {
        throw fail(`Your plan allows ${limitsFor(user).maxTargets} groups/channels${cfg.billingEnabled ? ' — upgrade for more' : ''}`, 402);
      }
      const resolved = isStatus
        ? { jid: STATUS_JID, name: 'My Status', kind: 'status', audience: parseAudience(audience), color: parseColor(color) }
        : cfg.dryRun && wa.get(user.id).status().state !== 'connected'
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
      const post = await addPost(user, body, { base: baseUrl(req) });
      await db.save();
      if (body.when?.type === 'now') {
        try {
          await scheduler.sendNow(user, post);
          return { ok: true, sent: true, ...postsView(user) };
        } catch (err) {
          return { ok: true, sent: false, error: err.message, ...postsView(user) };
        }
      }
      return { ok: true, id: post.id, eta: etas(db, user, now()).get(post.id), ...postsView(user) };
    },

    // Many posts at once (from a pasted list or a spreadsheet). Rows with a
    // time are scheduled; rows without one join the queue. All or nothing.
    'POST /api/posts/bulk': async (req, user) => {
      const { items, targets } = await readJson(req);
      if (!Array.isArray(items) || !items.length) throw fail('Nothing to add');
      if (items.length > 200) throw fail('Add up to 200 posts at a time');
      const limits = limitsFor(user);
      const upgrade = cfg.billingEnabled ? ' — upgrade for more' : '';
      if (usage(user).created + items.length > limits.postsPerMonth) {
        throw fail(`That's more than the ${limits.postsPerMonth - usage(user).created} posts you have left this month${upgrade}`, 402);
      }
      if (db.postsOf(user.id).length + items.length > limits.maxPending) throw fail(`You can have ${limits.maxPending} posts waiting at once${upgrade}`, 402);
      const added = [];
      try {
        for (const [i, item] of items.entries()) {
          const at = item.at === undefined || item.at === null || item.at === '' ? null : Number(item.at);
          try {
            added.push(await addPost(user, { text: item.text, targets, when: at === null ? { type: 'queue' } : { type: 'at', at } }, { base: baseUrl(req) }));
          } catch (err) {
            throw fail(`Row ${i + 1}: ${err.message}`, err.status || 400);
          }
        }
      } catch (err) {
        for (const p of added) delete db.data.posts[p.id];
        usage(user).created -= added.length;
        throw err;
      }
      await db.save();
      return { ok: true, added: added.length, ...postsView(user) };
    },

    // ----- Templates -----

    'POST /api/templates': async (req, user) => {
      const { name, text } = await readJson(req);
      const clean = String(text ?? '').trim();
      if (!clean) throw fail('Write the text to save first');
      if (clean.length > MAX_TEXT) throw fail('That text is too long');
      user.templates ??= [];
      if (user.templates.length >= 50) throw fail('You can save up to 50 templates');
      user.templates.push({ id: randomUUID(), name: String(name ?? '').trim().slice(0, 60) || clean.slice(0, 40), text: clean });
      await db.save();
      return { user: userView(user) };
    },

    // ----- Link clicks -----

    'GET /api/links': (req, user) => {
      const mine = Object.entries(db.data.links).filter(([, l]) => l.userId === user.id);
      const hours = new Array(24).fill(0);
      for (const [, l] of mine) l.hours.forEach((n, h) => { hours[h] += n; });
      const total = hours.reduce((a, b) => a + b, 0);
      return {
        total,
        hours,
        // The hours (in the account's time zone) that got the most clicks.
        bestHours: total >= 10 ? hours.map((n, h) => ({ h, n })).sort((a, b) => b.n - a.n).slice(0, 3).filter((x) => x.n > 0).map((x) => x.h) : [],
        links: mine.sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 30)
          .map(([code, l]) => ({ code, url: l.url, clicks: l.clicks, label: l.label, createdAt: l.createdAt })),
      };
    },

    // ----- AI writer -----

    'POST /api/ai/caption': async (req, user) => {
      if (!captioner) throw fail('The AI writer is not switched on here', 404);
      if (!isPaid(planFor(user))) throw fail('The AI writer is a Pro feature — upgrade to use it', 402);
      const { prompt, tone } = await readJson(req);
      const ask = String(prompt ?? '').trim();
      if (ask.length < 3) throw fail('Say what the post is about');
      if (ask.length > 2000) throw fail('Keep the description under 2,000 characters');
      const month = usage(user).month;
      if (user.ai?.month !== month) user.ai = { month, count: 0 };
      if (user.ai.count >= 200) throw fail('You’ve used this month’s 200 AI captions', 429);
      const text = await captioner({ prompt: ask, tone: AI_TONES.includes(tone) ? tone : 'friendly' });
      user.ai.count += 1;
      await db.save();
      return { text };
    },

    // ----- Feeds: new items in an RSS feed become queued posts -----

    'POST /api/feeds': async (req, user) => {
      if (!isPaid(planFor(user))) throw fail('Posting from a feed is a Pro feature — upgrade to use it', 402);
      const { url, targets, template } = await readJson(req);
      const ids = [...new Set(Array.isArray(targets) ? targets : [])].filter((id) => user.targets.some((t) => t.id === id));
      if (!ids.length) throw fail('Pick where the feed’s posts should go');
      user.feeds ??= [];
      if (user.feeds.length >= 5) throw fail('You can connect up to 5 feeds');
      const clean = String(url ?? '').trim();
      if (user.feeds.some((f) => f.url === clean)) throw fail('That feed is already connected', 409);
      const items = await feedFetcher(clean);
      // Everything already in the feed counts as seen: only new items post.
      user.feeds.push({ id: randomUUID(), url: clean, targets: ids, template: String(template ?? '').slice(0, 500), seen: items.map((x) => x.id), addedAt: now(), error: null });
      await db.save();
      return { user: userView(user), found: items.length };
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
      const body = await readJson(req);
      const plan = body.plan === 'business' ? 'business' : 'pro';
      const interval = body.interval === 'year' ? 'year' : 'month';
      const priceId = cfg.prices[plan][interval];
      if (!stripe || !priceId) throw fail('Payments are not set up yet — try again later', 503);
      if (isPaying(user)) throw fail('You already have a subscription — use Manage billing to change it', 409);
      const session = await stripe.checkout({ user, priceId, plan, baseUrl: baseUrl(req) });
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
      const t = now();
      const week = 7 * 864e5;
      const users = Object.values(db.data.users).sort((a, b) => b.createdAt - a.createdAt).map((u) => ({
        trialEndsAt: !isPaying(u) && u.trialEndsAt > t ? u.trialEndsAt : null,
        id: u.id,
        email: u.email,
        name: u.name,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt ?? null,
        plan: planFor(u),
        planOverride: u.planOverride ?? null,
        subscription: u.subscription?.status ?? null,
        pending: db.postsOf(u.id).length,
        postsThisMonth: usage(u).created,
        targets: u.targets.length,
        whatsapp: wa.get(u.id).status().state,
        sentTotal: u.sentTotal ?? 0,
        disabled: Boolean(u.disabled),
        isAdmin: isAdmin(u),
        // Admins named in ADMIN_EMAILS can only be changed there.
        adminByConfig: cfg.adminEmails.includes(u.email),
        isYou: u.id === user.id,
      }));
      const all = Object.values(db.data.users);
      const payers = all.filter(isPaying);
      const paying = payers.length;
      // Monthly recurring revenue, estimated from the price labels.
      const amount = (label) => Number(/[\d.]+/.exec(String(label).replace(/,/g, ''))?.[0]) || 0;
      const mrr = payers.reduce((sum, u) => {
        const labels = cfg.priceLabels[u.subscription.plan === 'business' ? 'business' : 'pro'];
        return sum + (u.subscription.interval === 'year' ? amount(labels.year) / 12 : amount(labels.month));
      }, 0);
      const weeks = Array.from({ length: 8 }, (_, i) => {
        const end = t - (7 - i) * week;
        return all.filter((u) => u.createdAt > end - week && u.createdAt <= end).length;
      });
      return {
        users,
        billingEnabled: cfg.billingEnabled,
        stats: {
          accounts: users.length,
          newThisWeek: users.filter((u) => t - u.createdAt < week).length,
          activeThisWeek: users.filter((u) => u.lastLoginAt && t - u.lastLoginAt < week).length,
          linked: users.filter((u) => u.whatsapp === 'connected').length,
          postsThisMonth: users.reduce((n, u) => n + u.postsThisMonth, 0),
          waiting: users.reduce((n, u) => n + u.pending, 0),
          pro: users.filter((u) => u.plan !== 'free').length,
          paying,
          mrr: Math.round(mrr * 100) / 100,
          trials: users.filter((u) => u.trialEndsAt).length,
          canceled: all.filter((u) => u.subscription?.status === 'canceled').length,
          pastDue: all.filter((u) => u.subscription?.status === 'past_due').length,
          conversion: users.length ? Math.round((paying / users.length) * 1000) / 10 : 0,
          signupsByWeek: weeks,
        },
      };
    },
  };

  // A full copy of the data file, for safe keeping. Admins only.
  authed['GET /api/admin/backup'] = (req, user) => {
    requireAdmin(user);
    return [db.data, { 'content-disposition': `attachment; filename="auto-poster-backup-${new Date(now()).toISOString().slice(0, 10)}.json"` }];
  };

  const priceMap = {};
  for (const [plan, ids] of Object.entries(cfg.prices)) for (const [interval, id] of Object.entries(ids)) if (id) priceMap[id] = { plan, interval };

  // ---------- background jobs (every few minutes) ----------

  async function pollFeeds() {
    for (const user of Object.values(db.data.users)) {
      if (user.disabled || !user.feeds?.length || !isPaid(planFor(user))) continue;
      for (const feed of user.feeds) {
        try {
          const items = await feedFetcher(feed.url);
          const seen = new Set(feed.seen);
          const fresh = items.filter((x) => !seen.has(x.id)).reverse().slice(0, 5); // oldest first, a few at a time
          feed.error = null;
          const targets = feed.targets.filter((id) => user.targets.some((t) => t.id === id));
          for (const item of fresh) {
            if (!targets.length) { feed.error = 'The places this feed posts to were removed'; break; }
            await addPost(user, { text: renderItem(feed.template, item), targets, when: { type: 'queue' } });
            feed.seen.push(item.id);
          }
          feed.seen = feed.seen.slice(-300);
        } catch (err) {
          feed.error = err.message;
        }
      }
    }
  }

  async function runJobs() {
    const t = now();
    const meta = db.data.meta;
    const day = new Date(t).toISOString().slice(0, 10);
    if (meta.backupDay !== day) {
      meta.backupDay = day;
      await db.save();
      await db.backup(day).catch((err) => log.warn?.(`Backup failed: ${err.message}`));
    }
    if (t - (meta.feedsAt ?? 0) >= 15 * 60 * 1000) {
      meta.feedsAt = t;
      await pollFeeds();
    }
    const base = cfg.baseUrl;
    for (const user of Object.values(db.data.users)) {
      if (user.disabled) continue;
      const state = wa.get(user.id).status().state;
      // Paying customer's WhatsApp dropped: tell them and the admins, once.
      if (state === 'connected') {
        user.waLinkedAt = t;
        user.waAlerted = false;
      } else if (state === 'needs_link' && user.waLinkedAt && !user.waAlerted) {
        user.waAlerted = true;
        mail(user.email, 'Your WhatsApp was unlinked', [
          `${cfg.appName} is no longer linked to your WhatsApp, so scheduled posts are waiting.`,
          `Link it again to carry on:${base ? `\n${base}` : ''}`,
        ]).catch(() => {});
        if (isPaying(user)) for (const to of admins()) mail(to, `Paying customer unlinked: ${user.email}`, [`${user.email}'s WhatsApp is no longer linked. ${db.postsOf(user.id).length} posts are waiting.`]).catch(() => {});
      }
      // A nudge a day after signing up, if WhatsApp was never linked.
      if (!user.nudged && !user.waLinkedAt && t - user.createdAt > DAY && t - user.createdAt < 7 * DAY) {
        user.nudged = true;
        mail(user.email, 'One step left: link your WhatsApp', [
          'Your account is ready, but WhatsApp isn’t linked yet, so nothing can be sent.',
          `It takes a minute: enter your number, then type the pairing code on your phone.${base ? `\n${base}` : ''}`,
        ]).catch(() => {});
      }
      if (user.trialEndsAt > t && user.trialEndsAt - t < 2 * DAY && !user.trialWarned && !isPaying(user)) {
        user.trialWarned = true;
        mail(user.email, 'Your free trial ends soon', [
          `Your ${cfg.appName} Pro trial ends in under two days. After that you move to the Free plan.`,
          `Keep everything by upgrading:${base ? `\n${base}/#/account/plan` : ''}`,
        ]).catch(() => {});
      }
    }
    await db.save();
  }

  function requireAdmin(user) {
    if (!isAdmin(user)) throw fail('Admins only', 403);
  }

  // Routes with an id in the path.
  async function dynamic(req, user, path) {
    let m = /^\/api\/targets\/([\w-]+)$/.exec(path);
    if (m && req.method === 'POST') { // edit a Status target's audience / colour
      const target = user.targets.find((t) => t.id === m[1]);
      if (!target) throw fail('Not found', 404);
      if (target.kind !== 'status') throw fail('Only your Status has settings to edit');
      const { audience, color } = await readJson(req);
      if (audience !== undefined) target.audience = parseAudience(audience);
      if (color !== undefined) target.color = parseColor(color);
      await db.save();
      return { user: userView(user) };
    }
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
      const { planOverride, disabled, isAdmin: makeAdmin } = await readJson(req);
      if (makeAdmin !== undefined) {
        if (target.id === user.id) throw fail('You can’t change your own admin access');
        if (cfg.adminEmails.includes(target.email)) throw fail('This admin is set in ADMIN_EMAILS — change it there');
        target.isAdmin = Boolean(makeAdmin);
      }
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
    if (m && req.method === 'DELETE' && !m[2]) {
      requireAdmin(user);
      const target = db.data.users[m[1]];
      if (!target) throw fail('Not found', 404);
      if (target.id === user.id) throw fail('Delete your own account from the Account page');
      await removeUser(target);
      return { ok: true };
    }

    m = /^\/api\/(templates|feeds)\/([\w-]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      const list = user[m[1]] ?? [];
      const i = list.findIndex((x) => x.id === m[2]);
      if (i < 0) throw fail('Not found', 404);
      list.splice(i, 1);
      await db.save();
      return { user: userView(user) };
    }

    m = /^\/api\/me\/sessions\/([\w-]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      const found = sessionsOf(db, user.id, now()).find((x) => sessionId(x.key) === m[1]);
      if (!found) throw fail('Not found', 404);
      delete db.data.sessions[found.key];
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
          const found = sessionOf(db, readCookie(req, COOKIE), now());
          const user = found ? db.data.users[found.session.userId] : null;
          if (!user || user.disabled) return send(res, 401, { error: 'Please log in' });
          found.session.lastSeenAt = now(); // kept in memory; written with the next save
          out = authed[key] ? await authed[key](req, user) : await dynamic(req, user, path);
        }
        if (out === undefined) return send(res, 404, { error: 'Not found' });
        if (out?.raw) return send(res, 200, out.raw, { 'content-type': out.type, 'cache-control': 'private, max-age=3600' });
        const [body, headers] = Array.isArray(out) ? out : [out, {}];
        return send(res, 200, body, { 'cache-control': 'no-store', ...headers });
      }

      // Tracked link: count the click, then send the visitor on.
      const link = req.method === 'GET' && /^\/l\/([\w-]+)$/.exec(path);
      if (link) {
        const entry = db.data.links[link[1]];
        if (!entry) return send(res, 404, 'Link not found');
        entry.clicks += 1;
        const owner = db.data.users[entry.userId];
        entry.hours[new Date(now()).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: owner?.timeZone || 'UTC' }) % 24] += 1;
        db.save().catch(() => {});
        return send(res, 302, '', { location: entry.url, 'cache-control': 'no-store' });
      }

      if (req.method === 'GET') {
        const page = PAGE_PATHS.includes(path.slice(1)) && renderPage(path.slice(1), cfg);
        if (page) return send(res, 200, page, { 'content-type': MIME['.html'] });
        if (path === '/robots.txt') return send(res, 200, `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /l/\n${cfg.baseUrl ? `Sitemap: ${cfg.baseUrl}/sitemap.xml\n` : ''}`);
        if (path === '/sitemap.xml') return send(res, 200, sitemap(cfg), { 'content-type': 'application/xml' });
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
  server.runJobs = runJobs;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  const app = await createApp(cfg);
  app.scheduler.start();
  setInterval(() => app.pruneSessions(), 6 * 60 * 60 * 1000).unref();
  // Backups, feeds, reminder emails and WhatsApp-unlinked alerts.
  setInterval(() => app.runJobs().catch((e) => console.error('Jobs failed:', e)), 5 * 60 * 1000).unref();
  app.listen(PORT, () => {
    console.log(`${cfg.appName} on http://localhost:${PORT}`);
    if (cfg.dryRun) console.log('DRY_RUN is on — posts are logged, not sent');
    if (!cfg.signupsOpen) console.log('Sign-ups are closed (SIGNUPS_OPEN=0)');
    console.log(cfg.billingEnabled
      ? `Billing ON${cfg.stripeSecretKey && cfg.stripePriceId && cfg.stripeWebhookSecret ? '' : ' — ⚠️ STRIPE_SECRET_KEY / STRIPE_PRICE_ID / STRIPE_WEBHOOK_SECRET missing'}${cfg.baseUrl ? '' : ' — ⚠️ set BASE_URL'}`

      : 'Billing off — everyone gets Pro for free (BILLING_ENABLED=1 to charge)');
    console.log(`Email ${cfg.smtp.host ? 'on' : 'off (set SMTP_HOST for password resets and reminders)'} · AI writer ${cfg.anthropicKey ? 'on' : 'off'}`);
    console.log(`${Object.keys(app.db.data.users).length} accounts · ${Object.keys(app.db.data.posts).length} posts waiting`);
  });
  const linked = await app.wa.startAll(Object.keys(app.db.data.users));
  if (linked) console.log(`Reconnecting ${linked} linked WhatsApp account(s)…`);
}
