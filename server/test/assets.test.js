import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createApp } from '../app.js';
import { cleanupExpiredAssets } from '../assets.js';

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

async function register(baseUrl, username, sentCodes) {
  const email = `${username}@example.com`;
  const codeResponse = await fetch(`${baseUrl}/api/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, purpose: 'register' }),
  });
  assert.equal(codeResponse.status, 202);
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: username,
      username,
      email,
      password: 'strong-pass-123',
      verificationCode: sentCodes.at(-1).code,
    }),
  });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie').split(';')[0];
}

async function upload(baseUrl, cookie, dataUrl) {
  return fetch(`${baseUrl}/api/assets`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
}

test('image assets require auth, persist exact bytes, deduplicate per user and validate input', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-assets-'));
  const sentCodes = [];
  const previousPublicUrl = process.env.PUBLIC_BACKEND_URL;
  process.env.PUBLIC_BACKEND_URL = 'https://backend.example.com/';
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'),
    secureCookies: false,
    sendEmailCode: async (message) => sentCodes.push(message),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    if (previousPublicUrl === undefined) delete process.env.PUBLIC_BACKEND_URL;
    else process.env.PUBLIC_BACKEND_URL = previousPublicUrl;
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthenticated = await upload(baseUrl, '', PNG_DATA_URL);
  assert.equal(unauthenticated.status, 401);

  const firstCookie = await register(baseUrl, 'asset-user-1', sentCodes);
  const secondCookie = await register(baseUrl, 'asset-user-2', sentCodes);
  const firstUpload = await upload(baseUrl, firstCookie, PNG_DATA_URL);
  assert.equal(firstUpload.status, 201);
  const firstAsset = (await firstUpload.json()).asset;
  assert.equal(firstAsset.url, `https://backend.example.com/api/assets/public/${firstAsset.id}`);
  assert.equal(firstAsset.mimeType, 'image/png');
  assert.equal(firstAsset.byteSize, PNG_BYTES.length);

  const unsignedUrl = `${baseUrl}${new URL(firstAsset.url).pathname}`;
  const anonymousResponse = await fetch(unsignedUrl);
  assert.equal(anonymousResponse.status, 401);
  const ownerResponse = await fetch(unsignedUrl, { headers: { cookie: firstCookie } });
  assert.equal(ownerResponse.status, 200);
  assert.equal(ownerResponse.headers.get('content-type'), 'image/png');
  assert.equal(ownerResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await ownerResponse.arrayBuffer()), PNG_BYTES);

  const signedResult = await (await fetch(`${baseUrl}/api/assets/${firstAsset.id}/signed-url`, { headers: { cookie: firstCookie } })).json();
  const signedUrl = new URL(signedResult.url);
  const signedResponse = await fetch(`${baseUrl}${signedUrl.pathname}${signedUrl.search}`);
  assert.equal(signedResponse.status, 200);
  assert.deepEqual(Buffer.from(await signedResponse.arrayBuffer()), PNG_BYTES);
  signedUrl.searchParams.set('signature', 'tampered');
  assert.equal((await fetch(`${baseUrl}${signedUrl.pathname}${signedUrl.search}`)).status, 401);

  const duplicateUpload = await upload(baseUrl, firstCookie, PNG_DATA_URL);
  assert.equal(duplicateUpload.status, 200);
  assert.equal((await duplicateUpload.json()).asset.id, firstAsset.id);
  assert.equal(db.read('assets').length, 1);

  const otherUserUpload = await upload(baseUrl, secondCookie, PNG_DATA_URL);
  assert.equal(otherUserUpload.status, 201);
  assert.notEqual((await otherUserUpload.json()).asset.id, firstAsset.id);
  assert.equal(db.read('assets').length, 2);

  const invalidMime = await upload(baseUrl, firstCookie, 'data:text/plain;base64,SGVsbG8=');
  assert.equal(invalidMime.status, 400);
  assert.equal((await invalidMime.json()).error, 'INVALID_IMAGE');

  const invalidBase64 = await upload(baseUrl, firstCookie, 'data:image/png;base64,not-valid!');
  assert.equal(invalidBase64.status, 400);
  assert.equal((await invalidBase64.json()).error, 'INVALID_IMAGE');

  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
  const oversizedResponse = await upload(baseUrl, firstCookie, `data:image/png;base64,${oversized}`);
  assert.equal(oversizedResponse.status, 413);
  assert.equal((await oversizedResponse.json()).error, 'ASSET_TOO_LARGE');
});

test('R2 asset storage keeps bytes out of the database and migrates legacy assets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-r2-assets-'));
  const sentCodes = [];
  const objects = new Map();
  const puts = [];
  const previousRetentionDays = process.env.ASSET_RETENTION_DAYS;
  process.env.ASSET_RETENTION_DAYS = '30';
  const assetStorage = {
    provider: 'r2',
    async put({ key, bytes, mimeType }) {
      puts.push(key);
      objects.set(key, { bytes: Buffer.from(bytes), mimeType });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) throw new Error('missing object');
      return object.bytes;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'),
    secureCookies: false,
    assetStorage,
    sendEmailCode: async (message) => sentCodes.push(message),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    if (previousRetentionDays === undefined) delete process.env.ASSET_RETENTION_DAYS;
    else process.env.ASSET_RETENTION_DAYS = previousRetentionDays;
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookie = await register(baseUrl, 'r2-user', sentCodes);
  const sha256 = createHash('sha256').update(PNG_BYTES).digest('hex');

  await db.mutate((data) => data.assets.push({
    id: 'legacy-asset', userId: data.users[0].id, sha256, mimeType: 'image/png',
    dataBase64: PNG_BYTES.toString('base64'), byteSize: PNG_BYTES.length, createdAt: new Date().toISOString(),
  }));

  const migratedResponse = await upload(baseUrl, cookie, PNG_DATA_URL);
  assert.equal(migratedResponse.status, 200);
  const migrated = db.read('assets')[0];
  assert.equal(migrated.storageProvider, 'r2');
  assert.equal(migrated.dataBase64, null);
  assert.match(migrated.objectKey, /^assets\/[^/]+\/[a-f0-9]{64}\.png$/);
  assert.equal(puts.length, 1);

  const publicResponse = await fetch(`${baseUrl}/api/assets/public/${migrated.id}`, { headers: { cookie } });
  assert.equal(publicResponse.status, 200);
  assert.deepEqual(Buffer.from(await publicResponse.arrayBuffer()), PNG_BYTES);

  const duplicateResponse = await upload(baseUrl, cookie, PNG_DATA_URL);
  assert.equal(duplicateResponse.status, 200);
  assert.equal(puts.length, 1);

  const assetList = await (await fetch(`${baseUrl}/api/assets`, { headers: { cookie } })).json();
  assert.equal(assetList.assets.length, 1);
  assert.equal(assetList.assets[0].referenced, false);
  assert.equal(assetList.retentionDays, 30);
  assert.match(assetList.assets[0].expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(assetList.usedBytes, PNG_BYTES.length);
  assert.equal(assetList.storageProvider, 'r2');

  await db.mutate((data) => data.projects.push({
    id: 'asset-project', userId: data.users[0].id, title: 'asset project', description: '',
    projectData: { nodes: [{ data: { generatedContent: `${baseUrl}/api/assets/public/${migrated.id}` } }] },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  const referencedDelete = await fetch(`${baseUrl}/api/assets/${migrated.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(referencedDelete.status, 409);

  await db.mutate((data) => { data.projects = []; });
  const deleted = await fetch(`${baseUrl}/api/assets/${migrated.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(deleted.status, 204);
  assert.equal(db.read('assets').length, 0);
  assert.equal(objects.size, 0);
});

test('expired unreferenced assets are cleaned while active, referenced and failed objects remain', async () => {
  const now = Date.parse('2026-08-09T12:00:00.000Z');
  const oldCreatedAt = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
  const freshCreatedAt = new Date(now - 29 * 24 * 60 * 60 * 1000).toISOString();
  const userId = 'cleanup-user';
  const data = {
    assets: [
      { id: 'expired', userId, objectKey: 'expired-key', createdAt: oldCreatedAt },
      { id: 'referenced', userId, objectKey: 'referenced-key', createdAt: oldCreatedAt },
      { id: 'fresh', userId, objectKey: 'fresh-key', createdAt: freshCreatedAt },
      { id: 'delete-fails', userId, objectKey: 'failed-key', createdAt: oldCreatedAt },
      { id: 'active-history', userId, objectKey: 'active-history-key', createdAt: oldCreatedAt },
      { id: 'expired-history', userId, objectKey: 'expired-history-key', createdAt: oldCreatedAt },
      { id: 'legacy-expired', userId, dataBase64: 'AA==', createdAt: oldCreatedAt },
    ],
    projects: [{
      id: 'cleanup-project', userId,
      projectData: { image: '/api/assets/public/referenced' },
    }],
    generationHistory: [
      {
        id: 'active-history-item', userId,
        url: '/api/assets/public/active-history',
        expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'expired-history-item', userId,
        thumbnail: '/api/assets/public/expired-history',
        expiresAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
  };
  const db = {
    read(table) { return data[table]; },
    async mutate(mutator) { return mutator(data); },
  };
  const deletedKeys = [];
  const assetStorage = {
    async delete(key) {
      if (key === 'failed-key') throw new Error('simulated R2 failure');
      deletedKeys.push(key);
    },
  };

  const result = await cleanupExpiredAssets({
    db, assetStorage, retentionDays: 30, now, onError: () => {},
  });

  assert.equal(result.deleted, 3);
  assert.equal(result.failed, 1);
  assert.deepEqual(deletedKeys, ['expired-key', 'expired-history-key']);
  assert.deepEqual(data.assets.map((asset) => asset.id), [
    'referenced', 'fresh', 'delete-fails', 'active-history',
  ]);
});
