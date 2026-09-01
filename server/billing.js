import { randomUUID } from 'node:crypto';
import { discoverSystemApi, knownVideoResolutions } from './api-discovery.js';
import { verifyPassword } from './auth.js';
import { runBackupDrill } from './backup-drill.js';
import { summarizeStoredObjects } from './object-storage.js';
import { createStorageCleanupPlan, referencedStorageKeys } from './storage-cleanup.js';
import { createOrphanQuarantinePlan, quarantineOrphanObjects, restoreQuarantinedObject } from './storage-quarantine.js';
import { generationFailureAlertConfig, summarizeGenerationFailures } from './generation-failure-policy.js';

const CATEGORIES = new Set(['text', 'image', 'video']);
const BILLING_UNITS = new Set(['request', 'image', 'second']);
const TEXT_PROTOCOLS = new Set(['auto', 'openai-chat', 'openai-responses', 'anthropic-messages']);
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
  return { ...api, textProtocol: api.textProtocol || 'auto', baseUrl: vault.decrypt(api.baseUrl), apiKey: revealKey ? vault.decrypt(api.encryptedApiKey) : '', hasApiKey: Boolean(api.encryptedApiKey), encryptedApiKey: undefined };
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
  const textProtocol = String(input.textProtocol ?? existing?.textProtocol ?? 'auto').trim();
  if (!existing && apiKey.length < 8) throw new Error('API Key 长度不足');
  if (!TEXT_PROTOCOLS.has(textProtocol)) throw new Error('文本调用协议无效');
  return {
    name,
    provider,
    textProtocol,
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
  const normalizeResolution = (value) => {
    const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    if (normalized === '1k') return '1080p';
    if (category === 'video') return ['480p', '720p', '1080p', '2k', '4k'].includes(normalized) ? normalized : null;
    return normalized.length <= 32 && /^[a-z0-9_.:-]+$/.test(normalized) ? normalized : null;
  };
  const rawResolutions = input.allowedResolutions ?? existing?.allowedResolutions ?? [];
  const allowedResolutions = [...new Set((Array.isArray(rawResolutions) ? rawResolutions : String(rawResolutions).split(',')).map(normalizeResolution).filter(Boolean))];
  const rawMaxReferenceImages = input.maxReferenceImages ?? existing?.maxReferenceImages;
  const maxReferenceImages = rawMaxReferenceImages === undefined || rawMaxReferenceImages === null || rawMaxReferenceImages === ''
    ? 4 : integer(rawMaxReferenceImages);
  const parseReferenceLimit = (value, fallback) => value === undefined || value === null || value === '' ? fallback : integer(value);
  const maxReferenceAudios = parseReferenceLimit(input.maxReferenceAudios ?? existing?.maxReferenceAudios, 0);
  const maxReferenceVideos = parseReferenceLimit(input.maxReferenceVideos ?? existing?.maxReferenceVideos, 0);
  if (allowedDurationsSec.length) { minDurationSec = null; maxDurationSec = null; }
  if (!apiId || !modelId || !displayName) throw new Error('API、模型 ID 和显示名称不能为空');
  if (!CATEGORIES.has(category) || !BILLING_UNITS.has(billingUnit)) throw new Error('模型类别或计费单位无效');
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 10_000_000) throw new Error('模型价格必须是有效的分值');
  if ([minDurationSec, maxDurationSec, ...allowedDurationsSec].some((v) => Number.isNaN(v))) throw new Error('视频时长规则无效');
  if (category === 'video' && rawResolutions && allowedResolutions.length !== (Array.isArray(rawResolutions) ? rawResolutions.length : String(rawResolutions).split(',').map((value) => value.trim()).filter(Boolean).length)) throw new Error('视频分辨率仅支持 480p、720p、1080p、2K 或 4K');
  if (category === 'image' && rawResolutions && allowedResolutions.length !== (Array.isArray(rawResolutions) ? rawResolutions.length : String(rawResolutions).split(',').map((value) => value.trim()).filter(Boolean).length)) throw new Error('图片分辨率格式无效');
  if (!Number.isInteger(maxReferenceImages) || maxReferenceImages < 0 || maxReferenceImages > 30) throw new Error('最大参考图数量必须是 0-30 的整数');
  if (!Number.isInteger(maxReferenceAudios) || maxReferenceAudios < 0 || maxReferenceAudios > 10) throw new Error('最大参考音频数量必须是 0-10 的整数');
  if (!Number.isInteger(maxReferenceVideos) || maxReferenceVideos < 0 || maxReferenceVideos > 10) throw new Error('最大参考视频数量必须是 0-10 的整数');
  if (minDurationSec && maxDurationSec && maxDurationSec < minDurationSec) throw new Error('最长时长不能小于最短时长');
  if (category === 'video' && !allowedDurationsSec.length && (!minDurationSec || !maxDurationSec)) {
    throw new Error('视频模型必须填写固定时长，或同时填写最短和最长时长');
  }
  return { apiId, modelId, displayName, category, billingUnit, unitPriceCents, minDurationSec, maxDurationSec, allowedDurationsSec, allowedResolutions, maxReferenceImages, maxReferenceAudios, maxReferenceVideos, enabled: input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled) };
}

export function registerCatalogRoutes(router, { db, requireAuth }) {
  router.use(requireAuth);
  router.get('/models', (req, res) => {
    const apis = new Map(db.read('systemApis').filter((api) => api.enabled).map((api) => [api.id, api]));
    const access = new Map(db.read('userModelAccess').filter((item) => item.userId === req.user.id && item.enabled).map((item) => [item.pricingId, item]));
    const restricted = req.user.accountType === 'special' && req.user.role !== 'system';
    const models = db.read('modelPricing').filter((price) => price.enabled && apis.has(price.apiId) && (!restricted || access.has(price.id))).map((price) => {
      const api = apis.get(price.apiId);
      const grant = access.get(price.id);
      return {
        id: price.id, apiId: api.id, modelId: price.modelId, name: price.displayName,
        provider: api.provider, category: price.category, billingUnit: price.billingUnit,
        unitPriceCents: grant ? grant.unitPriceCents : price.unitPriceCents, baseUrl: `/api/system-ai/${api.id}`, managed: true,
        apiName: api.name,
        textProtocol: api.textProtocol || 'auto',
        minDurationSec: price.minDurationSec, maxDurationSec: price.maxDurationSec, allowedDurationsSec: price.allowedDurationsSec,
        allowedResolutions: (price.allowedResolutions?.length ? price.allowedResolutions : knownVideoResolutions(api.provider, price.modelId)),
        maxReferenceImages: Number.isInteger(Number(price.maxReferenceImages)) ? Number(price.maxReferenceImages) : 4,
        maxReferenceAudios: Number.isInteger(Number(price.maxReferenceAudios)) ? Number(price.maxReferenceAudios) : 0,
        maxReferenceVideos: Number.isInteger(Number(price.maxReferenceVideos)) ? Number(price.maxReferenceVideos) : 0,
      };
    });
    models.sort((a, b) => a.apiName.localeCompare(b.apiName, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'));
    return res.json({ models, balanceCents: Number(req.user.balanceCents || 0), role: req.user.role, accountType: req.user.accountType || 'user' });
  });
}

export function registerBillingRoutes(router, { db, requireAuth }) {
  router.use(requireAuth);
  router.get('/balance', (req, res) => {
    const user = db.read('users').find((item) => item.id === req.user.id);
    return res.json({ balanceCents: Number(user?.balanceCents || 0) });
  });
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

export function registerAdminRoutes(router, { db, requireSystem, vault, fetchImpl, resolveHost, videoQueue = null, backupStorage = null, backupEncryptionKey = '', monitoring = null, requestMetrics = null }) {
  router.use(requireSystem);
  let backupDrillRunning = false;
  let storageUsageCache = null;
  const cleanupPreviews = new Map();
  const quarantinePreviews = new Map();
  const audit = async (req, action, targetType, targetId, metadata = {}) => {
    const record = { id: randomUUID(), userId: req.user.id, action, targetType, targetId: targetId || null, ipAddress: String(req.ip || '').slice(0, 100), userAgent: String(req.get('user-agent') || '').slice(0, 300), metadata: { requestId: req.requestId || null, ...metadata }, createdAt: nowIso() };
    await db.mutate((data) => data.auditLogs.push(record));
    return record;
  };
  const requireCurrentPassword = async (req, res, action, targetType, targetId) => {
    const user = db.read('users').find((item) => item.id === req.user.id);
    if (user && await verifyPassword(String(req.body?.currentPassword || ''), user.passwordHash)) return true;
    await audit(req, `${action}_denied`, targetType, targetId);
    res.status(401).json({ error: 'PASSWORD_INVALID', message: '请先输入当前系统账号密码以确认此敏感操作' });
    return false;
  };
  router.get('/video-queue', (_req, res) => res.json(videoQueue ? videoQueue.overview() : {
    counts: { queued: 0, submitting: 0, processing: 0, completed: 0, failed: 0 },
    config: null, recent: [],
  }));
  router.get('/backups', async (_req, res, next) => {
    try {
      if (!backupStorage || typeof backupStorage.list !== 'function') return res.status(503).json({ error: 'BACKUP_STORAGE_UNAVAILABLE', message: 'Backup storage is not configured' });
      const events = db.read('auditLogs').filter((item) => item.targetType === 'backup').slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
      const eventsByKey = new Map(events.filter((item) => item.targetId).map((item) => [item.targetId, item]));
      const objects = (await backupStorage.list('backups/')).filter((item) => item.key.endsWith('.json')).sort((a, b) => String(b.lastModified || b.key).localeCompare(String(a.lastModified || a.key)));
      return res.json({
        configured: true, provider: backupStorage.provider, running: backupDrillRunning,
        policy: { retentionDays: Number(process.env.BACKUP_RETENTION_DAYS || 30), minimumCopies: Number(process.env.BACKUP_MINIMUM_COPIES || 7) },
        backups: objects.map((item) => ({ ...item, kind: item.key.includes('/drills/') ? 'drill' : 'scheduled', verification: eventsByKey.get(item.key)?.action || null })),
        events: events.map((item) => ({ id: item.id, action: item.action, objectKey: item.targetId, metadata: item.metadata, createdAt: item.createdAt })),
      });
    } catch (error) { return next(error); }
  });
  router.get('/storage-usage', async (_req, res, next) => {
    try {
      if (!backupStorage || typeof backupStorage.list !== 'function') {
        return res.status(503).json({ error: 'OBJECT_STORAGE_UNAVAILABLE', message: 'Object storage is not configured' });
      }
      const cacheMs = 5 * 60 * 1000;
      if (!storageUsageCache || Date.now() - storageUsageCache.generatedAtMs >= cacheMs) {
        const [objects, database] = await Promise.all([backupStorage.list(''), typeof db.storageStats === 'function' ? db.storageStats() : null]);
        const usage = summarizeStoredObjects(objects);
        storageUsageCache = { ...usage, database, generatedAt: nowIso(), generatedAtMs: Date.now() };
      }
      const warningBytes = Math.max(0, Number(process.env.OBJECT_STORAGE_WARNING_BYTES || 0));
      const databaseWarningBytes = Math.max(0, Number(process.env.ALERT_DATABASE_WARNING_BYTES || 0));
      return res.json({
        configured: true,
        provider: backupStorage.provider,
        generatedAt: storageUsageCache.generatedAt,
        objects: storageUsageCache.objects,
        bytes: storageUsageCache.bytes,
        groups: storageUsageCache.groups,
        database: storageUsageCache.database,
        warning: warningBytes > 0 && storageUsageCache.bytes >= warningBytes,
        warningBytes: warningBytes || null,
        databaseWarning: databaseWarningBytes > 0 && Number(storageUsageCache.database?.bytes || 0) >= databaseWarningBytes,
        databaseWarningBytes: databaseWarningBytes || null,
        infrastructure: monitoring?.snapshot?.().capacity?.infrastructure || null,
      });
    } catch (error) { return next(error); }
  });
  router.get('/storage-cleanup/preview', async (req, res, next) => {
    try {
      if (!backupStorage?.list || !backupStorage?.delete) return res.status(503).json({ error: 'OBJECT_STORAGE_UNAVAILABLE', message: 'Object storage is not configured' });
      const objects = await backupStorage.list('');
      const plan = createStorageCleanupPlan({
        objects,
        referencedKeys: referencedStorageKeys(db),
        retentionHours: Math.max(1, Number(process.env.HEALTHCHECK_OBJECT_RETENTION_HOURS || 24)),
        maxDeletes: Math.min(1000, Math.max(1, Number(process.env.STORAGE_CLEANUP_MAX_OBJECTS || 200))),
      });
      const previewId = randomUUID();
      const expiresAt = Date.now() + 5 * 60 * 1000;
      for (const [id, preview] of cleanupPreviews) if (preview.userId === req.user.id || preview.expiresAt <= Date.now()) cleanupPreviews.delete(id);
      cleanupPreviews.set(previewId, { userId: req.user.id, expiresAt, keys: plan.candidates.map((item) => item.key) });
      return res.json({ previewId, expiresAt: new Date(expiresAt).toISOString(), summary: plan.summary, policy: plan.policy });
    } catch (error) { return next(error); }
  });
  router.post('/storage-cleanup/execute', async (req, res, next) => {
    try {
      if (!(await requireCurrentPassword(req, res, 'storage_cleanup', 'object_storage', null))) return;
      if (!backupStorage?.list || !backupStorage?.delete) return res.status(503).json({ error: 'OBJECT_STORAGE_UNAVAILABLE', message: 'Object storage is not configured' });
      const preview = cleanupPreviews.get(String(req.body?.previewId || ''));
      if (!preview || preview.userId !== req.user.id || preview.expiresAt <= Date.now()) return res.status(409).json({ error: 'CLEANUP_PREVIEW_EXPIRED', message: 'Cleanup preview is missing or expired; create a new preview' });
      cleanupPreviews.delete(String(req.body.previewId));
      const objects = await backupStorage.list('');
      const plan = createStorageCleanupPlan({
        objects,
        referencedKeys: referencedStorageKeys(db),
        retentionHours: Math.max(1, Number(process.env.HEALTHCHECK_OBJECT_RETENTION_HOURS || 24)),
        maxDeletes: Math.min(1000, Math.max(1, Number(process.env.STORAGE_CLEANUP_MAX_OBJECTS || 200))),
      });
      const currentKeys = plan.candidates.map((item) => item.key);
      if (currentKeys.length !== preview.keys.length || currentKeys.some((key, index) => key !== preview.keys[index])) {
        return res.status(409).json({ error: 'CLEANUP_PREVIEW_CHANGED', message: 'Object storage changed; review a fresh cleanup preview' });
      }
      let deleted = 0; let deletedBytes = 0;
      for (const candidate of plan.candidates) {
        await backupStorage.delete(candidate.key);
        deleted += 1; deletedBytes += candidate.size;
      }
      storageUsageCache = null;
      await audit(req, 'storage_cleanup_completed', 'object_storage', null, { deleted, deletedBytes, prefix: plan.policy.prefix });
      return res.json({ deleted, deletedBytes, prefix: plan.policy.prefix });
    } catch (error) { return next(error); }
  });
  router.get('/storage-quarantine', (_req, res) => res.json({
    records: db.read('storageQuarantine').slice().sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt)).slice(0, 200).map((item) => ({
      id: item.id, objectType: item.objectType, objectSize: Number(item.objectSize || 0), status: item.status,
      quarantinedAt: item.quarantinedAt, deleteAfter: item.deleteAfter, restoredAt: item.restoredAt, deletedAt: item.deletedAt, errorCode: item.errorCode,
    })),
  }));
  router.get('/storage-quarantine/preview', async (req, res, next) => {
    try {
      if (!backupStorage?.list || !backupStorage?.move) return res.status(503).json({ error: 'QUARANTINE_UNAVAILABLE', message: 'Object storage does not support quarantine moves' });
      const plan = createOrphanQuarantinePlan({
        objects: await backupStorage.list(''), referencedKeys: referencedStorageKeys(db), quarantineRecords: db.read('storageQuarantine'),
        minAgeDays: Math.max(1, Number(process.env.ORPHAN_OBJECT_MIN_AGE_DAYS || 7)), maxObjects: Math.min(500, Math.max(1, Number(process.env.ORPHAN_QUARANTINE_MAX_OBJECTS || 100))),
      });
      plan.policy.retentionDays = Math.max(1, Number(process.env.QUARANTINE_RETENTION_DAYS || 7));
      const previewId = randomUUID(); const expiresAt = Date.now() + 5 * 60 * 1000;
      for (const [id, preview] of quarantinePreviews) if (preview.userId === req.user.id || preview.expiresAt <= Date.now()) quarantinePreviews.delete(id);
      quarantinePreviews.set(previewId, { userId: req.user.id, expiresAt, keys: plan.candidates.map((item) => item.key) });
      return res.json({ previewId, expiresAt: new Date(expiresAt).toISOString(), summary: plan.summary, policy: plan.policy });
    } catch (error) { return next(error); }
  });
  router.post('/storage-quarantine/execute', async (req, res, next) => {
    try {
      if (!(await requireCurrentPassword(req, res, 'storage_quarantine', 'object_storage', null))) return;
      const preview = quarantinePreviews.get(String(req.body?.previewId || ''));
      if (!preview || preview.userId !== req.user.id || preview.expiresAt <= Date.now()) return res.status(409).json({ error: 'QUARANTINE_PREVIEW_EXPIRED', message: 'Quarantine preview is missing or expired' });
      quarantinePreviews.delete(String(req.body.previewId));
      const plan = createOrphanQuarantinePlan({
        objects: await backupStorage.list(''), referencedKeys: referencedStorageKeys(db), quarantineRecords: db.read('storageQuarantine'),
        minAgeDays: Math.max(1, Number(process.env.ORPHAN_OBJECT_MIN_AGE_DAYS || 7)), maxObjects: Math.min(500, Math.max(1, Number(process.env.ORPHAN_QUARANTINE_MAX_OBJECTS || 100))),
      });
      const currentKeys = plan.candidates.map((item) => item.key);
      if (currentKeys.length !== preview.keys.length || currentKeys.some((key, index) => key !== preview.keys[index])) return res.status(409).json({ error: 'QUARANTINE_PREVIEW_CHANGED', message: 'Object storage changed; create a fresh preview' });
      const result = await quarantineOrphanObjects({ db, storage: backupStorage, candidates: plan.candidates, actorId: req.user.id, retentionDays: Math.max(1, Number(process.env.QUARANTINE_RETENTION_DAYS || 7)) });
      storageUsageCache = null;
      await audit(req, 'storage_quarantine_completed', 'object_storage', null, { quarantined: result.quarantined, failed: result.failed, bytes: result.bytes });
      return res.json({ quarantined: result.quarantined, failed: result.failed, bytes: result.bytes });
    } catch (error) { return next(error); }
  });
  router.post('/storage-quarantine/:id/restore', async (req, res, next) => {
    try {
      if (!(await requireCurrentPassword(req, res, 'storage_quarantine_restore', 'storage_quarantine', req.params.id))) return;
      const result = await restoreQuarantinedObject({ db, storage: backupStorage, id: req.params.id });
      if (!result.restored) return res.status(result.error === 'ORIGINAL_OBJECT_EXISTS' ? 409 : 404).json({ error: result.error });
      await audit(req, 'storage_quarantine_restored', 'storage_quarantine', req.params.id);
      return res.json(result);
    } catch (error) { return next(error); }
  });
  router.post('/backups/drill', async (req, res) => {
    if (!(await requireCurrentPassword(req, res, 'backup_drill_started', 'backup', null))) return;
    if (!backupStorage || String(backupEncryptionKey).length < 24) return res.status(503).json({ error: 'BACKUP_NOT_CONFIGURED', message: 'Backup storage or encryption key is not configured' });
    if (backupDrillRunning) return res.status(409).json({ error: 'BACKUP_DRILL_RUNNING', message: 'A backup drill is already running' });
    if (db.consumeRateLimit) {
      const lock = await db.consumeRateLimit('backup-drill-admin-lock', 1, 30 * 60 * 1000);
      if (!lock.allowed) return res.status(409).json({ error: 'BACKUP_DRILL_LOCKED', message: 'A backup drill was started recently' });
    }
    backupDrillRunning = true;
    const operationId = randomUUID();
    await audit(req, 'backup_drill_started', 'backup', operationId);
    void runBackupDrill({ db, storage: backupStorage, encryptionKey: backupEncryptionKey })
      .catch(() => undefined)
      .finally(() => { backupDrillRunning = false; });
    return res.status(202).json({ accepted: true, operationId });
  });
  router.get('/metrics', async (_req, res, next) => {
    try {
    const jobs = db.read('generationJobs');
    const now = Date.now();
    const since = now - (24 * 60 * 60 * 1000);
    const recent = jobs.filter((job) => Date.parse(job.createdAt) >= since);
    const completed = recent.filter((job) => job.status === 'completed');
    const failures = summarizeGenerationFailures(recent);
    const durations = completed.map((job) => Date.parse(job.completedAt || job.updatedAt) - Date.parse(job.createdAt)).filter((value) => value >= 0);
    const refundedCents = db.read('balanceTransactions').filter((item) => item.type === 'model_refund' && Date.parse(item.createdAt) >= since).reduce((sum, item) => sum + Number(item.amountCents || 0), 0);
    const archivedJobIds = new Set(db.read('generatedMedia').map((item) => item.jobId));
    return res.json({
      generatedAt: nowIso(), windowHours: 24,
      http: requestMetrics?.snapshotPersistent ? await requestMetrics.snapshotPersistent() : requestMetrics?.snapshot?.() || null,
      queue: videoQueue ? videoQueue.overview().counts : { queued: 0, submitting: 0, processing: 0, completed: 0, failed: 0 },
      recent: {
        total: recent.length, completed: completed.length,
        failed: recent.filter((job) => job.status === 'failed').length,
        cancelled: recent.filter((job) => job.status === 'cancelled').length,
        activeUsers: new Set(recent.map((job) => job.userId)).size,
        averageCompletionMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
        refundedCents,
        archiveFallbacks: completed.filter((job) => job.resultUrl && !archivedJobIds.has(job.id)).length,
        failureRate: recent.length ? Number((recent.filter((job) => job.status === 'failed').length / recent.length).toFixed(4)) : 0,
        operationalFailureRate: failures.operationalFailureRate,
        operationalFailed: failures.operationalFailed,
        excludedFailed: failures.excludedFailed,
        moderationFailed: failures.moderationFailed,
        queueBacklog: recent.filter((job) => ['queued', 'submitting', 'processing'].includes(job.status)).length,
        averageQueueWaitMs: (() => { const waits = recent.map((job) => Date.parse(job.submittedAt) - Date.parse(job.createdAt)).filter((value) => Number.isFinite(value) && value >= 0); return waits.length ? Math.round(waits.reduce((sum, value) => sum + value, 0) / waits.length) : null; })(),
      },
    });
    } catch (error) { return next(error); }
  });
  router.get('/security-alerts', (_req, res) => {
    const since = Date.now() - (24 * 60 * 60 * 1000);
    const logs = db.read('auditLogs').filter((log) => Date.parse(log.createdAt) >= since);
    const failedByIp = new Map();
    logs.filter((log) => log.action === 'login_failed').forEach((log) => failedByIp.set(log.ipAddress, (failedByIp.get(log.ipAddress) || 0) + 1));
    const loginBruteForce = [...failedByIp.entries()].filter(([, count]) => count >= 5).map(([ipAddress, count]) => ({ ipAddress, count }));
    const privilegedActions = logs.filter((log) => ['system_api_revealed', 'user_role_updated', 'user_balance_adjusted', 'payment_refund_requested'].includes(log.action)).length;
    const modelCalls = logs.filter((log) => log.action === 'managed_model_requested').length;
    return res.json({ generatedAt: nowIso(), windowHours: 24, alerts: { loginBruteForce, privilegedActions, modelCalls }, recentSecurityEvents: logs.filter((log) => log.targetType === 'security').slice(-100).reverse() });
  });
  router.get('/operations-alerts', (_req, res) => {
    const now = Date.now();
    const since = now - (24 * 60 * 60 * 1000);
    const jobs = db.read('generationJobs');
    const recent = jobs.filter((job) => Date.parse(job.createdAt) >= since);
    const backlog = jobs.filter((job) => ['queued', 'submitting', 'processing'].includes(job.status));
    const failures = summarizeGenerationFailures(recent);
    const queueThreshold = Math.max(1, Number.parseInt(process.env.ALERT_QUEUE_BACKLOG || '25', 10) || 25);
    const failureAlert = generationFailureAlertConfig(process.env);
    const delayedThresholdMs = Math.max(60_000, (Number.parseInt(process.env.ALERT_PROCESSING_MINUTES || '30', 10) || 30) * 60_000);
    const delayed = backlog.filter((job) => job.status === 'processing' && now - Date.parse(job.updatedAt || job.createdAt) >= delayedThresholdMs)
      .map((job) => ({ jobId: job.id, userId: job.userId, apiId: job.apiId, updatedAt: job.updatedAt }));
    const backupMaxAgeHours = Math.max(1, Number.parseInt(process.env.ALERT_BACKUP_MAX_AGE_HOURS || '12', 10) || 12);
    const backupEvents = db.read('auditLogs').filter((item) => item.targetType === 'backup');
    const latestBackup = backupEvents.filter((item) => ['backup_completed', 'backup_drill_completed'].includes(item.action)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const latestBackupFailure = backupEvents.filter((item) => ['backup_failed', 'backup_drill_failed'].includes(item.action)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const backupStale = !latestBackup || now - Date.parse(latestBackup.createdAt) >= backupMaxAgeHours * 60 * 60 * 1000;
    const backupFailed = latestBackupFailure && (!latestBackup || latestBackupFailure.createdAt > latestBackup.createdAt);
    const capacityAlerts = (monitoring?.snapshot?.().alerts || []).filter((item) => item.code === 'DATABASE_CAPACITY_WARNING' || item.code === 'OBJECT_STORAGE_CAPACITY_WARNING');
    const alerts = [
      ...(backlog.length >= queueThreshold ? [{ code: 'QUEUE_BACKLOG', severity: 'warning', count: backlog.length, threshold: queueThreshold }] : []),
      ...(failures.operationalFailed >= failureAlert.minimumCount && failures.operationalFailureRate >= failureAlert.threshold
        ? [{ code: 'GENERATION_FAILURE_RATE', severity: 'warning', count: failures.operationalFailed, total: failures.eligibleTerminalJobs, rate: failures.operationalFailureRate, threshold: failureAlert.threshold, minimumCount: failureAlert.minimumCount }]
        : []),
      ...(delayed.length ? [{ code: 'PROCESSING_DELAYED', severity: 'warning', count: delayed.length, thresholdMinutes: Math.round(delayedThresholdMs / 60_000) }] : []),
      ...(backupFailed ? [{ code: 'BACKUP_FAILED', severity: 'critical', count: 1, occurredAt: latestBackupFailure.createdAt }] : []),
      ...(backupStale ? [{ code: 'BACKUP_STALE', severity: 'critical', count: 1, thresholdHours: backupMaxAgeHours, lastSuccessAt: latestBackup?.createdAt || null }] : []),
      ...capacityAlerts.map((item) => ({ ...item, severity: 'warning', count: 1 })),
    ];
    return res.json({
      generatedAt: nowIso(), windowHours: 24, healthy: alerts.length === 0, alerts, delayed,
      generationFailures: { ...failures, threshold: failureAlert.threshold, minimumCount: failureAlert.minimumCount },
      backup: { lastSuccessAt: latestBackup?.createdAt || null, lastFailureAt: latestBackupFailure?.createdAt || null },
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
  router.get('/users/:id/model-access', (req, res) => {
    const user = db.read('users').find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    const grants = db.read('userModelAccess').filter((item) => item.userId === user.id);
    return res.json({ user: safeUser(user), access: grants, pricing: db.read('modelPricing') });
  });
  router.put('/users/:id/model-access', async (req, res) => {
    const user = db.read('users').find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    const entries = Array.isArray(req.body?.models) ? req.body.models : [];
    const valid = new Map(db.read('modelPricing').map((item) => [item.id, item]));
    const normalized = entries.map((entry) => ({ pricingId: String(entry.pricingId || ''), unitPriceCents: integer(entry.unitPriceCents), enabled: entry.enabled !== false })).filter((entry) => valid.has(entry.pricingId));
    if (normalized.some((entry) => !Number.isInteger(entry.unitPriceCents) || entry.unitPriceCents < 0 || entry.unitPriceCents > 10_000_000)) return res.status(400).json({ error: 'INVALID_MODEL_PRICE', message: '特殊用户模型价格无效' });
    const now = nowIso();
    await db.mutate((data) => {
      data.userModelAccess = data.userModelAccess.filter((item) => item.userId !== user.id);
      data.userModelAccess.push(...normalized.map((entry) => ({ id: randomUUID(), userId: user.id, ...entry, createdAt: now, updatedAt: now })));
      user.accountType = 'special';
    });
    await audit(req, 'user_model_access_updated', 'user', user.id, { modelCount: normalized.length });
    return res.json({ access: db.read('userModelAccess').filter((item) => item.userId === user.id) });
  });
  router.patch('/users/:id/role', async (req, res) => {
    const role = String(req.body.role || '');
    if (!['user', 'system'].includes(role)) return res.status(400).json({ error: 'INVALID_ROLE', message: '角色无效' });
    if (req.params.id === req.user.id && role !== 'system') return res.status(400).json({ error: 'SELF_DEMOTION_FORBIDDEN', message: '不能取消自己的系统用户权限' });
    if (!(await requireCurrentPassword(req, res, 'user_role_updated', 'user', req.params.id))) return;
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
    if (!(await requireCurrentPassword(req, res, 'user_balance_adjusted', 'user', req.params.id))) return;
    const suppliedKey = String(req.get('idempotency-key') || '').trim();
    if (suppliedKey && !/^[A-Za-z0-9_-]{16,100}$/.test(suppliedKey)) return res.status(400).json({ error: 'INVALID_IDEMPOTENCY_KEY', message: '幂等键无效' });
    const referenceId = suppliedKey ? `admin-balance:${req.user.id}:${req.params.id}:${suppliedKey}` : null;
    const existingTransaction = referenceId && db.read('balanceTransactions').find((item) => item.referenceId === referenceId && item.type === 'admin_adjustment');
    if (existingTransaction) {
      const user = db.read('users').find((item) => item.id === req.params.id);
      return res.json({ user: safeUser(user || { id: req.params.id, balanceCents: 0 }), transaction: existingTransaction, replayed: true });
    }
    if (db.changeBalanceAtomic) {
      const result = await db.changeBalanceAtomic({ userId: req.params.id, amountCents, type: 'admin_adjustment', description: String(req.body.description || '系统用户调整余额').slice(0, 300), referenceId, createdBy: req.user.id });
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
      transaction = { id: randomUUID(), userId: user.id, amountCents, type: 'admin_adjustment', description: String(req.body.description || '系统用户调整余额').slice(0, 300), referenceId, createdBy: req.user.id, createdAt: nowIso() };
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
  // Keep the literal batch route ahead of the parameter route so Express does not
  // interpret "batch" as a pricing record id.
  router.put('/pricing/batch', async (req, res) => {
    const entries = Array.isArray(req.body?.pricing) ? req.body.pricing : [];
    let updated = []; let failure = null;
    try {
      await db.mutate((data) => {
        for (const entry of entries) {
          const pricing = data.modelPricing.find((item) => item.id === String(entry.id || ''));
          if (!pricing) { failure = 'PRICING_NOT_FOUND'; break; }
          const normalized = normalizePricingInput(entry, pricing);
          Object.assign(pricing, normalized, { updatedAt: nowIso() });
        }
        if (!failure) updated = entries.map((entry) => data.modelPricing.find((item) => item.id === String(entry.id))).filter(Boolean).map((item) => ({ ...item }));
      });
    } catch (error) { return res.status(400).json({ error: 'PRICING_VALIDATION_ERROR', message: error.message }); }
    if (failure) return res.status(404).json({ error: failure, message: '模型定价不存在' });
    await audit(req, 'model_pricing_batch_updated', 'model_pricing', null, { count: updated.length });
    return res.json({ pricing: updated });
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
  router.put('/pricing/batch', async (req, res) => {
    const entries = Array.isArray(req.body?.pricing) ? req.body.pricing : [];
    let updated = []; let failure = null;
    try {
      await db.mutate((data) => {
        for (const entry of entries) {
          const pricing = data.modelPricing.find((item) => item.id === String(entry.id || ''));
          if (!pricing) { failure = 'PRICING_NOT_FOUND'; break; }
          const normalized = normalizePricingInput(entry, pricing);
          Object.assign(pricing, normalized, { updatedAt: nowIso() });
        }
        if (!failure) updated = entries.map((entry) => data.modelPricing.find((item) => item.id === String(entry.id))).filter(Boolean).map((item) => ({ ...item }));
      });
    } catch (error) { return res.status(400).json({ error: 'PRICING_VALIDATION_ERROR', message: error.message }); }
    if (failure) return res.status(404).json({ error: failure, message: '模型定价不存在' });
    await audit(req, 'model_pricing_batch_updated', 'model_pricing', null, { count: updated.length });
    return res.json({ pricing: updated });
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
