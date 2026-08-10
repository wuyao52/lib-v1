import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoQueue, selectFairQueuedJobs } from '../video-queue.js';

function fakeDb(data) {
  return {
    data: { users: [], generationJobs: [], balanceTransactions: [], systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://provider.example', encryptedApiKey: 'key' }], generationHistory: [], ...data },
    read(name) { return this.data[name]; },
    async mutate(mutator) { return mutator(this.data); },
    async enqueueGenerationJob(job, maxQueuePerUser, terminalStatuses) {
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
