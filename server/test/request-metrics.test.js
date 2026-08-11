import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestMetrics } from '../request-metrics.js';

test('request metrics calculate latency percentiles and AI error rates without retaining paths', () => {
  const metrics = createRequestMetrics({ maxSamples: 200 });
  const now = Date.now();
  for (let index = 1; index <= 100; index += 1) metrics.record({ path: '/api/system-ai/secret-api/v1/videos', status: index <= 90 ? 200 : index <= 95 ? 400 : 502, durationMs: index, timestamp: now });
  metrics.record({ path: '/not-api/private', status: 500, durationMs: 999, timestamp: now });
  const snapshot = metrics.snapshot({ now });
  assert.equal(snapshot.total, 100);
  assert.equal(snapshot.p50Ms, 50);
  assert.equal(snapshot.p95Ms, 95);
  assert.equal(snapshot.p99Ms, 99);
  assert.equal(snapshot.managedAi.errorRate, 0.1);
  assert.equal(snapshot.managedAi.serverErrorRate, 0.05);
  assert.equal(JSON.stringify(snapshot).includes('secret-api'), false);
});

test('request metrics enforce a bounded sample window', () => {
  const metrics = createRequestMetrics({ maxSamples: 100 });
  for (let index = 0; index < 150; index += 1) metrics.record({ path: '/api/health', status: 200, durationMs: index });
  assert.equal(metrics.size, 100);
  assert.equal(metrics.snapshot().total, 100);
});
