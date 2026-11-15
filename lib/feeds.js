// RSS / Atom feeds: new items become queued posts.
//
// The URL comes from a user, so fetching it is guarded: http(s) only, no
// private or local addresses (also after redirects), a size cap and a timeout.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const a = ip.toLowerCase();
    if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7));
    return a === '::1' || a === '::' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function assertPublic(url, resolve) {
  let u;
  try { u = new URL(url); } catch { throw fail('That is not a valid feed address'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail('Feed addresses must start with http:// or https://');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await resolve(host).catch(() => { throw fail('Could not find that website'); });
  if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) throw fail('That address is not allowed');
  return u;
}

export async function fetchFeed(url, { fetchImpl = fetch, resolve = (h) => lookup(h, { all: true }) } = {}) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublic(current, resolve);
    const res = await fetchImpl(u, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    if (!res.ok) throw fail(`The feed answered with an error (${res.status})`, 502);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw fail('That feed is too large');
    return parseFeed(buf.toString('utf8'));
  }
  throw fail('Too many redirects');
}

const decode = (s = '') => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1];

// Newest first, as feeds list them. Each item: { id, title, link }.
export function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  if (!blocks.length && !/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw fail('That page is not an RSS or Atom feed');
  return blocks.map((b) => {
    const link = decode(tag(b, 'link')) || /<link[^>]*href="([^"]+)"/i.exec(b)?.[1] || '';
    const title = decode(tag(b, 'title'));
    const id = decode(tag(b, 'guid') ?? tag(b, 'id')) || link || title;
    return { id, title, link: /^https?:\/\//.test(link) ? link : '' };
  }).filter((x) => x.id && (x.title || x.link)).slice(0, 50);
}

export const renderItem = (template, item) => (template || '{title}\n\n{link}')
  .replaceAll('{title}', item.title).replaceAll('{link}', item.link).trim();
