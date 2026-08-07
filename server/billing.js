import { randomUUID } from 'node:crypto';
import { discoverSystemApi } from './api-discovery.js';

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

function exposedApi(api, vault) {
  return { ...api, baseUrl: vault.decrypt(api.baseUrl), apiKey: vault.decrypt(api.encryptedApiKey), encryptedApiKey: undefined };
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
  if (!apiId || !modelId || !displayName) throw new Error('API、模型 ID 和显示名称不能为空');
  if (!CATEGORIES.has(category) || !BILLING_UNITS.has(billingUnit)) throw new Error('模型类别或计费单位无效');
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 10_000_000) throw new Error('模型价格必须是有效的分值');
  return { apiId, modelId, displayName, category, billingUnit, unitPriceCents, enabled: input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled) };
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

export function registerAdminRoutes(router, { db, requireSystem, vault, fetchImpl, resolveHost }) {
  router.use(requireSystem);
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
    return res.json({ user: updated });
  });
  router.post('/users/:id/balance', async (req, res) => {
    const amountCents = integer(req.body.amountCents);
    if (!Number.isInteger(amountCents) || amountCents === 0 || Math.abs(amountCents) > 10_000_000) return res.status(400).json({ error: 'INVALID_AMOUNT', message: '调整金额无效' });
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
    return res.json({ user: updated, transaction });
  });

  router.get('/system-apis', (_req, res) => res.json({ apis: db.read('systemApis').map((api) => exposedApi(api, vault)) }));
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
    return res.json({ recharge: updatedRecharge, user: updatedUser });
  });
}
