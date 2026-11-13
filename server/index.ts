import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { openDb } from './db';

// Optional .env.local, read without a dependency. Real environment wins.
for (const f of ['.env.local', '.env']) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const dataDir = path.resolve(process.env.POS_DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });
const { db, initialPin } = openDb(path.join(dataDir, 'pos.sqlite'), {
  managerPin: process.env.POS_INITIAL_MANAGER_PIN || undefined,
  seed: process.env.POS_NO_SEED !== '1',
});
if (initialPin && !process.env.POS_INITIAL_MANAGER_PIN) {
  console.log(`\n  First run: manager PIN is ${initialPin}\n  Log in and change it under Admin > Staff. It is not shown again.\n`);
}

const app = createApp({ db, dataDir });
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve('dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(PORT, HOST, () => console.log(`Bar POS running on http://${HOST}:${PORT}`));
