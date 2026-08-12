import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

test('operations alerts expose real backlog, failures, and delayed work without request content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-operations-alerts-'));
  const codes = new Map();
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const email = 'operations-alert-admin@example.com';
  await fetch(`${origin}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
  const registration = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'operations-alert-admin', email, password: 'operations-password', verificationCode: codes.get(email) }) });
  const admin = (await registration.json()).user;
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const now = Date.now();
  await db.mutate((data) => {
    data.users.find((user) => user.id === admin.id).role = 'system';
    for (let index = 0; index < 25; index += 1) data.generationJobs.push({ id: `queued-${index}`, userId: admin.id, apiId: 'api-safe', modelId: 'video', status: 'queued', prompt: `secret-prompt-${index}`, createdAt: new Date(now - 5_000).toISOString(), updatedAt: new Date(now - 5_000).toISOString() });
    for (let index = 0; index < 7; index += 1) data.generationJobs.push({ id: `failed-${index}`, userId: admin.id, apiId: 'api-safe', modelId: 'video', status: 'failed', errorCode: 'UPSTREAM_VIDEO_FAILED', prompt: `secret-failure-${index}`, createdAt: new Date(now - 10_000).toISOString(), updatedAt: new Date(now - 5_000).toISOString() });
    data.generationJobs.push({ id: 'moderated', userId: admin.id, status: 'failed', errorCode: 'PROVIDER_MODERATION_ERROR', prompt: 'secret-moderated-prompt', createdAt: new Date(now - 10_000).toISOString(), updatedAt: new Date(now - 5_000).toISOString() });
    data.generationJobs.push({ id: 'delayed-job', userId: admin.id, apiId: 'api-safe', modelId: 'video', status: 'processing', prompt: 'secret-delayed-prompt', createdAt: new Date(now - 32 * 60_000).toISOString(), submittedAt: new Date(now - 31 * 60_000).toISOString(), updatedAt: new Date(now - 31 * 60_000).toISOString() });
  });
  const response = await fetch(`${origin}/api/admin/operations-alerts`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.healthy, false);
  assert.equal(body.alerts.find((item) => item.code === 'QUEUE_BACKLOG').count, 26);
  assert.equal(body.alerts.find((item) => item.code === 'GENERATION_FAILURE_RATE').count, 7);
  assert.deepEqual({
    totalFailed: body.generationFailures.totalFailed,
    operationalFailed: body.generationFailures.operationalFailed,
    moderationFailed: body.generationFailures.moderationFailed,
    minimumCount: body.generationFailures.minimumCount,
  }, { totalFailed: 8, operationalFailed: 7, moderationFailed: 1, minimumCount: 2 });
  assert.equal(body.delayed[0].jobId, 'delayed-job');
  assert.equal(JSON.stringify(body).includes('secret-'), false);
  const metrics = await (await fetch(`${origin}/api/admin/metrics`, { headers: { cookie } })).json();
  assert.equal(metrics.recent.queueBacklog, 26);
  assert.equal(metrics.recent.failureRate, Number((8 / 34).toFixed(4)));
  assert.equal(metrics.recent.operationalFailureRate, 1);
  assert.equal(metrics.recent.operationalFailed, 7);
  assert.equal(metrics.recent.excludedFailed, 1);
  assert.equal(metrics.recent.moderationFailed, 1);
  assert.equal(metrics.recent.averageQueueWaitMs, 60_000);
});
