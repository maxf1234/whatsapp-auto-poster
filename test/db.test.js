import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';

async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'apdb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('database: saves survive a restart; edits and deletes are written', async (t) => {
  const dir = await tmp(t);
  let db = await openDb(dir);
  assert.equal(db.format, 'sqlite');
  db.data.users.u1 = { id: 'u1', email: 'a@b.c', targets: [] };
  db.data.users.u2 = { id: 'u2', email: 'x@y.z' };
  db.data.posts.p1 = { id: 'p1', userId: 'u1', text: 'hi' };
  db.data.meta.site = { appName: 'X' };
  await db.save();
  db.data.users.u1.email = 'new@b.c';
  delete db.data.users.u2;
  await db.save();
  db.close();

  db = await openDb(dir);
  assert.deepEqual(Object.keys(db.data.users), ['u1']);
  assert.equal(db.userByEmail('new@b.c').id, 'u1');
  assert.equal(db.postsOf('u1')[0].text, 'hi');
  assert.equal(db.data.meta.site.appName, 'X');
  db.close();
});

test('database: the old db.json is imported once and kept', async (t) => {
  const dir = await tmp(t);
  const old = { version: 1, users: { u1: { id: 'u1', email: 'old@b.c' } }, sessions: { s1: { userId: 'u1' } }, posts: {} };
  await writeFile(join(dir, 'db.json'), JSON.stringify(old));
  let db = await openDb(dir);
  assert.equal(db.data.users.u1.email, 'old@b.c');
  assert.equal(db.data.sessions.s1.userId, 'u1');
  assert.deepEqual(db.data.links, {});
  db.close();
  const files = await readdir(dir);
  assert.ok(files.includes('db.json.imported') && !files.includes('db.json'), files.join());
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'db.json.imported'), 'utf8')), old, 'untouched');

  db = await openDb(dir);
  assert.equal(db.data.users.u1.email, 'old@b.c', 'reads from SQLite now');
  await db.backup('2026-01-01');
  assert.equal(JSON.parse(await readFile(join(dir, 'backups', 'db-2026-01-01.json'), 'utf8')).users.u1.email, 'old@b.c');
  db.close();
});

test('database: DB_FORMAT=json keeps the single-file format', async (t) => {
  const dir = await tmp(t);
  const db = await openDb(dir, { format: 'json' });
  assert.equal(db.format, 'json');
  db.data.users.u1 = { id: 'u1', email: 'a@b.c' };
  await db.save();
  assert.equal(JSON.parse(await readFile(join(dir, 'db.json'), 'utf8')).users.u1.email, 'a@b.c');
});
