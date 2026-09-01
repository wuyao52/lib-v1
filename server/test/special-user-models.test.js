import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ads-special-models-'));
  const codes = new Map();
  const { app, db } = await createApp({
    databasePath: join(dir, 'database.json'), secureCookies: false,
    encryptionKey: 'special-user-models-test-key-at-least-32', videoQueue: false,
    resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => {
    const email = `${username}@example.com`;
    await fetch(`${origin}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
    const response = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, password: 'correct-horse', verificationCode: codes.get(email) }) });
    assert.equal(response.status, 201);
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
  };
  const request = (path, cookie, options = {}) => fetch(`${origin}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), cookie, ...options.headers } });
  return { app, db, server, register, request };
}

test('new special users start with no models, then receive only assigned models and prices', async (t) => {
  const context = await setup();
  t.after(() => context.server.close());
  const admin = await context.register('special-admin');
  const special = await context.register('special-user');
  await context.db.mutate((data) => { data.users.find((item) => item.id === admin.user.id).role = 'system'; });

  const apiAResponse = await context.request('/api/admin/system-apis', admin.cookie, { method: 'POST', body: JSON.stringify({ name: 'A端口', provider: 'Compatible', baseUrl: 'https://a.example', apiKey: 'a-system-api-key' }) });
  assert.equal(apiAResponse.status, 201, await apiAResponse.clone().text());
  const apiA = (await apiAResponse.json()).api;
  const apiBResponse = await context.request('/api/admin/system-apis', admin.cookie, { method: 'POST', body: JSON.stringify({ name: 'B端口', provider: 'Compatible', baseUrl: 'https://b.example', apiKey: 'b-system-api-key' }) });
  assert.equal(apiBResponse.status, 201, await apiBResponse.clone().text());
  const apiB = (await apiBResponse.json()).api;
  const createPricing = async (apiId, modelId, price) => (await (await context.request('/api/admin/pricing', admin.cookie, { method: 'POST', body: JSON.stringify({ apiId, modelId, displayName: modelId, category: 'text', billingUnit: 'request', unitPriceCents: price }) })).json()).pricing;
  const first = await createPricing(apiB.id, 'b-model', 20);
  const second = await createPricing(apiA.id, 'a-model', 10);

  const empty = await (await context.request('/api/catalog/models', special.cookie)).json();
  assert.deepEqual(empty.models, []);
  const access = await context.request(`/api/admin/users/${special.user.id}/model-access`, admin.cookie, { method: 'PUT', body: JSON.stringify({ models: [{ pricingId: second.id, unitPriceCents: 7, enabled: true }] }) });
  assert.equal(access.status, 200);
  const assigned = await (await context.request('/api/catalog/models', special.cookie)).json();
  assert.deepEqual(assigned.models.map((item) => item.modelId), ['a-model']);
  assert.equal(assigned.models[0].unitPriceCents, 7);

  const normalDenied = await context.request(`/api/system-ai/${apiB.id}/v1/chat/completions`, special.cookie, { method: 'POST', body: JSON.stringify({ model: 'b-model', prompt: 'denied' }) });
  assert.equal(normalDenied.status, 403);

  const madeNormal = await context.request(`/api/admin/users/${special.user.id}/account-type`, admin.cookie, { method: 'PATCH', body: JSON.stringify({ accountType: 'user', currentPassword: 'correct-horse' }) });
  assert.equal(madeNormal.status, 200);
  assert.equal((await (await context.request('/api/catalog/models', special.cookie)).json()).models.length, 2);
  const madeSpecial = await context.request(`/api/admin/users/${special.user.id}/account-type`, admin.cookie, { method: 'PATCH', body: JSON.stringify({ accountType: 'special', currentPassword: 'correct-horse' }) });
  assert.equal(madeSpecial.status, 200);
  assert.deepEqual((await (await context.request('/api/catalog/models', special.cookie)).json()).models.map((item) => item.modelId), ['a-model']);
});

test('catalog groups models by API name and batch pricing updates atomically', async (t) => {
  const context = await setup();
  t.after(() => context.server.close());
  const admin = await context.register('batch-admin');
  await context.db.mutate((data) => { data.users.find((item) => item.id === admin.user.id).role = 'system'; });
  const apiZ = (await (await context.request('/api/admin/system-apis', admin.cookie, { method: 'POST', body: JSON.stringify({ name: 'Z端口', provider: 'Compatible', baseUrl: 'https://z.example', apiKey: 'z-system-api-key' }) })).json()).api;
  const apiA = (await (await context.request('/api/admin/system-apis', admin.cookie, { method: 'POST', body: JSON.stringify({ name: 'A端口', provider: 'Compatible', baseUrl: 'https://a.example', apiKey: 'a-system-api-key' }) })).json()).api;
  const add = async (apiId, modelId, price) => (await (await context.request('/api/admin/pricing', admin.cookie, { method: 'POST', body: JSON.stringify({ apiId, modelId, displayName: modelId, category: 'text', billingUnit: 'request', unitPriceCents: price }) })).json()).pricing;
  const z = await add(apiZ.id, 'z-model', 1); const a = await add(apiA.id, 'a-model', 2);
  const catalog = await (await context.request('/api/catalog/models', admin.cookie)).json();
  assert.deepEqual(catalog.models.map((item) => item.apiName), ['A端口', 'Z端口']);
  const updated = await context.request('/api/admin/pricing/batch', admin.cookie, { method: 'PUT', body: JSON.stringify({ pricing: [{ id: z.id, unitPriceCents: 11 }, { id: a.id, unitPriceCents: 22 }] }) });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated ? (await updated.json()).pricing.map((item) => item.unitPriceCents).sort() : [], [11, 22]);
});
