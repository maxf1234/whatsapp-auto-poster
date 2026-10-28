// The scheduler: one timer for every account.
//
// Each post is one of two kinds:
//   at     — goes out at `sendAt` (picked as an exact time, or "in N minutes"),
//            optionally repeating daily / weekly at the same local time
//   queue  — waits in the account's drip queue (like the NBA poster's): one
//            post every `intervalMin`, only inside the active hours
//
// A post goes to every one of its targets. If a send fails (WhatsApp
// reconnecting, phone offline), the targets it already reached are
// remembered, and it retries the rest every 5 minutes. After a day of
// failing it's marked failed and waits for the user (Send now / delete).

import { nextRepeatAfter, queueSchedule, DAY } from './time.js';

export const RETRY_MS = 5 * 60 * 1000;
export const GIVE_UP_MS = DAY;
const HISTORY_MAX = 50;
const BETWEEN_TARGETS_MS = 2000; // a little gap so WhatsApp doesn't see a burst

export const DEFAULT_QUEUE = { intervalMin: 120, startHour: 9, endHour: 23, paused: false, lastSentAt: 0, retryAt: 0, error: null };

export const withFooter = (text, footer) => (footer ? `${text}\n\n${footer}` : text);

export function queueOf(db, user) {
  return db.postsOf(user.id).filter((p) => p.mode === 'queue').sort((a, b) => a.order - b.order);
}

// ETA of each of the user's pending posts (queue ones depend on order).
export function etas(db, user, now) {
  const out = new Map();
  for (const p of db.postsOf(user.id)) if (p.mode === 'at') out.set(p.id, Math.max(p.sendAt, p.retryAt || 0));
  for (const { item, eta } of queueSchedule(queueOf(db, user), user.queue, now, user.timeZone)) out.set(item.id, eta);
  return out;
}

export function createScheduler({ db, deliver, now = Date.now, gapMs = BETWEEN_TARGETS_MS, log = console }) {
  const busy = new Set(); // userIds with a send in progress

  function record(user, post, status, targets) {
    user.history ??= [];
    user.history.unshift({ at: now(), text: post.text.slice(0, 280), hasImage: Boolean(post.imageType), targets, status });
    user.history.length = Math.min(user.history.length, HISTORY_MAX);
  }

  // Send `post` to the targets it hasn't reached yet. Throws if any fails.
  async function sendPost(user, post) {
    const image = post.imageType ? { type: post.imageType, buf: await db.readImage(post.id) } : undefined;
    const caption = withFooter(post.text, user.footer);
    post.sentTo ??= [];
    const targets = post.targets.map((id) => user.targets.find((t) => t.id === id)).filter(Boolean);
    if (!targets.length) throw Object.assign(new Error('None of this post’s groups/channels exist any more'), { status: 400 });

    let first = true;
    for (const t of targets) {
      if (post.sentTo.includes(t.id)) continue;
      if (!first && gapMs) await new Promise((r) => setTimeout(r, gapMs));
      first = false;
      await deliver(user, t, { caption, image });
      post.sentTo.push(t.id);
    }

    const t = now();
    record(user, post, 'sent', targets.map((x) => x.name));
    if (post.mode === 'queue') {
      user.queue.lastSentAt = t;
      user.queue.retryAt = 0;
      user.queue.error = null;
    }
    const next = post.mode === 'at' ? nextRepeatAfter(post.sendAt, post.repeat, user.timeZone, t) : null;
    if (next) {
      Object.assign(post, { sendAt: next, sentTo: [], retryAt: 0, error: null, status: 'scheduled', lastSentAt: t });
    } else {
      delete db.data.posts[post.id];
      if (post.imageType) await db.removeImage(post.id);
    }
    await db.save();
    return { sent: targets.length, next };
  }

  async function failPost(user, post, err) {
    const t = now();
    if (post.mode === 'queue') {
      user.queue.error = err.message;
      user.queue.retryAt = t + RETRY_MS;
    } else {
      post.error = err.message;
      post.retryAt = t + RETRY_MS;
      if (t - post.sendAt > GIVE_UP_MS) {
        post.status = 'failed';
        record(user, post, `failed: ${err.message}`, []);
      }
    }
    log.warn?.(`Post ${post.id} for ${user.email} failed: ${err.message}`);
    await db.save();
  }

  async function runUser(user) {
    const t = now();
    const posts = db.postsOf(user.id);
    const due = posts
      .filter((p) => p.mode === 'at' && p.status === 'scheduled' && p.sendAt <= t && (p.retryAt || 0) <= t)
      .sort((a, b) => a.sendAt - b.sendAt);
    const queue = queueOf(db, user);
    if (!user.queue.paused && queue.length) {
      const [head] = queueSchedule(queue, user.queue, t, user.timeZone);
      if (head.eta <= t) due.push(head.item);
    }
    for (const post of due) {
      try {
        await sendPost(user, post);
      } catch (err) {
        await failPost(user, post, err);
        if (err.status === 503) break; // not linked: the rest would fail the same way
      }
    }
  }

  return {
    sendPost,

    // "Send now" from the page: skips the schedule, and surfaces the error.
    async sendNow(user, post) {
      if (busy.has(user.id)) throw Object.assign(new Error('A post is sending right now — try again in a moment'), { status: 409 });
      busy.add(user.id);
      try {
        return await sendPost(user, post);
      } catch (err) {
        if (post.status === 'failed') post.status = 'scheduled';
        await failPost(user, post, err);
        throw err;
      } finally {
        busy.delete(user.id);
      }
    },

    async tick() {
      const users = Object.values(db.data.users).filter((u) => !u.disabled && !busy.has(u.id));
      await Promise.all(users.map(async (user) => {
        busy.add(user.id);
        try {
          await runUser(user);
        } catch (err) {
          log.error?.(`Scheduler failed for ${user.email}:`, err);
        } finally {
          busy.delete(user.id);
        }
      }));
    },

    start(everyMs = 20 * 1000) {
      const timer = setInterval(() => this.tick().catch((e) => log.error?.('Tick failed:', e)), everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
