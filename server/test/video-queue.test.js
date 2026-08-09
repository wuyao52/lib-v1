import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoQueue } from '../video-queue.js';

const waitFor = async (predicate, timeoutMs = 1000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for queue state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function fakeDb(seed = {}) {
  const data = {
    users: [], systemApis: [], generationJobs: [], generationHistory: [], balanceTransactions: [],
    ...seed,
  };
  return {
    data,
    read(collection) { return data[collection]; },
    async mutate(mutator) { return mutator(data); },
  };
}

async function withQueueEnv(values, operation) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await operation(); } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

test('video queue enforces fair global and per-user concurrency, saves history, and refunds once', async () => {
  await withQueueEnv({
    VIDEO_QUEUE_GLOBAL_CONCURRENCY: '2', VIDEO_QUEUE_USER_CONCURRENCY: '1',
    VIDEO_QUEUE_API_CONCURRENCY: '2', VIDEO_QUEUE_POLL_CONCURRENCY: '2',
  }, async () => {
    const db = fakeDb({
      users: [{ id: 'user-a', balanceCents: 0 }, { id: 'user-b', balanceCents: 50 }],
      systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://upstream.example', encryptedApiKey: 'secret' }],
    });
    const fetchImpl = async (url, options) => {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify({ id: `provider-${body.prompt}`, status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).endsWith('/provider-a1')) return new Response(JSON.stringify({ status: 'completed', progress: 100, video_url: 'https://cdn.example/a1.mp4' }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (String(url).endsWith('/provider-b')) return new Response(JSON.stringify({ status: 'failed', error: 'PROVIDER_MODERATION_ERROR' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ status: 'processing' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, fetchImpl, autoStart: false });

    await queue.enqueue({ id: 'job-a1', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'a1' } });
    await queue.enqueue({ id: 'job-a2', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'a2' } });
    await queue.enqueue({ id: 'job-b', userId: 'user-b', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'b' }, chargeCents: 50, billingReference: 'job-b' });

    await waitFor(() => db.data.generationJobs.filter((job) => job.status === 'processing').length === 2);
    assert.equal(db.data.generationJobs.find((job) => job.id === 'job-a2').status, 'queued');
    assert.deepEqual(db.data.generationJobs.filter((job) => job.status === 'processing').map((job) => job.userId).sort(), ['user-a', 'user-b']);

    db.data.generationJobs.filter((job) => job.status === 'processing').forEach((job) => { job.nextPollAt = 0; });
    await queue.tick();
    await waitFor(() => ['completed', 'failed'].every((status) => db.data.generationJobs.some((job) => job.status === status)));

    assert.equal(db.data.generationHistory.length, 1);
    assert.equal(db.data.generationHistory[0].url, 'https://cdn.example/a1.mp4');
    assert.equal(db.data.generationHistory[0].projectId, '');
    assert.equal(db.data.users.find((user) => user.id === 'user-b').balanceCents, 50);
    assert.equal(db.data.balanceTransactions.filter((item) => item.type === 'model_refund' && item.referenceId === 'job-b').length, 1);

    await queue.tick();
    await waitFor(() => db.data.generationJobs.find((job) => job.id === 'job-a2').status === 'processing');
    assert.equal(queue.overview().config.userConcurrency, 1);
  });
});

test('video queue delays transient submission failures instead of refunding immediately', async () => {
  let submissions = 0;
  const db = fakeDb({
    users: [{ id: 'user-a', balanceCents: 25 }],
    systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://upstream.example', encryptedApiKey: 'secret' }],
  });
  const fetchImpl = async (_url, options) => {
    if (options.method === 'POST') {
      submissions += 1;
      if (submissions === 1) return new Response('{"message":"busy"}', { status: 429, headers: { 'content-type': 'application/json' } });
      return new Response('{"id":"provider-retry","status":"queued"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"status":"processing"}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, fetchImpl, autoStart: false });
  await queue.enqueue({ id: 'retry-job', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'retry' }, chargeCents: 25, billingReference: 'retry-job' });
  await waitFor(() => db.data.generationJobs[0]?.status === 'queued' && db.data.generationJobs[0]?.attemptCount === 1);
  assert.equal(db.data.balanceTransactions.some((item) => item.type === 'model_refund'), false);
  db.data.generationJobs[0].nextPollAt = 0;
  await queue.tick();
  await waitFor(() => db.data.generationJobs[0]?.status === 'processing');
  assert.equal(submissions, 2);
});

test('video queue recovers interrupted submissions and only cleans expired terminal records', async () => {
  await withQueueEnv({ VIDEO_QUEUE_HISTORY_DAYS: '1' }, async () => {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const baseJob = {
      userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'recover' },
      providerTaskId: null, progress: 0, resultUrl: null, thumbnail: null, errorCode: null, errorMessage: null,
      chargeCents: 0, billingReference: null, projectId: null, nodeId: null, prompt: 'recover', attemptCount: 0,
      nextPollAt: Date.now() + 60000, createdAt: old, updatedAt: old, completedAt: null,
    };
    const db = fakeDb({
      systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://upstream.example', encryptedApiKey: 'secret' }],
      generationJobs: [
        { ...baseJob, id: 'interrupted', status: 'submitting' },
        { ...baseJob, id: 'old-completed', status: 'completed', completedAt: old, resultUrl: 'https://cdn.example/recovered.mp4' },
        { ...baseJob, id: 'old-processing', status: 'processing', providerTaskId: 'provider-old' },
      ],
    });
    const fetchImpl = async (_url, options) => options.method === 'POST'
      ? new Response('{"id":"provider-recovered","status":"queued"}', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('{"status":"processing"}', { status: 200, headers: { 'content-type': 'application/json' } });
    const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, fetchImpl, autoStart: false });
    assert.equal(db.data.generationJobs.find((job) => job.id === 'interrupted').status, 'queued');
    assert.equal(db.data.generationHistory.find((item) => item.url === 'https://cdn.example/recovered.mp4')?.projectId, '');
    await queue.tick();
    assert.equal(db.data.generationJobs.some((job) => job.id === 'old-completed'), false);
    assert.equal(db.data.generationJobs.some((job) => job.id === 'old-processing'), true);
    await waitFor(() => db.data.generationJobs.find((job) => job.id === 'interrupted')?.status === 'processing');
  });
});

test('video queue reserves balance atomically and never charges a rejected enqueue', async () => {
  const db = fakeDb({ users: [{ id: 'user-a', balanceCents: 10 }] });
  const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, autoStart: false });
  await assert.rejects(
    queue.enqueue({ id: 'no-balance', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'test' }, chargeCents: 25, billingReference: 'no-balance' }),
    (error) => error.code === 'INSUFFICIENT_BALANCE' && error.message === '错误：余额不足',
  );
  assert.equal(db.data.users[0].balanceCents, 10);
  assert.equal(db.data.generationJobs.length, 0);
  assert.equal(db.data.balanceTransactions.length, 0);
});
