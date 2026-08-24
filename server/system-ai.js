import { createHash, randomUUID } from 'node:crypto';
import { fetchWithTimeout, readLimitedBody, resourceGuardConfig } from './resource-guard.js';
import { knownVideoResolutions } from './api-discovery.js';
import { isUpstreamBalanceError, upstreamErrorText } from './upstream-errors.js';

const nowIso = () => new Date().toISOString();
// Video providers fetch reference assets asynchronously. Keep the temporary
// read grant long enough for a queued task without exposing a permanent URL.
const MODEL_REFERENCE_URL_TTL_SECONDS = 40 * 60;

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

function managedAssetId(value) {
  try {
    const url = new URL(String(value || ''), 'https://same-origin.invalid');
    return decodeURIComponent(url.pathname.match(/^\/api\/assets\/public\/([^/]+)$/)?.[1] || '');
  } catch {
    return '';
  }
}

async function normalizeReferenceImages(body, userId, db, assetStorage) {
  if (!body || !Object.hasOwn(body, 'images')) return body;
  if (!Array.isArray(body.images) || !body.images.length) {
    const error = new Error('参考图片不能为空'); error.code = 'INVALID_REFERENCE_IMAGE_URL'; throw error;
  }
  const normalizeUrl = async (value) => {
    const assetId = managedAssetId(value);
    if (assetId) {
      const asset = db.read('assets').find((entry) => entry.id === assetId && entry.userId === userId);
      if (!asset) { const error = new Error('参考图片不存在或不属于当前用户'); error.code = 'INVALID_REFERENCE_IMAGE_URL'; throw error; }
      if (!asset.objectKey || !assetStorage?.createDownloadUrl) {
        const error = new Error('参考图片尚未迁移到对象存储，请重新上传后再试'); error.code = 'REFERENCE_IMAGE_NOT_ARCHIVED'; throw error;
      }
      return assetStorage.createDownloadUrl({ key: asset.objectKey, mimeType: asset.mimeType, expiresInSeconds: MODEL_REFERENCE_URL_TTL_SECONDS });
    }
    let parsed;
    try { parsed = new URL(String(value || '')); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:') {
      const error = new Error('视频模型的参考图片必须是可公开读取的 HTTPS 地址'); error.code = 'INVALID_REFERENCE_IMAGE_URL'; throw error;
    }
    return parsed.toString();
  };
  const images = await Promise.all(body.images.map(async (image) => {
    if (typeof image === 'string') return normalizeUrl(image);
    if (image && typeof image === 'object') {
      const field = ['url', 'image_url', 'image'].find((key) => typeof image[key] === 'string');
      if (field) return { ...image, [field]: await normalizeUrl(image[field]) };
    }
    const error = new Error('参考图片参数格式无效'); error.code = 'INVALID_REFERENCE_IMAGE_URL'; throw error;
  }));
  return { ...body, images };
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
  return /moderation|content[_ -]?policy|safety|sensitive|privacyinformation|real\s*(?:person|human|face)|审核|敏感|真人|人脸|肖像/i.test(details);
}

function providerDetails(body) {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  const candidates = [
    body?.error?.detail, body?.error?.details, payload?.error?.detail, payload?.error?.details,
    body?.details, body?.detail, payload?.details, payload?.detail, body?.error?.message,
    payload?.error?.message, payload?.message, payload?.msg, body?.message, body?.msg,
  ];
  return candidates.find((value) => value && (typeof value === 'string' || typeof value === 'object')) || '';
}

function providerRestrictionMessage(body, refunded = false) {
  const details = JSON.stringify(body || '');
  const privacyRestriction = /privacyinformation|real\s*(?:person|human|face)|真人|人脸|肖像/i.test(details);
  const message = privacyRestriction
    ? '参考图片疑似包含真人，当前服务商不支持将真人肖像用作视频参考图。请移除该参考图，或改用原创角色素材后重试'
    : '内容审核未通过，请检查提示词、参考图片以及画面中的敏感内容后重试';
  return `${message}${refunded ? '；本次扣款已自动退回' : ''}`;
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

function normalizeManagedVideoResolution(pricing, api, body) {
  if (pricing.category !== 'video' || !body || typeof body !== 'object') return body;
  const allowed = (pricing.allowedResolutions?.length ? pricing.allowedResolutions : knownVideoResolutions(api.provider, pricing.modelId))
    .map((value) => String(value).toLowerCase());
  if (!allowed.length) return body;
  const supplied = String(body.resolution || '').trim().toLowerCase();
  if (supplied && !allowed.includes(supplied)) {
    const error = new Error(`该模型仅支持 ${allowed.join('、')} 分辨率，本次收到 ${body.resolution}`);
    error.code = 'INVALID_RESOLUTION';
    throw error;
  }
  return { ...body, resolution: supplied || (allowed.includes('720p') ? '720p' : allowed[0]) };
}

function enforceReferenceImageLimit(pricing, body) {
  if (pricing.category !== 'video' || !body || typeof body !== 'object') return;
  const images = Array.isArray(body.images) ? body.images : [];
  const maximum = Number.isInteger(Number(pricing.maxReferenceImages)) ? Number(pricing.maxReferenceImages) : 4;
  if (images.length > maximum) {
    const error = new Error(`该模型最多支持 ${maximum} 张参考图，本次收到 ${images.length} 张`);
    error.code = 'REFERENCE_IMAGE_LIMIT_EXCEEDED';
    throw error;
  }
}

function enforceReferenceMediaLimits(pricing, body) {
  if (pricing.category !== 'video' || !body || typeof body !== 'object') return;
  const count = (keys) => keys.reduce((total, key) => total + (Array.isArray(body[key]) ? body[key].length : body[key] ? 1 : 0), 0);
  const audioCount = count(['audios', 'audio', 'reference_audios', 'reference_audio']);
  const videoCount = count(['videos', 'video', 'reference_videos', 'reference_video']);
  const audioLimit = Number.isInteger(Number(pricing.maxReferenceAudios)) ? Number(pricing.maxReferenceAudios) : 0;
  const videoLimit = Number.isInteger(Number(pricing.maxReferenceVideos)) ? Number(pricing.maxReferenceVideos) : 0;
  if (audioCount > audioLimit) { const error = new Error(`该模型最多支持 ${audioLimit} 个参考音频，本次收到 ${audioCount} 个`); error.code = 'REFERENCE_AUDIO_LIMIT_EXCEEDED'; throw error; }
  if (videoCount > videoLimit) { const error = new Error(`该模型最多支持 ${videoLimit} 个参考视频，本次收到 ${videoCount} 个`); error.code = 'REFERENCE_VIDEO_LIMIT_EXCEEDED'; throw error; }
}

function buildTarget(api, requestUrl) {
  const base = new URL(`${api.baseUrl.replace(/\/+$/, '')}/`);
  let suffix = String(requestUrl || '/').replace(/^\/+/, '');
  // Administrators commonly save an OpenAI-compatible root ending in /v1.
  // The client also uses /v1/* paths, so avoid forwarding /v1/v1/* upstream.
  if (/\/v1\/$/i.test(base.pathname) && /^v1\//i.test(suffix)) suffix = suffix.slice(3);
  const target = new URL(suffix, base);
  const expectedPath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if (target.protocol !== 'https:' || target.origin !== base.origin || !target.pathname.startsWith(expectedPath)) {
    const error = new Error('请求路径不被允许'); error.code = 'INVALID_UPSTREAM_PATH'; throw error;
  }
  return target;
}

async function changeBalance(db, { userId, amountCents, type, description, referenceId }) {
  if (db.changeBalanceAtomic) {
    const result = await db.changeBalanceAtomic({ userId, amountCents, type, description, referenceId });
    if (result.failure) { const error = new Error(result.failure === 'INSUFFICIENT_BALANCE' ? '余额不足，请先充值' : '用户不存在'); error.code = result.failure; throw error; }
    return result.balance;
  }
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

export function registerSystemAiRoutes(router, { db, requireAuth, vault, fetchImpl = fetch, videoQueue = null, assetStorage = null }) {
  const limits = resourceGuardConfig();
  router.use(requireAuth);
  router.use('/:apiId', async (req, res, next) => {
    const api = db.read('systemApis').find((item) => item.id === req.params.apiId && item.enabled);
    if (!api) return res.status(404).json({ error: 'API_NOT_FOUND', message: '系统 API 不存在或已停用' });

    const relativeUrl = req.originalUrl.slice(req.originalUrl.indexOf(`/api/system-ai/${api.id}`) + `/api/system-ai/${api.id}`.length) || '/';
    const pathname = relativeUrl.split('?')[0].replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && videoQueue) {
      const localJobId = decodeURIComponent(pathname.match(/^\/v1\/videos\/([^/]+)$/)?.[1] || '');
      const localJob = localJobId ? videoQueue.get(localJobId, req.user.id) : null;
      if (localJob) return res.json(localJob);
    }
    if (req.method === 'DELETE' && videoQueue) {
      const localJobId = decodeURIComponent(pathname.match(/^\/v1\/videos\/([^/]+)$/)?.[1] || '');
      if (localJobId) {
        try {
          return res.json(await videoQueue.cancel(localJobId, req.user.id));
        } catch (error) {
          if (error.code === 'VIDEO_JOB_NOT_FOUND') return res.status(404).json({ error: error.code, message: error.message });
          if (error.code === 'PROVIDER_CANCELLATION_UNCONFIRMED') return res.status(409).json({ error: error.code, message: error.message });
          return next(error);
        }
      }
    }
    if (req.method === 'GET' && pathname === '/v1/models') {
      const data = db.read('modelPricing').filter((item) => item.apiId === api.id && item.enabled)
        .map((item) => ({ id: item.modelId, object: 'model', name: item.displayName, category: item.category, billingUnit: item.billingUnit, unitPriceCents: item.unitPriceCents, maxReferenceImages: Number.isInteger(Number(item.maxReferenceImages)) ? Number(item.maxReferenceImages) : 4 }));
      return res.json({ object: 'list', data });
    }

    const client = req.body?._client && typeof req.body._client === 'object' ? req.body._client : {};
    let requestBody = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
    if (requestBody && typeof requestBody === 'object') delete requestBody._client;
    if (req.method === 'POST' && pathname === '/v1/videos') {
      try { requestBody = await normalizeReferenceImages(requestBody, req.user.id, db, assetStorage); }
      catch (error) { return res.status(error.code === 'REFERENCE_IMAGE_NOT_ARCHIVED' ? 409 : 400).json({ error: error.code || 'INVALID_REFERENCE_IMAGE_URL', message: error.message }); }
    }
    let pricing; let chargeCents = 0; let transactionId;
    if (req.method === 'POST') {
      const modelId = String(requestBody?.model || '').trim();
      pricing = db.read('modelPricing').find((item) => item.apiId === api.id && item.modelId === modelId && item.enabled);
      if (!pricing) return res.status(403).json({ error: 'MODEL_NOT_PRICED', message: '该模型未开放或尚未定价' });
      try {
        requestBody = normalizeManagedVideoResolution(pricing, api, requestBody);
        enforceReferenceImageLimit(pricing, requestBody);
        enforceReferenceMediaLimits(pricing, requestBody);
        chargeCents = computeCharge(pricing, requestBody);
      } catch (error) { return res.status(400).json({ error: error.code, message: error.message }); }
      await db.mutate((data) => data.auditLogs.push({
        id: randomUUID(), userId: req.user.id, action: 'managed_model_requested', targetType: 'model_pricing', targetId: pricing.id,
        ipAddress: String(req.ip || '').slice(0, 100), userAgent: String(req.get('user-agent') || '').slice(0, 300),
        metadata: { requestId: req.requestId || null, apiId: api.id, modelId: pricing.modelId, category: pricing.category, chargeCents, durationSec: Number(requestBody?.seconds ?? requestBody?.duration ?? 0) || null }, createdAt: nowIso(),
      }));
      const willUseVideoQueue = pathname === '/v1/videos' && pricing?.category === 'video' && videoQueue;
      if (req.user.role !== 'system' && chargeCents > 0 && !willUseVideoQueue) {
        transactionId = randomUUID();
        try {
          await changeBalance(db, { userId: req.user.id, amountCents: -chargeCents, type: 'model_usage', description: `${pricing.displayName} 模型调用`, referenceId: transactionId });
        } catch (error) {
          if (error.code === 'INSUFFICIENT_BALANCE') return res.status(402).json({ error: error.code, message: '错误：余额不足' });
          return next(error);
        }
      }
    }

    const refund = async () => {
      if (!transactionId || chargeCents <= 0) return;
      await changeBalance(db, { userId: req.user.id, amountCents: chargeCents, type: 'model_refund', description: `${pricing.displayName} 调用失败退款`, referenceId: transactionId });
      transactionId = null;
    };

    if (req.method === 'POST' && pathname === '/v1/videos' && pricing?.category === 'video' && videoQueue) {
      try {
        const suppliedIdempotencyKey = String(req.get('idempotency-key') || '').trim();
        if (suppliedIdempotencyKey && !/^[A-Za-z0-9._:-]{16,128}$/.test(suppliedIdempotencyKey)) {
          return res.status(400).json({ error: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must contain 16-128 safe characters' });
        }
        const jobId = suppliedIdempotencyKey
          ? `idem-${createHash('sha256').update(`${req.user.id}:${api.id}:${suppliedIdempotencyKey}`).digest('hex').slice(0, 48)}`
          : randomUUID();
        const queued = await videoQueue.enqueue({
          id: jobId, userId: req.user.id, apiId: api.id, modelId: pricing.modelId,
          requestBody, chargeCents: req.user.role === 'system' ? 0 : chargeCents,
          billingReference: req.user.role === 'system' ? null : jobId, client,
        });
        return res.status(202).json({ ...videoQueue.get(queued.job.id, req.user.id), queue_position: queued.queuePosition });
      } catch (error) {
        try { await refund(); } catch (refundError) { return next(refundError); }
        if (error.code === 'INSUFFICIENT_BALANCE') return res.status(402).json({ error: error.code, message: '错误：余额不足' });
        const status = error.code === 'VIDEO_QUEUE_USER_LIMIT' ? 429 : 503;
        return res.status(status).json({ error: error.code || 'VIDEO_QUEUE_UNAVAILABLE', message: error.message || '视频队列暂时不可用' });
      }
    }

    try {
      let baseUrl; let apiKey;
      try {
        baseUrl = vault.decrypt(api.baseUrl);
        apiKey = vault.decrypt(api.encryptedApiKey);
      } catch (error) {
        error.code = 'SYSTEM_API_SECRET_UNAVAILABLE';
        throw error;
      }
      const target = buildTarget({ ...api, baseUrl }, relativeUrl);
      const headers = new Headers({ accept: req.headers.accept || 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey });
      if (/\/v1\/messages\/?$/i.test(pathname)) headers.set('anthropic-version', '2023-06-01');
      if (req.method !== 'GET' && req.method !== 'HEAD') headers.set('content-type', 'application/json');
      const isTextCompletion = req.method === 'POST' && /^\/v1\/(?:chat\/completions|responses|messages)\/?$/i.test(pathname);
      const timeoutMs = isTextCompletion ? limits.textTimeoutMs : limits.timeoutMs;
      const upstream = await fetchWithTimeout(fetchImpl, target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(requestBody), redirect: 'manual' }, timeoutMs);
      let responseBody = await readLimitedBody(upstream, limits.maxResponseBytes);
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
          const message = providerRestrictionMessage(parsedResponseBody, refunded);
          parsedResponseBody = {
            ...parsedResponseBody,
            message,
            error: { code: 'PROVIDER_MODERATION_ERROR', message },
          };
          responseBody = Buffer.from(JSON.stringify(parsedResponseBody));
        }
      }
      const upstreamMessage = upstreamErrorText(providerDetails(parsedResponseBody) || parsedResponseBody?.error || '');
      if ((!upstream.ok || businessFailure) && isModerationFailure(parsedResponseBody)) {
        const message = providerRestrictionMessage(parsedResponseBody);
        return res.status(upstream.status >= 400 ? upstream.status : 502).json({
          error: 'PROVIDER_MODERATION_ERROR',
          message,
        });
      }
      if (isUpstreamBalanceError(upstreamMessage)) {
        return res.status(upstream.status >= 400 ? upstream.status : 502).json({
          error: 'UPSTREAM_BALANCE_INSUFFICIENT',
          message: '错误：99',
        });
      }
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
      if (error.code === 'SYSTEM_API_SECRET_UNAVAILABLE') return res.status(503).json({ error: error.code, message: '系统 API 密钥不可用，请确认 Railway 的 APP_ENCRYPTION_KEY 与录入 API 时保持一致；必要时重新录入该系统 API' });
      if (error.code === 'UPSTREAM_RESPONSE_TOO_LARGE') return res.status(502).json({ error: error.code, message: error.message });
      if (error.name === 'AbortError') return res.status(504).json({ error: 'UPSTREAM_TIMEOUT', message: 'AI 服务响应超时，请稍后重试；长文本可将 Railway 的 AI_TEXT_UPSTREAM_TIMEOUT_MS 设置为 300000-600000' });
      return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE', message: '系统 AI 服务暂时不可用，已自动退款' });
    }
  });
}
