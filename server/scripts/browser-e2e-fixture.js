import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';
import { JsonDatabase } from '../store.js';

const port = Number(process.env.E2E_PORT || 8790);
const directory = await mkdtemp(join(tmpdir(), 'ai-drama-browser-e2e-'));
const db = await new JsonDatabase(join(directory, 'database.json')).init();
const userId = randomUUID();
const token = `e2e-${randomUUID()}`;
const now = new Date();
const storedObjects = new Map();
const fixtureStorage = {
  provider: 'memory-fixture',
  async list(prefix = '') {
    return [...storedObjects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.length, lastModified: now.toISOString() }));
  },
  async delete(key) { storedObjects.delete(key); },
  async move(sourceKey, destinationKey) {
    const value = storedObjects.get(sourceKey);
    if (!value) throw Object.assign(new Error('Fixture object not found'), { code: 'NoSuchKey' });
    storedObjects.set(destinationKey, value);
    storedObjects.delete(sourceKey);
  },
};
await db.mutate((data) => {
  data.users.push({ id: userId, username: 'browser-admin', email: 'browser-admin@example.test', name: 'browser-admin', passwordHash: 'fixture:not-used', role: 'system', balanceCents: 5000, createdAt: now.toISOString() });
  data.sessions.push({ id: randomUUID(), userId, tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: now.getTime(), expiresAt: now.getTime() + 60 * 60 * 1000, userAgent: 'browser-e2e' });
  data.projects.push({ id: 'browser-project', userId, title: '浏览器联合验证项目', description: 'local fixture', projectData: { id: 'browser-project', title: '浏览器联合验证项目', description: 'local fixture', nodes: [], edges: [], settings: {}, createdAt: now.toISOString(), updatedAt: now.toISOString() }, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() });
  data.generationHistory.push({ id: randomUUID(), userId, projectId: 'browser-project', nodeId: 'video-result', type: 'video', prompt: '浏览器联合验证短片', url: 'https://example.test/generated.mp4', thumbnail: null, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString() });
});

const { app } = await createApp({ database: db, secureCookies: false, serveFrontend: true, videoQueue: false, maintenance: false, monitoring: false, assetStorage: fixtureStorage, backupEncryptionKey: 'browser-e2e-backup-key-32-bytes-long', sendEmailCode: async () => {} });
const fixture = express();
fixture.get('/__e2e/login', async (_req, res, next) => {
  try {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db.mutate((data) => {
      if (!data.sessions.some((session) => session.tokenHash === tokenHash)) data.sessions.push({ id: randomUUID(), userId, tokenHash, createdAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000, userAgent: 'browser-e2e' });
    });
  } catch (error) { return next(error); }
  res.cookie('ads_session', token, { httpOnly: true, sameSite: 'strict', secure: false, path: '/', maxAge: 60 * 60 * 1000 });
  return res.redirect('/');
});
fixture.use(app);
const server = fixture.listen(port, '127.0.0.1', () => console.log(`BROWSER_E2E_READY http://127.0.0.1:${port}/__e2e/login`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
