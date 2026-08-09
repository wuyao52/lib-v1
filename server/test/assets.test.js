import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

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

  const publicResponse = await fetch(`${baseUrl}${new URL(firstAsset.url).pathname}`);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get('content-type'), 'image/png');
  assert.equal(publicResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await publicResponse.arrayBuffer()), PNG_BYTES);

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

