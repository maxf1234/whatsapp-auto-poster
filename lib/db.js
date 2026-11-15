// Storage on DATA_DIR (a Railway volume).
//
//   data.sqlite    — users, sessions, posts, links and settings (SQLite)
//   images/<id>    — each scheduled post's attachment
//   backups/       — a dated JSON copy per day
//
// Everything is kept in memory and written back after each change. With
// SQLite only the records that changed are written, inside one transaction,
// so a save stays fast and safe however many accounts there are.
//
// Upgrading from the old single-file format is automatic: on the first start
// db.json is imported and then kept as db.json.imported, untouched. To go
// back, set DB_FORMAT=json and rename that file to db.json.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const KINDS = ['users', 'sessions', 'posts', 'links'];
const EMPTY = () => ({ version: 1, users: {}, sessions: {}, posts: {}, links: {}, meta: {} });

async function readJsonFile(file) {
  try {
    return { ...EMPTY(), ...JSON.parse(await readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${file}: ${err.message}`);
    return null;
  }
}

// The old format: the whole database as one JSON file, rewritten each save.
async function jsonStore(dir) {
  const file = join(dir, 'db.json');
  const data = (await readJsonFile(file)) ?? EMPTY();
  return {
    data,
    format: 'json',
    async write() {
      await mkdir(dir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(data));
      await rename(`${file}.tmp`, file); // atomic: a crash never leaves half a file
    },
  };
}

async function sqliteStore(dir, DatabaseSync) {
  await mkdir(dir, { recursive: true });
  const sql = new DatabaseSync(join(dir, 'data.sqlite'));
  sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  sql.exec('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, id)) WITHOUT ROWID');

  const data = EMPTY();
  const written = new Map(KINDS.map((k) => [k, new Map()])); // what's on disk, to spot changes
  let metaWritten = null;
  const rows = sql.prepare('SELECT kind, id, json FROM records').all();
  for (const { kind, id, json } of rows) {
    if (kind === 'meta') { data.meta = JSON.parse(json); metaWritten = json; } else if (written.has(kind)) { data[kind][id] = JSON.parse(json); written.get(kind).set(id, json); }
  }

  const put = sql.prepare('INSERT INTO records (kind, id, json) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET json = excluded.json');
  const del = sql.prepare('DELETE FROM records WHERE kind = ? AND id = ?');
  function write() {
    const ops = [];
    for (const kind of KINDS) {
      const seen = written.get(kind);
      for (const [id, value] of Object.entries(data[kind])) {
        const json = JSON.stringify(value);
        if (seen.get(id) !== json) ops.push(() => { put.run(kind, id, json); seen.set(id, json); });
      }
      for (const id of seen.keys()) if (!(id in data[kind])) ops.push(() => { del.run(kind, id); seen.delete(id); });
    }
    const meta = JSON.stringify(data.meta ?? {});
    if (meta !== metaWritten) ops.push(() => { put.run('meta', 'root', meta); metaWritten = meta; });
    if (!ops.length) return;
    sql.exec('BEGIN');
    try {
      for (const op of ops) op();
      sql.exec('COMMIT');
    } catch (err) {
      sql.exec('ROLLBACK');
      for (const m of written.values()) m.clear(); // unsure what landed: rewrite everything next time
      metaWritten = null;
      throw err;
    }
  }

  // First start after upgrading: bring the old db.json across.
  const old = join(dir, 'db.json');
  if (!rows.length && existsSync(old)) {
    Object.assign(data, await readJsonFile(old));
    write();
    await rename(old, `${old}.imported`);
    console.log(`Imported ${Object.keys(data.users).length} accounts from db.json into data.sqlite (the old file is kept as db.json.imported)`);
  }
  return { data, format: 'sqlite', write: async () => write(), close: () => sql.close() };
}

export async function openDb(dir, { format = process.env.DB_FORMAT } = {}) {
  const imgDir = join(dir, 'images');
  let DatabaseSync = null;
  if (format !== 'json') {
    try { ({ DatabaseSync } = await import('node:sqlite')); } catch {} // older Node: stay on the JSON file
  }
  const store = DatabaseSync ? await sqliteStore(dir, DatabaseSync) : await jsonStore(dir);
  const { data } = store;

  // Writes are serialized so two requests can never interleave a save.
  let chain = Promise.resolve();
  const save = () => {
    chain = chain.catch(() => {}).then(() => store.write());
    return chain;
  };

  return {
    data,
    save,
    format: store.format,
    close: () => store.close?.(),
    userByEmail: (email) => Object.values(data.users).find((u) => u.email === email) ?? null,
    postsOf: (userId) => Object.values(data.posts).filter((p) => p.userId === userId),

    // A dated, readable copy of everything under backups/, keeping the newest
    // `keep`. Restore one by saving it as db.json with DB_FORMAT=json, or by
    // starting with an empty data.sqlite next to it.
    async backup(day, keep = 14) {
      await chain.catch(() => {});
      const bdir = join(dir, 'backups');
      await mkdir(bdir, { recursive: true });
      await writeFile(join(bdir, `db-${day}.json`), JSON.stringify(data));
      const old = (await readdir(bdir)).filter((f) => /^db-.*\.json$/.test(f)).sort().reverse().slice(keep);
      for (const f of old) await rm(join(bdir, f), { force: true });
    },

    async writeImage(id, buf) {
      await mkdir(imgDir, { recursive: true });
      await writeFile(join(imgDir, id), buf);
    },
    readImage: (id) => readFile(join(imgDir, id)),
    removeImage: (id) => rm(join(imgDir, id), { force: true }),
  };
}
