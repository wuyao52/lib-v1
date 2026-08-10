import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

test('repeated admin balance requests with the same idempotency key adjust funds exactly once', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-abuse-balance-')); const codes = new Map();
  const { app, db } = await createApp({ databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false, monitoring: false, sendEmailCode: async ({ email, code }) => codes.set(email, code) });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => { const email = `${username}@example.com`; await fetch(`${origin}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) }); const response = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, password: 'abuse-resilience-password', verificationCode: codes.get(email) }) }); return { user: (await response.json()).user, cookie: response.headers.get('set-cookie').split(';')[0] }; };
  const admin = await register('abuse-admin'); const target = await register('abuse-target');
  await db.mutate((data) => { data.users.find((user) => user.id === admin.user.id).role = 'system'; });
  const request = () => fetch(`${origin}/api/admin/users/${target.user.id}/balance`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json', 'idempotency-key': 'balance-click-storm-key-0001' }, body: JSON.stringify({ amountCents: 250, description: 'click storm proof' }) });
  const responses = await Promise.all(Array.from({ length: 12 }, request));
  assert.equal(responses.every((response) => response.status === 200), true);
  assert.equal(db.read('users').find((user) => user.id === target.user.id).balanceCents, 250);
  assert.equal(db.read('balanceTransactions').filter((item) => item.userId === target.user.id && item.type === 'admin_adjustment').length, 1);
  const invalidKey = await fetch(`${origin}/api/admin/users/${target.user.id}/balance`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json', 'idempotency-key': 'bad' }, body: JSON.stringify({ amountCents: 100 }) });
  assert.equal(invalidKey.status, 400);
});
