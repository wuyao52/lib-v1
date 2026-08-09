import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';
import { decryptWechatResource, signAlipayParams } from '../payments.js';

test('signed Alipay callback credits once and rejects forged or amount-mismatched callbacks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-payments-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const codes = new Map();
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
    paymentConfig: {
      alipay: { appId: 'test-app-id', privateKey, publicKey, sellerId: 'seller-1', notifyUrl: 'https://backend.example/api/payments/callback/alipay', returnUrl: 'https://frontend.example/payment-return', gateway: 'https://openapi.alipay.test/gateway.do' },
      wechat: {},
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const email = 'payer@example.com';
  await fetch(`${baseUrl}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
  const registration = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'payer', email, name: 'Payer', password: 'strong-password', verificationCode: codes.get(email) }) });
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const user = (await registration.json()).user;

  const providerStatus = await (await fetch(`${baseUrl}/api/payments/providers`, { headers: { cookie } })).json();
  assert.deepEqual(providerStatus.providers, { alipay: true, wechat: false });
  const createdResponse = await fetch(`${baseUrl}/api/payments/orders`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'alipay', amountCents: 500 }) });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).order;
  assert.match(created.payUrl, /^https:\/\/openapi\.alipay\.test\/gateway\.do\?/);
  const storedOrder = db.read('paymentOrders').find((item) => item.id === created.id);
  const callback = { app_id: 'test-app-id', seller_id: 'seller-1', trade_status: 'TRADE_SUCCESS', out_trade_no: storedOrder.merchantOrderNo, trade_no: 'ali-trade-100', notify_id: 'ali-notify-100', total_amount: '5.00', sign_type: 'RSA2' };
  const postCallback = (values) => fetch(`${baseUrl}/api/payments/callback/alipay`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });

  const forged = await postCallback({ ...callback, sign: Buffer.from('forged').toString('base64') });
  assert.equal(forged.status, 400);
  assert.equal(db.read('users').find((item) => item.id === user.id).balanceCents, 0);

  const mismatched = { ...callback, notify_id: 'ali-notify-wrong-amount', total_amount: '6.00' };
  mismatched.sign = signAlipayParams(mismatched, privateKey);
  assert.equal((await postCallback(mismatched)).status, 400);
  assert.equal(db.read('users').find((item) => item.id === user.id).balanceCents, 0);

  callback.sign = signAlipayParams(callback, privateKey);
  assert.equal(await (await postCallback(callback)).text(), 'success');
  assert.equal(await (await postCallback(callback)).text(), 'success');
  assert.equal(db.read('users').find((item) => item.id === user.id).balanceCents, 500);
  assert.equal(db.read('balanceTransactions').filter((item) => item.referenceId === storedOrder.id).length, 1);
  assert.equal(db.read('paymentEvents').filter((item) => item.orderId === storedOrder.id).length, 1);
  await db.mutate((data) => { data.users.find((item) => item.id === user.id).role = 'system'; });
  const reconciliation = await (await fetch(`${baseUrl}/api/admin/payment-reconciliation`, { headers: { cookie } })).json();
  assert.equal(reconciliation.ok, true);
  assert.deepEqual(reconciliation.paidWithoutCredit, []);
});

test('WeChat API v3 resource decryption authenticates ciphertext', () => {
  const apiV3Key = '12345678901234567890123456789012';
  const nonceText = randomBytes(6).toString('hex');
  const nonce = Buffer.from(nonceText);
  const associatedData = 'transaction';
  const plaintext = JSON.stringify({ out_trade_no: 'ADS100', trade_state: 'SUCCESS', amount: { total: 500 } });
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), nonce);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const resource = { ciphertext, nonce: nonceText, associated_data: associatedData };
  assert.equal(decryptWechatResource(resource, apiV3Key).amount.total, 500);
  assert.throws(() => decryptWechatResource({ ...resource, associated_data: 'tampered' }, apiV3Key));
});
