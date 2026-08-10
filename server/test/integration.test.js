import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

const key = 'integration-test-encryption-key-with-at-least-32-characters';
const waitFor = async (predicate, timeoutMs = 1000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('integration workflow timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('full creator workflow keeps project, asset, billing, queue and history consistent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-integration-'));
  const codes = new Map();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      if (body.prompt === 'will-fail') return new Response(JSON.stringify({ id: 'provider-fail', status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: 'provider-ok', status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/provider-fail')) return new Response(JSON.stringify({ status: 'failed', error: { message: 'provider failed' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ status: 'completed', progress: 100, video_url: 'https://cdn.example/integration.mp4' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { app, db, videoQueue } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, encryptionKey: key,
    fetchImpl, videoQueue: true, videoQueueAutoStart: false,
    resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => {
    const email = `${username}@example.com`;
    await fetch(`${origin}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
    const response = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, password: 'strong-password', verificationCode: codes.get(email) }) });
    assert.equal(response.status, 201);
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
  };
  const request = (path, cookie, options = {}) => fetch(`${origin}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), cookie, ...options.headers } });
  const user = await register('workflow-user');
  const admin = await register('workflow-admin');
  await db.mutate((data) => { data.users.find((item) => item.id === admin.user.id).role = 'system'; });

  const apiResponse = await request('/api/admin/system-apis', admin.cookie, { method: 'POST', body: JSON.stringify({ name: 'Integration API', provider: 'Test Provider', baseUrl: 'https://upstream.example', apiKey: 'integration-secret-key' }) });
  assert.equal(apiResponse.status, 201);
  const api = (await apiResponse.json()).api;
  const pricingResponse = await request('/api/admin/pricing', admin.cookie, { method: 'POST', body: JSON.stringify({ apiId: api.id, modelId: 'video-model', displayName: 'Integration Video', category: 'video', billingUnit: 'second', unitPriceCents: 20, allowedDurationsSec: [5, 10] }) });
  assert.equal(pricingResponse.status, 201);
  assert.equal((await (await request('/api/catalog/models', user.cookie)).json()).models[0].modelId, 'video-model');
  assert.equal((await request('/api/admin/users', user.cookie)).status, 403);
  await request(`/api/admin/users/${user.user.id}/balance`, admin.cookie, { method: 'POST', body: JSON.stringify({ amountCents: 100 }) });

  const projectId = 'workflow-project';
  const initialProject = { id: projectId, title: '联合工作流', description: 'integration', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes: [], edges: [], settings: {} };
  const createdProject = await request(`/api/projects/${projectId}`, user.cookie, { method: 'PUT', body: JSON.stringify({ project: initialProject }) });
  assert.equal(createdProject.status, 201);
  assert.equal((await createdProject.json()).project.version, 1);

  const assetResponse = await request('/api/assets', user.cookie, { method: 'POST', body: JSON.stringify({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }) });
  assert.equal(assetResponse.status, 201);
  const asset = (await assetResponse.json()).asset;
  assert.match(asset.url, /\/api\/assets\/public\//);
  const linkedProject = { ...initialProject, updatedAt: new Date().toISOString(), nodes: [{ id: 'image-1', type: 'image', position: { x: 0, y: 0 }, data: { type: 'image', content: asset.url } }] };
  const linkedSave = await request(`/api/projects/${projectId}`, user.cookie, { method: 'PUT', body: JSON.stringify({ project: linkedProject, expectedVersion: 1 }) });
  assert.equal(linkedSave.status, 200);
  const image = await request(asset.url.replace(origin, ''), user.cookie);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const video = await request(`/api/system-ai/${api.id}/v1/videos`, user.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'workflow scene', seconds: 5, _client: { projectId, nodeId: 'video-1' } }) });
  assert.equal(video.status, 202);
  const job = await video.json();
  assert.equal(db.read('users').find((item) => item.id === user.user.id).balanceCents, 0);
  await videoQueue.tick();
  await waitFor(() => db.read('generationJobs').find((item) => item.id === job.id).status === 'processing');
  await db.mutate((data) => { data.generationJobs.find((item) => item.id === job.id).nextPollAt = 0; });
  await videoQueue.tick();
  const completed = await request(`/api/system-ai/${api.id}/v1/videos/${job.id}`, user.cookie);
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).status, 'completed');
  const history = await request(`/api/generation-history?limit=10`, user.cookie);
  assert.equal(history.status, 200);
  const historyBody = await history.json();
  assert.equal(historyBody.history.length, 1);
  assert.equal(historyBody.history[0].projectId, projectId);
  assert.equal(historyBody.history[0].nodeId, 'video-1');
  assert.equal((await request('/api/generation-history', admin.cookie)).status, 200);
  assert.equal((await (await request(`/api/projects/${projectId}`, admin.cookie)).json()).project, undefined);

  await request(`/api/admin/users/${user.user.id}/balance`, admin.cookie, { method: 'POST', body: JSON.stringify({ amountCents: 100 }) });
  const failing = await request(`/api/system-ai/${api.id}/v1/videos`, user.cookie, { method: 'POST', body: JSON.stringify({ model: 'video-model', prompt: 'will-fail', seconds: 5 }) });
  assert.equal(failing.status, 202);
  const failedJob = await failing.json();
  await videoQueue.tick();
  await waitFor(() => db.read('generationJobs').find((item) => item.id === failedJob.id).status === 'processing');
  await db.mutate((data) => { data.generationJobs.find((item) => item.id === failedJob.id).nextPollAt = 0; });
  await videoQueue.tick();
  await db.mutate((data) => { data.generationJobs.find((item) => item.id === failedJob.id).nextPollAt = 0; });
  await videoQueue.tick();
  assert.equal(db.read('generationJobs').find((item) => item.id === failedJob.id).status, 'failed');
  assert.equal(db.read('users').find((item) => item.id === user.user.id).balanceCents, 100);
  assert.equal(db.read('balanceTransactions').filter((item) => item.type === 'model_refund' && item.referenceId === failedJob.id).length, 1);
  assert.equal(calls.some((call) => String(call.body || '').includes('integration-secret-key')), false);
});

test('custom API lifecycle does not break saved projects or managed generation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-custom-lifecycle-'));
  const codes = new Map();
  const upstreamCalls = [];
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, encryptionKey: key, videoQueue: false,
    fetchImpl: async (url, options) => { upstreamCalls.push({ url: String(url), body: options.body }); return new Response(JSON.stringify({ data: [{ id: 'model-ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); },
    resolveHost: async () => [{ address: '203.0.113.10', family: 4 }], sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => { const email = `${username}@example.com`; await fetch(`${origin}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) }); const response = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, password: 'strong-password', verificationCode: codes.get(email) }) }); return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user }; };
  const request = (path, cookie, options = {}) => fetch(`${origin}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), cookie, ...options.headers } });
  const user = await register('custom-owner');
  const other = await register('custom-other');
  const created = await request('/api/user-api-configs', user.cookie, { method: 'POST', body: JSON.stringify({ name: 'Personal API', provider: 'Test', baseUrl: 'https://personal.example/v1', apiKey: 'personal-secret-key' }) });
  assert.equal(created.status, 201); const config = (await created.json()).config;
  const project = { id: 'custom-project', title: 'custom lifecycle', description: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes: [], edges: [], settings: { aiModel: { id: config.id, credentialConfigId: config.id, baseUrl: config.baseUrl, apiKey: '' } } };
  assert.equal((await request('/api/projects/custom-project', user.cookie, { method: 'PUT', body: JSON.stringify({ project }) })).status, 201);
  assert.equal((await request(`${config.baseUrl}/v1/models`, user.cookie)).status, 200);
  const disabled = await request(`/api/user-api-configs/${config.id}`, user.cookie, { method: 'DELETE' });
  assert.equal(disabled.status, 200); assert.equal((await disabled.json()).affectedProjects, 1);
  assert.equal((await request(`${config.baseUrl}/v1/models`, user.cookie)).status, 410);
  const loaded = await request('/api/projects/custom-project', user.cookie); assert.equal(loaded.status, 200); assert.equal((await loaded.json()).project.settings.aiModel.credentialConfigId, config.id);
  assert.equal((await request('/api/projects/custom-project', other.cookie)).status, 404);
  assert.equal((await request(`/api/user-api-configs/${config.id}`, user.cookie, { method: 'PUT', body: JSON.stringify({ enabled: true }) })).status, 200);
  assert.equal((await request(`${config.baseUrl}/v1/models`, user.cookie)).status, 200);
  assert.equal(upstreamCalls.some((call) => call.url === 'https://personal.example/v1/v1/models'), true);
  assert.equal(JSON.stringify(db.read('userApiConfigs')).includes('personal-secret-key'), false);
});
