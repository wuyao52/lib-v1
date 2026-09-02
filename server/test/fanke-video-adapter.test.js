import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoProviderAdapter, isFankeVideoApi } from '../video-provider-adapters.js';

test('Fanke adapter uses open v1 endpoints and converts video request fields', async () => {
  const calls = [];
  const adapter = createVideoProviderAdapter({ baseUrl: 'https://ai.fanke2026.xyz', apiKey: 'fanke-key' }, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ success: true, jobId: 'job-f-1', status: 'submitted' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(isFankeVideoApi({ baseUrl: 'https://ai.fanke2026.xyz/' }), true);
  await adapter.submit({
    model: 'limited_seedance_2_full_720p', prompt: '镜头 @[角色](node-1)', duration: 10,
    aspect_ratio: '9:16', resolution: '720p',
    images: [{ url: 'https://assets.example/a.png' }],
    videos: [{ url: 'https://assets.example/a.mp4' }],
    audios: [{ url: 'https://assets.example/a.mp3' }],
  }, 'idem-f-1', new AbortController().signal);

  assert.equal(calls[0].url, 'https://ai.fanke2026.xyz/api/open/v1/video/generate');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'limited_seedance_2_full_720p', prompt: '镜头 角色', ratio: '9:16', duration: 10,
    resolution: '720p', imageUrls: ['https://assets.example/a.png'],
    videoUrls: ['https://assets.example/a.mp4'], audioUrls: ['https://assets.example/a.mp3'],
  });
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer fanke-key');

  await adapter.poll('job-f-1', new AbortController().signal);
  const poll = new URL(calls[1].url);
  assert.equal(poll.pathname, '/api/open/v1/video/status');
  assert.equal(poll.searchParams.get('jobId'), 'job-f-1');
  assert.ok(poll.searchParams.get('_'));
  assert.equal(calls[1].options.headers.get('cache-control'), 'no-cache');
  assert.equal(calls[1].options.cache, 'no-store');
});

test('non-Fanke APIs keep the OpenAI-compatible adapter', () => {
  const adapter = createVideoProviderAdapter({ baseUrl: 'https://upstream.example', apiKey: 'test-key' });
  assert.equal(adapter.kind, 'openai-compatible');
});
