import { randomUUID } from 'node:crypto';

const nowIso = () => new Date().toISOString();

function computeCharge(pricing, body) {
  const requiresDuration = pricing.category === 'video' || pricing.billingUnit === 'second';
  if (!requiresDuration) return Number(pricing.unitPriceCents);
  const seconds = Number(body?.duration ?? body?.seconds ?? body?.settings?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
    const error = new Error('按秒计费的模型请求必须提供 0-3600 范围内的 duration');
    error.code = 'INVALID_DURATION';
    throw error;
  }
  const allowed = Array.isArray(pricing.allowedDurationsSec) ? pricing.allowedDurationsSec.map(Number).filter(Number.isFinite) : [];
  if ((pricing.minDurationSec && seconds < Number(pricing.minDurationSec)) || (pricing.maxDurationSec && seconds > Number(pricing.maxDurationSec)) || (allowed.length > 0 && !allowed.includes(seconds))) {
    const error = new Error(allowed.length ? `该模型仅支持 ${allowed.join('、')} 秒` : `该模型支持 ${pricing.minDurationSec || 1}-${pricing.maxDurationSec || 3600} 秒`);
    error.code = 'INVALID_DURATION';
    throw error;
  }
  return pricing.billingUnit === 'second' ? Math.ceil(seconds * Number(pricing.unitPriceCents)) : Number(pricing.unitPriceCents);
}

function buildTarget(api, requestUrl) {
  const base = new URL(`${api.baseUrl.replace(/\/+$/, '')}/`);
  const suffix = String(requestUrl || '/').replace(/^\/+/, '');
  const target = new URL(suffix, base);
  const expectedPath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if (target.protocol !== 'https:' || target.origin !== base.origin || !target.pathname.startsWith(expectedPath)) {
    const error = new Error('请求路径不被允许'); error.code = 'INVALID_UPSTREAM_PATH'; throw error;
  }
  return target;
}

async function changeBalance(db, { userId, amountCents, type, description, referenceId }) {
  let balance; let failure;
  await db.mutate((data) => {
    const user = data.users.find((item) => item.id === userId);
    if (!user) { failure = 'USER_NOT_FOUND'; return; }
    const next = Number(user.balanceCents || 0) + amountCents;
    if (next < 0) { failure = 'INSUFFICIENT_BALANCE'; return; }
    user.balanceCents = next; balance = next;
    data.balanceTransactions.push({ id: randomUUID(), userId, amountCents, type, description, referenceId, createdBy: null, createdAt: nowIso() });
  });
  if (failure) { const error = new Error(failure === 'INSUFFICIENT_BALANCE' ? '余额不足，请先充值' : '用户不存在'); error.code = failure; throw error; }
  return balance;
}

export function registerSystemAiRoutes(router, { db, requireAuth, vault, fetchImpl = fetch }) {
  router.use(requireAuth);
  router.use('/:apiId', async (req, res, next) => {
    const api = db.read('systemApis').find((item) => item.id === req.params.apiId && item.enabled);
    if (!api) return res.status(404).json({ error: 'API_NOT_FOUND', message: '系统 API 不存在或已停用' });

    const relativeUrl = req.originalUrl.slice(req.originalUrl.indexOf(`/api/system-ai/${api.id}`) + `/api/system-ai/${api.id}`.length) || '/';
    const pathname = relativeUrl.split('?')[0].replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && pathname === '/v1/models') {
      const data = db.read('modelPricing').filter((item) => item.apiId === api.id && item.enabled)
        .map((item) => ({ id: item.modelId, object: 'model', name: item.displayName, category: item.category, billingUnit: item.billingUnit, unitPriceCents: item.unitPriceCents }));
      return res.json({ object: 'list', data });
    }

    let requestBody = req.body;
    let pricing; let chargeCents = 0; let transactionId;
    if (req.method === 'POST') {
      const modelId = String(requestBody?.model || '').trim();
      pricing = db.read('modelPricing').find((item) => item.apiId === api.id && item.modelId === modelId && item.enabled);
      if (!pricing) return res.status(403).json({ error: 'MODEL_NOT_PRICED', message: '该模型未开放或尚未定价' });
      try { chargeCents = computeCharge(pricing, requestBody); } catch (error) { return res.status(400).json({ error: error.code, message: error.message }); }
      if (req.user.role !== 'system' && chargeCents > 0) {
        transactionId = randomUUID();
        try {
          await changeBalance(db, { userId: req.user.id, amountCents: -chargeCents, type: 'model_usage', description: `${pricing.displayName} 模型调用`, referenceId: transactionId });
        } catch (error) {
          if (error.code === 'INSUFFICIENT_BALANCE') return res.status(402).json({ error: error.code, message: error.message, requiredCents: chargeCents });
          return next(error);
        }
      }
    }

    const refund = async () => {
      if (!transactionId || chargeCents <= 0) return;
      await changeBalance(db, { userId: req.user.id, amountCents: chargeCents, type: 'model_refund', description: `${pricing.displayName} 调用失败退款`, referenceId: transactionId });
      transactionId = null;
    };

    try {
      const target = buildTarget({ ...api, baseUrl: vault.decrypt(api.baseUrl) }, relativeUrl);
      const headers = new Headers({ accept: req.headers.accept || 'application/json', authorization: `Bearer ${vault.decrypt(api.encryptedApiKey)}`, 'x-api-key': vault.decrypt(api.encryptedApiKey) });
      if (req.method !== 'GET' && req.method !== 'HEAD') headers.set('content-type', 'application/json');
      const upstream = await fetchImpl(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(requestBody), redirect: 'manual' });
      const responseBody = Buffer.from(await upstream.arrayBuffer());
      if (!upstream.ok) await refund();
      res.status(upstream.status);
      res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      return res.send(responseBody);
    } catch (error) {
      try { await refund(); } catch (refundError) { return next(refundError); }
      if (error.code === 'INVALID_UPSTREAM_PATH') return res.status(400).json({ error: error.code, message: error.message });
      return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE', message: '系统 AI 服务暂时不可用，已自动退款' });
    }
  });
}
