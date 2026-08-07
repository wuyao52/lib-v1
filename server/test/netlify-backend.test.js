import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../../netlify/functions/backend.mjs';

function createEvent(path, overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { accept: 'application/json', origin: 'https://lib-v1-1.netlify.app' },
    queryStringParameters: { path },
    body: null,
    isBase64Encoded: false,
    ...overrides,
  };
}

test('Netlify backend proxy forwards protected APIs and preserves session cookies', async (t) => {
  const previousOrigin = process.env.API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.API_ORIGIN = 'https://api.example.com';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.example.com/api/auth/captcha');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.get('origin'), 'https://lib-v1-1.netlify.app');
    return new Response('{"captchaId":"captcha-1","image":"data:image/svg+xml;base64,abc"}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'ads_session=token; HttpOnly; Secure; SameSite=Strict' },
    });
  };
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
    globalThis.fetch = previousFetch;
  });

  const result = await handler(createEvent('/api/auth/captcha'));

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-type'], 'application/json');
  assert.match(result.body, /captcha-1/);
  assert.match(result.multiValueHeaders['set-cookie'][0], /ads_session=/);
});

test('Netlify backend proxy reconstructs the protected path from a redirect scope', async (t) => {
  const previousOrigin = process.env.API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.API_ORIGIN = 'https://api.example.com';
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.example.com/api/auth/captcha');
    return new Response('{"captchaId":"captcha-2","image":"data:image/svg+xml;base64,abc"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
    globalThis.fetch = previousFetch;
  });

  const result = await handler(createEvent('captcha', { queryStringParameters: { scope: 'auth', path: 'captcha' } }));
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /captcha-2/);
});

test('Netlify backend proxy rejects paths outside the protected API surface', async () => {
  const result = await handler(createEvent('/api/arbitrary-target'));
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /INVALID_API_PATH/);
});

test('Netlify backend proxy reports a missing backend configuration explicitly', async (t) => {
  const previousOrigin = process.env.API_ORIGIN;
  delete process.env.API_ORIGIN;
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
  });

  const result = await handler(createEvent('/api/auth/captcha'));
  assert.equal(result.statusCode, 503);
  assert.match(result.body, /BACKEND_NOT_CONFIGURED/);
});
