import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';

async function startServer() {
  const directory = await mkdtemp(join(tmpdir(), 'ads-auth-'));
  const databasePath = join(directory, 'database.json');
  const sentCodes = [];
  const { app, db } = await createApp({
    databasePath,
    secureCookies: false,
    sendEmailCode: async (message) => sentCodes.push(message),
    generateImageCaptcha: () => ({ text: '24682', data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  return { server, databasePath, sentCodes, db, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function requestCode(context, email, purpose) {
  const response = await fetch(`${context.baseUrl}/api/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, purpose }),
  });
  assert.equal(response.status, 202);
  return context.sentCodes.at(-1).code;
}

async function requestCaptcha(context) {
  const response = await fetch(`${context.baseUrl}/api/auth/captcha`);
  assert.equal(response.status, 200);
  const captcha = await response.json();
  assert.match(captcha.image, /^data:image\/svg\+xml;base64,/);
  return captcha.captchaId;
}

test('registration uses email codes and login uses one-time image captchas', async (t) => {
  const context = await startServer();
  t.after(() => context.server.close());
  const email = 'director@example.com';
  const registrationCode = await requestCode(context, email, 'register');
  const cooldownResponse = await fetch(`${context.baseUrl}/api/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, purpose: 'register' }),
  });
  assert.equal(cooldownResponse.status, 429);
  assert.ok(Number(cooldownResponse.headers.get('retry-after')) > 0);

  const wrongCode = await fetch(`${context.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Director', username: 'director', email, password: 'correct-horse', verificationCode: '000000' }),
  });
  assert.equal(wrongCode.status, 400);

  const registration = await fetch(`${context.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Director', username: 'director', email, password: 'correct-horse', verificationCode: registrationCode }),
  });
  assert.equal(registration.status, 201);
  await requestCode(context, 'another-director@example.com', 'register');
  assert.deepEqual(context.sentCodes.map((message) => message.email), [email, 'another-director@example.com']);
  const cookie = registration.headers.get('set-cookie').split(';')[0];

  const me = await fetch(`${context.baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal((await me.json()).user.email, email);
  await fetch(`${context.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });

  const sentEmailCountAfterRegistration = context.sentCodes.length;
  const expiredCaptchaId = await requestCaptcha(context);
  await context.db.mutate((data) => {
    const record = data.imageCaptchas.find((item) => item.id === expiredCaptchaId);
    record.expiresAt = Date.now() - 1;
  });
  const expiredLogin = await fetch(`${context.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'director', password: 'correct-horse', captchaId: expiredCaptchaId, captchaCode: '24682' }),
  });
  assert.equal(expiredLogin.status, 400);

  const wrongCaptchaId = await requestCaptcha(context);
  const wrongCaptcha = await fetch(`${context.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'director', password: 'correct-horse', captchaId: wrongCaptchaId, captchaCode: '22222' }),
  });
  assert.equal(wrongCaptcha.status, 400);

  const invalidLoginCaptchaId = await requestCaptcha(context);
  const invalidLogin = await fetch(`${context.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'director', password: 'wrong-pass', captchaId: invalidLoginCaptchaId, captchaCode: '24682' }),
  });
  assert.equal(invalidLogin.status, 401);

  const loginCaptchaId = await requestCaptcha(context);
  const validLogin = await fetch(`${context.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'director', password: 'correct-horse', captchaId: loginCaptchaId, captchaCode: '24682' }),
  });
  assert.equal(validLogin.status, 200);
  const loginCookie = validLogin.headers.get('set-cookie').split(';')[0];
  await fetch(`${context.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: loginCookie } });

  const reusedCode = await fetch(`${context.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'director', password: 'correct-horse', captchaId: loginCaptchaId, captchaCode: '24682' }),
  });
  assert.equal(reusedCode.status, 400);
  assert.equal(context.sentCodes.length, sentEmailCountAfterRegistration);

  const database = JSON.parse(await readFile(context.databasePath, 'utf8'));
  assert.ok(database.users[0].passwordHash.includes(':'));
  assert.equal(database.users[0].username, 'director');
  assert.equal('password' in database.users[0], false);
  assert.ok(database.emailVerifications.every((record) => !('code' in record)));
  assert.ok(database.imageCaptchas.every((record) => !('code' in record)));
  assert.equal(database.sessions.length, 0);
});

test('users can change passwords and reset them by email, invalidating old sessions', async (t) => {
  const context = await startServer();
  t.after(() => context.server.close());
  const email = 'password@example.com';
  const code = await requestCode(context, email, 'register');
  const registration = await fetch(`${context.baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Password User', username: 'password-user', email, password: 'old-password', verificationCode: code }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie').split(';')[0];

  const changed = await fetch(`${context.baseUrl}/api/auth/change-password`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'changed-password', confirmPassword: 'changed-password' }) });
  assert.equal(changed.status, 200);
  const wrongCurrent = await fetch(`${context.baseUrl}/api/auth/change-password`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'another-password', confirmPassword: 'another-password' }) });
  assert.equal(wrongCurrent.status, 401);

  const resetCode = await requestCode(context, email, 'reset_password');
  const reset = await fetch(`${context.baseUrl}/api/auth/reset-password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, verificationCode: resetCode, newPassword: 'reset-password', confirmPassword: 'reset-password' }) });
  assert.equal(reset.status, 200);
  const oldSession = await fetch(`${context.baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal((await oldSession.json()).user, null);

  const captchaResponse = await fetch(`${context.baseUrl}/api/auth/captcha`);
  const captcha = await captchaResponse.json();
  const login = await fetch(`${context.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password: 'reset-password', captchaId: captcha.captchaId, captchaCode: '24682' }) });
  assert.equal(login.status, 200);
});

test('registration needs no nickname and usernames are unique case-insensitively', async (t) => {
  const context = await startServer();
  t.after(() => context.server.close());
  const firstEmail = 'unique-first@example.com';
  const secondEmail = 'unique-second@example.com';
  const firstCode = await requestCode(context, firstEmail, 'register');
  const secondCode = await requestCode(context, secondEmail, 'register');
  const register = (username, email, verificationCode) => fetch(`${context.baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, email, password: 'strong-password', verificationCode }),
  });
  const [first, second] = await Promise.all([
    register('UniqueUser', firstEmail, firstCode),
    register('uniqueuser', secondEmail, secondCode),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const successful = first.status === 201 ? await first.json() : await second.json();
  const conflict = first.status === 409 ? await first.json() : await second.json();
  assert.equal(successful.user.name, successful.user.username);
  assert.equal(conflict.error, 'USERNAME_EXISTS');
  assert.equal(context.db.read('users').filter((user) => user.username.toLowerCase() === 'uniqueuser').length, 1);
});

test('email-code endpoint limits rotating email addresses from one IP', async (t) => {
  const context = await startServer();
  t.after(() => context.server.close());
  const responses = await Promise.all(Array.from({ length: 7 }, (_, index) => fetch(`${context.baseUrl}/api/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `rotating-${index}@example.com`, purpose: 'register' }),
  })));
  assert.deepEqual(responses.slice(0, 6).map((response) => response.status), [202, 202, 202, 202, 202, 202]);
  assert.equal(responses[6].status, 429);
  assert.equal(context.sentCodes.length, 6);
});

test('security headers, origin protection and session cap are enforced', async (t) => {
  const context = await startServer();
  t.after(() => context.server.close());
  const health = await fetch(`${context.baseUrl}/api/health`, { headers: { 'x-request-id': '<script>alert(1)</script>' } });
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.match(health.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  const blocked = await fetch(`${context.baseUrl}/api/auth/login`, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(blocked.status, 403);

  const email = 'sessions@example.com';
  const code = await requestCode(context, email, 'register');
  const registered = await fetch(`${context.baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sessions', email, password: 'strong-password', verificationCode: code }) });
  assert.equal(registered.status, 201);
  for (let index = 0; index < 5; index += 1) {
    const captchaId = await requestCaptcha(context);
    const login = await fetch(`${context.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password: 'strong-password', captchaId, captchaCode: '24682' }) });
    assert.equal(login.status, 200);
  }
  assert.equal(context.db.read('sessions').filter((session) => session.userId === context.db.read('users')[0].id).length, 4);
});
