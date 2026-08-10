import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceGuard, readLimitedBody } from '../resource-guard.js';

test('AI resource guard limits one user while allowing another user', async () => {
  const guard = createResourceGuard({ config: { globalConcurrency: 2, userConcurrency: 1, requestsPerMinute: 10, maxResponseBytes: 64, timeoutMs: 1000 } });
  const releaseA = await guard.acquire('user-a');
  await assert.rejects(guard.acquire('user-a'), (error) => error.code === 'AI_CONCURRENCY_LIMIT');
  const releaseB = await guard.acquire('user-b');
  assert.equal(guard.active, 2);
  releaseA(); releaseB();
  const releaseAgain = await guard.acquire('user-a');
  releaseAgain();
  assert.equal(guard.active, 0);
});

test('AI response guard rejects an oversized response', async () => {
  const response = new Response('12345', { headers: { 'content-length': '5' } });
  await assert.rejects(readLimitedBody(response, 4), (error) => error.code === 'UPSTREAM_RESPONSE_TOO_LARGE');
});
