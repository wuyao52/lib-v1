import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

test('generation history uses stable cursor pagination without duplicates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-history-page-'));
  const codes = new Map();
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const email = 'history-page@example.com';
  await fetch(`${baseUrl}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
  const registration = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'history-page', name: 'History Page', email, password: 'strong-password', verificationCode: codes.get(email) }) });
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const user = (await registration.json()).user;
  const managedImage = await fetch(`${baseUrl}/api/generation-history`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'image', prompt: 'managed image', url: '/api/assets/public/owned-image', thumbnail: '/api/assets/public/owned-image' }),
  });
  assert.equal(managedImage.status, 201);
  const managedImageItem = (await managedImage.json()).item;
  assert.equal(Date.parse(managedImageItem.expiresAt) - Date.parse(managedImageItem.createdAt), 3 * 24 * 60 * 60 * 1000);
  const imageOnly = await (await fetch(`${baseUrl}/api/generation-history?type=image&limit=10`, { headers: { cookie } })).json();
  assert.deepEqual(imageOnly.history.map((item) => item.id), [managedImageItem.id]);
  const arbitraryRelativeUrl = await fetch(`${baseUrl}/api/generation-history`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ url: '/untrusted/file.png' }),
  });
  assert.equal(arbitraryRelativeUrl.status, 400);
  const createdAt = new Date().toISOString();
  await db.mutate((data) => {
    data.generationHistory.push(...['a', 'b', 'c'].map((id) => ({ id, userId: user.id, projectId: '', nodeId: null, type: 'video', prompt: id, url: `https://cdn.example/${id}.mp4`, thumbnail: null, createdAt, expiresAt: new Date(Date.now() + 60000).toISOString() })));
  });

  const first = await (await fetch(`${baseUrl}/api/generation-history?limit=2`, { headers: { cookie } })).json();
  assert.equal(first.history.length, 2);
  assert.ok(first.nextCursor);
  const second = await (await fetch(`${baseUrl}/api/generation-history?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, { headers: { cookie } })).json();
  assert.equal(second.history.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.history, ...second.history].map((item) => item.id)).size, 4);
});
