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
  const storage = {
    provider: 'r2',
    async put({ key, bytes, mimeType }) { objects.set(key, { bytes: Buffer.from(bytes), mimeType }); },
    async get(key) { return objects.get(key).bytes; },
    async read(key, range) {
      const object = objects.get(key);
      const match = String(range || '').match(/^bytes=(\d+)-(\d*)$/);
      if (!match) return { bytes: object.bytes, contentLength: object.bytes.length, contentType: object.mimeType };
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : object.bytes.length - 1;
      return { bytes: object.bytes.subarray(start, end + 1), contentLength: end - start + 1, contentRange: `bytes ${start}-${end}/${object.bytes.length}`, contentType: object.mimeType };
    },
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

  const service = createGeneratedMediaService({ db, storage, fetchImpl });
  const archived = await service.archive({ id: 'job-archive', userId: user.id }, { url: 'https://provider.example/result.mp4' });
  assert.match(archived.url, /^\/api\/generated-media\/[0-9a-f-]+$/);
  assert.equal(objects.size, 1);
  assert.equal(db.read('generatedMedia').length, 1);

  assert.equal((await fetch(`${baseUrl}${archived.url}`)).status, 401);
  const partial = await fetch(`${baseUrl}${archived.url}`, { headers: { cookie, range: 'bytes=1-3' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 1-3/${videoBytes.length}`);
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), '123');
});
