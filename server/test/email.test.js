import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailSenderFromEnv } from '../email.js';

test('email sender fails explicitly when production mail configuration is missing', async () => {
  const sender = createEmailSenderFromEnv({});
  await assert.rejects(
    sender({ email: 'user@example.com', code: '123456', purpose: 'register', expiresInMinutes: 10 }),
    (error) => error.code === 'EMAIL_NOT_CONFIGURED'
  );
});

test('Resend is preferred and receives the registration email over HTTPS', async () => {
  const requests = [];
  const sender = createEmailSenderFromEnv(
    {
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'AI Drama Studio <register@example.com>',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'smtp-user',
      SMTP_PASS: 'smtp-pass',
    },
    {
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200 };
      },
    },
  );

  await sender({ email: 'user@example.com', code: '123456', purpose: 'register', expiresInMinutes: 10 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer re_test_key');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    from: 'AI Drama Studio <register@example.com>',
    to: 'user@example.com',
    subject: 'AI Drama Studio 注册验证码',
    text: '你的注册验证码是 123456。验证码将在 10 分钟后失效，请勿转发给他人。',
    html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111827"><h2>AI Drama Studio</h2><p>你的注册验证码：</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">123456</p><p>验证码将在 10 分钟后失效，请勿转发给他人。</p></div>',
  });
});

test('Resend configuration and API failures return sanitized errors', async () => {
  const incompleteSender = createEmailSenderFromEnv({ RESEND_API_KEY: 're_test_key' });
  await assert.rejects(
    incompleteSender({ email: 'user@example.com', code: '123456', purpose: 'register', expiresInMinutes: 10 }),
    (error) => error.code === 'EMAIL_NOT_CONFIGURED' && !error.message.includes('re_test_key'),
  );

  const failingSender = createEmailSenderFromEnv(
    { RESEND_API_KEY: 're_secret_value', EMAIL_FROM: 'register@example.com' },
    { fetchImpl: async () => ({ ok: false, status: 401 }) },
  );
  await assert.rejects(
    failingSender({ email: 'user@example.com', code: '123456', purpose: 'register', expiresInMinutes: 10 }),
    (error) => error.code === 'EMAIL_DELIVERY_FAILED' && !error.message.includes('re_secret_value'),
  );
});
