import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSystemApi } from '../api-discovery.js';

test('system API discovery exposes the public Shishikeji video catalog without requiring an unsupported models endpoint', async () => {
  let fetched = false;
  const result = await discoverSystemApi({
    baseUrl: 'https://api.shishikeji.com', apiKey: 'license-test-secret',
    fetchImpl: async () => { fetched = true; throw new Error('should not call /v1/models'); },
    resolveHost: async () => [{ address: '203.0.113.20', family: 4 }],
  });
  assert.equal(fetched, false);
  assert.equal(result.name, '时时科技视频 API');
  assert.equal(result.provider, '时时科技');
  assert.equal(result.models.length, 12);
  assert.deepEqual(result.models.find(({ id }) => id === 'xinghe-2.0'), {
    id: 'xinghe-2.0', name: '星核 2.0', type: 'video',
  });
  assert.deepEqual(result.models.find(({ id }) => id === 'xinghe-2.5-12s'), {
    id: 'xinghe-2.5-12s', name: '星核 2.5 12秒', type: 'video',
  });
  assert.ok(result.models.every(({ type }) => type === 'video'));
});
