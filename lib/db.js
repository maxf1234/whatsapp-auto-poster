// Storage: one JSON file plus an images folder on DATA_DIR (a Railway
// volume), the same approach as the NBA poster's queue — no database to run.
//
//   db.json        — users, sessions, posts
//   images/<id>    — each scheduled post's image
//
// Everything is kept in memory and written back atomically after each change.
// Writes are serialized so two requests can never interleave a save.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EMPTY = () => ({ version: 1, users: {}, sessions: {}, posts: {} });

export async function openDb(dir) {
  const file = join(dir, 'db.json');
  const imgDir = join(dir, 'images');
  let data = EMPTY();
  try {
    data = { ...EMPTY(), ...JSON.parse(await readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${file}: ${err.message}`);
  }

  let chain = Promise.resolve();
  const save = () => {
    chain = chain.then(async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(data));
      await rename(`${file}.tmp`, file); // atomic: a crash never leaves half a file
    });
    return chain;
  };

  return {
    data,
    save,
    userByEmail: (email) => Object.values(data.users).find((u) => u.email === email) ?? null,
    postsOf: (userId) => Object.values(data.posts).filter((p) => p.userId === userId),

    async writeImage(id, buf) {
      await mkdir(imgDir, { recursive: true });
      await writeFile(join(imgDir, id), buf);
    },
    readImage: (id) => readFile(join(imgDir, id)),
    removeImage: (id) => rm(join(imgDir, id), { force: true }),
  };
}
