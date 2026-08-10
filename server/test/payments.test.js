import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, generateKeyPairSync, randomBytes, sign as rsaSign } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';
import { decryptWechatResource, signAlipayParams } from '../payments.js';

test('signed Alipay payment and refund execute once while forged callbacks are rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-payments-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const codes = new Map();
  const fetchImpl = async (_url, options) => {
    assert.equal(options.method, 'POST');
    const refundResponse = { code: '10000', msg: 'Success', refund_fee: '5.00', trade_no: 'ali-trade-100' };
    const signedContent = JSON.stringify(refundResponse);
    return new Response(JSON.stringify({ alipay_trade_refund_response: refundResponse, sign: rsaSign('RSA-SHA256', Buffer.from(signedContent), privateKey).toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
    fetchImpl,
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
  const deniedRefund = await fetch(`${baseUrl}/api/payments/admin/orders/${storedOrder.id}/refund`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'incorrect-password' }) });
  assert.equal(deniedRefund.status, 401);
  assert.equal(db.read('paymentOrders').find((item) => item.id === storedOrder.id).status, 'paid');
  const refund = await fetch(`${baseUrl}/api/payments/admin/orders/${storedOrder.id}/refund`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'strong-password' }) });
  assert.equal(refund.status, 200);
  assert.equal((await refund.json()).order.status, 'refunded');
  assert.equal(db.read('users').find((item) => item.id === user.id).balanceCents, 0);
  assert.equal(db.read('balanceTransactions').filter((item) => item.type === 'payment_refund' && item.referenceId === storedOrder.id).length, 1);
  assert.equal((await fetch(`${baseUrl}/api/payments/admin/orders/${storedOrder.id}/refund`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'strong-password' }) })).status, 409);
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

test('WeChat H5 payment settles only a verified callback and completes an asynchronous refund', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-wechat-payment-'));
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const platform = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const apiV3Key = '12345678901234567890123456789012'; const codes = new Map(); const requests = [];
  const encrypt = (payload, associatedData) => { const nonceText = randomBytes(6).toString('hex'); const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonceText)); cipher.setAAD(Buffer.from(associatedData)); return { ciphertext: Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]).toString('base64'), nonce: nonceText, associated_data: associatedData }; };
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
    fetchImpl: async (url, options) => { requests.push({ url: String(url), options }); return new Response(JSON.stringify(String(url).includes('/refunds') ? { status: 'PROCESSING', refund_id: 'wechat-refund-1' } : { h5_url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx-prepay' }), { status: 200, headers: { 'content-type': 'application/json' } }); },
    paymentConfig: { alipay: {}, wechat: { appId: 'wx-app', mchId: 'mch-1', serialNo: 'merchant-cert-1', platformSerialNo: 'platform-cert-1', privateKey: merchant.privateKey, platformCertificate: platform.publicKey, apiV3Key, notifyUrl: 'https://backend.example/api/payments/callback/wechat', refundNotifyUrl: 'https://backend.example/api/payments/callback/wechat-refund' } },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`; const email = 'wechat-payer@example.com';
  await fetch(`${baseUrl}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
  const registration = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'wechat-payer', email, password: 'wechat-payment-password', verificationCode: codes.get(email) }) });
  const cookie = registration.headers.get('set-cookie').split(';')[0]; const user = (await registration.json()).user;
  const created = await (await fetch(`${baseUrl}/api/payments/orders`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'wechat', amountCents: 500 }) })).json();
  assert.match(created.order.payUrl, /^https:\/\/wx\.tenpay\.com/); assert.match(requests[0].options.headers.authorization, /^WECHATPAY2-SHA256-RSA2048 /);
  const order = db.read('paymentOrders').find((item) => item.id === created.order.id);
  const postNotice = async (pathOrPayload, payloadOrEvent, eventType = 'TRANSACTION.SUCCESS') => { const path = typeof pathOrPayload === 'string' ? pathOrPayload : '/api/payments/callback/wechat'; const payload = typeof pathOrPayload === 'string' ? payloadOrEvent : pathOrPayload; const actualEvent = typeof pathOrPayload === 'string' ? eventType : 'TRANSACTION.SUCCESS'; const raw = JSON.stringify({ id: `event-${actualEvent}`, event_type: actualEvent, resource: encrypt(payload, 'transaction') }); const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = 'callback-nonce'; const signature = rsaSign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), platform.privateKey).toString('base64'); return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': 'platform-cert-1', 'wechatpay-signature': signature }, body: raw }); };
  const forged = await fetch(`${baseUrl}/api/payments/callback/wechat`, { method: 'POST', headers: { 'content-type': 'application/json', 'wechatpay-timestamp': String(Math.floor(Date.now() / 1000)), 'wechatpay-nonce': 'x', 'wechatpay-serial': 'platform-cert-1', 'wechatpay-signature': 'forged' }, body: '{}' });
  assert.equal(forged.status, 401);
  assert.equal((await postNotice({ out_trade_no: order.merchantOrderNo, transaction_id: 'wechat-trade-1', trade_state: 'SUCCESS', appid: 'wx-app', mchid: 'mch-1', amount: { total: 500 } })).status, 200);
  assert.equal((await postNotice({ out_trade_no: order.merchantOrderNo, transaction_id: 'wechat-trade-1', trade_state: 'SUCCESS', appid: 'wx-app', mchid: 'mch-1', amount: { total: 500 } })).status, 200);
  assert.equal(db.read('users').find((item) => item.id === user.id).balanceCents, 500);
  await db.mutate((data) => { data.users.find((item) => item.id === user.id).role = 'system'; });
  assert.equal((await fetch(`${baseUrl}/api/payments/admin/orders/${order.id}/refund`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'wechat-payment-password' }) })).status, 200);
  assert.equal(db.read('paymentOrders').find((item) => item.id === order.id).status, 'refunding');
  const refund = await postNotice('/api/payments/callback/wechat-refund', { out_refund_no: `R${order.merchantOrderNo}`, refund_status: 'SUCCESS', amount: { refund: 500, total: 500 } }, 'REFUND.SUCCESS');
  assert.equal(refund.status, 200);
  assert.equal(db.read('paymentOrders').find((item) => item.id === order.id).status, 'refunded');
  assert.equal(db.read('users').find((item) => item.id === user.id).balanceCents, 0);
});
