import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../../netlify/functions/proxy.mjs';

function createEvent(overrides = {}) {
  return {
    httpMethod: 'GET',
    path: '/.netlify/functions/proxy',
    headers: { Authorization: 'Bearer test-key', 'X-API-Key': 'test-key' },
    queryStringParameters: { service: 'hongniaoai', path: 'v1/models' },
    body: null,
    isBase64Encoded: false,
    ...overrides,
  };
}

test('Netlify AI proxy forwards Hongniao model requests with credentials', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://open.hongniaoai.com/api/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.get('authorization'), 'Bearer test-key');
    assert.equal(options.headers.get('x-api-key'), 'test-key');
    return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const result = await handler(createEvent());

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-type'], 'application/json');
  assert.equal(result.body, '{"data":[]}');
});

test('Netlify AI proxy preserves query parameters, request bodies, and non-JSON responses', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://open.hongniaoai.com/api/v1/videos?include=usage');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, '{"model":"seedance"}');
    return new Response('upstream temporarily unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const result = await handler(createEvent({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    queryStringParameters: { service: 'hongniaoai', path: 'v1/videos', include: 'usage' },
    body: '{"model":"seedance"}',
  }));

  assert.equal(result.statusCode, 503);
  assert.equal(result.body, 'upstream temporarily unavailable');
  assert.equal(result.headers['content-type'], 'text/plain');
});

test('Netlify AI proxy rejects unknown services and path traversal', async () => {
  const unknown = await handler(createEvent({ queryStringParameters: { service: 'unknown', path: 'v1/models' } }));
  const traversal = await handler(createEvent({ queryStringParameters: { service: 'hongniaoai', path: '../admin' } }));

  assert.equal(unknown.statusCode, 400);
  assert.equal(traversal.statusCode, 400);
  assert.match(unknown.body, /INVALID_PROXY_TARGET/);
});
