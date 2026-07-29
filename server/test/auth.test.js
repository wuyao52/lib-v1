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
    body: JSON.stringify({ name: 'Director', email, password: 'correct-horse', verificationCode: '000000' }),
  });
  assert.equal(wrongCode.status, 400);

  const registration = await fetch(`${context.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Director', email, password: 'correct-horse', verificationCode: registrationCode }),
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
    body: JSON.stringify({ email, password: 'correct-horse', captchaId: expiredCaptchaId, captchaCode: '24682' }),
  });
  assert.equal(expiredLogin.status, 400);

  const wrongCaptchaId = await requestCaptcha(context);
  const wrongCaptcha = await fetch(`${context.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse', captchaId: wrongCaptchaId, captchaCode: '22222' }),
  });
  assert.equal(wrongCaptcha.status, 400);

  const invalidLoginCaptchaId = await requestCaptcha(context);
  const invalidLogin = await fetch(`${context.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrong-pass', captchaId: invalidLoginCaptchaId, captchaCode: '24682' }),
  });
  assert.equal(invalidLogin.status, 401);

  const loginCaptchaId = await requestCaptcha(context);
  const validLogin = await fetch(`${context.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse', captchaId: loginCaptchaId, captchaCode: '24682' }),
  });
  assert.equal(validLogin.status, 200);
  const loginCookie = validLogin.headers.get('set-cookie').split(';')[0];
  await fetch(`${context.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: loginCookie } });

  const reusedCode = await fetch(`${context.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse', captchaId: loginCaptchaId, captchaCode: '24682' }),
  });
  assert.equal(reusedCode.status, 400);
  assert.equal(context.sentCodes.length, sentEmailCountAfterRegistration);

  const database = JSON.parse(await readFile(context.databasePath, 'utf8'));
  assert.ok(database.users[0].passwordHash.includes(':'));
  assert.equal('password' in database.users[0], false);
  assert.ok(database.emailVerifications.every((record) => !('code' in record)));
  assert.ok(database.imageCaptchas.every((record) => !('code' in record)));
  assert.equal(database.sessions.length, 0);
});
