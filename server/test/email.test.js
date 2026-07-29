import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailSenderFromEnv } from '../email.js';

test('SMTP sender fails explicitly when production mail configuration is missing', async () => {
  const sender = createEmailSenderFromEnv({});
  await assert.rejects(
    sender({ email: 'user@example.com', code: '123456', purpose: 'register', expiresInMinutes: 10 }),
    (error) => error.code === 'EMAIL_NOT_CONFIGURED'
  );
});
