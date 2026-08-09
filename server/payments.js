import { createDecipheriv, createHash, randomBytes, randomUUID, sign as rsaSign, verify as rsaVerify } from 'node:crypto';

const nowIso = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pem = (value) => String(value || '').replace(/\\n/g, '\n').trim();
const orderNumber = () => `ADS${Date.now()}${randomBytes(5).toString('hex').toUpperCase()}`;

function canonicalParams(params) {
  return Object.entries(params).filter(([key, value]) => key !== 'sign' && key !== 'sign_type' && value !== undefined && value !== '')
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
}

export function signAlipayParams(params, privateKey) {
  return rsaSign('RSA-SHA256', Buffer.from(canonicalParams(params), 'utf8'), pem(privateKey)).toString('base64');
}

export function verifyAlipayNotification(params, publicKey) {
  if (!params?.sign) return false;
  return rsaVerify('RSA-SHA256', Buffer.from(canonicalParams(params), 'utf8'), pem(publicKey), Buffer.from(String(params.sign), 'base64'));
}

function chinaTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date).replace('T', ' ');
}

function createAlipayProvider(config) {
  const gateway = config.gateway || 'https://openapi.alipay.com/gateway.do';
  return {
    enabled: Boolean(config.appId && config.privateKey && config.publicKey && config.notifyUrl && config.returnUrl),
    async create(order) {
      const params = {
        app_id: config.appId, method: 'alipay.trade.page.pay', format: 'JSON', charset: 'utf-8', sign_type: 'RSA2',
        timestamp: chinaTimestamp(), version: '1.0', notify_url: config.notifyUrl, return_url: config.returnUrl,
        biz_content: JSON.stringify({ out_trade_no: order.merchantOrderNo, total_amount: (order.amountCents / 100).toFixed(2), subject: 'AI Drama Studio 余额充值', product_code: 'FAST_INSTANT_TRADE_PAY' }),
      };
      params.sign = signAlipayParams(params, config.privateKey);
      return `${gateway}?${new URLSearchParams(params).toString()}`;
    },
    verify(params) {
      if (!verifyAlipayNotification(params, config.publicKey)) throw new Error('支付宝回调签名无效');
      if (String(params.app_id) !== String(config.appId)) throw new Error('支付宝应用 ID 不匹配');
      if (config.sellerId && String(params.seller_id) !== String(config.sellerId)) throw new Error('支付宝收款账号不匹配');
      if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(params.trade_status))) throw new Error('支付宝交易尚未成功');
      return { merchantOrderNo: String(params.out_trade_no), providerTradeNo: String(params.trade_no), amountCents: Math.round(Number(params.total_amount) * 100), eventId: String(params.notify_id || params.trade_no), payloadHash: sha256(canonicalParams(params)) };
    },
  };
}

function wechatAuthorization({ method, path, body, mchId, serialNo, privateKey, timestamp = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('hex') }) {
  const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = rsaSign('RSA-SHA256', Buffer.from(message), pem(privateKey)).toString('base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${serialNo}",signature="${signature}"`;
}

export function decryptWechatResource(resource, apiV3Key) {
  const bytes = Buffer.from(String(resource.ciphertext), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(String(apiV3Key), 'utf8'), Buffer.from(String(resource.nonce), 'utf8'));
  decipher.setAAD(Buffer.from(String(resource.associated_data || ''), 'utf8'));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString('utf8'));
}

function createWechatProvider(config, fetchImpl) {
  return {
    enabled: Boolean(config.appId && config.mchId && config.serialNo && config.privateKey && config.platformCertificate && config.apiV3Key?.length === 32 && config.notifyUrl),
    async create(order, clientIp) {
      const path = '/v3/pay/transactions/h5';
      const body = JSON.stringify({ appid: config.appId, mchid: config.mchId, description: 'AI Drama Studio 余额充值', out_trade_no: order.merchantOrderNo, notify_url: config.notifyUrl, amount: { total: order.amountCents, currency: 'CNY' }, scene_info: { payer_client_ip: clientIp || '127.0.0.1', h5_info: { type: 'Wap' } } });
      const response = await fetchImpl(`https://api.mch.weixin.qq.com${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: wechatAuthorization({ method: 'POST', path, body, mchId: config.mchId, serialNo: config.serialNo, privateKey: config.privateKey }) }, body });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.h5_url) throw new Error(result.message || `微信支付下单失败 (${response.status})`);
      return result.h5_url;
    },
    verify(rawBody, headers) {
      const timestamp = String(headers['wechatpay-timestamp'] || '');
      const nonce = String(headers['wechatpay-nonce'] || '');
      const signature = String(headers['wechatpay-signature'] || '');
      const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
      if (!signature || !rsaVerify('RSA-SHA256', Buffer.from(message), pem(config.platformCertificate), Buffer.from(signature, 'base64'))) throw new Error('微信支付回调签名无效');
      if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error('微信支付回调时间戳已过期');
      const notification = JSON.parse(rawBody);
      const transaction = decryptWechatResource(notification.resource, config.apiV3Key);
      if (transaction.trade_state !== 'SUCCESS' || transaction.appid !== config.appId || transaction.mchid !== config.mchId) throw new Error('微信支付交易信息无效');
      return { merchantOrderNo: String(transaction.out_trade_no), providerTradeNo: String(transaction.transaction_id), amountCents: Number(transaction.amount?.total), eventId: String(notification.id), payloadHash: sha256(rawBody) };
    },
  };
}

async function settlePaidOrder(db, provider, payment) {
  if (db.settlePaymentOrder) return db.settlePaymentOrder(provider, payment);
  let result = { found: false, credited: false, mismatch: false };
  await db.mutate((data) => {
    const order = data.paymentOrders.find((item) => item.provider === provider && item.merchantOrderNo === payment.merchantOrderNo);
    if (!order) return;
    result.found = true;
    if (Number(order.amountCents) !== Number(payment.amountCents)) { result.mismatch = true; return; }
    if (data.paymentEvents.some((item) => item.provider === provider && item.providerEventId === payment.eventId)) return;
    data.paymentEvents.push({ id: sha256(`${provider}:${payment.eventId}`), provider, providerEventId: payment.eventId, orderId: order.id, eventType: 'payment_succeeded', payloadHash: payment.payloadHash, createdAt: nowIso() });
    if (order.status === 'paid') return;
    if (order.status !== 'pending') return;
    const user = data.users.find((item) => item.id === order.userId);
    if (!user) return;
    order.status = 'paid'; order.providerTradeNo = payment.providerTradeNo; order.paidAt = nowIso();
    user.balanceCents = Number(user.balanceCents || 0) + Number(order.amountCents);
    data.balanceTransactions.push({ id: randomUUID(), userId: user.id, amountCents: Number(order.amountCents), type: 'payment_recharge', description: `${provider === 'alipay' ? '支付宝' : '微信支付'}充值`, referenceId: order.id, createdBy: null, createdAt: nowIso() });
    result.credited = true;
  });
  return result;
}

export function createPaymentService({ db, fetchImpl = fetch, env = process.env, config = null }) {
  const notifyBase = String(env.PAYMENT_NOTIFY_BASE_URL || '').replace(/\/+$/, '');
  const paymentConfig = config || {
    alipay: { appId: env.ALIPAY_APP_ID, privateKey: env.ALIPAY_PRIVATE_KEY, publicKey: env.ALIPAY_PUBLIC_KEY, sellerId: env.ALIPAY_SELLER_ID, notifyUrl: `${notifyBase}/api/payments/callback/alipay`, returnUrl: env.ALIPAY_RETURN_URL },
    wechat: { appId: env.WECHAT_PAY_APP_ID, mchId: env.WECHAT_PAY_MCH_ID, serialNo: env.WECHAT_PAY_SERIAL_NO, privateKey: env.WECHAT_PAY_PRIVATE_KEY, platformCertificate: env.WECHAT_PAY_PLATFORM_CERT, apiV3Key: env.WECHAT_PAY_API_V3_KEY, notifyUrl: `${notifyBase}/api/payments/callback/wechat` },
  };
  const providers = { alipay: createAlipayProvider(paymentConfig.alipay || {}), wechat: createWechatProvider(paymentConfig.wechat || {}, fetchImpl) };
  return { providers, settle: (provider, payment) => settlePaidOrder(db, provider, payment) };
}

function publicOrder(order) {
  return { id: order.id, provider: order.provider, amountCents: order.amountCents, status: order.status, payUrl: order.payUrl, createdAt: order.createdAt, expiresAt: order.expiresAt, paidAt: order.paidAt || null };
}

export function registerPaymentRoutes(router, { db, requireAuth, paymentService }) {
  router.post('/callback/alipay', async (req, res) => {
    try {
      const payment = paymentService.providers.alipay.verify(req.body || {});
      const result = await paymentService.settle('alipay', payment);
      if (!result.found || result.mismatch) return res.status(400).type('text/plain').send('failure');
      return res.type('text/plain').send('success');
    } catch { return res.status(400).type('text/plain').send('failure'); }
  });
  router.post('/callback/wechat', async (req, res) => {
    try {
      const payment = paymentService.providers.wechat.verify(String(req.rawBody || ''), req.headers);
      const result = await paymentService.settle('wechat', payment);
      if (!result.found || result.mismatch) return res.status(400).json({ code: 'FAIL', message: '订单校验失败' });
      return res.json({ code: 'SUCCESS', message: '成功' });
    } catch { return res.status(401).json({ code: 'FAIL', message: '签名或交易校验失败' }); }
  });
  router.get('/providers', requireAuth, (_req, res) => res.json({ providers: Object.fromEntries(Object.entries(paymentService.providers).map(([name, provider]) => [name, provider.enabled])) }));
  router.get('/orders', requireAuth, (req, res) => res.json({ orders: db.read('paymentOrders').filter((item) => item.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(publicOrder) }));
  router.post('/orders', requireAuth, async (req, res) => {
    const providerName = String(req.body?.provider || '');
    const provider = paymentService.providers[providerName];
    const amountCents = Number(req.body?.amountCents);
    if (!provider?.enabled) return res.status(503).json({ error: 'PAYMENT_PROVIDER_NOT_CONFIGURED', message: '该支付渠道尚未配置' });
    if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 10_000_000) return res.status(400).json({ error: 'INVALID_AMOUNT', message: '充值金额必须在 1-100000 元之间' });
    const createdAt = new Date();
    const order = { id: randomUUID(), userId: req.user.id, merchantOrderNo: orderNumber(), provider: providerName, amountCents, status: 'pending', providerTradeNo: null, payUrl: '', createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000).toISOString(), paidAt: null, refundedAt: null };
    await db.mutate((data) => data.paymentOrders.push(order));
    try {
      const payUrl = await provider.create(order, req.ip);
      await db.mutate((data) => {
        const stored = data.paymentOrders.find((item) => item.id === order.id);
        if (stored) stored.payUrl = payUrl;
      });
      order.payUrl = payUrl;
    } catch (error) {
      await db.mutate((data) => {
        const stored = data.paymentOrders.find((item) => item.id === order.id);
        if (stored) stored.status = 'failed';
      });
      return res.status(502).json({ error: 'PAYMENT_CREATE_FAILED', message: error.message });
    }
    return res.status(201).json({ order: publicOrder(order) });
  });
}
