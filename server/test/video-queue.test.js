import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoQueue, selectFairQueuedJobs } from '../video-queue.js';

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

test('video queue accepts a completed ToAPIs-style result.data video response without a task ID', async () => {
  const db = fakeDb({
    users: [{ id: 'user-a', balanceCents: 0 }],
    systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://upstream.example', encryptedApiKey: 'secret' }],
  });
  const fetchImpl = async (_url, options) => {
    assert.equal(options.method, 'POST');
    return new Response(JSON.stringify({
      generation: { ratio: '9:16', resolution: '720p' },
      result: { type: 'video', data: [{ url: 'https://files.toapis.example/videos/finished.mp4', format: 'mp4' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, fetchImpl, autoStart: false });
  await queue.enqueue({ id: 'toapis-result-job', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'completed response' } });
  await waitFor(() => db.data.generationJobs[0]?.status === 'completed');
  assert.equal(db.data.generationJobs[0].resultUrl, 'https://files.toapis.example/videos/finished.mp4');
  assert.equal(db.data.generationHistory[0]?.url, 'https://files.toapis.example/videos/finished.mp4');
});

test('video queue completes a polled ToAPIs task when a direct video exists at 100 percent despite a stale processing status', async () => {
  const db = fakeDb({
    users: [{ id: 'user-a', balanceCents: 0 }],
    systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://upstream.example', encryptedApiKey: 'secret' }],
  });
  const fetchImpl = async (_url, options) => {
    if (options.method === 'POST') {
      return new Response(JSON.stringify({ id: 'tsk_vid_toapis', status: 'processing', progress: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      status: 'processing',
      progress: 100,
      generation: { ratio: '9:16', resolution: '720p' },
      result: { type: 'video', data: [{ url: 'https://files.toapis.example/videos/polled-finished.mp4', format: 'mp4' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, fetchImpl, autoStart: false });
  await queue.enqueue({ id: 'toapis-polled-job', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'polled completed response' } });
  await waitFor(() => db.data.generationJobs[0]?.status === 'processing');
  db.data.generationJobs[0].nextPollAt = 0;
  await queue.tick();
  await waitFor(() => db.data.generationJobs[0]?.status === 'completed');
  assert.equal(db.data.generationJobs[0].resultUrl, 'https://files.toapis.example/videos/polled-finished.mp4');
  assert.equal(db.data.generationHistory[0]?.url, 'https://files.toapis.example/videos/polled-finished.mp4');
});

test('video queue extracts a completed video from a JSON-encoded provider wrapper', async () => {
  const db = fakeDb({
    users: [{ id: 'user-a', balanceCents: 0 }],
    systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://upstream.example', encryptedApiKey: 'secret' }],
  });
  const fetchImpl = async (_url, options) => options.method === 'POST'
    ? new Response(JSON.stringify({ id: 'tsk_encoded', status: 'processing' }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({
      status: 'processing', progress: 100,
      provider_payload: JSON.stringify({ result: { type: 'video', data: [{ url: 'https://files.toapis.example/videos/encoded-finished.mp4', format: 'mp4' }] } }),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, fetchImpl, autoStart: false });
  await queue.enqueue({ id: 'encoded-result-job', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'encoded result' } });
  await waitFor(() => db.data.generationJobs[0]?.status === 'processing');
  db.data.generationJobs[0].nextPollAt = 0;
  await queue.tick();
  await waitFor(() => db.data.generationJobs[0]?.status === 'completed');
  assert.equal(db.data.generationJobs[0].resultUrl, 'https://files.toapis.example/videos/encoded-finished.mp4');
});

test('video queue adapts Shishikeji multipart submission, license auth, polling and refreshed video links', async () => {
  const db = fakeDb({
    users: [{ id: 'user-a', balanceCents: 0 }],
    systemApis: [{ id: 'api-shishikeji', enabled: true, baseUrl: 'https://api.shishikeji.com', encryptedApiKey: 'license-test-secret' }],
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    const target = String(url);
    calls.push({ target, options });
    if (/^https:\/\/assets\.example\/reference-?\d*\.jpg$/.test(target)) {
      return new Response(Buffer.from('reference-image-bytes'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '21' } });
    }
    assert.equal(options.headers.get('x-license-key'), 'license-test-secret');
    assert.equal(options.headers.has('authorization'), false);
    if (target === 'https://api.shishikeji.com/api/generate-video') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.has('content-type'), false);
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('prompt'), 'adapter prompt');
      assert.equal(options.body.get('duration'), '5');
      assert.equal(options.body.get('ratio'), '9:16');
      assert.equal(options.body.get('resolution'), '720p');
      assert.equal(options.body.get('model'), 'xinghe-2.0');
      assert.equal(options.body.get('protect_stripe'), 'true');
      assert.equal(options.body.getAll('files').length, 5);
      return new Response(JSON.stringify({ task_id: 'provider-shishikeji-task', status: 'processing', progress: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://api.shishikeji.com/api/task/provider-shishikeji-task') {
      return new Response(JSON.stringify({ task_id: 'provider-shishikeji-task', status: 'completed', progress: 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://api.shishikeji.com/api/task/provider-shishikeji-task/video-link?refresh=1') {
      return new Response(JSON.stringify({ official_video_url: 'https://cdn.shishikeji.example/results/final.mp4' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected adapter request: ${target}`);
  };
  const queue = await createVideoQueue({
    db, vault: { decrypt: (value) => value }, fetchImpl, autoStart: false,
    resolveHost: async () => [{ address: '203.0.113.20', family: 4 }],
  });
  await queue.enqueue({
    id: 'shishikeji-job', userId: 'user-a', apiId: 'api-shishikeji', modelId: 'xinghe-2.0',
    requestBody: {
      model: 'xinghe-2.0', prompt: 'adapter prompt', seconds: 5,
      aspect_ratio: '9:16', resolution: '720p', images: [
        'https://assets.example/reference-1.jpg',
        'https://assets.example/reference-2.jpg',
        'https://assets.example/reference-3.jpg',
        'https://assets.example/reference-4.jpg',
        'https://assets.example/reference-5.jpg',
      ],
    },
  });
  await waitFor(() => db.data.generationJobs[0]?.status === 'processing');
  db.data.generationJobs[0].nextPollAt = 0;
  await queue.tick();
  await waitFor(() => db.data.generationJobs[0]?.status === 'completed');
  assert.equal(db.data.generationJobs[0].resultUrl, 'https://cdn.shishikeji.example/results/final.mp4');
  assert.equal(db.data.generationHistory[0]?.url, 'https://cdn.shishikeji.example/results/final.mp4');
  assert.equal(calls.some((call) => call.target.includes('license_key=')), false);
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

test('provider capacity failures return to the queue and retry without charging twice', async () => {
  let submissions = 0;
  const db = fakeDb({
    users: [{ id: 'user-a', balanceCents: 25 }],
    systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://upstream.example', encryptedApiKey: 'secret' }],
  });
  const fetchImpl = async (_url, options) => {
    if (options.method === 'POST') {
      submissions += 1;
      return new Response(JSON.stringify({ id: `provider-capacity-${submissions}`, status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(_url).endsWith('/provider-capacity-1')) {
      return new Response(JSON.stringify({ status: 'failed', error: { message: '当前用户最多同时运行 20 个图片/视频任务，当前已有 20 个任务运行中' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ status: 'processing', progress: 10 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, fetchImpl, autoStart: false });
  await queue.enqueue({ id: 'capacity-job', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'capacity' }, chargeCents: 25, billingReference: 'capacity-job' });
  await waitFor(() => db.data.generationJobs[0]?.status === 'processing');
  db.data.generationJobs[0].nextPollAt = 0;
  await queue.tick();
  await waitFor(() => db.data.generationJobs[0]?.status === 'queued');
  assert.equal(db.data.generationJobs[0].providerTaskId, null);
  assert.equal(db.data.balanceTransactions.some((item) => item.type === 'model_refund'), false);
  db.data.generationJobs[0].nextPollAt = 0;
  await queue.tick();
  await waitFor(() => db.data.generationJobs[0]?.providerTaskId === 'provider-capacity-2');
  assert.equal(submissions, 2);
  assert.equal(db.data.balanceTransactions.some((item) => item.type === 'model_refund'), false);
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

test('video queue cancellation stops queued and provider tasks and refunds exactly once', async () => {
  await withQueueEnv({ VIDEO_QUEUE_GLOBAL_CONCURRENCY: '1' }, async () => {
    const now = new Date().toISOString();
    const db = fakeDb({
      users: [{ id: 'user-a', balanceCents: 100 }],
      systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://upstream.example', encryptedApiKey: 'secret' }],
      generationJobs: [{
        id: 'blocker', userId: 'other-user', apiId: 'api-1', modelId: 'video', requestBody: {},
        status: 'processing', providerTaskId: 'provider-blocker', progress: 10, resultUrl: null, thumbnail: null,
        errorCode: null, errorMessage: null, chargeCents: 0, billingReference: null, projectId: null, nodeId: null,
        prompt: '', attemptCount: 0, nextPollAt: Date.now() + 60000, createdAt: now, updatedAt: now, completedAt: null,
      }],
    });
    const deleted = [];
    const fetchImpl = async (url, options) => {
      if (options.method === 'DELETE') {
        deleted.push(String(url));
        return new Response('{"status":"cancelled"}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (options.method === 'POST') return new Response('{"id":"provider-running","status":"queued"}', { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{"status":"processing"}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const queue = await createVideoQueue({ db, vault: { decrypt: (value) => value }, fetchImpl, autoStart: false });

    await queue.enqueue({ id: 'queued-cancel', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'cancel me' }, chargeCents: 40, billingReference: 'queued-cancel' });
    assert.equal(db.data.users[0].balanceCents, 60);
    assert.equal((await queue.cancel('queued-cancel', 'user-a')).status, 'cancelled');
    assert.equal(db.data.users[0].balanceCents, 100);
    await queue.cancel('queued-cancel', 'user-a');
    assert.equal(db.data.balanceTransactions.filter((item) => item.type === 'model_refund').length, 1);

    db.data.generationJobs.find((job) => job.id === 'blocker').status = 'completed';
    await queue.enqueue({ id: 'running-cancel', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'running' } });
    await waitFor(() => db.data.generationJobs.find((job) => job.id === 'running-cancel')?.status === 'processing');
    assert.equal((await queue.cancel('running-cancel', 'user-a')).status, 'cancelled');
    assert.equal(deleted.some((url) => url.endsWith('/v1/videos/provider-running')), true);
  });
});

test('fair queue selection alternates users even when one user submitted first', () => {
  const jobs = [
    ['a-1', 'user-a', '2026-01-01T00:00:00.000Z'],
    ['a-2', 'user-a', '2026-01-01T00:00:01.000Z'],
    ['a-3', 'user-a', '2026-01-01T00:00:02.000Z'],
    ['b-1', 'user-b', '2026-01-01T00:00:03.000Z'],
    ['b-2', 'user-b', '2026-01-01T00:00:04.000Z'],
  ].map(([id, userId, createdAt]) => ({ id, userId, apiId: 'api-1', status: 'queued', nextPollAt: 0, createdAt }));
  const selected = selectFairQueuedJobs(jobs, [], { globalConcurrency: 4, userConcurrency: 20, apiConcurrency: 20 }, Date.now());
  assert.deepEqual(selected.map((job) => job.userId), ['user-a', 'user-b', 'user-a', 'user-b']);
});

test('video queue drains in-flight submission, rejects new work and releases its lease', async () => {
  let releaseSubmission;
  const submissionGate = new Promise((resolve) => { releaseSubmission = resolve; });
  const db = fakeDb({
    users: [{ id: 'user-a', balanceCents: 0 }],
    systemApis: [{ id: 'api-1', enabled: true, baseUrl: 'https://upstream.example', encryptedApiKey: 'secret' }],
  });
  const queue = await createVideoQueue({
    db, vault: { decrypt: (value) => value }, autoStart: false,
    fetchImpl: async () => { await submissionGate; return new Response('{"id":"provider-drain","status":"queued"}', { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  await queue.enqueue({ id: 'drain-job', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: { prompt: 'drain' } });
  await waitFor(() => db.data.generationJobs[0]?.status === 'submitting');
  const stopping = queue.stop({ timeoutMs: 2000 });
  await assert.rejects(queue.enqueue({ id: 'late-job', userId: 'user-a', apiId: 'api-1', modelId: 'video', requestBody: {} }), (error) => error.code === 'VIDEO_QUEUE_DRAINING');
  releaseSubmission();
  const result = await stopping;
  assert.equal(result.drained, true);
  assert.equal(queue.isAccepting(), false);
  assert.equal(queue.overview().draining, true);
  assert.equal(db.data.generationJobs[0].status, 'processing');
  assert.equal(db.data.generationJobs[0].leaseOwner, null);
  assert.equal(db.data.generationJobs[0].leaseUntil, 0);
});
