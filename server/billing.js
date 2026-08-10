import { randomUUID } from 'node:crypto';
import { discoverSystemApi } from './api-discovery.js';
import { verifyPassword } from './auth.js';

const CATEGORIES = new Set(['text', 'image', 'video']);
const BILLING_UNITS = new Set(['request', 'image', 'second']);
const nowIso = () => new Date().toISOString();
const integer = (value) => Number.isSafeInteger(Number(value)) ? Number(value) : NaN;

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role || 'user',
    balanceCents: Number(user.balanceCents || 0),
    createdAt: user.createdAt,
  };
}

function exposedApi(api, vault, revealKey = false) {
  return { ...api, baseUrl: vault.decrypt(api.baseUrl), apiKey: revealKey ? vault.decrypt(api.encryptedApiKey) : '', hasApiKey: Boolean(api.encryptedApiKey), encryptedApiKey: undefined };
}

function decryptStoredUrl(value, vault) {
  try { return vault.decrypt(value); } catch { return String(value || ''); }
}

function normalizeApiInput(input, existing, vault) {
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 100);
  const provider = String(input.provider ?? existing?.provider ?? '').trim().slice(0, 80);
  const rawBaseUrl = String(input.baseUrl ?? (existing ? decryptStoredUrl(existing.baseUrl, vault) : '')).trim().replace(/\/+$/, '');
  let baseUrl;
  try { baseUrl = new URL(rawBaseUrl); } catch { throw new Error('API 地址无效'); }
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
    throw new Error('系统 API 必须使用不含账号信息的 HTTPS 地址');
  }
  if (!name || !provider) throw new Error('API 名称和服务商不能为空');
  const apiKey = String(input.apiKey || '').trim();
  if (!existing && apiKey.length < 8) throw new Error('API Key 长度不足');
  return {
    name,
    provider,
    baseUrl: vault.encrypt(baseUrl.toString().replace(/\/$/, '')),
    encryptedApiKey: apiKey ? vault.encrypt(apiKey) : existing.encryptedApiKey,
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled),
  };
}

function normalizePricingInput(input, existing) {
  const apiId = String(input.apiId ?? existing?.apiId ?? '');
  const modelId = String(input.modelId ?? existing?.modelId ?? '').trim().slice(0, 160);
  const displayName = String(input.displayName ?? existing?.displayName ?? '').trim().slice(0, 160);
  const category = String(input.category ?? existing?.category ?? '');
  const billingUnit = String(input.billingUnit ?? existing?.billingUnit ?? '');
  const unitPriceCents = integer(input.unitPriceCents ?? existing?.unitPriceCents);
  const parseDuration = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = integer(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 3600 ? parsed : NaN;
  };
  let minDurationSec = parseDuration(input.minDurationSec ?? existing?.minDurationSec);
  let maxDurationSec = parseDuration(input.maxDurationSec ?? existing?.maxDurationSec);
  const rawAllowed = input.allowedDurationsSec ?? existing?.allowedDurationsSec ?? [];
  const allowedDurationsSec = Array.isArray(rawAllowed) ? [...new Set(rawAllowed.map((v) => parseDuration(v)))].sort((a, b) => a - b) : String(rawAllowed).split(',').map((v) => v.trim()).filter(Boolean).map(parseDuration).sort((a, b) => a - b);
  if (allowedDurationsSec.length) { minDurationSec = null; maxDurationSec = null; }
  if (!apiId || !modelId || !displayName) throw new Error('API、模型 ID 和显示名称不能为空');
  if (!CATEGORIES.has(category) || !BILLING_UNITS.has(billingUnit)) throw new Error('模型类别或计费单位无效');
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 10_000_000) throw new Error('模型价格必须是有效的分值');
  if ([minDurationSec, maxDurationSec, ...allowedDurationsSec].some((v) => Number.isNaN(v))) throw new Error('视频时长规则无效');
  if (minDurationSec && maxDurationSec && maxDurationSec < minDurationSec) throw new Error('最长时长不能小于最短时长');
  if (category === 'video' && !allowedDurationsSec.length && (!minDurationSec || !maxDurationSec)) {
    throw new Error('视频模型必须填写固定时长，或同时填写最短和最长时长');
  }
  return { apiId, modelId, displayName, category, billingUnit, unitPriceCents, minDurationSec, maxDurationSec, allowedDurationsSec, enabled: input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled) };
}

export function registerCatalogRoutes(router, { db, requireAuth }) {
  router.use(requireAuth);
  router.get('/models', (req, res) => {
    const apis = new Map(db.read('systemApis').filter((api) => api.enabled).map((api) => [api.id, api]));
    const models = db.read('modelPricing').filter((price) => price.enabled && apis.has(price.apiId)).map((price) => {
      const api = apis.get(price.apiId);
      return {
        id: price.id, apiId: api.id, modelId: price.modelId, name: price.displayName,
        provider: api.provider, category: price.category, billingUnit: price.billingUnit,
        unitPriceCents: price.unitPriceCents, baseUrl: `/api/system-ai/${api.id}`, managed: true,
        minDurationSec: price.minDurationSec, maxDurationSec: price.maxDurationSec, allowedDurationsSec: price.allowedDurationsSec,
      };
    });
    return res.json({ models, balanceCents: Number(req.user.balanceCents || 0), role: req.user.role });
  });
}

export function registerBillingRoutes(router, { db, requireAuth }) {
  router.use(requireAuth);
  router.get('/me', (req, res) => {
    const user = db.read('users').find((item) => item.id === req.user.id);
    const transactions = db.read('balanceTransactions').filter((item) => item.userId === req.user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
    const recharges = db.read('rechargeRequests').filter((item) => item.userId === req.user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.json({ balanceCents: Number(user?.balanceCents || 0), transactions, recharges });
  });
  router.post('/recharges', async (req, res) => {
    const amountCents = integer(req.body.amountCents);
    if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 10_000_000) {
      return res.status(400).json({ error: 'INVALID_AMOUNT', message: '充值金额必须在 1-100000 元之间' });
    }
    let request;
    try {
      await db.mutate((data) => {
        if (data.rechargeRequests.some((item) => item.userId === req.user.id && item.status === 'pending')) {
          const error = new Error('已有待审核的充值申请'); error.code = 'PENDING_RECHARGE_EXISTS'; throw error;
        }
        request = { id: randomUUID(), userId: req.user.id, amountCents, status: 'pending', note: String(req.body.note || '').trim().slice(0, 300), reviewedBy: null, createdAt: nowIso(), reviewedAt: null };
        data.rechargeRequests.push(request);
      });
    } catch (error) {
      if (error.code === 'PENDING_RECHARGE_EXISTS') return res.status(409).json({ error: error.code, message: error.message });
      throw error;
    }
    return res.status(201).json({ recharge: request });
  });
}

export function registerAdminRoutes(router, { db, requireSystem, vault, fetchImpl, resolveHost, videoQueue = null }) {
  router.use(requireSystem);
  const audit = async (req, action, targetType, targetId, metadata = {}) => {
    const record = { id: randomUUID(), userId: req.user.id, action, targetType, targetId: targetId || null, ipAddress: String(req.ip || '').slice(0, 100), userAgent: String(req.get('user-agent') || '').slice(0, 300), metadata: { requestId: req.requestId || null, ...metadata }, createdAt: nowIso() };
    await db.mutate((data) => data.auditLogs.push(record));
    return record;
  };
  router.get('/video-queue', (_req, res) => res.json(videoQueue ? videoQueue.overview() : {
    counts: { queued: 0, submitting: 0, processing: 0, completed: 0, failed: 0 },
    config: null, recent: [],
  }));
  router.get('/metrics', (_req, res) => {
    const jobs = db.read('generationJobs');
    const now = Date.now();
    const since = now - (24 * 60 * 60 * 1000);
    const recent = jobs.filter((job) => Date.parse(job.createdAt) >= since);
    const completed = recent.filter((job) => job.status === 'completed');
    const durations = completed.map((job) => Date.parse(job.completedAt || job.updatedAt) - Date.parse(job.createdAt)).filter((value) => value >= 0);
    const refundedCents = db.read('balanceTransactions').filter((item) => item.type === 'model_refund' && Date.parse(item.createdAt) >= since).reduce((sum, item) => sum + Number(item.amountCents || 0), 0);
    const archivedJobIds = new Set(db.read('generatedMedia').map((item) => item.jobId));
    return res.json({
      generatedAt: nowIso(), windowHours: 24,
      queue: videoQueue ? videoQueue.overview().counts : { queued: 0, submitting: 0, processing: 0, completed: 0, failed: 0 },
      recent: {
        total: recent.length, completed: completed.length,
        failed: recent.filter((job) => job.status === 'failed').length,
        cancelled: recent.filter((job) => job.status === 'cancelled').length,
        activeUsers: new Set(recent.map((job) => job.userId)).size,
        averageCompletionMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
        refundedCents,
        archiveFallbacks: completed.filter((job) => job.resultUrl && !archivedJobIds.has(job.id)).length,
      },
    });
  });
  router.get('/payment-reconciliation', (_req, res) => {
    const orders = db.read('paymentOrders');
    const transactions = db.read('balanceTransactions').filter((item) => item.type === 'payment_recharge');
    const transactionReferences = new Set(transactions.map((item) => item.referenceId));
    const orderIds = new Set(orders.map((item) => item.id));
    const paidWithoutCredit = orders.filter((item) => item.status === 'paid' && !transactionReferences.has(item.id)).map((item) => ({ orderId: item.id, provider: item.provider, amountCents: item.amountCents, paidAt: item.paidAt }));
    const creditWithoutOrder = transactions.filter((item) => !orderIds.has(item.referenceId)).map((item) => ({ transactionId: item.id, referenceId: item.referenceId, amountCents: item.amountCents, createdAt: item.createdAt }));
    const amountMismatch = orders.filter((order) => order.status === 'paid').flatMap((order) => {
      const transaction = transactions.find((item) => item.referenceId === order.id);
      return transaction && Number(transaction.amountCents) !== Number(order.amountCents) ? [{ orderId: order.id, orderAmountCents: order.amountCents, creditedCents: transaction.amountCents }] : [];
    });
    return res.json({ checkedAt: nowIso(), ok: !paidWithoutCredit.length && !creditWithoutOrder.length && !amountMismatch.length, paidWithoutCredit, creditWithoutOrder, amountMismatch });
  });
  router.get('/users', (_req, res) => res.json({ users: db.read('users').map(safeUser) }));
  router.patch('/users/:id/role', async (req, res) => {
    const role = String(req.body.role || '');
    if (!['user', 'system'].includes(role)) return res.status(400).json({ error: 'INVALID_ROLE', message: '角色无效' });
    if (req.params.id === req.user.id && role !== 'system') return res.status(400).json({ error: 'SELF_DEMOTION_FORBIDDEN', message: '不能取消自己的系统用户权限' });
    let updated;
    await db.mutate((data) => {
      const user = data.users.find((item) => item.id === req.params.id);
      if (!user) return;
      user.role = role; updated = safeUser(user);
    });
    if (!updated) return res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    await audit(req, 'user_role_updated', 'user', updated.id, { role: updated.role });
    return res.json({ user: updated });
  });
  router.post('/users/:id/balance', async (req, res) => {
    const amountCents = integer(req.body.amountCents);
    if (!Number.isInteger(amountCents) || amountCents === 0 || Math.abs(amountCents) > 10_000_000) return res.status(400).json({ error: 'INVALID_AMOUNT', message: '调整金额无效' });
    if (db.changeBalanceAtomic) {
      const result = await db.changeBalanceAtomic({ userId: req.params.id, amountCents, type: 'admin_adjustment', description: String(req.body.description || '系统用户调整余额').slice(0, 300), createdBy: req.user.id });
      if (result.failure === 'USER_NOT_FOUND') return res.status(404).json({ error: result.failure, message: '用户不存在' });
      if (result.failure) return res.status(409).json({ error: result.failure, message: '余额不能小于零' });
      const user = db.read('users').find((item) => item.id === req.params.id);
      await audit(req, 'user_balance_adjusted', 'user', req.params.id, { amountCents, transactionId: result.transaction?.id || null });
      return res.json({ user: safeUser(user || { id: req.params.id, balanceCents: result.balance }), transaction: result.transaction });
    }
    let updated; let transaction; let failure;
    await db.mutate((data) => {
      const user = data.users.find((item) => item.id === req.params.id);
      if (!user) { failure = 'USER_NOT_FOUND'; return; }
      if (Number(user.balanceCents || 0) + amountCents < 0) { failure = 'INSUFFICIENT_BALANCE'; return; }
      user.balanceCents = Number(user.balanceCents || 0) + amountCents;
      transaction = { id: randomUUID(), userId: user.id, amountCents, type: 'admin_adjustment', description: String(req.body.description || '系统用户调整余额').slice(0, 300), referenceId: null, createdBy: req.user.id, createdAt: nowIso() };
      data.balanceTransactions.push(transaction); updated = safeUser(user);
    });
    if (failure === 'USER_NOT_FOUND') return res.status(404).json({ error: failure, message: '用户不存在' });
    if (failure) return res.status(409).json({ error: failure, message: '余额不能小于零' });
    await audit(req, 'user_balance_adjusted', 'user', req.params.id, { amountCents, transactionId: transaction?.id || null });
    return res.json({ user: updated, transaction });
  });

  router.get('/system-apis', (_req, res) => res.json({ apis: db.read('systemApis').map((api) => exposedApi(api, vault)) }));
  router.post('/system-apis/:id/reveal', async (req, res) => {
    const api = db.read('systemApis').find((item) => item.id === req.params.id);
    if (!api) return res.status(404).json({ error: 'API_NOT_FOUND', message: '系统 API 不存在' });
    const user = db.read('users').find((item) => item.id === req.user.id);
    if (!user || !(await verifyPassword(String(req.body.password || ''), user.passwordHash))) {
      await audit(req, 'system_api_reveal_denied', 'system_api', api.id);
      return res.status(401).json({ error: 'PASSWORD_INVALID', message: '当前登录密码错误' });
    }
    await audit(req, 'system_api_revealed', 'system_api', api.id);
    return res.json({ apiKey: vault.decrypt(api.encryptedApiKey) });
  });
  router.get('/audit-logs', (_req, res) => res.json({ logs: db.read('auditLogs').slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200) }));
  router.post('/system-apis/discover', async (req, res) => {
    try {
      const existing = req.body.apiId ? db.read('systemApis').find((api) => api.id === req.body.apiId) : null;
      if (req.body.apiId && !existing) return res.status(404).json({ error: 'API_NOT_FOUND', message: '系统 API 不存在' });
      const result = await discoverSystemApi({
        baseUrl: req.body.baseUrl || (existing ? decryptStoredUrl(existing.baseUrl, vault) : ''),
        apiKey: String(req.body.apiKey || '').trim() || (existing ? vault.decrypt(existing.encryptedApiKey) : ''),
        fetchImpl, resolveHost,
      });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: 'API_DISCOVERY_FAILED', message: error.message || 'API 自动识别失败' });
    }
  });
  router.post('/system-apis', async (req, res) => {
    try {
      const now = nowIso();
      const api = { id: randomUUID(), ...normalizeApiInput(req.body, null, vault), createdBy: req.user.id, createdAt: now, updatedAt: now };
      await db.mutate((data) => data.systemApis.push(api));
      await audit(req, 'system_api_created', 'system_api', api.id, { name: api.name, provider: api.provider });
      return res.status(201).json({ api: exposedApi(api, vault) });
    } catch (error) { return res.status(400).json({ error: 'API_VALIDATION_ERROR', message: error.message }); }
  });
  router.put('/system-apis/:id', async (req, res) => {
    try {
      let updated;
      await db.mutate((data) => {
        const api = data.systemApis.find((item) => item.id === req.params.id);
        if (!api) return;
        Object.assign(api, normalizeApiInput(req.body, api, vault), { updatedAt: nowIso() }); updated = exposedApi(api, vault);
      });
      if (!updated) return res.status(404).json({ error: 'API_NOT_FOUND', message: '系统 API 不存在' });
      await audit(req, 'system_api_updated', 'system_api', req.params.id, { name: updated.name, provider: updated.provider });
      return res.json({ api: updated });
    } catch (error) { return res.status(400).json({ error: 'API_VALIDATION_ERROR', message: error.message }); }
  });
  router.delete('/system-apis/:id', async (req, res) => {
    let found = false;
    await db.mutate((data) => {
      found = data.systemApis.some((item) => item.id === req.params.id);
      data.systemApis = data.systemApis.filter((item) => item.id !== req.params.id);
      data.modelPricing = data.modelPricing.filter((item) => item.apiId !== req.params.id);
    });
    if (found) await audit(req, 'system_api_deleted', 'system_api', req.params.id);
    return found ? res.status(204).end() : res.status(404).json({ error: 'API_NOT_FOUND', message: '系统 API 不存在' });
  });

  router.get('/pricing', (_req, res) => res.json({ pricing: db.read('modelPricing') }));
  router.post('/pricing', async (req, res) => {
    try {
      const input = normalizePricingInput(req.body); let pricing; let failure;
      await db.mutate((data) => {
        if (!data.systemApis.some((api) => api.id === input.apiId)) { failure = 'API_NOT_FOUND'; return; }
        if (data.modelPricing.some((item) => item.apiId === input.apiId && item.modelId === input.modelId)) { failure = 'PRICING_EXISTS'; return; }
        const now = nowIso(); pricing = { id: randomUUID(), ...input, createdAt: now, updatedAt: now }; data.modelPricing.push(pricing);
      });
      if (failure === 'API_NOT_FOUND') return res.status(404).json({ error: failure, message: '系统 API 不存在' });
      if (failure) return res.status(409).json({ error: failure, message: '该模型已经定价' });
      await audit(req, 'model_pricing_created', 'model_pricing', pricing.id, { apiId: pricing.apiId, modelId: pricing.modelId, unitPriceCents: pricing.unitPriceCents });
      return res.status(201).json({ pricing });
    } catch (error) { return res.status(400).json({ error: 'PRICING_VALIDATION_ERROR', message: error.message }); }
  });
  router.put('/pricing/:id', async (req, res) => {
    try {
      let updated; let failure;
      await db.mutate((data) => {
        const pricing = data.modelPricing.find((item) => item.id === req.params.id);
        if (!pricing) return;
        const normalized = normalizePricingInput(req.body, pricing);
        if (!data.systemApis.some((api) => api.id === normalized.apiId)) { failure = 'API_NOT_FOUND'; return; }
        if (data.modelPricing.some((item) => item.id !== pricing.id && item.apiId === normalized.apiId && item.modelId === normalized.modelId)) { failure = 'PRICING_EXISTS'; return; }
        Object.assign(pricing, normalized, { updatedAt: nowIso() }); updated = { ...pricing };
      });
      if (failure === 'API_NOT_FOUND') return res.status(404).json({ error: failure, message: '系统 API 不存在' });
      if (failure) return res.status(409).json({ error: failure, message: '该模型已经定价' });
      if (!updated) return res.status(404).json({ error: 'PRICING_NOT_FOUND', message: '模型定价不存在' });
      await audit(req, 'model_pricing_updated', 'model_pricing', updated.id, { apiId: updated.apiId, modelId: updated.modelId, unitPriceCents: updated.unitPriceCents });
      return res.json({ pricing: updated });
    } catch (error) { return res.status(400).json({ error: 'PRICING_VALIDATION_ERROR', message: error.message }); }
  });
  router.delete('/pricing/:id', async (req, res) => {
    let found = false;
    await db.mutate((data) => { found = data.modelPricing.some((item) => item.id === req.params.id); data.modelPricing = data.modelPricing.filter((item) => item.id !== req.params.id); });
    return found ? res.status(204).end() : res.status(404).json({ error: 'PRICING_NOT_FOUND', message: '模型定价不存在' });
  });

  router.get('/recharges', (_req, res) => {
    const users = new Map(db.read('users').map((user) => [user.id, safeUser(user)]));
    const recharges = db.read('rechargeRequests').map((item) => ({ ...item, user: users.get(item.userId) || null })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.json({ recharges });
  });
  router.post('/recharges/:id/review', async (req, res) => {
    const decision = String(req.body.decision || '');
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'INVALID_DECISION', message: '审核结果无效' });
    let updatedRecharge; let updatedUser; let failure;
    await db.mutate((data) => {
      const recharge = data.rechargeRequests.find((item) => item.id === req.params.id);
      if (!recharge) { failure = 'RECHARGE_NOT_FOUND'; return; }
      if (recharge.status !== 'pending') { failure = 'RECHARGE_ALREADY_REVIEWED'; return; }
      const user = data.users.find((item) => item.id === recharge.userId);
      if (!user) { failure = 'USER_NOT_FOUND'; return; }
      recharge.status = decision; recharge.reviewedBy = req.user.id; recharge.reviewedAt = nowIso();
      if (decision === 'approved') {
        user.balanceCents = Number(user.balanceCents || 0) + Number(recharge.amountCents);
        data.balanceTransactions.push({ id: randomUUID(), userId: user.id, amountCents: Number(recharge.amountCents), type: 'recharge', description: '充值申请审核通过', referenceId: recharge.id, createdBy: req.user.id, createdAt: nowIso() });
      }
      updatedRecharge = { ...recharge }; updatedUser = safeUser(user);
    });
    if (failure === 'RECHARGE_NOT_FOUND') return res.status(404).json({ error: failure, message: '充值申请不存在' });
    if (failure === 'USER_NOT_FOUND') return res.status(404).json({ error: failure, message: '用户不存在' });
    if (failure) return res.status(409).json({ error: failure, message: '该申请已处理' });
    await audit(req, 'recharge_reviewed', 'recharge', updatedRecharge.id, { decision, amountCents: updatedRecharge.amountCents, userId: updatedRecharge.userId });
    return res.json({ recharge: updatedRecharge, user: updatedUser });
  });
}
