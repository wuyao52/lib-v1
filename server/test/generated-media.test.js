import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';
import { createGeneratedMediaService } from '../generated-media.js';

test('generated videos are archived to owned storage and served privately with ranges', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-generated-media-'));
  const codes = new Map();
  const objects = new Map();
  const videoBytes = Buffer.from('0123456789-video-bytes');
  let requestedRange = null;
  const storage = {
    provider: 'r2',
    async put({ key, bytes, mimeType }) { objects.set(key, { bytes: Buffer.from(bytes), mimeType }); },
    async get(key) { return objects.get(key).bytes; },
    async read(key, range) {
      requestedRange = range;
      const object = objects.get(key);
      const match = String(range || '').match(/^bytes=(\d+)-(\d*)$/);
      if (!match) return { bytes: object.bytes, contentLength: object.bytes.length, contentType: object.mimeType };
      const start = Number(match[1]);
      const end = Math.min(match[2] ? Number(match[2]) : object.bytes.length - 1, object.bytes.length - 1);
      return { bytes: object.bytes.subarray(start, end + 1), contentLength: end - start + 1, contentRange: `bytes ${start}-${end}/${object.bytes.length}`, contentType: object.mimeType };
    },
    async createDownloadUrl({ key }) { return `https://oss.example/play/${encodeURIComponent(key)}`; },
    async delete(key) { objects.delete(key); },
  };
  const fetchImpl = async () => new Response(videoBytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(videoBytes.length) } });
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    assetStorage: storage, fetchImpl, sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const email = 'archive@example.com';
  await fetch(`${baseUrl}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
  const registration = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'archive-user', name: 'Archive User', email, password: 'strong-password', verificationCode: codes.get(email) }) });
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const user = (await registration.json()).user;

  const service = createGeneratedMediaService({ db, storage, fetchImpl, resolveHost: async () => [{ address: '203.0.113.10', family: 4 }] });
  const archived = await service.archive({ id: 'job-archive', userId: user.id }, { url: 'https://provider.example/result.mp4' });
  assert.match(archived.url, /^\/api\/generated-media\/[0-9a-f-]+$/);
  assert.equal(objects.size, 1);
  assert.equal(db.read('generatedMedia').length, 1);

  const playback = await fetch(`${baseUrl}${archived.url}/playback-url`, { headers: { cookie } });
  assert.equal(playback.status, 200);
  assert.match((await playback.json()).url, /^https:\/\/oss\.example\/play\//);

  assert.equal((await fetch(`${baseUrl}${archived.url}`)).status, 401);
  const partial = await fetch(`${baseUrl}${archived.url}`, { headers: { cookie, range: 'bytes=1-3' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 1-3/${videoBytes.length}`);
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), '123');
  const openEnded = await fetch(`${baseUrl}${archived.url}`, { headers: { cookie, range: 'bytes=0-' } });
  assert.equal(openEnded.status, 206);
  assert.equal(requestedRange, 'bytes=0-1048575');
  assert.equal(openEnded.headers.get('content-range'), `bytes 0-${videoBytes.length - 1}/${videoBytes.length}`);
});

test('generated-media archive forwards provider authentication only to the server-side download', async () => {
  const seen = [];
  const bytes = Buffer.from('authenticated-video');
  const service = createGeneratedMediaService({
    db: { read: () => [], mutate: async () => {} },
    storage: { async put({ bytes: value }) { assert.deepEqual(Buffer.from(value), bytes); } },
    fetchImpl: async (_url, options) => {
      seen.push(options.headers?.get('authorization'));
      return new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } });
    },
    resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
  });
  await service.archive(
    { id: 'auth-job', userId: 'user-1' },
    { url: 'https://www.weijinapi.top/v1/videos/task-auth/content' },
    { headers: { authorization: 'Bearer server-only-secret' } },
  );
  assert.deepEqual(seen, ['Bearer server-only-secret']);
});

test('non-streaming storage rejects a declared large video before buffering it', async () => {
  let stored = false;
  const storage = {
    async put() { stored = true; },
  };
  const db = {
    read: () => [],
    mutate: async () => {},
  };
  const service = createGeneratedMediaService({
    db,
    storage,
    fetchImpl: async () => new Response('not-read', {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(33 * 1024 * 1024) },
    }),
    resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
  });

  await assert.rejects(
    () => service.archive({ id: 'large-job', userId: 'user-1' }, { url: 'https://provider.example/large.mp4' }),
    /storage does not support streaming|不支持流式/i,
  );
  assert.equal(stored, false);
});

test('generated-media archive rejects a private provider result URL before downloading', async () => {
  let fetched = false;
  const service = createGeneratedMediaService({
    db: { read: () => [] },
    storage: { putStream: async () => {} },
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  });

  await assert.rejects(
    () => service.archive({ id: 'ssrf-job', userId: 'user-1' }, { url: 'https://video-result.example/private.mp4' }),
    /private|public|内网|公网/i,
  );
  assert.equal(fetched, false);
});

test('non-streaming storage stops a body that exceeds a forged small content length', async () => {
  let stored = false;
  const firstChunk = new Uint8Array(20 * 1024 * 1024);
  const secondChunk = new Uint8Array(20 * 1024 * 1024);
  const body = new ReadableStream({
    start(controller) { controller.enqueue(firstChunk); controller.enqueue(secondChunk); controller.close(); },
  });
  const service = createGeneratedMediaService({
    db: { read: () => [] },
    storage: { async put() { stored = true; } },
    fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '1024' } }),
    resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
  });

  await assert.rejects(
    () => service.archive({ id: 'forged-size-job', userId: 'user-1' }, { url: 'https://provider.example/forged.mp4' }),
    /too large|超过大小限制|超过大小/i,
  );
  assert.equal(stored, false);
});

test('streaming storage stops actual bytes beyond the configured limit and removes partial output', async (t) => {
  const previous = process.env.GENERATED_VIDEO_MAX_BYTES;
  process.env.GENERATED_VIDEO_MAX_BYTES = '10';
  t.after(() => { if (previous === undefined) delete process.env.GENERATED_VIDEO_MAX_BYTES; else process.env.GENERATED_VIDEO_MAX_BYTES = previous; });
  let deleted = false;
  const service = createGeneratedMediaService({
    db: { read: () => [], mutate: async () => {} },
    storage: {
      async putStream({ body }) {
        const reader = body.getReader();
        while (!(await reader.read()).done) { /* consume to exercise the limiter */ }
      },
      async delete() { deleted = true; },
    },
    fetchImpl: async () => new Response(new Uint8Array(20), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '5' } }),
    resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
  });
  await assert.rejects(
    () => service.archive({ id: 'stream-limit-job', userId: 'user-1' }, { url: 'https://provider.example/stream.mp4' }),
    /超过平台归档大小限制/,
  );
  assert.equal(deleted, true);
});
