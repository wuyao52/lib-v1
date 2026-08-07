import { randomUUID } from 'node:crypto';

const CATEGORIES = new Set(['text', 'image', 'video']);
const BILLING_UNITS = new Set(['request', 'image', 'second']);

const nowIso = () => new Date().toISOString();
const money = (value) => Number.isSafeInteger(Number(value)) ? Number(value) : NaN;

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

function normalizeApiInput(input, existing, vault) {
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 100);
  const provider = String(input.provider ?? existing?.provider ?? '').trim().slice(0, 80);
  const rawBaseUrl = String(input.baseUrl ?? existing?.baseUrl ?? '').trim().replace(/\/+$/, '');
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error('API 地址无效');
  }
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) throw new Error('系统 API 必须使用不含账号信息的 HTTPS 地址');
  if (!name || !provider) throw new Error('API 名称和服务商不能为空');
  const apiKey = String(input.apiKey || '');
  if (!existing && apiKey.length < 8) throw new Error('API Key 长度不足');
  return {
    name,
    provider,
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
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
  const unitPriceCents = money(input.unitPriceCents ?? existing?.unitPriceCents);
  if (!apiId || !modelId || !displayName) throw new Error('API、模型 ID 和显示名称不能为空');
  if (!CATEGORIES.has(category) || !BILLING_UNITS.has(billingUnit)) throw new Error('模型类别或计费单位无效');
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 10_000_000) throw new Error('模型价格必须为有效的分值');
  return { apiId, modelId, displayName, category, billingUnit, unitPriceCents, enabled: input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled) };
}

export function registerCatalogRoutes(router, { db, requireAuth }) {
  router.use(requireAuth);
  router.get('/models', (req, res) => {
    const apis = new Map(db.read('systemApis').filter((api) => api.enabled).map((api) => [api.id, api]));
    const models = db.read('modelPricing').filter((price) => price.enabled && apis.has(price.apiId)).map((price) => {
      const api = apis.get(price.apiId);
      return {
        id: price.id,
        apiId: api.id,
        modelId: price.modelId,
        name: price.displayName,
        provider: api.provider,
        category: price.category,
        billingUnit: price.billingUnit,
        unitPriceCents: price.unitPriceCents,
        baseUrl: `/api/system-ai/${api.id}`,
        managed: true,
      };
    });
    return res.json({ models, balanceCents: req.user.balanceCents, role: req.user.role });
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
    const amountCents = money(req.body.amountCents);
    if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 10_000_000) {
      return res.status(400).json({ error: 'INVALID_AMOUNT', message: '充值金额必须在 1-100000 元之间' });
    }
    const pending = db.read('rechargeRequests').some((item) => item.userId === req.user.id && item.status === 'pending');
    if (pending) return res.status(409).json({ error: 'PENDING_RECHARGE_EXISTS', message: '已有待审核的充值申请' });
    const request = { id: randomUUID(), userId: req.user.id, amountCents, status: 'pending', note: String(req.body.note || '').trim().slice(0, 300), reviewedBy: null, createdAt: nowIso(), reviewedAt: null };
    await db.mutate((data) => data.rechargeRequests.push(request));
    return res.status(201).json({ recharge: request });
  });
}

export function registerAdminRoutes(router, { db, requireSystem, vault }) {
  router.use(requireSystem);

  router.get('/users', (_req, res) => res.json({ users: db.read('users').map(safeUser) }));
  router.patch('/users/:id/role', async (req, res) => {
    const role = String(req.body.role || '');
    if (!['user', 'system'].includes(role)) return res.status(400).json({ error: 'INVALID_ROLE', message: '角色无效' });
    if (req.params.id === req.user.id && role !== 'system') return res.status(400).json({ error: 'SELF_DEMOTION_FORBIDDEN', message: '不能取消自己的系统用户权限' });
    const user = db.read('users').find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    await db.mutate(() => { user.role = role; });
    return res.json({ user: safeUser(user) });
  });
  router.post('/users/:id/balance', async (req, res) => {
    const amountCents = money(req.body.amountCents);
    const user = db.read('users').find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    if (!Number.isInteger(amountCents) || amountCents === 0 || Math.abs(amountCents) > 10_000_000) return res.status(400).json({ error: 'INVALID_AMOUNT', message: '调整金额无效' });
    if (Number(user.balanceCents || 0) + amountCents < 0) return res.status(409).json({ error: 'INSUFFICIENT_BALANCE', message: '余额不能小于零' });
    const transaction = { id: randomUUID(), userId: user.id, amountCents, type: 'admin_adjustment', description: String(req.body.description || '系统用户调整余额').slice(0, 300), referenceId: null, createdBy: req.user.id, createdAt: nowIso() };
    await db.mutate((data) => { user.balanceCents = Number(user.balanceCents || 0) + amountCents; data.balanceTransactions.push(transaction); });
    return res.json({ user: safeUser(user), transaction });
  });

  router.get('/system-apis', (_req, res) => {
    const apis = db.read('systemApis').map((api) => ({ ...api, apiKey: vault.decrypt(api.encryptedApiKey), encryptedApiKey: undefined }));
    return res.json({ apis });
  });
  router.post('/system-apis', async (req, res) => {
    try {
      const now = nowIso();
      const api = { id: randomUUID(), ...normalizeApiInput(req.body, null, vault), createdBy: req.user.id, createdAt: now, updatedAt: now };
      await db.mutate((data) => data.systemApis.push(api));
      return res.status(201).json({ api: { ...api, apiKey: req.body.apiKey, encryptedApiKey: undefined } });
    } catch (error) {
      return res.status(400).json({ error: 'API_VALIDATION_ERROR', message: error.message });
    }
  });
  router.put('/system-apis/:id', async (req, res) => {
    try {
      const api = db.read('systemApis').find((item) => item.id === req.params.id);
      if (!api) return res.status(404).json({ error: 'API_NOT_FOUND', message: '系统 API 不存在' });
      Object.assign(api, normalizeApiInput(req.body, api, vault), { updatedAt: nowIso() });
      await db.mutate(() => undefined);
      return res.json({ api: { ...api, apiKey: vault.decrypt(api.encryptedApiKey), encryptedApiKey: undefined } });
    } catch (error) {
      return res.status(400).json({ error: 'API_VALIDATION_ERROR', message: error.message });
    }
  });
  router.delete('/system-apis/:id', async (req, res) => {
    const api = db.read('systemApis').find((item) => item.id === req.params.id);
    if (!api) return res.status(404).json({ error: 'API_NOT_FOUND', message: '系统 API 不存在' });
    await db.mutate((data) => {
      data.systemApis = data.systemApis.filter((item) => item.id !== api.id);
      data.modelPricing = data.modelPricing.filter((item) => item.apiId !== api.id);
    });
    return res.status(204).end();
  });

  router.get('/pricing', (_req, res) => res.json({ pricing: db.read('modelPricing') }));
  router.post('/pricing', async (req, res) => {
    try {
      const input = normalizePricingInput(req.body);
      if (!db.read('systemApis').some((api) => api.id === input.apiId)) return res.status(404).json({ error: 'API_NOT_FOUND', message: '系统 API 不存在' });
      if (db.read('modelPricing').some((item) => item.apiId === input.apiId && item.modelId === input.modelId)) return res.status(409).json({ error: 'PRICING_EXISTS', message: '该模型已经定价' });
      const now = nowIso();
      const pricing = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
      await db.mutate((data) => data.modelPricing.push(pricing));
      return res.status(201).json({ pricing });
    } catch (error) {
      return res.status(400).json({ error: 'PRICING_VALIDATION_ERROR', message: error.message });
    }
  });
  router.put('/pricing/:id', async (req, res) => {
    try {
      const pricing = db.read('modelPricing').find((item) => item.id === req.params.id);
      if (!pricing) return res.status(404).json({ error: 'PRICING_NOT_FOUND', message: '模型定价不存在' });
      Object.assign(pricing, normalizePricingInput(req.body, pricing), { updatedAt: nowIso() });
      await db.mutate(() => undefined);
      return res.json({ pricing });
    } catch (error) {
      return res.status(400).json({ error: 'PRICING_VALIDATION_ERROR', message: error.message });
    }
  });
  router.delete('/pricing/:id', async (req, res) => {
    const pricing = db.read('modelPricing').find((item) => item.id === req.params.id);
    if (!pricing) return res.status(404).json({ error: 'PRICING_NOT_FOUND', message: '模型定价不存在' });
    await db.mutate((data) => { data.modelPricing = data.modelPricing.filter((item) => item.id !== pricing.id); });
    return res.status(204).end();
  });

  router.get('/recharges', (_req, res) => {
    const users = new Map(db.read('users').map((user) => [user.id, safeUser(user)]));
    const recharges = db.read('rechargeRequests').map((item) => ({ ...item, user: users.get(item.userId) || null })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.json({ recharges });
  });
  router.post('/recharges/:id/review', async (req, res) => {
    const decision = String(req.body.decision || '');
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'INVALID_DECISION', message: '审核结果无效' });
    const recharge = db.read('rechargeRequests').find((item) => item.id === req.params.id);
    if (!recharge) return res.status(404).json({ error: 'RECHARGE_NOT_FOUND', message: '充值申请不存在' });
    if (recharge.status !== 'pending') return res.status(409).json({ error: 'RECHARGE_ALREADY_REVIEWED', message: '该申请已处理' });
    const user = db.read('users').find((item) => item.id === recharge.userId);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    await db.mutate((data) => {
      recharge.status = decision;
      recharge.reviewedBy = req.user.id;
      recharge.reviewedAt = nowIso();
      if (decision === 'approved') {
        user.balanceCents = Number(user.balanceCents || 0) + Number(recharge.amountCents);
        data.balanceTransactions.push({ id: randomUUID(), userId: user.id, amountCents: Number(recharge.amountCents), type: 'recharge', description: '充值申请审核通过', referenceId: recharge.id, createdBy: req.user.id, createdAt: nowIso() });
      }
    });
    return res.json({ recharge, user: safeUser(user) });
  });
}
