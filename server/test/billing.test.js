import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ads-billing-'));
  const codes = new Map();
  const upstreamCalls = [];
  const fetchImpl = async (url, options) => {
    upstreamCalls.push({ url: String(url), authorization: options.headers.get('authorization'), apiKey: options.headers.get('x-api-key'), body: options.body });
    const body = JSON.parse(options.body || '{}');
    if (body.prompt === 'fail') return new Response(JSON.stringify({ error: { message: 'upstream failed' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'task-1', status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false,
    encryptionKey: 'test-encryption-key-with-at-least-32-characters', fetchImpl,
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => {
    const email = `${username}@example.com`;
    await fetch(`${baseUrl}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
    const response = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, name: username, password: 'correct-horse', verificationCode: codes.get(email) }) });
    assert.equal(response.status, 201);
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
  };
  const request = (path, cookie, options = {}) => fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), cookie, ...options.headers } });
  return { server, db, register, request, upstreamCalls };
}

test('system APIs, pricing, balances and managed gateway enforce roles and billing', async (t) => {
  const context = await setup();
  t.after(() => context.server.close());
  const normal = await context.register('normal');
  const admin = await context.register('admin');
  await context.db.mutate((data) => { data.users.find((item) => item.id === admin.user.id).role = 'system'; });

  assert.equal((await context.request('/api/admin/users', normal.cookie)).status, 403);
  const createdApiResponse = await context.request('/api/admin/system-apis', admin.cookie, { method: 'POST', body: JSON.stringify({ name: 'Managed', provider: 'Compatible', baseUrl: 'https://upstream.example', apiKey: 'secret-system-key' }) });
  assert.equal(createdApiResponse.status, 201);
  const createdApi = (await createdApiResponse.json()).api;
  assert.equal(createdApi.apiKey, 'secret-system-key');
  assert.equal('encryptedApiKey' in createdApi, false);

  const pricingResponse = await context.request('/api/admin/pricing', admin.cookie, { method: 'POST', body: JSON.stringify({ apiId: createdApi.id, modelId: 'video-model', displayName: '视频模型', category: 'video', billingUnit: 'second', unitPriceCents: 10 }) });
  assert.equal(pricingResponse.status, 201);
  const catalog = await (await context.request('/api/catalog/models', normal.cookie)).json();
  assert.equal(catalog.models[0].baseUrl, `/api/system-ai/${createdApi.id}`);
  assert.equal(JSON.stringify(catalog).includes('secret-system-key'), false);
  assert.equal(JSON.stringify(catalog).includes('encryptedApiKey'), false);

  await context.request(`/api/admin/users/${normal.user.id}/balance`, admin.cookie, { method: 'POST', body: JSON.stringify({ amountCents: 1000 }) });
  const success = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'ok', duration: 5 }) });
  assert.equal(success.status, 200);
  assert.equal(context.upstreamCalls[0].authorization, 'Bearer secret-system-key');
  assert.equal(context.upstreamCalls[0].apiKey, 'secret-system-key');
  let billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);
  assert.equal(billing.transactions.some((item) => item.type === 'model_usage' && item.amountCents === -50), true);

  const failed = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'fail', duration: 5 }) });
  assert.equal(failed.status, 500);
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);
  assert.equal(billing.transactions.some((item) => item.type === 'model_refund' && item.amountCents === 50), true);

  await context.request(`/api/admin/users/${normal.user.id}/balance`, admin.cookie, { method: 'POST', body: JSON.stringify({ amountCents: -950 }) });
  const insufficient = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'ok', duration: 5 }) });
  assert.equal(insufficient.status, 402);
  const adminCall = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, admin.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'ok', duration: 5 }) });
  assert.equal(adminCall.status, 200);
});

test('recharge approval is single-use and credits the requested user', async (t) => {
  const context = await setup();
  t.after(() => context.server.close());
  const normal = await context.register('payer');
  const admin = await context.register('reviewer');
  await context.db.mutate((data) => { data.users.find((item) => item.id === admin.user.id).role = 'system'; });
  const created = await context.request('/api/billing/recharges', normal.cookie, { method: 'POST', body: JSON.stringify({ amountCents: 2500, note: 'manual payment reference' }) });
  assert.equal(created.status, 201);
  const recharge = (await created.json()).recharge;
  const approved = await context.request(`/api/admin/recharges/${recharge.id}/review`, admin.cookie, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).user.balanceCents, 2500);
  const duplicate = await context.request(`/api/admin/recharges/${recharge.id}/review`, admin.cookie, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
  assert.equal(duplicate.status, 409);
});
