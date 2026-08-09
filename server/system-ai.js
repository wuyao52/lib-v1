import { createHash, randomUUID } from 'node:crypto';

const nowIso = () => new Date().toISOString();

function isBusinessFailure(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.success === false) return true;
  return body.code !== undefined && !['0', '200', '20000', 'SUCCESS'].includes(String(body.code).toUpperCase());
}

function responseStatus(body) {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  return String(payload?.status || payload?.state || body?.status || body?.state || '').toLowerCase();
}

function isTerminalFailure(body) {
  return ['failed', 'error', 'rejected', 'cancelled', 'canceled'].includes(responseStatus(body));
}

function providerTaskId(body) {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  return String(payload?.id || payload?.task_id || payload?.taskId || body?.id || '').trim();
}

function taskBillingReference(apiId, userId, taskId) {
  return createHash('sha256').update(`${apiId}:${userId}:${taskId}`).digest('hex');
}

function isModerationFailure(body) {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  const details = [
    body?.code, body?.message, body?.msg, body?.error?.code, body?.error?.message, body?.error,
    payload?.code, payload?.message, payload?.msg, payload?.error?.code, payload?.error?.message, payload?.error,
  ]
    .filter((value) => typeof value === 'string').join(' ');
  return /moderation|content[_ -]?policy|safety|sensitive|审核|敏感/i.test(details);
}

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
  const durationInvalid = allowed.length > 0
    ? !allowed.some((duration) => Math.abs(duration - seconds) < Number.EPSILON)
    : (pricing.minDurationSec && seconds < Number(pricing.minDurationSec)) || (pricing.maxDurationSec && seconds > Number(pricing.maxDurationSec));
  if (durationInvalid) {
    const error = new Error(allowed.length ? `该模型仅支持 ${allowed.join('、')} 秒，本次收到 ${seconds} 秒` : `该模型支持 ${pricing.minDurationSec || 1}-${pricing.maxDurationSec || 3600} 秒，本次收到 ${seconds} 秒`);
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

async function attachChargeToTask(db, { userId, transactionId, referenceId }) {
  await db.mutate((data) => {
    const transaction = data.balanceTransactions.find((item) => (
      item.userId === userId && item.type === 'model_usage' && item.referenceId === transactionId
    ));
    if (transaction) transaction.referenceId = referenceId;
  });
}

async function refundTaskCharge(db, { userId, referenceId }) {
  let refunded = false;
  await db.mutate((data) => {
    const charge = data.balanceTransactions.find((item) => (
      item.userId === userId && item.type === 'model_usage' && item.referenceId === referenceId
    ));
    const alreadyRefunded = data.balanceTransactions.some((item) => (
      item.userId === userId && item.type === 'model_refund' && item.referenceId === referenceId
    ));
    if (!charge || alreadyRefunded) return;
    const user = data.users.find((item) => item.id === userId);
    if (!user) return;
    const amountCents = Math.abs(Number(charge.amountCents || 0));
    if (!amountCents) return;
    user.balanceCents = Number(user.balanceCents || 0) + amountCents;
    data.balanceTransactions.push({
      id: randomUUID(), userId, amountCents, type: 'model_refund',
      description: `${charge.description.replace(/模型调用$/, '').trim()}异步任务失败退款`,
      referenceId, createdBy: null, createdAt: nowIso(),
    });
    refunded = true;
  });
  return refunded;
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
      let responseBody = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
      let businessFailure = false; let parsedResponseBody;
      if (contentType.includes('json') && responseBody.length) {
        try { parsedResponseBody = JSON.parse(responseBody.toString('utf8')); businessFailure = isBusinessFailure(parsedResponseBody); } catch { businessFailure = false; }
      }
      const terminalFailure = isTerminalFailure(parsedResponseBody);
      const pathTaskId = req.method === 'GET' ? decodeURIComponent(pathname.match(/^\/v1\/videos\/([^/]+)$/)?.[1] || '') : '';
      if (!upstream.ok || businessFailure) await refund();
      if (req.method === 'POST' && transactionId && upstream.ok && !businessFailure && !terminalFailure) {
        const taskId = providerTaskId(parsedResponseBody);
        if (taskId && ['queued', 'pending', 'processing', 'running', ''].includes(responseStatus(parsedResponseBody))) {
          const referenceId = taskBillingReference(api.id, req.user.id, taskId);
          await attachChargeToTask(db, { userId: req.user.id, transactionId, referenceId });
          transactionId = referenceId;
        }
      }
      if (terminalFailure && pathTaskId) {
        const referenceId = taskBillingReference(api.id, req.user.id, pathTaskId);
        const refunded = await refundTaskCharge(db, { userId: req.user.id, referenceId });
        if (isModerationFailure(parsedResponseBody)) {
          const message = `内容审核未通过，请检查提示词、参考图片以及画面中的敏感内容后重试${refunded ? '；本次扣款已自动退回' : ''}`;
          parsedResponseBody = {
            ...parsedResponseBody,
            message,
            error: { code: 'PROVIDER_MODERATION_ERROR', message },
          };
          responseBody = Buffer.from(JSON.stringify(parsedResponseBody));
        }
      }
      const upstreamMessage = String(parsedResponseBody?.message || parsedResponseBody?.msg || parsedResponseBody?.error?.message || '');
      if (!upstream.ok && pricing?.category === 'video' && /(?:seconds?|duration|时长).*(?:不支持|unsupported|invalid)|(?:不支持|unsupported).*(?:seconds?|duration|时长)/i.test(upstreamMessage)) {
        const receivedSeconds = requestBody?.seconds ?? requestBody?.duration ?? requestBody?.settings?.duration;
        return res.status(409).json({
          error: 'UPSTREAM_DURATION_MISMATCH',
          message: `系统模型 ${pricing.displayName} 的后台时长规则与供应商不一致：供应商拒绝了 ${receivedSeconds} 秒。请系统用户修改该模型的固定时长设置`,
        });
      }
      res.status(businessFailure && upstream.ok ? 502 : upstream.status);
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'no-store');
      return res.send(responseBody);
    } catch (error) {
      try { await refund(); } catch (refundError) { return next(refundError); }
      if (error.code === 'INVALID_UPSTREAM_PATH') return res.status(400).json({ error: error.code, message: error.message });
      return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE', message: '系统 AI 服务暂时不可用，已自动退款' });
    }
  });
}
