import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoQueue, selectFairQueuedJobs } from '../video-queue.js';

function fakeDb(data) {
  return {
    data: { users: [], generationJobs: [], balanceTransactions: [], systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://provider.example', encryptedApiKey: 'key' }], generationHistory: [], ...data },
    read(name) { return this.data[name]; },
    async mutate(mutator) { return mutator(this.data); },
    async enqueueGenerationJob(job, maxQueuePerUser, terminalStatuses) {
      const existing = this.data.generationJobs.find((item) => item.id === job.id && item.userId === job.userId);
      if (existing) return { job: existing };
      const active = this.data.generationJobs.filter((item) => item.userId === job.userId && !terminalStatuses.has(item.status));
      if (active.length >= maxQueuePerUser) return { error: 'VIDEO_QUEUE_USER_LIMIT' };
      const user = this.data.users.find((item) => item.id === job.userId);
      if (job.chargeCents && (!user || user.balanceCents < job.chargeCents)) return { error: 'INSUFFICIENT_BALANCE' };
      if (job.chargeCents) { user.balanceCents -= job.chargeCents; this.data.balanceTransactions.push({ id: `charge-${job.id}`, userId: job.userId, amountCents: -job.chargeCents, type: 'model_usage', referenceId: job.billingReference }); }
      this.data.generationJobs.push(job); return { job };
    },
  };
}

test('load scenario: 20 users submit 40 jobs without unfair scheduling or duplicate charges', async () => {
  const users = Array.from({ length: 20 }, (_, index) => ({ id: `user-${index}`, balanceCents: 100 }));
  const db = fakeDb({ users });
  const queue = await createVideoQueue({
    db,
    vault: { decrypt: (value) => value },
    autoStart: false,
    fetchImpl: async () => new Response(JSON.stringify({ id: 'provider-task', status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const jobs = Array.from({ length: 40 }, (_, index) => ({ id: `load-${index}`, userId: `user-${index % 20}`, apiId: 'api-1', modelId: 'video', requestBody: { prompt: `job-${index}` }, chargeCents: 10, billingReference: `load-${index}` }));
  const results = await Promise.all(jobs.map((job) => queue.enqueue(job)));
  assert.equal(results.length, 40);
  assert.equal(db.data.generationJobs.length, 40);
  assert.equal(db.data.balanceTransactions.filter((item) => item.type === 'model_usage').length, 40);
  assert.equal(db.data.users.every((user) => user.balanceCents === 80), true);
  const queuedSnapshot = jobs.map((job, index) => ({ ...job, status: 'queued', createdAt: new Date(Date.now() + index).toISOString(), nextPollAt: 0 }));
  const selected = selectFairQueuedJobs(queuedSnapshot, [], { globalConcurrency: 12, userConcurrency: 4, apiConcurrency: 8 }, Date.now() + 1000);
  assert.equal(selected.length, 8);
  assert.equal(new Set(selected.map((job) => job.userId)).size, 8);
  assert.equal(selected.every((job) => queuedSnapshot.some((item) => item.id === job.id)), true);
});

test('load scenario: 100 users make 1000 attempts while one abusive user is capped at 20', async () => {
  const previousLimit = process.env.VIDEO_QUEUE_MAX_PENDING_PER_USER;
  process.env.VIDEO_QUEUE_MAX_PENDING_PER_USER = '20';
  try {
    const users = Array.from({ length: 100 }, (_, index) => ({ id: `pressure-user-${index}`, balanceCents: 10_000 }));
    const db = fakeDb({ users });
    const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, autoStart: false, fetchImpl: async () => new Response('{"id":"provider-pressure","status":"queued"}', { status: 200, headers: { 'content-type': 'application/json' } }) });
    const abusive = Array.from({ length: 100 }, (_, index) => ({ id: `abuse-${index}`, userId: 'pressure-user-0', apiId: 'api-1', modelId: 'video', requestBody: { prompt: `abuse-${index}` }, chargeCents: 10, billingReference: `abuse-${index}` }));
    const normal = Array.from({ length: 900 }, (_, index) => ({ id: `normal-${index}`, userId: `pressure-user-${1 + (index % 99)}`, apiId: 'api-1', modelId: 'video', requestBody: { prompt: `normal-${index}` }, chargeCents: 10, billingReference: `normal-${index}` }));
    const results = await Promise.allSettled([...abusive, ...normal].map((job) => queue.enqueue(job)));
    const accepted = results.filter((item) => item.status === 'fulfilled').length;
    const rejected = results.filter((item) => item.status === 'rejected');
    assert.equal(accepted, 920);
    assert.equal(rejected.length, 80);
    assert.equal(rejected.every((item) => item.reason.code === 'VIDEO_QUEUE_USER_LIMIT'), true);
    assert.equal(db.data.generationJobs.filter((job) => job.userId === 'pressure-user-0').length, 20);
    assert.equal(new Set(db.data.generationJobs.filter((job) => job.userId !== 'pressure-user-0').map((job) => job.userId)).size, 99);
    assert.equal(db.data.balanceTransactions.length, 920);

    const candidates = db.data.generationJobs.map((job, index) => ({ ...job, status: 'queued', nextPollAt: 0, createdAt: new Date(Date.now() + index).toISOString() }));
    const selected = selectFairQueuedJobs(candidates, [], { globalConcurrency: 100, userConcurrency: 20, apiConcurrency: 100 }, Date.now() + 5000);
    assert.equal(selected.length, 100);
    assert.equal(new Set(selected.map((job) => job.userId)).size, 100);
  } finally {
    if (previousLimit === undefined) delete process.env.VIDEO_QUEUE_MAX_PENDING_PER_USER;
    else process.env.VIDEO_QUEUE_MAX_PENDING_PER_USER = previousLimit;
  }
});

test('load scenario: 50 concurrent retries of one id create one job and one charge', async () => {
  const db = fakeDb({ users: [{ id: 'retry-user', balanceCents: 1000 }] });
  const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, autoStart: false });
  const request = { id: 'stable-idempotent-job', userId: 'retry-user', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'same click' }, chargeCents: 25, billingReference: 'stable-idempotent-job' };
  const results = await Promise.all(Array.from({ length: 50 }, () => queue.enqueue(request)));
  assert.equal(results.length, 50);
  assert.equal(new Set(results.map((item) => item.job.id)).size, 1);
  assert.equal(db.data.generationJobs.length, 1);
  assert.equal(db.data.balanceTransactions.length, 1);
  assert.equal(db.data.users[0].balanceCents, 975);
});
