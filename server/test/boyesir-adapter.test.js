import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoProviderAdapter, isBoyesirVideoApi } from '../video-provider-adapters.js';

test('BYS adapter uses generations and tasks endpoints and extracts compatible fields', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/v1/videos/generations')) {
      return new Response(JSON.stringify({ task_id: 'canvas_vid_test', status: 'queued' }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ task_id: 'canvas_vid_test', status: 'succeeded', result: { videos: ['https://cdn.example/result.mp4'] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = { baseUrl: 'https://www.boyesir.icu', apiKey: 'test-key' };
  assert.equal(isBoyesirVideoApi(api), true);
  const adapter = createVideoProviderAdapter(api, { fetchImpl });
  const submit = await adapter.submit({ model: 'nd-seedance-2.0-720p', prompt: '镜头 @[角色](node-1)', seconds: 10, aspect_ratio: '16:9', resolution: '720p', images: [{ url: 'https://assets.example/a.png' }] }, 'idem-test-123456789', new AbortController().signal);
  assert.equal(submit.status, 202);
  const sent = JSON.parse(calls[0].options.body);
  assert.deepEqual(sent, { model: 'nd-seedance-2.0-720p', prompt: '镜头 角色', duration: 10, ratio: '16:9', resolution: '720p', images: ['https://assets.example/a.png'] });
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer test-key');
  const poll = await adapter.poll('canvas_vid_test', new AbortController().signal);
  assert.equal(poll.status, 200);
  const body = await poll.json();
  assert.equal(body.result.videos[0].endsWith('.mp4'), true);
});

test('BYS adapter accepts a base URL that already ends in /v1 without duplicating the path', async () => {
  const targets = [];
  const adapter = createVideoProviderAdapter({ baseUrl: 'https://www.boyesir.icu/v1', apiKey: 'test-key' }, {
    fetchImpl: async (url) => { targets.push(String(url)); return new Response('{"task_id":"task-1"}', { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  await adapter.submit({ model: 'seedance-2.0-mini', prompt: 'test', duration: 5 }, 'idem-test-123456789', new AbortController().signal);
  await adapter.poll('task-1', new AbortController().signal);
  assert.deepEqual(targets, [
    'https://www.boyesir.icu/v1/videos/generations',
    'https://www.boyesir.icu/v1/tasks/task-1',
  ]);
});
