// Accounts: email + password (scrypt), sessions in an HttpOnly cookie.
//
// The cookie holds a random token; the database only stores its SHA-256, so
// a leaked db.json can't be used to log in as anyone.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SESSION_DAYS = 30;
export const COOKIE = 'sid';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

const tokenHash = (token) => createHash('sha256').update(token).digest('base64url');

export function createSession(db, userId, now = Date.now(), { userAgent = '' } = {}) {
  const token = randomBytes(32).toString('base64url');
  db.data.sessions[tokenHash(token)] = {
    userId, expiresAt: now + SESSION_DAYS * 864e5, createdAt: now, lastSeenAt: now,
    userAgent: String(userAgent).slice(0, 300),
  };
  return token;
}

// The stored session behind a cookie token, with its key (the token's hash).
export function sessionOf(db, token, now = Date.now()) {
  if (!token) return null;
  const key = tokenHash(token);
  const s = db.data.sessions[key];
  if (!s || s.expiresAt < now) return null;
  return { key, session: s };
}

export function sessionUser(db, token, now = Date.now()) {
  const found = sessionOf(db, token, now);
  return found ? db.data.users[found.session.userId] ?? null : null;
}

// A short public id for a session: enough to pick one out of a user's own
// list, useless for logging in (it's a slice of a hash of the token).
export const sessionId = (key) => key.slice(0, 16);

export function sessionsOf(db, userId, now = Date.now()) {
  return Object.entries(db.data.sessions)
    .filter(([, s]) => s.userId === userId && s.expiresAt >= now)
    .map(([key, s]) => ({ key, ...s }))
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

// Ends every session of a user except `keepKey`. Returns how many ended.
export function endOtherSessions(db, userId, keepKey) {
  let n = 0;
  for (const [k, s] of Object.entries(db.data.sessions)) {
    if (s.userId === userId && k !== keepKey) { delete db.data.sessions[k]; n += 1; }
  }
  return n;
}

export function endSession(db, token) {
  if (token) delete db.data.sessions[tokenHash(token)];
}

export function endAllSessions(db, userId) {
  for (const [k, s] of Object.entries(db.data.sessions)) if (s.userId === userId) delete db.data.sessions[k];
}

export function pruneSessions(db, now = Date.now()) {
  for (const [k, s] of Object.entries(db.data.sessions)) if (s.expiresAt < now) delete db.data.sessions[k];
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token, { secure }) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', secure && 'Secure'].filter(Boolean);
  return token
    ? `${COOKIE}=${token}; Max-Age=${SESSION_DAYS * 86400}; ${attrs.join('; ')}`
    : `${COOKIE}=; Max-Age=0; ${attrs.join('; ')}`;
}

export const normalizeEmail = (e) => String(e ?? '').trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

// Slows down password guessing: 10 tries per key per 15 minutes.
export function createRateLimiter({ max = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const h = hits.get(key);
    if (!h || h.resetAt < t) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      if (hits.size > 10000) for (const [k, v] of hits) if (v.resetAt < t) hits.delete(k);
      return true;
    }
    h.count += 1;
    return h.count <= max;
  };
}
