import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoProviderAdapter } from '../video-provider-adapters.js';

test('MiniMax H3 768p requests retain the upstream-required uppercase P', async () => {
  let sent;
  const adapter = createVideoProviderAdapter({ baseUrl: 'https://upstream.example', apiKey: 'test-key' }, {
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response('{"id":"task-1"}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const response = await adapter.submit({
    model: 'MINIMAX-H3-768p', prompt: 'local adapter proof', seconds: 15,
    aspect_ratio: '9:16', resolution: '768p', images: [],
  }, 'idem-minimax-768p', new AbortController().signal);

  assert.equal(response.status, 200);
  assert.equal(sent.resolution, '768P');
  assert.equal(sent.model, 'MINIMAX-H3-768p');
});

test('other OpenAI-compatible video models keep their configured resolution unchanged', async () => {
  let sent;
  const adapter = createVideoProviderAdapter({ baseUrl: 'https://upstream.example', apiKey: 'test-key' }, {
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response('{"id":"task-1"}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await adapter.submit({ model: 'another-video-720p', prompt: 'unchanged', resolution: '720p' }, 'idem-other-720p', new AbortController().signal);
  assert.equal(sent.resolution, '720p');
});
