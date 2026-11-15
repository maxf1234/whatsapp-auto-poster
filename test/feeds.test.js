import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFeed, isPrivateAddress, parseFeed, renderItem } from '../lib/feeds.js';
import { nextRepeat } from '../lib/time.js';

test('feeds: RSS and Atom parse to id / title / link', () => {
  const rss = parseFeed('<rss><channel><item><title><![CDATA[Deal &amp; more]]></title><link>https://a.test/1</link><guid>g1</guid></item></channel></rss>');
  assert.deepEqual(rss, [{ id: 'g1', title: 'Deal & more', link: 'https://a.test/1' }]);
  const atom = parseFeed('<feed><entry><title>Hi</title><link href="https://a.test/2"/><id>tag:2</id></entry></feed>');
  assert.deepEqual(atom, [{ id: 'tag:2', title: 'Hi', link: 'https://a.test/2' }]);
  assert.throws(() => parseFeed('<html><body>nope</body></html>'), /not an RSS/);
  assert.equal(renderItem('', rss[0]), 'Deal & more\n\nhttps://a.test/1');
});

test('feeds: private and local addresses are refused, also after a redirect', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '172.20.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  const resolve = async (h) => [{ address: h === 'inside.test' ? '10.0.0.5' : '93.184.216.34' }];
  await assert.rejects(fetchFeed('http://inside.test/feed', { resolve, fetchImpl: async () => assert.fail('must not fetch') }), /not allowed/);
  await assert.rejects(fetchFeed('file:///etc/passwd', { resolve }), /http/);
  const redirect = async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
  await assert.rejects(fetchFeed('https://ok.test/feed', { resolve, fetchImpl: redirect }), /not allowed/);
  const ok = async () => new Response('<rss><channel><item><title>T</title><link>https://ok.test/1</link></item></channel></rss>');
  assert.equal((await fetchFeed('https://ok.test/feed', { resolve, fetchImpl: ok })).length, 1);
});

test('repeats: weekdays skip the weekend, monthly keeps the day', () => {
  const fri = Date.parse('2026-10-30T09:00:00Z'); // a Friday
  assert.equal(new Date(nextRepeat(fri, 'weekdays', 'UTC')).toISOString(), '2026-11-02T09:00:00.000Z');
  assert.equal(new Date(nextRepeat(fri, 'every2', 'UTC')).toISOString(), '2026-11-01T09:00:00.000Z');
  assert.equal(new Date(nextRepeat(Date.parse('2027-01-31T09:00:00Z'), 'monthly', 'UTC')).toISOString(), '2027-02-28T09:00:00.000Z');
  assert.equal(new Date(nextRepeat(fri, 'monthly', 'UTC')).toISOString(), '2026-11-30T09:00:00.000Z');
});
