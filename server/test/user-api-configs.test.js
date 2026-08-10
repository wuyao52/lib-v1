import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

test('user API configs are encrypted, isolated, and proxied without exposing credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-user-api-'));
  const databasePath = join(directory, 'database.json');
  const codes = new Map();
  const upstreamCalls = [];
  const fetchImpl = async (url, options) => {
    upstreamCalls.push({ url: String(url), authorization: options.headers.get('authorization'), apiKey: options.headers.get('x-api-key'), body: options.body });
    return new Response(JSON.stringify({ data: [{ id: 'private-model', object: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { app, db } = await createApp({
    databasePath,
    secureCookies: false,
    encryptionKey: 'user-api-test-encryption-key-at-least-32-characters',
    videoQueue: false,
    fetchImpl,
    resolveHost: async () => [{ address: '203.0.113.20', family: 4 }],
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => {
    const email = `${username}@example.com`;
    await fetch(`${baseUrl}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
    const response = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, name: username, password: 'strong-password', verificationCode: codes.get(email) }) });
    return response.headers.get('set-cookie').split(';')[0];
  };
  const ownerCookie = await register('api-owner');
  const otherCookie = await register('api-other');
  const request = (path, cookie, options = {}) => fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), cookie, ...options.headers } });

  const secretKey = 'sk-user-private-never-plaintext';
  const secretUrl = 'https://private-ai.example/custom';
  const createdResponse = await request('/api/user-api-configs', ownerCookie, { method: 'POST', body: JSON.stringify({ name: 'My Private API', provider: 'Private Provider', baseUrl: secretUrl, apiKey: secretKey }) });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).config;
  assert.equal(created.baseUrl, `/api/user-ai/${created.id}`);
  assert.equal(created.apiKey, undefined);

  const stored = db.read('userApiConfigs')[0];
  assert.notEqual(stored.encryptedApiKey, secretKey);
  assert.notEqual(stored.encryptedBaseUrl, secretUrl);
  const databaseText = await readFile(databasePath, 'utf8');
  assert.equal(databaseText.includes(secretKey), false);
  assert.equal(databaseText.includes(secretUrl), false);

  const ownerList = await (await request('/api/user-api-configs', ownerCookie)).json();
  assert.equal(ownerList.configs.length, 1);
  assert.equal(JSON.stringify(ownerList).includes(secretKey), false);
  assert.equal((await (await request('/api/user-api-configs', otherCookie)).json()).configs.length, 0);
  assert.equal((await request(`/api/user-ai/${created.id}/v1/models`, otherCookie)).status, 404);

  const proxyResponse = await request(`/api/user-ai/${created.id}/v1/models`, ownerCookie);
  assert.equal(proxyResponse.status, 200);
  assert.equal((await proxyResponse.json()).data[0].id, 'private-model');
  assert.equal(upstreamCalls.at(-1).url, `${secretUrl}/v1/models`);
  assert.equal(upstreamCalls.at(-1).authorization, `Bearer ${secretKey}`);
  assert.equal(upstreamCalls.at(-1).apiKey, secretKey);

  assert.equal((await request(`/api/user-api-configs/${created.id}`, otherCookie, { method: 'DELETE' })).status, 404);
  const disabled = await request(`/api/user-api-configs/${created.id}`, ownerCookie, { method: 'DELETE' });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).disabled, true);
  assert.equal(db.read('userApiConfigs')[0].enabled, false);
  assert.equal((await request(`/api/user-ai/${created.id}/v1/models`, ownerCookie)).status, 410);
});

test('user API configs reject private-network upstreams', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-user-api-private-'));
  const codes = new Map();
  const { app } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    encryptionKey: 'user-api-test-encryption-key-at-least-32-characters',
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const email = 'private-host@example.com';
  await fetch(`${baseUrl}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
  const registration = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'private-host', email, name: 'Private Host', password: 'strong-password', verificationCode: codes.get(email) }) });
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${baseUrl}/api/user-api-configs`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Internal', provider: 'Internal', baseUrl: 'https://127.0.0.1', apiKey: 'secret-key-value' }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'INVALID_API_CONFIG');
});
