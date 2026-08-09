import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

async function listen(databasePath) {
  const { app } = await createApp({ databasePath, secureCookies: false, videoQueue: false, sendEmailCode: async () => {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('authentication rate limits survive a server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-rate-limit-'));
  const databasePath = join(directory, 'database.json');
  const first = await listen(databasePath);
  for (let index = 0; index < 12; index += 1) {
    assert.equal((await fetch(`${first.baseUrl}/api/auth/captcha`)).status, 200);
  }
  assert.equal((await fetch(`${first.baseUrl}/api/auth/captcha`)).status, 429);
  await new Promise((resolve) => first.server.close(resolve));

  const restarted = await listen(databasePath);
  try {
    const response = await fetch(`${restarted.baseUrl}/api/auth/captcha`);
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
  } finally {
    await new Promise((resolve) => restarted.server.close(resolve));
  }
});
