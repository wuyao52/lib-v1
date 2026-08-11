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

test('request metrics survive restart and aggregate two application instances', async () => {
  const rows = new Map();
  const store = {
    async writeRequestMetricBuckets(buckets) {
      for (const item of buckets) {
        const key = `${item.bucketStart}:${item.scope}:${item.statusClass}:${item.latencyBucketMs}`;
        const previous = rows.get(key);
        rows.set(key, previous ? { ...previous, count: previous.count + item.count, durationTotalMs: previous.durationTotalMs + item.durationTotalMs } : { ...item });
      }
    },
    async readRequestMetricBuckets(since) { return [...rows.values()].filter((item) => item.bucketStart >= since); },
  };
  const now = Date.now();
  const first = createRequestMetrics({ store, flushIntervalMs: 60_000 });
  const second = createRequestMetrics({ store, flushIntervalMs: 60_000 });
  first.record({ path: '/api/system-ai/private-id/v1/videos', status: 200, durationMs: 40, timestamp: now });
  second.record({ path: '/api/system-ai/another-private-id/v1/videos', status: 502, durationMs: 600, timestamp: now });
  await Promise.all([first.close(), second.close()]);

  const restarted = createRequestMetrics({ store, flushIntervalMs: 60_000 });
  const snapshot = await restarted.snapshotPersistent({ now });
  await restarted.close();
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.managedAi.total, 2);
  assert.equal(snapshot.managedAi.serverErrorRate, 0.5);
  assert.equal(snapshot.p50Ms, 50);
  assert.equal(snapshot.p95Ms, 1000);
  assert.equal(JSON.stringify([...rows.values()]).includes('private-id'), false);
});
