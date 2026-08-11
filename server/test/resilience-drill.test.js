import test from 'node:test';
import assert from 'node:assert/strict';
import { runResilienceDrill } from '../resilience-drill.js';

test('resilience drill exposes database and storage outages then verifies combined recovery', async () => {
  const result = await runResilienceDrill({ concurrency: 30 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.databaseFailure, { status: 503, check: 'error' });
  assert.deepEqual(result.storageFailure, { status: 503, check: 'error' });
  assert.deepEqual(result.recovered, { status: 200, ok: true });
  assert.deepEqual(result.concurrent, { attempted: 30, succeeded: 30 });
  assert.deepEqual(result.maintenance, { removedSessions: 1, remainingSessions: ['drill-active'] });
  assert.ok(result.metrics.total >= 33);
  assert.equal(JSON.stringify(result).includes('injected'), false);
});
