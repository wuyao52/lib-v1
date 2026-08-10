import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

test('security alerts identify repeated failed logins without storing credentials or prompts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-security-alerts-'));
  const codes = new Map();
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    encryptionKey: 'security-observability-encryption-key-at-least-32',
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
    generateImageCaptcha: () => ({ text: '24682', data: '<svg/>' }),
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => { const email = `${username}@example.com`; await fetch(`${origin}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) }); const response = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, password: 'correct-password', verificationCode: codes.get(email) }) }); return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user }; };
  const admin = await register('security-admin');
  await db.mutate((data) => { data.users.find((user) => user.id === admin.user.id).role = 'system'; });
  for (let index = 0; index < 5; index += 1) {
    const captcha = await (await fetch(`${origin}/api/auth/captcha`)).json();
    const result = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'security-admin', password: `wrong-secret-${index}`, captchaId: captcha.captchaId, captchaCode: '24682' }) });
    assert.equal(result.status, 401);
  }
  const alerts = await fetch(`${origin}/api/admin/security-alerts`, { headers: { cookie: admin.cookie } });
  assert.equal(alerts.status, 200);
  const body = await alerts.json();
  assert.equal(body.alerts.loginBruteForce[0].count, 5);
  assert.equal(body.recentSecurityEvents.filter((item) => item.action === 'login_failed').length, 5);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('wrong-secret-'), false);
  assert.equal(serialized.includes('correct-password'), false);
});

test('managed model audit keeps the request trace while excluding prompt and API key', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-model-audit-'));
  const codes = new Map();
  const upstreamKey = 'provider-key-must-never-appear-in-audit';
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    encryptionKey: 'model-audit-encryption-key-at-least-32',
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, id: 'reply-1' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => { const email = `${username}@example.com`; await fetch(`${origin}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) }); const response = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, password: 'model-audit-password', verificationCode: codes.get(email) }) }); return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user }; };
  const admin = await register('model-audit-admin');
  const user = await register('model-audit-user');
  await db.mutate((data) => {
    data.users.find((item) => item.id === admin.user.id).role = 'system';
    data.users.find((item) => item.id === user.user.id).balanceCents = 500;
  });
  const apiResponse = await fetch(`${origin}/api/admin/system-apis`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Audit provider', provider: 'Test', baseUrl: 'https://provider.example/api', apiKey: upstreamKey }) });
  assert.equal(apiResponse.status, 201);
  const api = (await apiResponse.json()).api;
  const pricing = await fetch(`${origin}/api/admin/pricing`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ apiId: api.id, modelId: 'audit-text', displayName: 'Audit text', category: 'text', billingUnit: 'request', unitPriceCents: 25 }) });
  assert.equal(pricing.status, 201);
  const requestSecret = 'prompt-secret-must-not-be-audited';
  const generated = await fetch(`${origin}/api/system-ai/${api.id}/v1/chat/completions`, { method: 'POST', headers: { cookie: user.cookie, 'content-type': 'application/json', 'x-request-id': 'audit-trace-001' }, body: JSON.stringify({ model: 'audit-text', prompt: requestSecret }) });
  assert.equal(generated.status, 200);
  const logs = await (await fetch(`${origin}/api/admin/audit-logs`, { headers: { cookie: admin.cookie } })).json();
  const event = logs.logs.find((item) => item.action === 'managed_model_requested');
  assert.equal(event.userId, user.user.id);
  assert.equal(event.metadata.requestId, 'audit-trace-001');
  assert.equal(event.metadata.modelId, 'audit-text');
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(requestSecret), false);
  assert.equal(serialized.includes(upstreamKey), false);
});
