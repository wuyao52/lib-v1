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
    id: 'xinghe-2.0', name: '星核 2.0', type: 'video', supportedResolutions: ['480p', '720p', '1080p', '4k'],
  });
  assert.deepEqual(result.models.find(({ id }) => id === 'xinghe-2.5-12s'), {
    id: 'xinghe-2.5-12s', name: '星核 2.5 12秒', type: 'video', supportedResolutions: ['720p'],
  });
  assert.ok(result.models.every(({ type }) => type === 'video'));
});

test('system API discovery reads WeijinAPI video capabilities from /v1/models', async () => {
  let requestedUrl = '';
  const result = await discoverSystemApi({
    baseUrl: 'https://www.weijinapi.top', apiKey: 'weijin-test-secret',
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.headers.get('authorization'), 'Bearer weijin-test-secret');
      return new Response(JSON.stringify({ data: [{ id: 'seedance2.0-one-full-flex-720p', display_name: 'Seedance ONE Full', type: 'video', resolution: '720p', durations_seconds: [15], ratios: ['16:9', '9:16'], max_images: 9, max_videos: 3, max_audios: 3 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    resolveHost: async () => [{ address: '203.0.113.21', family: 4 }],
  });
  assert.equal(requestedUrl, 'https://www.weijinapi.top/v1/models');
  assert.equal(result.provider, 'WeijinAPI');
  assert.deepEqual(result.models[0], { id: 'seedance2.0-one-full-flex-720p', name: 'Seedance ONE Full', type: 'video', supportedResolutions: ['720p'], allowedDurationsSec: [15], supportedRatios: ['16:9', '9:16'], maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3 });
});

test('system API discovery reads fixed and selectable image resolutions from common model fields', async () => {
  const result = await discoverSystemApi({
    baseUrl: 'https://images.example.com', apiKey: 'image-model-test-key',
    fetchImpl: async () => new Response(JSON.stringify({ data: [
      { id: 'fixed-image', name: 'Fixed Image', type: 'image_generation', resolution: '1K' },
      { id: 'flex-image', name: 'Flex Image', type: 'image', supported_resolutions: ['720p', '1080p', '2K'] },
      { id: 'sized-image', name: 'Sized Image', type: 'image', capabilities: { resolutions: '1024x1024,1536x1024' } },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    resolveHost: async () => [{ address: '203.0.113.23', family: 4 }],
  });
  assert.deepEqual(result.models.map(({ id, supportedResolutions }) => ({ id, supportedResolutions })), [
    { id: 'fixed-image', supportedResolutions: ['1080p'] },
    { id: 'flex-image', supportedResolutions: ['720p', '1080p', '2k'] },
    { id: 'sized-image', supportedResolutions: ['1024x1024', '1536x1024'] },
  ]);
  assert.ok(result.models.every(({ type }) => type === 'image'));
});

test('system API discovery exposes BYS video paths and model-specific duration rules', async () => {
  const result = await discoverSystemApi({
    baseUrl: 'https://www.boyesir.icu/', apiKey: 'boyesir-test-secret',
    fetchImpl: async () => { throw new Error('BYS catalog is documented and needs no /v1/models call'); },
    resolveHost: async () => [{ address: '203.0.113.22', family: 4 }],
  });
  assert.equal(result.provider, 'BYS api');
  assert.deepEqual(result.models.find(({ id }) => id === 'nd-seedance-2.0-720p'), {
    id: 'nd-seedance-2.0-720p', name: 'Seedance 2.0 720p', type: 'video', supportedResolutions: ['720p'],
  });
  assert.deepEqual(result.models.find(({ id }) => id === 'seedance-2.0-mini').allowedDurationsSec, [4, 5, 6, 8, 10, 12]);
});
