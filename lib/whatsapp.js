// WhatsApp connections (Baileys), one per account.
//
// Same library and pairing-code login as the NBA poster and the DealsPulse
// bot, but multi-tenant: every account links its own WhatsApp number from the
// page and posts from it. Each login lives in its own folder under
// DATA_DIR/wa/<userId> (a Railway volume), so linking is a one-time thing.
//
// Where a post can go (a "target"):
//   - a group the linked number is in (picked from the list on the page,
//     or a chat.whatsapp.com invite link)
//   - a channel it owns or admins (whatsapp.com/channel/… link)
//   - a raw …@g.us / …@newsletter id

import { access, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Baileys wants a pino-like logger; a silent no-op keeps logs clean.
const logger = {
  level: 'silent',
  child: () => logger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isJid = (s) => /^[\w.-]+@(newsletter|g\.us)$/.test(s);
export const channelInviteCode = (s) => s.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i)?.[1] ?? null;
export const groupInviteCode = (s) => s.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]+)/i)?.[1] ?? null;

export function createWhatsApp({ authDir, label = '' }) {
  let baileys; // lazy-loaded so tests and dry-run never touch the network
  let sock = null;
  let state = 'needs_link'; // needs_link | connecting | pairing | connected
  let pairingCode = null;
  let lastError = null;
  let me = null;
  let stopped = false;
  let reconnectTimer = null;

  async function connect() {
    stopped = false;
    baileys ??= await import('@whiskeysockets/baileys');
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {} // bundled default is fine

    sock = makeWASocket({
      auth,
      version,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    const thisSock = sock;
    sock.ev.on('creds.update', saveCreds);
    if (state !== 'pairing') state = sock.authState.creds.registered ? 'connecting' : 'needs_link';

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (thisSock !== sock) return; // an old socket we've replaced
      if (connection === 'open') {
        state = 'connected';
        pairingCode = null;
        lastError = null;
        me = sock.user?.id?.split(/[:@]/)[0] ?? null;
        console.log(`WhatsApp connected ${label}`);
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (stopped) return;
        if (code === baileys.DisconnectReason.loggedOut) {
          // Unlinked from the phone: wipe the session so the page can relink.
          console.warn(`WhatsApp logged out ${label} — clearing session`);
          await rm(authDir, { recursive: true, force: true });
          sock = null;
          state = 'needs_link';
          pairingCode = null;
          me = null;
          return;
        }
        if (state === 'connected') state = 'connecting';
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connect().catch((e) => { lastError = e.message; }), 5000);
      }
    });
  }

  const requireConnected = () => {
    if (state !== 'connected') throw fail('WhatsApp is not linked yet — link it first', 503);
  };

  // Turn whatever the user pasted into { jid, name, kind }.
  async function resolve(ref) {
    requireConnected();
    const s = String(ref ?? '').trim();
    const channel = channelInviteCode(s);
    if (channel) {
      const meta = await sock.newsletterMetadata('invite', channel).catch(() => null);
      if (!meta?.id) throw fail('That channel link did not resolve — check it');
      return { jid: meta.id, name: meta.thread_metadata?.name?.text ?? meta.name ?? 'Channel', kind: 'channel' };
    }
    const group = groupInviteCode(s);
    if (group) {
      const info = await sock.groupGetInviteInfo(group).catch(() => null);
      if (!info?.id) throw fail('That group link did not resolve — check it');
      return { jid: info.id, name: info.subject || 'Group', kind: 'group' };
    }
    if (isJid(s)) {
      const isChannel = s.endsWith('@newsletter');
      const meta = isChannel
        ? await sock.newsletterMetadata('jid', s).catch(() => null)
        : await sock.groupMetadata(s).catch(() => null);
      const name = meta?.thread_metadata?.name?.text ?? meta?.name ?? meta?.subject ?? s;
      return { jid: s, name, kind: isChannel ? 'channel' : 'group' };
    }
    throw fail('Paste a group invite link, a channel link, or pick a group from the list');
  }

  return {
    connect,

    status: () => ({ state, pairingCode, error: lastError, phone: me }),

    // Digits only, with country code. Returns the 8-character code the user
    // types on their phone: Linked Devices → Link a Device → "Link with phone
    // number instead".
    async requestPairingCode(phone) {
      const digits = String(phone ?? '').replace(/\D/g, '');
      if (digits.length < 8) throw fail('Enter the full number with country code');
      if (state === 'connected') throw fail('Already linked', 409);
      if (!sock) {
        await connect();
        await sleep(1500); // let the socket finish its handshake first
      }
      pairingCode = await sock.requestPairingCode(digits);
      state = 'pairing';
      return pairingCode;
    },

    async listGroups() {
      requireConnected();
      const all = await sock.groupFetchAllParticipating();
      return Object.values(all)
        .map((g) => ({ jid: g.id, name: g.subject || g.id, announce: Boolean(g.announce) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    resolve,

    async send(jid, { caption, image }) {
      requireConnected();
      await sock.sendMessage(jid, image ? { image: image.buf, mimetype: image.type, caption } : { text: caption });
    },

    // Unlink from the page (also removes the linked device on the phone).
    async logout() {
      stopped = true;
      clearTimeout(reconnectTimer);
      try { await sock?.logout(); } catch {}
      try { sock?.end?.(); } catch {}
      sock = null;
      state = 'needs_link';
      pairingCode = null;
      me = null;
      await rm(authDir, { recursive: true, force: true });
    },

    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      try { sock?.end?.(); } catch {}
    },
  };
}

// One connection per account, created on demand. On boot, every account
// that has linked before reconnects on its own.
export function createWhatsAppManager({ dir, factory = createWhatsApp }) {
  const conns = new Map();
  const authDir = (userId) => join(dir, userId);
  const get = (userId) => {
    let c = conns.get(userId);
    if (!c) {
      c = factory({ authDir: authDir(userId), label: `(${userId.slice(0, 8)})` });
      conns.set(userId, c);
    }
    return c;
  };

  return {
    get,

    async startAll(userIds) {
      let linked = [];
      try {
        const folders = new Set(await readdir(dir));
        linked = userIds.filter((id) => folders.has(id));
      } catch {} // nothing linked yet
      for (const id of linked) {
        if (!(await access(join(authDir(id), 'creds.json')).then(() => true, () => false))) continue;
        get(id).connect().catch((e) => console.error(`WhatsApp start failed for ${id}: ${e.message}`));
        await sleep(250); // don't open every socket in the same instant
      }
      return linked.length;
    },

    async remove(userId) {
      await conns.get(userId)?.logout();
      conns.delete(userId);
      await rm(authDir(userId), { recursive: true, force: true });
    },
  };
}
