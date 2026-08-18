import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

async function setup({ videoQueue = false, videoQueueAutoStart = true, assetStorage } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ads-billing-'));
  const codes = new Map();
  const upstreamCalls = [];
  const fetchImpl = async (url, options) => {
    upstreamCalls.push({ url: String(url), authorization: options.headers.get('authorization'), apiKey: options.headers.get('x-api-key'), body: options.body });
    if (options.method === 'DELETE') return new Response(JSON.stringify({ status: 'cancelled' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'video-model', name: 'Video Model', type: 'video_generation', owned_by: 'Detected Provider' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/v1/videos/moderation-task')) return new Response(JSON.stringify({ status: 'failed', progress: 100, error: 'PROVIDER_MODERATION_ERROR' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(options.body || '{}');
    if (body.prompt === 'fail') return new Response(JSON.stringify({ error: { message: 'upstream failed' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    if (body.prompt === 'duration-fail') return new Response(JSON.stringify({ msg: `参数 seconds 不支持 ${body.seconds || body.duration}` }), { status: 400, headers: { 'content-type': 'application/json' } });
    if (body.prompt === 'business-fail') return new Response(JSON.stringify({ code: '9999', data: null, msg: 'request entity too large' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (body.prompt === 'upstream-balance') return new Response(JSON.stringify({ error: { message: '余额不足，当前余额 ¥0.23，需要 ¥2.08' } }), { status: 402, headers: { 'content-type': 'application/json' } });
    if (body.prompt === 'privacy-fail') return new Response(JSON.stringify({ error: { code: '***.PrivacyInformation', message: "The request failed because the input image 'content[1]' may contain real person. Request id: test-request-id" } }), { status: 400, headers: { 'content-type': 'application/json' } });
    if (body.prompt === 'moderation-later') return new Response(JSON.stringify({ id: 'moderation-task', status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'task-1', status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { app, db, videoQueue: queue } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false,
    encryptionKey: 'test-encryption-key-with-at-least-32-characters', fetchImpl,
    videoQueue, videoQueueAutoStart,
    assetStorage,
    resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
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
  return { server, db, register, request, upstreamCalls, videoQueue: queue };
}

test('managed video replaces owned asset paths with public OSS URLs before calling the provider', async (t) => {
  const signedKeys = [];
  const context = await setup({
    assetStorage: {
      provider: 'test-oss',
      async createDownloadUrl({ key }) { signedKeys.push(key); return `https://oss.example.test/${encodeURIComponent(key)}?signed=1`; },
      async health() {}, async get() { return Buffer.alloc(0); }, async put() {}, async delete() {},
    },
  });
  t.after(() => context.server.close());
  const normal = await context.register('asset-video-user');
  const admin = await context.register('asset-video-admin');
  await context.db.mutate((data) => {
    data.users.find((item) => item.id === admin.user.id).role = 'system';
    data.users.find((item) => item.id === normal.user.id).balanceCents = 1000;
    data.assets.push({ id: 'owned-image', userId: normal.user.id, objectKey: 'assets/owned-image.png', mimeType: 'image/png', byteSize: 10, createdAt: new Date().toISOString() });
    data.assets.push({ id: 'other-image', userId: admin.user.id, objectKey: 'assets/other-image.png', mimeType: 'image/png', byteSize: 10, createdAt: new Date().toISOString() });
  });
  const apiResponse = await context.request('/api/admin/system-apis', admin.cookie, { method: 'POST', body: JSON.stringify({ name: 'Managed', provider: 'Compatible', baseUrl: 'https://upstream.example', apiKey: 'secret-system-key' }) });
  const api = (await apiResponse.json()).api;
  await context.request('/api/admin/pricing', admin.cookie, { method: 'POST', body: JSON.stringify({ apiId: api.id, modelId: 'video-model', displayName: '视频模型', category: 'video', billingUnit: 'second', unitPriceCents: 1, allowedDurationsSec: [5] }) });
  const generated = await context.request(`/api/system-ai/${api.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'asset-url', seconds: 5, images: ['/api/assets/public/owned-image'] }) });
  assert.equal(generated.status, 200);
  const providerBody = JSON.parse(context.upstreamCalls.find((call) => call.body?.includes('asset-url')).body);
  assert.deepEqual(providerBody.images, ['https://oss.example.test/assets%2Fowned-image.png?signed=1']);
  assert.deepEqual(signedKeys, ['assets/owned-image.png']);
  const stolen = await context.request(`/api/system-ai/${api.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'stolen', seconds: 5, images: ['/api/assets/public/other-image'] }) });
  assert.equal(stolen.status, 400);
  assert.equal((await stolen.json()).error, 'INVALID_REFERENCE_IMAGE_URL');
});

test('system APIs, pricing, balances and managed gateway enforce roles and billing', async (t) => {
  const context = await setup();
  t.after(() => context.server.close());
  const normal = await context.register('normal');
  const admin = await context.register('admin');
  await context.db.mutate((data) => { data.users.find((item) => item.id === admin.user.id).role = 'system'; });

  assert.equal((await context.request('/api/admin/users', normal.cookie)).status, 403);
  assert.equal((await context.request('/api/admin/system-apis/discover', normal.cookie, { method: 'POST', body: JSON.stringify({ baseUrl: 'https://upstream.example', apiKey: 'secret-system-key' }) })).status, 403);
  const discoveryResponse = await context.request('/api/admin/system-apis/discover', admin.cookie, { method: 'POST', body: JSON.stringify({ baseUrl: 'https://upstream.example', apiKey: 'secret-system-key' }) });
  assert.equal(discoveryResponse.status, 200);
  const discovery = await discoveryResponse.json();
  assert.equal(discovery.provider, 'Detected Provider');
  assert.equal(discovery.models[0].id, 'video-model');
  assert.equal(JSON.stringify(discovery).includes('secret-system-key'), false);
  const privateDiscovery = await context.request('/api/admin/system-apis/discover', admin.cookie, { method: 'POST', body: JSON.stringify({ baseUrl: 'https://127.0.0.1', apiKey: 'secret-system-key' }) });
  assert.equal(privateDiscovery.status, 400);
  assert.equal((await privateDiscovery.json()).error, 'API_DISCOVERY_FAILED');
  const createdApiResponse = await context.request('/api/admin/system-apis', admin.cookie, { method: 'POST', body: JSON.stringify({ name: 'Managed', provider: 'Compatible', baseUrl: 'https://upstream.example', apiKey: 'secret-system-key' }) });
  assert.equal(createdApiResponse.status, 201);
  const createdApi = (await createdApiResponse.json()).api;
  assert.equal(createdApi.apiKey, '');
  assert.equal('encryptedApiKey' in createdApi, false);
  const storedApi = context.db.read('systemApis')[0];
  assert.notEqual(storedApi.baseUrl, 'https://upstream.example');
  assert.equal(storedApi.encryptedApiKey.includes('secret-system-key'), false);
  const maskedApis = await (await context.request('/api/admin/system-apis', admin.cookie)).json();
  assert.equal(maskedApis.apis[0].apiKey, '');
  const deniedReveal = await context.request(`/api/admin/system-apis/${createdApi.id}/reveal`, admin.cookie, { method: 'POST', body: JSON.stringify({ password: 'wrong-password' }) });
  assert.equal(deniedReveal.status, 401);
  const revealed = await context.request(`/api/admin/system-apis/${createdApi.id}/reveal`, admin.cookie, { method: 'POST', body: JSON.stringify({ password: 'correct-horse' }) });
  assert.equal(revealed.status, 200);
  assert.equal((await revealed.json()).apiKey, 'secret-system-key');
  const auditLogs = await (await context.request('/api/admin/audit-logs', admin.cookie)).json();
  assert.equal(auditLogs.logs.some((item) => item.action === 'system_api_revealed' && item.targetId === createdApi.id), true);
  assert.equal(JSON.stringify(auditLogs).includes('secret-system-key'), false);
  const savedApiModelsResponse = await context.request('/api/admin/system-apis/discover', admin.cookie, { method: 'POST', body: JSON.stringify({ apiId: createdApi.id }) });
  assert.equal(savedApiModelsResponse.status, 200);
  assert.equal((await savedApiModelsResponse.json()).models[0].id, 'video-model');

  const missingDurationPricing = await context.request('/api/admin/pricing', admin.cookie, { method: 'POST', body: JSON.stringify({ apiId: createdApi.id, modelId: 'invalid-video-model', displayName: '未配置时长模型', category: 'video', billingUnit: 'second', unitPriceCents: 10 }) });
  assert.equal(missingDurationPricing.status, 400);
  assert.match((await missingDurationPricing.json()).message, /固定时长/);
  const pricingResponse = await context.request('/api/admin/pricing', admin.cookie, { method: 'POST', body: JSON.stringify({ apiId: createdApi.id, modelId: 'video-model', displayName: '视频模型', category: 'video', billingUnit: 'second', unitPriceCents: 10, allowedDurationsSec: [5, 15], allowedResolutions: ['720p'] }) });
  assert.equal(pricingResponse.status, 201);
  const catalog = await (await context.request('/api/catalog/models', normal.cookie)).json();
  assert.equal(catalog.models[0].baseUrl, `/api/system-ai/${createdApi.id}`);
  assert.deepEqual(catalog.models[0].allowedResolutions, ['720p']);
  assert.equal(JSON.stringify(catalog).includes('secret-system-key'), false);
  assert.equal(JSON.stringify(catalog).includes('encryptedApiKey'), false);

  const insufficient = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'ok', duration: 5 }) });
  assert.equal(insufficient.status, 402);
  const insufficientBody = await insufficient.json();
  assert.equal(insufficientBody.message, '错误：余额不足');
  assert.equal('requiredCents' in insufficientBody, false);
  assert.equal(JSON.stringify(insufficientBody).includes('当前余额'), false);
  assert.equal(JSON.stringify(insufficientBody).includes('需要'), false);

  await context.request(`/api/admin/users/${normal.user.id}/balance`, admin.cookie, { method: 'POST', body: JSON.stringify({ amountCents: 1000, currentPassword: 'correct-horse' }) });
  const success = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'ok', duration: 5 }) });
  assert.equal(success.status, 200);
  const generationCall = context.upstreamCalls.find((call) => call.body?.includes('"prompt":"ok"'));
  assert.equal(JSON.parse(generationCall.body).resolution, '720p');
  assert.equal(generationCall.authorization, 'Bearer secret-system-key');
  assert.equal(generationCall.apiKey, 'secret-system-key');
  let billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);
  assert.equal(billing.transactions.some((item) => item.type === 'model_usage' && item.amountCents === -50), true);

  const unsupportedResolution = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'wrong-resolution', duration: 5, resolution: '1080p' }) });
  assert.equal(unsupportedResolution.status, 400);
  assert.equal((await unsupportedResolution.json()).error, 'INVALID_RESOLUTION');

  const upstreamInsufficient = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'upstream-balance', duration: 5 }) });
  assert.equal(upstreamInsufficient.status, 402);
  const upstreamInsufficientBody = await upstreamInsufficient.json();
  assert.deepEqual(upstreamInsufficientBody, { error: 'UPSTREAM_BALANCE_INSUFFICIENT', message: '错误：99' });
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);

  const privacyFailure = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'privacy-fail', duration: 5, images: ['https://assets.example/portrait.png'] }) });
  assert.equal(privacyFailure.status, 400);
  const privacyBody = await privacyFailure.json();
  assert.equal(privacyBody.error, 'PROVIDER_MODERATION_ERROR');
  assert.match(privacyBody.message, /疑似包含真人/);
  assert.equal(privacyBody.message.includes('test-request-id'), false);
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);

  const failed = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'fail', duration: 5 }) });
  assert.equal(failed.status, 500);
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);
  assert.equal(billing.transactions.some((item) => item.type === 'model_refund' && item.amountCents === 50), true);

  const businessFailed = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'business-fail', duration: 5 }) });
  assert.equal(businessFailed.status, 502);
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);

  const durationMismatch = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'duration-fail', seconds: 5 }) });
  assert.equal(durationMismatch.status, 409);
  assert.equal((await durationMismatch.json()).error, 'UPSTREAM_DURATION_MISMATCH');
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);

  const moderationTask = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'moderation-later', seconds: 5 }) });
  assert.equal(moderationTask.status, 200);
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 900);
  const moderationFailure = await context.request(`/api/system-ai/${createdApi.id}/v1/videos/moderation-task`, normal.cookie);
  assert.equal(moderationFailure.status, 200);
  const moderationBody = await moderationFailure.json();
  assert.equal(moderationBody.error.code, 'PROVIDER_MODERATION_ERROR');
  assert.match(moderationBody.message, /自动退回/);
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);
  const moderationRefunds = billing.transactions.filter((item) => item.type === 'model_refund' && item.description.includes('异步任务失败'));
  assert.equal(moderationRefunds.length, 1);

  await context.request(`/api/system-ai/${createdApi.id}/v1/videos/moderation-task`, normal.cookie);
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 950);
  assert.equal(billing.transactions.filter((item) => item.type === 'model_refund' && item.description.includes('异步任务失败')).length, 1);

  const pricing = (await pricingResponse.json()).pricing;
  const fixedPricingResponse = await context.request(`/api/admin/pricing/${pricing.id}`, admin.cookie, { method: 'PUT', body: JSON.stringify({ allowedDurationsSec: [15], minDurationSec: 20, maxDurationSec: 30 }) });
  assert.equal(fixedPricingResponse.status, 200);
  const fixedPricing = (await fixedPricingResponse.json()).pricing;
  assert.equal(fixedPricing.minDurationSec, null);
  assert.equal(fixedPricing.maxDurationSec, null);
  const refreshedCatalog = await (await context.request('/api/catalog/models', normal.cookie)).json();
  assert.deepEqual(refreshedCatalog.models[0].allowedDurationsSec, [15]);
  assert.equal(refreshedCatalog.models[0].minDurationSec, null);
  assert.equal(refreshedCatalog.models[0].maxDurationSec, null);
  const fixedDurationSuccess = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'fixed-15', seconds: '15' }) });
  assert.equal(fixedDurationSuccess.status, 200);
  const invalidDuration = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'invalid-10', seconds: '10' }) });
  assert.equal(invalidDuration.status, 400);
  assert.match((await invalidDuration.json()).message, /本次收到 10 秒/);
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 800);

  await context.request(`/api/admin/users/${normal.user.id}/balance`, admin.cookie, { method: 'POST', body: JSON.stringify({ amountCents: -650, currentPassword: 'correct-horse' }) });
  const concurrent = await Promise.all(['concurrent-a', 'concurrent-b'].map((prompt) => context.request(`/api/system-ai/${createdApi.id}/v1/videos`, normal.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt, duration: 15 }) })));
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 402]);
  billing = await (await context.request('/api/billing/me', normal.cookie)).json();
  assert.equal(billing.balanceCents, 0);
  const adminCall = await context.request(`/api/system-ai/${createdApi.id}/v1/videos`, admin.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'ok', duration: 15 }) });
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

test('sensitive admin balance and role changes require the current system password', async (t) => {
  const context = await setup();
  t.after(() => context.server.close());
  const target = await context.register('sensitive-target');
  const admin = await context.register('sensitive-admin');
  await context.db.mutate((data) => { data.users.find((item) => item.id === admin.user.id).role = 'system'; });

  const deniedBalance = await context.request(`/api/admin/users/${target.user.id}/balance`, admin.cookie, {
    method: 'POST', body: JSON.stringify({ amountCents: 500, currentPassword: 'incorrect-password' }),
  });
  assert.equal(deniedBalance.status, 401);
  assert.equal(context.db.read('users').find((item) => item.id === target.user.id).balanceCents, 0);
  const deniedRole = await context.request(`/api/admin/users/${target.user.id}/role`, admin.cookie, {
    method: 'PATCH', body: JSON.stringify({ role: 'system', currentPassword: 'incorrect-password' }),
  });
  assert.equal(deniedRole.status, 401);
  assert.equal(context.db.read('users').find((item) => item.id === target.user.id).role, 'user');

  const accepted = await context.request(`/api/admin/users/${target.user.id}/balance`, admin.cookie, {
    method: 'POST', body: JSON.stringify({ amountCents: 500, currentPassword: 'correct-horse' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(context.db.read('users').find((item) => item.id === target.user.id).balanceCents, 500);
});

test('managed video requests use the persistent queue protocol and expose an admin overview', async (t) => {
  const context = await setup({ videoQueue: true, videoQueueAutoStart: false });
  t.after(() => context.server.close());
  const normal = await context.register('queue-normal');
  const admin = await context.register('queue-admin');
  await context.db.mutate((data) => { data.users.find((item) => item.id === admin.user.id).role = 'system'; });
  const apiResponse = await context.request('/api/admin/system-apis', admin.cookie, {
    method: 'POST', body: JSON.stringify({ name: 'Queue API', provider: 'Compatible', baseUrl: 'https://upstream.example', apiKey: 'secret-system-key' }),
  });
  const api = (await apiResponse.json()).api;
  await context.request('/api/admin/pricing', admin.cookie, {
    method: 'POST', body: JSON.stringify({ apiId: api.id, modelId: 'video-model', displayName: '队列视频', category: 'video', billingUnit: 'second', unitPriceCents: 10, allowedDurationsSec: [5] }),
  });
  await context.request(`/api/admin/users/${normal.user.id}/balance`, admin.cookie, { method: 'POST', body: JSON.stringify({ amountCents: 100, currentPassword: 'correct-horse' }) });

  const queuedResponse = await context.request(`/api/system-ai/${api.id}/v1/videos`, normal.cookie, {
    method: 'POST',
    headers: { 'idempotency-key': 'queue-click-proof-0001' },
    body: JSON.stringify({ model: 'video-model', prompt: 'queued-video', seconds: 5, _client: { projectId: 'project-1', nodeId: 'node-1' } }),
  });
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json();
  assert.match(queued.id, /^idem-[0-9a-f]{48}$/);
  const duplicateResponse = await context.request(`/api/system-ai/${api.id}/v1/videos`, normal.cookie, {
    method: 'POST',
    headers: { 'idempotency-key': 'queue-click-proof-0001' },
    body: JSON.stringify({ model: 'video-model', prompt: 'queued-video', seconds: 5, _client: { projectId: 'project-1', nodeId: 'node-1' } }),
  });
  assert.equal(duplicateResponse.status, 202);
  assert.equal((await duplicateResponse.json()).id, queued.id);
  assert.equal(context.db.read('generationJobs').length, 1);
  assert.equal(context.db.read('balanceTransactions').filter((item) => item.type === 'model_usage').length, 1);

  const invalidIdempotencyKey = await context.request(`/api/system-ai/${api.id}/v1/videos`, normal.cookie, {
    method: 'POST', headers: { 'idempotency-key': 'short' }, body: JSON.stringify({ model: 'video-model', prompt: 'invalid-key', seconds: 5 }),
  });
  assert.equal(invalidIdempotencyKey.status, 400);
  assert.equal((await invalidIdempotencyKey.json()).error, 'INVALID_IDEMPOTENCY_KEY');

  const startedAt = Date.now();
  while (context.db.read('generationJobs')[0]?.status !== 'processing') {
    if (Date.now() - startedAt > 1000) throw new Error('queued video was not submitted');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const stored = context.db.read('generationJobs')[0];
  assert.equal(stored.projectId, 'project-1');
  assert.equal(stored.nodeId, 'node-1');
  const submission = context.upstreamCalls.find((call) => call.body?.includes('queued-video'));
  assert.equal(submission.body.includes('_client'), false);

  const polledResponse = await context.request(`/api/system-ai/${api.id}/v1/videos/${queued.id}`, normal.cookie);
  assert.equal(polledResponse.status, 200);
  assert.equal((await polledResponse.json()).status, 'processing');
  const cancelledResponse = await context.request(`/api/system-ai/${api.id}/v1/videos/${queued.id}`, normal.cookie, { method: 'DELETE' });
  assert.equal(cancelledResponse.status, 200);
  assert.equal((await cancelledResponse.json()).status, 'cancelled');
  assert.equal(context.db.read('users').find((item) => item.id === normal.user.id).balanceCents, 100);
  assert.equal(context.db.read('balanceTransactions').filter((item) => item.type === 'model_refund' && item.referenceId === queued.id).length, 1);
  const overview = await (await context.request('/api/admin/video-queue', admin.cookie)).json();
  assert.equal(overview.counts.processing, 0);
  assert.equal(overview.config.userConcurrency, 4);
});
