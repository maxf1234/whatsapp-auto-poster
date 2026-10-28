// Time math for the scheduler, all in the account's own time zone.
//
// - Active hours (the queue only sends inside them), same rules as the NBA
//   poster: [startHour, endHour), start === end = all day, overnight works.
// - Repeating posts keep their wall-clock time across DST changes: a post at
//   9:00 every day stays at 9:00, not 8:00 after the clocks move.

const STEP_MS = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const fmtCache = new Map();
function formatter(timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

export function isTimeZone(tz) {
  try {
    formatter(String(tz));
    return true;
  } catch {
    return false;
  }
}

// Wall-clock fields of `ms` in `timeZone`.
export function zonedParts(ms, timeZone) {
  const p = {};
  for (const { type, value } of formatter(timeZone).formatToParts(ms)) p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

// Wall-clock time in `timeZone` → epoch ms. Nonexistent times (inside a DST
// gap) land just after the gap.
export function zonedToUtc({ y, m, d, h = 0, mi = 0, s = 0 }, timeZone) {
  const wall = Date.UTC(y, m - 1, d, h, mi, s);
  const offsetAt = (t) => {
    const p = zonedParts(t, timeZone);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
  };
  const first = wall - offsetAt(wall);
  const second = wall - offsetAt(first);
  return Math.max(first, second);
}

export const hourIn = (ms, timeZone) => zonedParts(ms, timeZone).h;

export function inWindow(ms, { startHour, endHour }, timeZone) {
  if (startHour === endHour) return true;
  const h = hourIn(ms, timeZone);
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

// First moment at or after `ms` that's inside the window.
export function nextOpen(ms, settings, timeZone) {
  if (inWindow(ms, settings, timeZone)) return ms;
  let t = Math.ceil(ms / STEP_MS) * STEP_MS;
  for (let i = 0; i < 400 && !inWindow(t, settings, timeZone); i++) t += STEP_MS;
  // Land on the hour the window opens rather than a 5-minute step past it.
  const onHour = t - (t % HOUR);
  return onHour >= ms && inWindow(onHour, settings, timeZone) ? onHour : t;
}

export const REPEATS = { none: 0, daily: 1, weekly: 7 };

// Next occurrence of a repeating post after `ms`, same local time of day.
export function nextRepeat(ms, repeat, timeZone) {
  const days = REPEATS[repeat];
  if (!days) return null;
  const p = zonedParts(ms, timeZone);
  const date = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return zonedToUtc({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), h: p.h, mi: p.mi, s: p.s }, timeZone);
}

// Roll a repeating post forward past `now` (e.g. after the server was down
// for a day, it shouldn't fire every missed occurrence at once).
export function nextRepeatAfter(ms, repeat, timeZone, now) {
  let t = nextRepeat(ms, repeat, timeZone);
  while (t !== null && t <= now) t = nextRepeat(t, repeat, timeZone);
  return t;
}

// Send time for every queued post, in order: one per interval, inside the
// active hours, the first one interval after the last queue send.
export function queueSchedule(items, queue, now, timeZone) {
  const gap = queue.intervalMin * 60 * 1000;
  let t = Math.max(now, queue.lastSentAt ? queue.lastSentAt + gap : now, queue.retryAt || 0);
  return items.map((item, i) => {
    if (i > 0) t += gap;
    t = nextOpen(t, queue, timeZone);
    return { item, eta: t };
  });
}

export const monthKey = (ms, timeZone) => {
  const { y, m } = zonedParts(ms, timeZone);
  return `${y}-${String(m).padStart(2, '0')}`;
};

export { HOUR, DAY };
