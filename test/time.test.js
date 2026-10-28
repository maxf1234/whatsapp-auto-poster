import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inWindow, nextOpen, nextRepeat, nextRepeatAfter, queueSchedule, zonedToUtc } from '../lib/time.js';

const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();

test('active-hours window, including overnight windows', () => {
  const day = { startHour: 9, endHour: 23 };
  assert.equal(inWindow(at('2026-10-28T08:59:00Z'), day, 'UTC'), false);
  assert.equal(inWindow(at('2026-10-28T09:00:00Z'), day, 'UTC'), true);
  assert.equal(inWindow(at('2026-10-28T23:00:00Z'), day, 'UTC'), false);
  const night = { startHour: 18, endHour: 2 };
  assert.equal(inWindow(at('2026-10-28T01:30:00Z'), night, 'UTC'), true);
  assert.equal(inWindow(at('2026-10-28T12:00:00Z'), night, 'UTC'), false);
  assert.equal(inWindow(at('2026-10-28T03:00:00Z'), { startHour: 0, endHour: 0 }, 'UTC'), true);
  assert.equal(nextOpen(at('2026-10-28T23:30:00Z'), day, 'UTC'), at('2026-10-29T09:00:00Z'));
});

test('active hours follow the account time zone', () => {
  // 9 AM New York (EDT, UTC-4) = 13:00 UTC
  assert.equal(nextOpen(at('2026-10-28T05:00:00Z'), { startHour: 9, endHour: 17 }, 'America/New_York'), at('2026-10-28T13:00:00Z'));
});

test('wall-clock → UTC', () => {
  assert.equal(iso(zonedToUtc({ y: 2026, m: 7, d: 1, h: 9 }, 'America/New_York')), '2026-07-01T13:00:00.000Z');
  assert.equal(iso(zonedToUtc({ y: 2026, m: 12, d: 1, h: 9 }, 'America/New_York')), '2026-12-01T14:00:00.000Z');
  assert.equal(iso(zonedToUtc({ y: 2026, m: 12, d: 1, h: 9 }, 'Asia/Jerusalem')), '2026-12-01T07:00:00.000Z');
});

test('daily repeat keeps the local time across a DST change', () => {
  // US clocks go back on Sun 1 Nov 2026: 9 AM EDT (13:00Z) → 9 AM EST (14:00Z)
  const sat = at('2026-10-31T13:00:00Z');
  assert.equal(iso(nextRepeat(sat, 'daily', 'America/New_York')), '2026-11-01T14:00:00.000Z');
  assert.equal(iso(nextRepeat(sat, 'weekly', 'America/New_York')), '2026-11-07T14:00:00.000Z');
  assert.equal(nextRepeat(sat, 'none', 'America/New_York'), null);
});

test('missed repeats roll forward past now instead of firing in a burst', () => {
  const was = at('2026-10-20T09:00:00Z');
  assert.equal(iso(nextRepeatAfter(was, 'daily', 'UTC', at('2026-10-28T12:00:00Z'))), '2026-10-29T09:00:00.000Z');
});

test('queue ETAs: one per interval, skipping quiet hours', () => {
  const q = { intervalMin: 120, startHour: 9, endHour: 23, lastSentAt: 0, retryAt: 0 };
  const etas = queueSchedule(['a', 'b', 'c'], q, at('2026-10-28T20:00:00Z'), 'UTC').map((x) => iso(x.eta));
  assert.deepEqual(etas, ['2026-10-28T20:00:00.000Z', '2026-10-28T22:00:00.000Z', '2026-10-29T09:00:00.000Z']);
  const after = queueSchedule(['a'], { ...q, lastSentAt: at('2026-10-28T19:30:00Z') }, at('2026-10-28T20:00:00Z'), 'UTC');
  assert.equal(iso(after[0].eta), '2026-10-28T21:30:00.000Z');
});
