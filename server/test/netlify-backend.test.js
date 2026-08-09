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

test('Netlify backend proxy resolves the path suffix used by Netlify function rewrites', async (t) => {
  const previousOrigin = process.env.API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.API_ORIGIN = 'https://api.example.com';
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.example.com/api/auth/captcha');
    return new Response('{"captchaId":"captcha-3","image":"data:image/svg+xml;base64,abc"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
    globalThis.fetch = previousFetch;
  });

  const result = await handler(createEvent('', { path: '/.netlify/functions/backend/auth/captcha', queryStringParameters: {} }));
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /captcha-3/);
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

test('Netlify backend proxy forwards authenticated project storage routes', async (t) => {
  const previousOrigin = process.env.API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.API_ORIGIN = 'https://api.example.com';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.example.com/api/projects/project-1');
    assert.equal(options.method, 'PUT');
    return new Response('{"project":{"id":"project-1"}}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
    globalThis.fetch = previousFetch;
  });

  const result = await handler(createEvent('project-1', {
    httpMethod: 'PUT',
    path: '/.netlify/functions/backend/projects/project-1',
    queryStringParameters: {},
    body: '{"project":{"id":"project-1"}}',
  }));
  assert.equal(result.statusCode, 200);
});

test('Netlify backend proxy forwards generation history writes', async (t) => {
  const previousOrigin = process.env.API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.API_ORIGIN = 'https://api.example.com';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.example.com/api/generation-history');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.get('cookie'), 'ads_session=token');
    assert.match(String(options.body), /video-1\.mp4/);
    return new Response('{"item":{"id":"history-1"}}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
    globalThis.fetch = previousFetch;
  });

  const result = await handler(createEvent('', {
    httpMethod: 'POST',
    path: '/.netlify/functions/backend/generation-history',
    queryStringParameters: {},
    headers: { cookie: 'ads_session=token', 'content-type': 'application/json' },
    body: '{"projectId":"project-1","type":"video","prompt":"test","url":"https://cdn.example/video-1.mp4"}',
  }));
  assert.equal(result.statusCode, 201);
  assert.match(result.body, /history-1/);
});

test('Netlify backend proxy forwards image asset uploads', async (t) => {
  const previousOrigin = process.env.API_ORIGIN;
  const previousFetch = globalThis.fetch;
  process.env.API_ORIGIN = 'https://api.example.com';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.example.com/api/assets');
    assert.equal(options.method, 'POST');
    assert.match(String(options.body), /data:image\/png;base64/);
    return new Response('{"asset":{"id":"asset-1","url":"https://api.example.com/api/assets/public/asset-1"}}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
    globalThis.fetch = previousFetch;
  });

  const result = await handler(createEvent('/api/assets', {
    httpMethod: 'POST',
    headers: { cookie: 'ads_session=token', 'content-type': 'application/json' },
    body: '{"dataUrl":"data:image/png;base64,AAAA"}',
  }));
  assert.equal(result.statusCode, 201);
  assert.match(result.body, /asset-1/);
});

test('Netlify backend proxy preserves public image asset bytes', async (t) => {
  const previousOrigin = process.env.API_ORIGIN;
  const previousFetch = globalThis.fetch;
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  process.env.API_ORIGIN = 'https://api.example.com';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.example.com/api/assets/public/asset-1');
    assert.equal(options.method, 'GET');
    return new Response(imageBytes, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
    globalThis.fetch = previousFetch;
  });

  const result = await handler(createEvent('/api/assets/public/asset-1'));
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-type'], 'image/png');
  assert.equal(result.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(result.body, 'base64'), imageBytes);
});

test('Netlify backend proxy forwards private API and payment routes', async (t) => {
  const previousOrigin = process.env.API_ORIGIN;
  const previousFetch = globalThis.fetch;
  const targets = [];
  process.env.API_ORIGIN = 'https://api.example.com';
  globalThis.fetch = async (url) => {
    targets.push(String(url));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
    globalThis.fetch = previousFetch;
  });
  assert.equal((await handler(createEvent('/api/user-api-configs'))).statusCode, 200);
  assert.equal((await handler(createEvent('/api/user-ai/config-1/v1/models'))).statusCode, 200);
  assert.equal((await handler(createEvent('/api/payments/providers'))).statusCode, 200);
  assert.equal((await handler(createEvent('/api/health'))).statusCode, 200);
  assert.deepEqual(targets, [
    'https://api.example.com/api/user-api-configs',
    'https://api.example.com/api/user-ai/config-1/v1/models',
    'https://api.example.com/api/payments/providers',
    'https://api.example.com/api/health',
  ]);
});
