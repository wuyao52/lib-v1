import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { Activity, Archive, Check, Cloud, Coins, Copy, Database, Eye, EyeOff, HardDrive, Pencil, Play, Plus, RefreshCw, Shield, Trash2, Wallet, X } from 'lucide-react';
import { apiRequest } from '@/services/apiClient';
import { useAuth, type AuthUser } from '@/auth/AuthContext';

type Transaction = { id: string; amountCents: number; type: string; description: string; createdAt: string };
type Recharge = { id: string; amountCents: number; status: string; note: string; createdAt: string; user?: AuthUser };
type PaymentOrder = { id: string; userId?: string; provider: 'alipay' | 'wechat'; amountCents: number; status: string; payUrl: string; createdAt: string; paidAt?: string | null };
type TextProtocol = 'auto' | 'openai-chat' | 'openai-responses' | 'anthropic-messages';
type SystemApi = { id: string; name: string; provider: string; textProtocol: TextProtocol; baseUrl: string; apiKey: string; enabled: boolean };
type Pricing = { id: string; apiId: string; modelId: string; displayName: string; category: string; billingUnit: string; unitPriceCents: number; minDurationSec?: number | null; maxDurationSec?: number | null; allowedDurationsSec?: number[]; allowedResolutions?: string[]; maxReferenceImages?: number; maxReferenceAudios?: number; maxReferenceVideos?: number; enabled: boolean };
type DiscoveredModel = { id: string; name: string; type: string; supportedResolutions?: string[]; allowedDurationsSec?: number[]; supportedRatios?: string[]; maxReferenceImages?: number; maxReferenceAudios?: number; maxReferenceVideos?: number };
type QueueOverview = {
  counts: Record<'queued' | 'submitting' | 'processing' | 'completed' | 'failed', number>;
  config: { globalConcurrency: number; userConcurrency: number; apiConcurrency: number; maxQueuePerUser: number } | null;
  recent: Array<{ id: string; userId: string; modelId: string; status: string; progress: number; errorCode?: string | null; createdAt: string }>;
};
type AdminMetrics = { http: { total: number; p95Ms: number | null; p99Ms: number | null; errorRate: number; serverErrorRate: number; managedAi: { total: number; errorRate: number; serverErrorRate: number } } | null; recent: { total: number; completed: number; failed: number; activeUsers: number; failureRate: number; queueBacklog: number; averageQueueWaitMs: number | null } };
type OperationsAlerts = { healthy: boolean; alerts: Array<{ code: string; severity: string; count: number; total?: number; rate?: number; threshold?: number; thresholdMinutes?: number; thresholdHours?: number }>; delayed: Array<{ jobId: string; userId: string; apiId: string; updatedAt: string }>; backup?: { lastSuccessAt: string | null; lastFailureAt: string | null } };
type SecurityAlerts = { alerts: { loginBruteForce: Array<{ ipAddress: string; count: number }>; privilegedActions: number; modelCalls: number } };
type BackupOverview = {
  configured: boolean;
  provider: string;
  running: boolean;
  policy: { retentionDays: number; minimumCopies: number };
  backups: Array<{ key: string; size: number; lastModified: string | null; kind: 'drill' | 'scheduled'; verification: string | null }>;
  events: Array<{ id: string; action: string; objectKey: string | null; createdAt: string }>;
};
type StorageUsage = { provider: string; objects: number; bytes: number; warning: boolean; warningBytes: number | null; databaseWarning: boolean; databaseWarningBytes: number | null; database: { provider: string; bytes: number; rows: number } | null; infrastructure: { source: string; usedBytes: number; totalBytes: number; usagePercent: number; reportedAt: string; stale: boolean } | null; groups: Array<{ prefix: string; objects: number; bytes: number }> };
type StorageCleanupPreview = { previewId: string; expiresAt: string; summary: { candidates: number; candidateBytes: number; referenced: number; referencedBytes: number; recentHealthchecks: number; limited: boolean }; policy: { prefix: string; retentionHours: number; maxDeletes: number } };
type QuarantinePreview = { previewId: string; expiresAt: string; summary: { candidates: number; candidateBytes: number; referenced: number; tooRecent: number; tracked: number; limited: boolean }; policy: { minAgeDays: number; maxObjects: number; retentionDays: number } };
type QuarantineRecord = { id: string; objectType: 'asset' | 'generated_video'; objectSize: number; status: string; quarantinedAt: string; deleteAfter: string; restoredAt?: string | null; deletedAt?: string | null; errorCode?: string | null };
type ProviderFlags = Record<'alipay' | 'wechat', boolean>;
type BillingProps = { balance: number; transactions: Transaction[]; recharges: Recharge[]; amount: string; setAmount: (value: string) => void; providers: ProviderFlags; provider: 'alipay' | 'wechat'; setProvider: (value: 'alipay' | 'wechat') => void; orders: PaymentOrder[]; startPayment: () => void };
type AdminUsersProps = { users: AuthUser[]; currentUserId?: string; recharges: Recharge[]; pricing: Pricing[]; accessUserId: string | null; accessDraft: Record<string, { enabled: boolean; price: string }>; balanceAdjustments: Record<string, string>; setBalanceAdjustments: (value: Record<string, string>) => void; setAccessDraft: (value: Record<string, { enabled: boolean; price: string }> | ((current: Record<string, { enabled: boolean; price: string }>) => Record<string, { enabled: boolean; price: string }>)) => void; currentPassword: string; act: (job: () => Promise<unknown>, success: string) => Promise<void>; loadModelAccess: (userId: string) => Promise<void>; saveModelAccess: () => Promise<void> };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求失败';

const yuan = (cents: number) => `¥${(Number(cents || 0) / 100).toFixed(2)}`;
const field = 'w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded text-sm text-white focus:outline-none focus:border-primary-500';
const emptyApi: { name: string; provider: string; textProtocol: TextProtocol; baseUrl: string; apiKey: string } = { name: '', provider: '', textProtocol: 'auto', baseUrl: '', apiKey: '' };
const emptyPrice = { apiId: '', modelId: '', displayName: '', category: 'text', billingUnit: 'request', priceYuan: '', minDurationSec: '', maxDurationSec: '', allowedDurations: '', allowedResolutions: '', maxReferenceImages: '4', maxReferenceAudios: '0', maxReferenceVideos: '0' };

function AccountCenterContent({ mode, onClose }: { mode: 'billing' | 'admin'; onClose: () => void }) {
  const { user, refresh } = useAuth();
  const [balance, setBalance] = useState(0);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [recharges, setRecharges] = useState<Recharge[]>([]);
  const [apis, setApis] = useState<SystemApi[]>([]);
  const [pricing, setPricing] = useState<Pricing[]>([]);
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [accessUserId, setAccessUserId] = useState<string | null>(null);
  const [accessDraft, setAccessDraft] = useState<Record<string, { enabled: boolean; price: string }>>({});
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({});
  const [revealPasswords, setRevealPasswords] = useState<Record<string, string>>({});
  const [apiForm, setApiForm] = useState(emptyApi);
  const [priceForm, setPriceForm] = useState(emptyPrice);
  const [editingApiId, setEditingApiId] = useState<string | null>(null);
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [balanceAdjustments, setBalanceAdjustments] = useState<Record<string, string>>({});
  const [adminPassword, setAdminPassword] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [queue, setQueue] = useState<QueueOverview | null>(null);
  const [paymentProviders, setPaymentProviders] = useState<Record<'alipay' | 'wechat', boolean>>({ alipay: false, wechat: false });
  const [paymentOrders, setPaymentOrders] = useState<PaymentOrder[]>([]);
  const [paymentProvider, setPaymentProvider] = useState<'alipay' | 'wechat'>('alipay');
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [operationsAlerts, setOperationsAlerts] = useState<OperationsAlerts | null>(null);
  const [securityAlerts, setSecurityAlerts] = useState<SecurityAlerts | null>(null);
  const [backupOverview, setBackupOverview] = useState<BackupOverview | null>(null);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [storageCleanup, setStorageCleanup] = useState<StorageCleanupPreview | null>(null);
  const [quarantinePreview, setQuarantinePreview] = useState<QuarantinePreview | null>(null);
  const [quarantineRecords, setQuarantineRecords] = useState<QuarantineRecord[]>([]);

  const loadBackups = useCallback(async () => {
    const data = await apiRequest<BackupOverview>('/api/admin/backups');
    setBackupOverview(data);
    return data;
  }, []);

  const load = useCallback(async () => {
    if (mode === 'billing') {
      const [data, providerData, orderData] = await Promise.all([
        apiRequest<{ balanceCents: number; transactions: Transaction[]; recharges: Recharge[] }>('/api/billing/me'),
        apiRequest<{ providers: Record<'alipay' | 'wechat', boolean> }>('/api/payments/providers'),
        apiRequest<{ orders: PaymentOrder[] }>('/api/payments/orders'),
      ]);
      setBalance(data.balanceCents); setTransactions(data.transactions); setRecharges(data.recharges);
      setPaymentProviders(providerData.providers); setPaymentOrders(orderData.orders);
      return;
    }
    // Load the controls needed to render the admin view first. Heavy operational
    // reports continue in the background and no longer delay the first paint.
    const [apiData, priceData, userData, rechargeData, queueData, paymentData] = await Promise.all([
      apiRequest<{ apis: SystemApi[] }>('/api/admin/system-apis'),
      apiRequest<{ pricing: Pricing[] }>('/api/admin/pricing'),
      apiRequest<{ users: AuthUser[] }>('/api/admin/users'),
      apiRequest<{ recharges: Recharge[] }>('/api/admin/recharges'),
      apiRequest<QueueOverview>('/api/admin/video-queue'),
      apiRequest<{ orders: PaymentOrder[] }>('/api/payments/admin/orders'),
    ]);
    const nextApis = Array.isArray(apiData.apis) ? apiData.apis : [];
    const nextPricing = Array.isArray(priceData.pricing) ? priceData.pricing : [];
    const nextUsers = Array.isArray(userData.users) ? userData.users : [];
    const nextRecharges = Array.isArray(rechargeData.recharges) ? rechargeData.recharges : [];
    setApis(nextApis); setPricing(nextPricing); setPriceDrafts(Object.fromEntries(nextPricing.map((item) => [item.id, String(item.unitPriceCents / 100)]))); setUsers(nextUsers); setRecharges(nextRecharges);
    setQueue({
      counts: queueData && typeof queueData.counts === 'object' ? queueData.counts : { queued: 0, submitting: 0, processing: 0, completed: 0, failed: 0 },
      config: queueData?.config || null,
      recent: Array.isArray(queueData?.recent) ? queueData.recent : [],
    });
    setPaymentOrders(Array.isArray(paymentData.orders) ? paymentData.orders : []);
    void Promise.all([
      apiRequest<AdminMetrics>('/api/admin/metrics'),
      apiRequest<OperationsAlerts>('/api/admin/operations-alerts'),
      apiRequest<SecurityAlerts>('/api/admin/security-alerts'),
      apiRequest<BackupOverview>('/api/admin/backups').catch(() => null),
      apiRequest<StorageUsage>('/api/admin/storage-usage').catch(() => null),
      apiRequest<{ records: QuarantineRecord[] }>('/api/admin/storage-quarantine').catch(() => ({ records: [] })),
    ]).then(([metricData, operationData, securityData, backupData, storageData, quarantineData]) => {
      setMetrics(metricData && typeof metricData === 'object' ? metricData : null); setOperationsAlerts(operationData && typeof operationData === 'object' ? operationData : null); setSecurityAlerts(securityData && typeof securityData === 'object' ? securityData : null);
      setBackupOverview(backupData && typeof backupData === 'object' ? { ...backupData, backups: Array.isArray(backupData.backups) ? backupData.backups : [], events: Array.isArray(backupData.events) ? backupData.events : [] } : null); setStorageUsage(storageData && typeof storageData === 'object' ? storageData : null); setQuarantineRecords(Array.isArray(quarantineData?.records) ? quarantineData.records : []);
    }).catch(() => undefined);
  }, [mode]);

  useEffect(() => { load().catch((error) => setMessage(error.message)); }, [load]);

  useEffect(() => {
    if (mode !== 'admin') return undefined;
    const refreshLiveData = () => {
      if (document.visibilityState === 'hidden') return;
      void Promise.all([
        apiRequest<QueueOverview>('/api/admin/video-queue'),
        apiRequest<AdminMetrics>('/api/admin/metrics'),
        apiRequest<OperationsAlerts>('/api/admin/operations-alerts'),
        apiRequest<SecurityAlerts>('/api/admin/security-alerts'),
      ]).then(([queueData, metricData, operationData, securityData]) => {
        setQueue({ counts: queueData && typeof queueData.counts === 'object' ? queueData.counts : { queued: 0, submitting: 0, processing: 0, completed: 0, failed: 0 }, config: queueData?.config || null, recent: Array.isArray(queueData?.recent) ? queueData.recent : [] }); setMetrics(metricData && typeof metricData === 'object' ? metricData : null); setOperationsAlerts(operationData && typeof operationData === 'object' ? operationData : null); setSecurityAlerts(securityData && typeof securityData === 'object' ? securityData : null);
      }).catch(() => undefined);
    };
    const timer = window.setInterval(refreshLiveData, 15_000);
    document.addEventListener('visibilitychange', refreshLiveData);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshLiveData); };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'admin' || !backupOverview?.running) return undefined;
    const timer = window.setInterval(() => { void loadBackups().catch(() => undefined); }, 15000);
    return () => window.clearInterval(timer);
  }, [backupOverview?.running, loadBackups, mode]);

  const act = async (job: () => Promise<unknown>, success: string) => {
    try { await job(); await load(); await refresh(); setMessage(success); } catch (error: any) { setMessage(error.message); }
  };

  const startPayment = async () => {
    try {
      const { order } = await apiRequest<{ order: PaymentOrder }>('/api/payments/orders', { method: 'POST', body: JSON.stringify({ provider: paymentProvider, amountCents: Math.round(Number(amount) * 100) }) });
      window.location.assign(order.payUrl);
    } catch (error: any) { setMessage(error.message); }
  };

  const startBackupDrill = async () => {
    if (!adminPassword) return setMessage('开始恢复演练前请输入当前系统账号密码');
    try {
      await apiRequest<{ accepted: true; operationId: string }>('/api/admin/backups/drill', { method: 'POST', body: JSON.stringify({ currentPassword: adminPassword }) });
      await loadBackups();
      setMessage('后台恢复演练已启动。只有出现“验证完成”事件后才代表演练成功。');
    } catch (error) { setMessage(errorMessage(error)); }
  };

  const previewStorageCleanup = async () => {
    try {
      const preview = await apiRequest<StorageCleanupPreview>('/api/admin/storage-cleanup/preview');
      setStorageCleanup(preview);
      setMessage(`清理预览已生成：可安全删除 ${preview.summary.candidates} 个临时对象。`);
    } catch (error) { setMessage(errorMessage(error)); }
  };

  const executeStorageCleanup = async () => {
    if (!storageCleanup) return setMessage('请先生成清理预览');
    if (!adminPassword) return setMessage('执行清理前请输入当前系统账号密码');
    try {
      const result = await apiRequest<{ deleted: number; deletedBytes: number }>('/api/admin/storage-cleanup/execute', { method: 'POST', body: JSON.stringify({ previewId: storageCleanup.previewId, currentPassword: adminPassword }) });
      setStorageCleanup(null);
      setMessage(`清理完成：删除 ${result.deleted} 个临时对象。`);
      await load();
    } catch (error) { setMessage(errorMessage(error)); }
  };

  const previewQuarantine = async () => {
    try { const preview = await apiRequest<QuarantinePreview>('/api/admin/storage-quarantine/preview'); setQuarantinePreview(preview); setMessage(`发现 ${preview.summary.candidates} 个可隔离孤立对象。`); }
    catch (error) { setMessage(errorMessage(error)); }
  };

  const executeQuarantine = async () => {
    if (!quarantinePreview) return setMessage('请先生成孤立对象预览');
    if (!adminPassword) return setMessage('执行隔离前请输入当前系统账号密码');
    try {
      const result = await apiRequest<{ quarantined: number; failed: number }>('/api/admin/storage-quarantine/execute', { method: 'POST', body: JSON.stringify({ previewId: quarantinePreview.previewId, currentPassword: adminPassword }) });
      setQuarantinePreview(null); await load(); setMessage(`已隔离 ${result.quarantined} 个对象，失败 ${result.failed} 个。`);
    } catch (error) { setMessage(errorMessage(error)); }
  };

  const restoreQuarantine = async (id: string) => {
    if (!adminPassword) return setMessage('恢复对象前请输入当前系统账号密码');
    try { await apiRequest(`/api/admin/storage-quarantine/${id}/restore`, { method: 'POST', body: JSON.stringify({ currentPassword: adminPassword }) }); await load(); setMessage('隔离对象已恢复到原位置。'); }
    catch (error) { setMessage(errorMessage(error)); }
  };

  const revealApiKey = async (apiId: string) => {
    if (showKeys[apiId]) {
      setShowKeys((current) => ({ ...current, [apiId]: false }));
      setRevealedKeys((current) => ({ ...current, [apiId]: '' }));
      return;
    }
    const password = revealPasswords[apiId] || '';
    if (!password) return setMessage('查看系统 API Key 前请输入当前登录密码');
    try {
      const result = await apiRequest<{ apiKey: string }>(`/api/admin/system-apis/${apiId}/reveal`, { method: 'POST', body: JSON.stringify({ password }) });
      setRevealedKeys((current) => ({ ...current, [apiId]: result.apiKey }));
      setShowKeys((current) => ({ ...current, [apiId]: true }));
      setRevealPasswords((current) => ({ ...current, [apiId]: '' }));
      setMessage('密钥已解锁，将在 60 秒后自动隐藏；本次查看已记录审计日志。');
      window.setTimeout(() => {
        setShowKeys((current) => ({ ...current, [apiId]: false }));
        setRevealedKeys((current) => ({ ...current, [apiId]: '' }));
      }, 60000);
    } catch (error: any) { setMessage(error.message); }
  };

  const discoverApi = async () => {
    setIsDiscovering(true); setMessage('正在从 API 读取服务信息和模型目录...');
    try {
      const result = await apiRequest<{ name: string; provider: string; models: DiscoveredModel[] }>('/api/admin/system-apis/discover', {
        method: 'POST', body: JSON.stringify({ apiId: editingApiId, baseUrl: apiForm.baseUrl, apiKey: apiForm.apiKey }),
      });
      setApiForm((current) => ({ ...current, name: result.name, provider: result.provider }));
      setDiscoveredModels(result.models);
      setMessage(`识别成功：${result.provider}，读取到 ${result.models.length} 个模型。名称和服务商仍可手动修改。`);
    } catch (error: any) { setMessage(error.message); } finally { setIsDiscovering(false); }
  };

  const saveApi = async () => {
    try {
      const result = await apiRequest<{ api: SystemApi }>(editingApiId ? `/api/admin/system-apis/${editingApiId}` : '/api/admin/system-apis', {
        method: editingApiId ? 'PUT' : 'POST', body: JSON.stringify(apiForm),
      });
      setPriceForm((current) => ({ ...current, apiId: result.api.id }));
      setApiForm(emptyApi); setEditingApiId(null);
      await load();
      setMessage('系统 API 已保存。可在下方选择该 API 并读取模型进行定价。');
    } catch (error: any) { setMessage(error.message); }
  };

  const selectDiscoveredModel = (modelId: string) => {
    const model = discoveredModels.find((item) => item.id === modelId);
    setPriceForm((current) => ({ ...current, modelId, displayName: model?.name || current.displayName, category: model?.type || current.category, allowedDurations: model?.allowedDurationsSec?.join(',') || current.allowedDurations, allowedResolutions: model?.supportedResolutions?.join(',') || current.allowedResolutions, maxReferenceImages: model?.maxReferenceImages === undefined ? current.maxReferenceImages : String(model.maxReferenceImages), maxReferenceAudios: model?.maxReferenceAudios === undefined ? current.maxReferenceAudios : String(model.maxReferenceAudios), maxReferenceVideos: model?.maxReferenceVideos === undefined ? current.maxReferenceVideos : String(model.maxReferenceVideos) }));
  };

  const loadModelsForPricing = async (apiId: string, resetSelection = true) => {
    if (resetSelection) setPriceForm((current) => ({ ...current, apiId, modelId: '', displayName: '' }));
    if (!apiId) { setDiscoveredModels([]); return; }
    setIsDiscovering(true); setMessage('正在读取所选系统 API 的模型目录...');
    try {
      const result = await apiRequest<{ provider: string; models: DiscoveredModel[] }>('/api/admin/system-apis/discover', { method: 'POST', body: JSON.stringify({ apiId }) });
      setDiscoveredModels(result.models);
      setMessage(`已从 ${result.provider} 读取 ${result.models.length} 个模型，请选择一个模型定价。`);
    } catch (error: any) { setDiscoveredModels([]); setMessage(error.message); } finally { setIsDiscovering(false); }
  };

  const submitPricing = async () => {
    const unitPriceCents = Math.round(Number(priceForm.priceYuan) * 100);
    const fixedDurations = priceForm.allowedDurations.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0);
    if (!priceForm.apiId) return setMessage('请先选择一个已保存的系统 API');
    if (!priceForm.modelId || !priceForm.displayName) return setMessage('请选择模型并填写显示名称');
    if (!Number.isFinite(unitPriceCents) || unitPriceCents < 0) return setMessage('请输入有效的模型单价');
    if (priceForm.category === 'video' && !fixedDurations.length && (!priceForm.minDurationSec || !priceForm.maxDurationSec)) {
      return setMessage('视频模型必须填写固定时长，或同时填写最短和最长时长');
    }
    try {
      await apiRequest(editingPriceId ? `/api/admin/pricing/${editingPriceId}` : '/api/admin/pricing', {
        method: editingPriceId ? 'PUT' : 'POST',
        body: JSON.stringify({ ...priceForm, unitPriceCents, minDurationSec: fixedDurations.length ? null : priceForm.minDurationSec, maxDurationSec: fixedDurations.length ? null : priceForm.maxDurationSec, allowedDurationsSec: fixedDurations, allowedResolutions: priceForm.allowedResolutions.split(',').map((value) => value.trim()).filter(Boolean), maxReferenceImages: priceForm.maxReferenceImages, maxReferenceAudios: priceForm.maxReferenceAudios, maxReferenceVideos: priceForm.maxReferenceVideos }),
      });
      const selectedApiId = priceForm.apiId;
      const wasEditing = Boolean(editingPriceId);
      setEditingPriceId(null);
      setPriceForm((current) => ({ ...emptyPrice, apiId: current.apiId }));
      await load();
      await loadModelsForPricing(selectedApiId, false);
      setMessage(wasEditing ? '模型定价已更新。发布状态可在下方单独切换。' : '模型定价已保存，当前已发布到普通用户模型列表；可在下方取消发布。');
    } catch (error: any) { setMessage(error.message); }
  };

  const togglePricingPublished = (item: Pricing) => {
    const nextPublished = !item.enabled;
    return act(
      () => apiRequest(`/api/admin/pricing/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: nextPublished }),
      }),
      nextPublished ? `模型“${item.displayName}”已发布，普通用户现在可以看到并使用。` : `模型“${item.displayName}”已取消发布，普通用户将无法看到或调用。`,
    );
  };

  const savePricingBatch = async () => {
    const changed = pricing.filter((item) => priceDrafts[item.id] !== undefined && Math.round(Number(priceDrafts[item.id]) * 100) !== Number(item.unitPriceCents)).map((item) => ({ id: item.id, unitPriceCents: Math.round(Number(priceDrafts[item.id]) * 100) }));
    if (!changed.length) return setMessage('没有需要更新的模型价格');
    if (changed.some((item) => !Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0)) return setMessage('请输入有效的模型价格');
    try { await apiRequest('/api/admin/pricing/batch', { method: 'PUT', body: JSON.stringify({ pricing: changed }) }); await load(); setMessage(`已统一更新 ${changed.length} 个模型价格`); } catch (error: any) { setMessage(error.message); }
  };
  const loadModelAccess = async (userId: string) => { const result = await apiRequest<{ access: Array<{ pricingId: string; unitPriceCents: number; enabled: boolean }> }>(`/api/admin/users/${userId}/model-access`); setAccessUserId(userId); setAccessDraft(Object.fromEntries(result.access.map((item) => [item.pricingId, { enabled: item.enabled, price: String(item.unitPriceCents / 100) }]))); };
  const saveModelAccess = async () => { if (!accessUserId) return; const models = Object.entries(accessDraft).filter(([, item]) => item.enabled).map(([pricingId, item]) => ({ pricingId, enabled: true, unitPriceCents: Math.round(Number(item.price) * 100) })); await apiRequest(`/api/admin/users/${accessUserId}/model-access`, { method: 'PUT', body: JSON.stringify({ models }) }); setMessage('特殊用户模型权限已更新'); };
  const apiOrder = new Map(apis.map((api, index) => [api.id, index]));
  const pricingInApiOrder = pricing.slice().sort((left, right) => (apiOrder.get(left.apiId) ?? Number.MAX_SAFE_INTEGER) - (apiOrder.get(right.apiId) ?? Number.MAX_SAFE_INTEGER) || left.displayName.localeCompare(right.displayName, 'zh-CN'));

  return <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
    <button className="absolute inset-0 bg-black/70" onClick={onClose} aria-label="关闭" />
    <section className="relative w-full max-w-6xl max-h-[90vh] bg-dark-800 border border-dark-600 rounded-lg shadow-2xl flex flex-col overflow-hidden">
      <header className="min-h-14 px-5 py-2 border-b border-dark-600 flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2">{mode === 'billing' ? <Wallet className="w-5 h-5 text-green-400" /> : <Shield className="w-5 h-5 text-primary-400" />}{mode === 'billing' ? '余额与在线充值' : '系统管理控制台'}</h2>
          <p className="text-[11px] text-dark-400 mt-0.5">当前身份：{user?.role === 'system' ? '系统用户（拥有管理权限）' : '普通用户'}</p>
        </div>
        <div className="flex gap-1"><button onClick={() => load()} className="p-2 text-dark-400 hover:text-white" title="刷新"><RefreshCw className="w-4 h-4" /></button><button onClick={onClose} className="p-2 text-dark-400 hover:text-white" title="关闭"><X className="w-4 h-4" /></button></div>
      </header>
      <div className="overflow-y-auto p-5 space-y-6">
        {message && <div className="px-3 py-2 bg-dark-900 border border-dark-600 rounded text-sm text-dark-200">{message}</div>}
        {mode === 'billing' ? <BillingView balance={balance} transactions={transactions} recharges={recharges} amount={amount} setAmount={setAmount} providers={paymentProviders} provider={paymentProvider} setProvider={setPaymentProvider} orders={paymentOrders} startPayment={startPayment} /> : <>
          <div className="grid md:grid-cols-[1fr_auto] gap-4 items-center p-4 border border-primary-500/30 bg-primary-500/5 rounded">
            <div><div className="text-sm font-medium text-white">系统用户专属管理区</div><p className="text-xs text-dark-300 mt-1">只有系统用户能看到此页面。充值申请必须由系统用户明确点击“通过”后才会增加余额。</p></div>
            <div className="px-3 py-2 rounded bg-dark-900 text-sm text-amber-300">待审核 {recharges.filter((item) => item.status === 'pending').length} 笔</div>
          </div>
          <div className="flex items-center gap-3 border border-amber-500/30 bg-amber-500/5 p-3 rounded"><Shield className="w-4 h-4 text-amber-300" /><input className={`${field} max-w-xs`} type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} placeholder="当前系统账号密码（余额、权限、退款确认）" /><span className="text-xs text-dark-400">仅随本次敏感请求发送，不保存。</span></div>

          <section>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-medium text-white">系统 API</h3>
              <button onClick={discoverApi} disabled={isDiscovering || !apiForm.baseUrl || (!editingApiId && !apiForm.apiKey)} className="px-3 py-1.5 rounded bg-dark-700 disabled:text-dark-600 text-primary-300 hover:bg-dark-600 text-xs flex items-center gap-2"><RefreshCw className={`w-3.5 h-3.5 ${isDiscovering ? 'animate-spin' : ''}`} />自动识别名称、服务商和模型</button>
            </div>
            <div className="grid md:grid-cols-5 gap-2">
              <input className={field} value={apiForm.name} onChange={(e) => setApiForm({ ...apiForm, name: e.target.value })} placeholder="名称（可自动识别）" />
              <input className={field} value={apiForm.provider} onChange={(e) => setApiForm({ ...apiForm, provider: e.target.value })} placeholder="服务商（可自动识别）" />
              <select aria-label="文本调用协议" className={field} value={apiForm.textProtocol} onChange={(e) => setApiForm({ ...apiForm, textProtocol: e.target.value as TextProtocol })}><option value="auto">文本协议：自动识别</option><option value="openai-chat">OpenAI Chat</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select>
              <input className={field} value={apiForm.baseUrl} onChange={(e) => setApiForm({ ...apiForm, baseUrl: e.target.value })} placeholder="HTTPS API 根地址" />
              <div className="flex gap-2"><input className={field} type="password" value={apiForm.apiKey} onChange={(e) => setApiForm({ ...apiForm, apiKey: e.target.value })} placeholder={editingApiId ? '留空则使用已保存 Key' : 'API Key'} /><button title={editingApiId ? '保存' : '添加'} className="px-3 bg-primary-600 rounded text-white" onClick={saveApi}>{editingApiId ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}</button></div>
            </div>
            {discoveredModels.length > 0 && <p className="mt-2 text-xs text-green-400">已识别 {discoveredModels.length} 个模型，保存 API 后可在下方选择模型并定价。</p>}
            <div className="mt-3 divide-y divide-dark-700">{apis.map((api) => <div key={api.id} className="py-2 grid md:grid-cols-[1fr_1.2fr_2fr_auto] gap-3 items-center text-sm">
              <span className="text-white">{api.name}<small className="block text-dark-500">{api.provider} · {api.textProtocol === 'openai-chat' ? 'OpenAI Chat' : api.textProtocol === 'openai-responses' ? 'OpenAI Responses' : api.textProtocol === 'anthropic-messages' ? 'Anthropic Messages' : '自动识别'}</small></span><code className="text-dark-300 truncate">{showKeys[api.id] ? revealedKeys[api.id] : '••••••••••••'}</code><span className="text-dark-400 truncate">{api.baseUrl}</span>
              <div className="flex items-center"><input aria-label="当前登录密码" className="h-8 w-28 border border-dark-600 bg-dark-900 px-2 text-xs text-white" type="password" value={revealPasswords[api.id] || ''} onChange={(event) => setRevealPasswords((current) => ({ ...current, [api.id]: event.target.value }))} placeholder="当前密码" /><button title={showKeys[api.id] ? '隐藏' : '验证并显示'} onClick={() => void revealApiKey(api.id)} className="p-2 text-dark-400">{showKeys[api.id] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button><button title="复制已解锁密钥" disabled={!revealedKeys[api.id]} onClick={() => void navigator.clipboard.writeText(revealedKeys[api.id] || '')} className="p-2 text-dark-400 disabled:text-dark-700"><Copy className="w-4 h-4" /></button><button title="编辑" onClick={() => { setEditingApiId(api.id); setApiForm({ name: api.name, provider: api.provider, textProtocol: api.textProtocol || 'auto', baseUrl: api.baseUrl, apiKey: '' }); setDiscoveredModels([]); }} className="p-2 text-primary-400"><Pencil className="w-4 h-4" /></button><button title="删除" onClick={() => act(() => apiRequest(`/api/admin/system-apis/${api.id}`, { method: 'DELETE' }), 'API 已删除')} className="p-2 text-red-400"><Trash2 className="w-4 h-4" /></button></div>
            </div>)}</div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-3"><div><h3 className="text-sm font-medium text-white">系统模型定价</h3><p className="text-xs text-dark-400 mt-1">先选择系统用户保存的 API，再读取并选择该 API 提供的模型。</p></div>{priceForm.apiId && <button onClick={() => loadModelsForPricing(priceForm.apiId, false)} disabled={isDiscovering} className="px-3 py-1.5 rounded bg-dark-700 text-xs text-primary-300 flex items-center gap-2"><RefreshCw className={`w-3.5 h-3.5 ${isDiscovering ? 'animate-spin' : ''}`} />重新读取模型</button>}</div>
            <div className="grid lg:grid-cols-[240px_1fr] gap-4 border border-dark-600 rounded p-4 bg-dark-900/30">
              <div><div className="text-xs text-dark-400 mb-2">1. 选择系统 API</div><div className="space-y-2 max-h-64 overflow-y-auto">{apis.length ? apis.map((api) => <button key={api.id} onClick={() => loadModelsForPricing(api.id)} className={`w-full px-3 py-2 rounded border text-left ${priceForm.apiId === api.id ? 'border-primary-500 bg-primary-500/10' : 'border-dark-600 bg-dark-800 hover:border-dark-400'}`}><span className="block text-sm text-white truncate">{api.name}</span><span className="block text-[10px] text-dark-400 truncate">{api.provider} · {api.baseUrl}</span></button>) : <p className="text-xs text-dark-500">请先在上方保存系统 API</p>}</div></div>
              <div className="space-y-4"><div><div className="text-xs text-dark-400 mb-2">2. 选择从 API 获取的模型</div>{isDiscovering ? <div className="h-10 flex items-center text-sm text-dark-400"><RefreshCw className="w-4 h-4 mr-2 animate-spin" />正在读取模型...</div> : <select className={field} value={priceForm.modelId} disabled={!priceForm.apiId || !discoveredModels.length} onChange={(e) => selectDiscoveredModel(e.target.value)}><option value="">{priceForm.apiId ? (discoveredModels.length ? '请选择模型' : '该 API 未返回模型') : '请先选择左侧 API'}</option>{discoveredModels.map((model) => { const priced = pricing.some((item) => item.apiId === priceForm.apiId && item.modelId === model.id); return <option key={model.id} value={model.id}>{model.name} ({model.id}){priced ? ' · 已定价' : ''}</option>; })}</select>}</div>
                <div><div className="text-xs text-dark-400 mb-2">3. 设置模型类型、价格和视频能力</div><div className="grid md:grid-cols-4 gap-2"><input className={field} value={priceForm.displayName} onChange={(e) => setPriceForm({ ...priceForm, displayName: e.target.value })} placeholder="用户看到的模型名称" /><select className={field} value={priceForm.category} onChange={(e) => setPriceForm({ ...priceForm, category: e.target.value })}><option value="text">文本模型</option><option value="image">图片模型</option><option value="video">视频模型</option></select><select className={field} value={priceForm.billingUnit} onChange={(e) => setPriceForm({ ...priceForm, billingUnit: e.target.value })}><option value="request">按次计费</option><option value="image">按张计费</option><option value="second">按秒计费</option></select><input className={field} type="number" min="0" step="0.01" value={priceForm.priceYuan} onChange={(e) => setPriceForm({ ...priceForm, priceYuan: e.target.value })} placeholder="单价（元）" /></div>{priceForm.category === 'video' && <><div className="grid md:grid-cols-4 gap-2 mt-2"><input className={field} type="number" min="1" max="3600" value={priceForm.minDurationSec} onChange={(e) => setPriceForm({ ...priceForm, minDurationSec: e.target.value })} placeholder="最短时长（秒，可空）" /><input className={field} type="number" min="1" max="3600" value={priceForm.maxDurationSec} onChange={(e) => setPriceForm({ ...priceForm, maxDurationSec: e.target.value })} placeholder="最长时长（秒，可空）" /><input className={field} value={priceForm.allowedDurations} onChange={(e) => setPriceForm({ ...priceForm, allowedDurations: e.target.value })} placeholder="固定时长，如 5,10,15" /><input className={field} value={priceForm.allowedResolutions} onChange={(e) => setPriceForm({ ...priceForm, allowedResolutions: e.target.value })} placeholder="分辨率，如 480p,720p,1080p,4K" /></div><div className="grid grid-cols-1 gap-2 mt-2 md:grid-cols-3"><label className="space-y-1"><span className="text-xs text-dark-300">最大参考图片数量</span><input aria-label="最大参考图片数量" className={field} type="number" min="0" max="30" step="1" value={priceForm.maxReferenceImages} onChange={(e) => setPriceForm({ ...priceForm, maxReferenceImages: e.target.value })} /></label><label className="space-y-1"><span className="text-xs text-cyan-300">最大参考音频数量</span><input aria-label="最大参考音频数量" className={field} type="number" min="0" max="10" step="1" value={priceForm.maxReferenceAudios} onChange={(e) => setPriceForm({ ...priceForm, maxReferenceAudios: e.target.value })} /></label><label className="space-y-1"><span className="text-xs text-violet-300">最大参考视频数量</span><input aria-label="最大参考视频数量" className={field} type="number" min="0" max="10" step="1" value={priceForm.maxReferenceVideos} onChange={(e) => setPriceForm({ ...priceForm, maxReferenceVideos: e.target.value })} /></label></div><p className="mt-1 text-[10px] text-dark-500">填写 0 表示该模型不支持对应类型的参考素材。</p></>}</div>
                <button onClick={submitPricing} disabled={!priceForm.apiId || !priceForm.modelId || !priceForm.displayName || priceForm.priceYuan === ''} className="w-full py-2.5 rounded bg-primary-600 hover:bg-primary-500 disabled:bg-dark-700 disabled:text-dark-500 text-white text-sm font-medium flex items-center justify-center gap-2"><Check className="w-4 h-4" />{editingPriceId ? '确认修改定价' : '确认定价'}</button>
              </div>
            </div>
            <div className="mt-3 divide-y divide-dark-700">{pricingInApiOrder.map((item) => <div key={item.id} className="py-2 flex justify-between gap-3 text-sm"><span className="text-dark-200 min-w-0">{item.displayName} <small className="text-dark-500">{item.modelId} · {item.category}</small></span><span className="flex items-center gap-2 text-green-400 shrink-0"><input aria-label={`${item.displayName}价格`} className="w-20 px-2 py-1 bg-dark-900 border border-dark-600 text-white" type="number" min="0" step="0.01" value={priceDrafts[item.id] ?? ''} onChange={(event) => setPriceDrafts((current) => ({ ...current, [item.id]: event.target.value }))} /> / {item.billingUnit === 'second' ? '秒' : item.billingUnit === 'image' ? '张' : '次'}<button title={item.enabled ? '取消发布' : '发布'} className={item.enabled ? 'text-green-400' : 'text-dark-500'} onClick={() => void togglePricingPublished(item)}>{item.enabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}</button><button title="编辑" className="text-primary-400" onClick={() => { setEditingPriceId(item.id); setPriceForm({ apiId: item.apiId, modelId: item.modelId, displayName: item.displayName, category: item.category, billingUnit: item.billingUnit, priceYuan: String(item.unitPriceCents / 100), minDurationSec: String(item.minDurationSec || ''), maxDurationSec: String(item.maxDurationSec || ''), allowedDurations: (item.allowedDurationsSec || []).join(','), allowedResolutions: (item.allowedResolutions || []).join(','), maxReferenceImages: String(Number.isInteger(item.maxReferenceImages) ? item.maxReferenceImages : 4), maxReferenceAudios: String(Number.isInteger(item.maxReferenceAudios) ? item.maxReferenceAudios : 0), maxReferenceVideos: String(Number.isInteger(item.maxReferenceVideos) ? item.maxReferenceVideos : 0) }); void loadModelsForPricing(item.apiId, false); }}><Pencil className="w-4 h-4" /></button><button title="删除" className="text-red-400" onClick={() => act(() => apiRequest(`/api/admin/pricing/${item.id}`, { method: 'DELETE' }), '定价已删除')}><Trash2 className="w-4 h-4" /></button></span></div>)}</div><button onClick={() => void savePricingBatch()} className="mt-3 px-3 py-2 bg-primary-600 text-white text-sm">统一更新价格</button>
          </section>

          <OperationsView metrics={metrics} operationsAlerts={operationsAlerts} securityAlerts={securityAlerts} storageUsage={storageUsage} />
          <StorageCleanupView preview={storageCleanup} onPreview={previewStorageCleanup} onExecute={executeStorageCleanup} currentPassword={adminPassword} />
          <StorageQuarantineView preview={quarantinePreview} records={quarantineRecords} onPreview={previewQuarantine} onExecute={executeQuarantine} onRestore={restoreQuarantine} currentPassword={adminPassword} />
          <BackupManagementView overview={backupOverview} currentPassword={adminPassword} onStart={startBackupDrill} onRefresh={loadBackups} setMessage={setMessage} />
          <QueueView overview={queue} users={users} />
          <AdminPaymentOrders orders={paymentOrders} users={users} currentPassword={adminPassword} act={act} />
          <AdminUsers users={users} currentUserId={user?.id} recharges={recharges} pricing={pricing} accessUserId={accessUserId} accessDraft={accessDraft} setAccessDraft={setAccessDraft} balanceAdjustments={balanceAdjustments} setBalanceAdjustments={setBalanceAdjustments} currentPassword={adminPassword} act={act} loadModelAccess={loadModelAccess} saveModelAccess={saveModelAccess} />
        </>}
      </div>
    </section>
  </div>;
}

type AccountCenterBoundaryProps = { mode: 'billing' | 'admin'; onClose: () => void };
type AccountCenterBoundaryState = { error: Error | null };

class AccountCenterBoundary extends Component<AccountCenterBoundaryProps, AccountCenterBoundaryState> {
  state: AccountCenterBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AccountCenterBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('系统管理页面渲染失败', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"><section className="w-full max-w-md rounded-lg border border-red-500/40 bg-dark-800 p-5 text-white"><h2 className="text-base font-semibold">系统管理暂时无法显示</h2><p className="mt-2 text-sm text-dark-300">管理接口返回了不完整数据，请关闭后刷新页面重试。</p><button className="mt-4 rounded bg-primary-600 px-3 py-2 text-sm" onClick={this.props.onClose}>关闭</button></section></div>;
    }
    return <AccountCenterContent {...this.props} />;
  }
}

export default function AccountCenter(props: AccountCenterBoundaryProps) {
  return <AccountCenterBoundary {...props} />;
}

function BillingView({ balance, transactions, recharges, amount, setAmount, providers, provider, setProvider, orders, startPayment }: BillingProps) {
  return <><div className="grid md:grid-cols-[1fr_2fr] gap-5"><div><div className="text-xs text-dark-400">当前余额</div><div className="text-3xl text-white font-semibold mt-1">{yuan(balance)}</div><div className="mt-5 space-y-3"><div className="grid grid-cols-2 gap-2"><button disabled={!providers.alipay} onClick={() => setProvider('alipay')} className={`border px-3 py-2 text-sm ${provider === 'alipay' ? 'border-blue-500 bg-blue-500/10 text-blue-300' : 'border-dark-600 text-dark-300'} disabled:text-dark-600`}>支付宝</button><button disabled={!providers.wechat} onClick={() => setProvider('wechat')} className={`border px-3 py-2 text-sm ${provider === 'wechat' ? 'border-green-500 bg-green-500/10 text-green-300' : 'border-dark-600 text-dark-300'} disabled:text-dark-600`}>微信支付</button></div><input className={field} type="number" min="1" max="100000" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="充值金额（元）" /><button disabled={!providers[provider] || !Number(amount)} className="w-full bg-primary-600 py-2 text-sm text-white disabled:bg-dark-700 disabled:text-dark-500" onClick={startPayment}>前往安全支付</button>{!providers.alipay && !providers.wechat && <p className="text-xs text-amber-300">支付商户参数尚未在 Railway 配置，当前不能创建在线订单。</p>}</div></div><div><h3 className="text-sm text-white mb-2">余额流水</h3><div className="divide-y divide-dark-700">{transactions.map((item: Transaction) => <div key={item.id} className="py-2 flex justify-between text-sm"><span className="text-dark-300">{item.description}<small className="block text-dark-500">{new Date(item.createdAt).toLocaleString()}</small></span><span className={item.amountCents >= 0 ? 'text-green-400' : 'text-red-400'}>{item.amountCents >= 0 ? '+' : ''}{yuan(item.amountCents)}</span></div>)}</div></div></div><div><h3 className="text-sm text-white mb-2">在线支付订单</h3><div className="divide-y divide-dark-700">{orders.map((item: PaymentOrder) => <div key={item.id} className="py-2 flex justify-between text-sm text-dark-300"><span>{item.provider === 'alipay' ? '支付宝' : '微信支付'} · {yuan(item.amountCents)}<small className="block text-dark-500">{new Date(item.createdAt).toLocaleString()}</small></span><span>{item.status === 'paid' ? '已到账' : item.status === 'pending' ? '待支付' : item.status}</span></div>)}</div>{recharges.length > 0 && <p className="mt-3 text-xs text-dark-500">历史人工充值申请保留只读记录，共 {recharges.length} 条。</p>}</div></>;
}

function OperationsView({ metrics, operationsAlerts, securityAlerts, storageUsage }: { metrics: AdminMetrics | null; operationsAlerts: OperationsAlerts | null; securityAlerts: SecurityAlerts | null; storageUsage: StorageUsage | null }) {
  const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  const stats = [
    ['队列积压', String(metrics?.recent?.queueBacklog ?? 0)],
    ['24h 失败率', `${((metrics?.recent?.failureRate ?? 0) * 100).toFixed(1)}%`],
    ['平均等待', metrics?.recent?.averageQueueWaitMs == null ? '-' : `${Math.round(metrics.recent.averageQueueWaitMs / 1000)} 秒`],
    ['活跃用户', String(metrics?.recent?.activeUsers ?? 0)],
    ['API P95', metrics?.http?.p95Ms == null ? '-' : `${metrics.http.p95Ms} ms`],
    ['AI 网关错误', `${((metrics?.http?.managedAi?.errorRate ?? 0) * 100).toFixed(1)}%`],
  ];
  const labels: Record<string, string> = { QUEUE_BACKLOG: '队列积压', GENERATION_FAILURE_RATE: '生成失败率偏高', PROCESSING_DELAYED: '任务处理延迟', BACKUP_FAILED: '最近备份失败', BACKUP_STALE: '备份超过时限' };
  const alertLabels = { ...labels, DATABASE_CAPACITY_WARNING: '数据库容量接近上限', OBJECT_STORAGE_CAPACITY_WARNING: '对象存储容量接近上限' };
  return <section className="border border-dark-600 bg-dark-900/30 p-4 rounded">
    <div className="flex items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-medium text-white"><Activity className="h-4 w-4 text-cyan-400" />运行监测</h3><p className="mt-1 text-xs text-dark-400">每 5 秒自动刷新，仅展示聚合指标与任务标识。</p></div><span className={operationsAlerts?.healthy ? 'text-xs text-green-400' : 'text-xs text-amber-300'}>{operationsAlerts?.healthy ? '运行正常' : '需要处理告警'}</span></div>
    <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">{stats.map(([label, value]) => <div key={label} className="border border-dark-600 bg-dark-900 px-3 py-2 rounded"><p className="text-[10px] text-dark-500">{label}</p><p className="mt-1 text-lg text-white">{value}</p></div>)}</div>
    <div className="mt-3 space-y-1 text-xs">{Array.isArray(operationsAlerts?.alerts) && operationsAlerts.alerts.length ? operationsAlerts.alerts.map((alert) => <div key={String(alert.code || Math.random())} className="flex items-center justify-between gap-3 border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-200 rounded"><span>{alertLabels[alert.code as keyof typeof alertLabels] || alert.code || '未知告警'}</span><span>{alert.code === 'GENERATION_FAILURE_RATE' ? `${Number(alert.count || 0)}/${Number(alert.total || 0)} (${(Number(alert.rate || 0) * 100).toFixed(1)}%)` : `${Number(alert.count || 0)} 项`}</span></div>) : <p className="text-dark-400">暂无运营告警</p>}</div>
    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-dark-400"><span>登录异常 IP：{securityAlerts?.alerts?.loginBruteForce?.length ?? 0}</span><span>敏感管理操作：{securityAlerts?.alerts?.privilegedActions ?? 0}</span><span>系统模型调用：{securityAlerts?.alerts?.modelCalls ?? 0}</span></div>
    <div className="mt-4 grid gap-2 md:grid-cols-3">
      <div className={`flex items-center gap-3 rounded border px-3 py-2 ${storageUsage?.databaseWarning ? 'border-amber-500/40 bg-amber-500/5' : 'border-dark-600 bg-dark-900'}`}><Database className="h-4 w-4 text-cyan-400" /><div><p className="text-[10px] text-dark-500">数据库占用</p><p className="text-sm text-white">{storageUsage?.database ? formatBytes(storageUsage.database.bytes) : '-'} <span className="text-xs text-dark-500">{storageUsage?.database?.rows ?? 0} 行</span></p></div></div>
      <div className={`flex items-center gap-3 rounded border px-3 py-2 ${storageUsage?.warning ? 'border-amber-500/40 bg-amber-500/5' : 'border-dark-600 bg-dark-900'}`}><Cloud className="h-4 w-4 text-green-400" /><div><p className="text-[10px] text-dark-500">对象存储占用</p><p className="text-sm text-white">{storageUsage ? formatBytes(storageUsage.bytes) : '-'} <span className="text-xs text-dark-500">{storageUsage?.objects ?? 0} 个对象</span></p></div></div>
      <div data-testid="infrastructure-capacity" className={`flex items-center gap-3 rounded border px-3 py-2 ${storageUsage?.infrastructure?.stale || Number(storageUsage?.infrastructure?.usagePercent || 0) >= 85 ? 'border-amber-500/40 bg-amber-500/5' : 'border-dark-600 bg-dark-900'}`}><HardDrive className="h-4 w-4 text-amber-400" /><div><p className="text-[10px] text-dark-500">基础设施卷占用</p><p className="text-sm text-white">{storageUsage?.infrastructure ? `${Number(storageUsage.infrastructure.usagePercent || 0).toFixed(1)}%` : '-'} <span className="text-xs text-dark-500">{storageUsage?.infrastructure?.stale ? '上报已过期' : storageUsage?.infrastructure ? formatBytes(Number(storageUsage.infrastructure.usedBytes || 0)) : '未上报'}</span></p></div></div>
    </div>
  </section>;
}

function StorageCleanupView({ preview, onPreview, onExecute, currentPassword }: { preview: StorageCleanupPreview | null; onPreview: () => Promise<void>; onExecute: () => Promise<void>; currentPassword: string }) {
  const formatCleanupBytes = (bytes: number) => bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return <section data-testid="storage-cleanup">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-medium text-white"><Trash2 className="h-4 w-4 text-amber-400" />对象存储安全清理</h3><p className="mt-1 text-xs text-dark-400">仅处理超过保留期的 healthchecks 临时对象；资产、视频、备份和数据库引用不会删除。</p></div><button onClick={() => void onPreview()} className="border border-dark-600 px-3 py-2 text-xs text-dark-200 hover:border-primary-500">生成清理预览</button></div>
    {preview && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-y border-dark-700 py-3 text-xs text-dark-300"><span>候选 {preview.summary.candidates} 个 · {formatCleanupBytes(preview.summary.candidateBytes)} · 引用保护 {preview.summary.referenced} 个 · 保留 {preview.policy.retentionHours} 小时</span><button disabled={!currentPassword || preview.summary.candidates === 0} onClick={() => void onExecute()} className="border border-red-500/40 px-3 py-2 text-red-300 disabled:border-dark-600 disabled:text-dark-600">确认清理</button></div>}
  </section>;
}

function StorageQuarantineView({ preview, records, onPreview, onExecute, onRestore, currentPassword }: { preview: QuarantinePreview | null; records: QuarantineRecord[]; onPreview: () => Promise<void>; onExecute: () => Promise<void>; onRestore: (id: string) => Promise<void>; currentPassword: string }) {
  const bytes = (value: number) => value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.max(0, Math.round(value / 1024))} KB`;
  return <section data-testid="storage-quarantine"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-medium text-white"><Archive className="h-4 w-4 text-cyan-400" />孤立对象隔离区</h3><p className="mt-1 text-xs text-dark-400">数据库无引用且超过安全期的图片和视频先隔离，到期后才永久删除。</p></div><button onClick={() => void onPreview()} className="border border-dark-600 px-3 py-2 text-xs text-dark-200 hover:border-primary-500">扫描孤立对象</button></div>
    {preview && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-y border-dark-700 py-3 text-xs text-dark-300"><span>候选 {preview.summary.candidates} 个 · {bytes(preview.summary.candidateBytes)} · 隔离保留 {preview.policy.retentionDays} 天</span><button disabled={!currentPassword || preview.summary.candidates === 0} onClick={() => void onExecute()} className="border border-amber-500/40 px-3 py-2 text-amber-300 disabled:border-dark-600 disabled:text-dark-600">移入隔离区</button></div>}
    <div className="mt-3 max-h-48 divide-y divide-dark-700 overflow-y-auto">{records.length ? records.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 py-2 text-xs"><span className="text-dark-300">{item.objectType === 'asset' ? '图片资产' : '生成视频'} · {bytes(item.objectSize)}<small className="block text-dark-500">{item.status} · {new Date(item.quarantinedAt).toLocaleString()}</small></span>{item.status === 'quarantined' && <button disabled={!currentPassword} onClick={() => void onRestore(item.id)} className="border border-cyan-500/40 px-2 py-1 text-cyan-300 disabled:border-dark-600 disabled:text-dark-600">恢复</button>}</div>) : <p className="py-3 text-xs text-dark-500">隔离区为空</p>}</div>
  </section>;
}

function BackupManagementView({ overview, currentPassword, onStart, onRefresh, setMessage }: { overview: BackupOverview | null; currentPassword: string; onStart: () => Promise<void>; onRefresh: () => Promise<BackupOverview>; setMessage: (value: string) => void }) {
  const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(0, Math.round(bytes / 1024))} KB`;
  const eventLabels: Record<string, string> = { backup_completed: '定时备份完成', backup_failed: '定时备份失败', backup_drill_started: '恢复演练已启动', backup_drill_completed: '恢复演练验证完成', backup_drill_failed: '恢复演练失败' };
  return <section data-testid="backup-management">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="flex items-center gap-2 text-sm font-medium text-white"><Archive className="h-4 w-4 text-green-400" />生产备份与恢复演练</h3><p className="mt-1 text-xs text-dark-400">对象仅展示元数据；备份正文、数据库内容和加密密钥不会返回浏览器。</p></div>
      <div className="flex items-center gap-2"><button title="刷新备份状态" onClick={() => void onRefresh().catch((error) => setMessage(errorMessage(error)))} className="p-2 text-dark-400 hover:text-white"><RefreshCw className="h-4 w-4" /></button><button disabled={!currentPassword || overview?.running || !overview} onClick={() => void onStart()} className="flex items-center gap-2 border border-green-500/40 px-3 py-2 text-xs text-green-300 disabled:border-dark-600 disabled:text-dark-600"><Play className="h-4 w-4" />{overview?.running ? '演练进行中' : '开始恢复演练'}</button></div>
    </div>
    <div className="flex flex-wrap gap-x-5 gap-y-1 border-y border-dark-700 py-2 text-xs text-dark-400"><span>存储：{overview?.provider || '未连接'}</span><span>保留：{overview?.policy?.retentionDays ?? '-'} 天</span><span>最低副本：{overview?.policy?.minimumCopies ?? '-'}</span><span>对象数：{overview?.backups?.length ?? 0}</span></div>
    <div className="max-h-64 divide-y divide-dark-700 overflow-y-auto">{Array.isArray(overview?.backups) && overview.backups.length ? overview.backups.map((item, index) => <div key={String(item.key || index)} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3 text-xs"><span className="min-w-0 text-dark-300"><span className="block text-sm text-white">{item.kind === 'drill' ? '恢复演练备份' : '定时数据库备份'} · {item.verification === 'backup_drill_completed' || item.verification === 'backup_completed' ? <span className="text-green-400">验证完成</span> : <span className="text-dark-400">已存储</span>}</span><code className="mt-1 block truncate text-[10px] text-dark-500" title={item.key}>{item.key || '未知对象'}</code></span><span className="text-right text-dark-400">{formatBytes(Number(item.size || 0))}<small className="block text-dark-500">{item.lastModified ? new Date(item.lastModified).toLocaleString() : '时间未知'}</small></span></div>) : <p className="py-5 text-center text-xs text-dark-500">暂无可见备份对象</p>}</div>
    <div className="mt-3 text-xs text-dark-400"><span className="mr-2">最近事件：</span>{Array.isArray(overview?.events) && overview.events[0] ? <span className={String(overview.events[0].action || '').endsWith('failed') ? 'text-red-400' : String(overview.events[0].action || '').endsWith('completed') ? 'text-green-400' : 'text-cyan-400'}>{eventLabels[String(overview.events[0].action || '')] || String(overview.events[0].action || '未知事件')} · {overview.events[0].createdAt ? new Date(overview.events[0].createdAt).toLocaleString() : '时间未知'}</span> : '暂无事件'}</div>
  </section>;
}

function QueueView({ overview, users }: { overview: QueueOverview | null; users: AuthUser[] }) {
  const labels: Record<string, string> = { queued: '排队', submitting: '提交中', processing: '生成中', completed: '成功', failed: '失败' };
  const userNames = new Map(users.map((user) => [user.id, user.username]));
  return <section>
    <div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-medium text-white"><Activity className="h-4 w-4 text-cyan-400" />视频任务队列</h3><p className="mt-1 text-xs text-dark-400">每 5 秒刷新。并发限制由 Railway 环境变量控制。</p></div>{overview?.config && <span className="text-xs text-dark-400">全站 {overview.config.globalConcurrency} · 单用户 {overview.config.userConcurrency} · 单 API {overview.config.apiConcurrency}</span>}</div>
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">{Object.entries(labels).map(([status, label]) => <div key={status} className="rounded border border-dark-600 bg-dark-900 px-3 py-2"><p className="text-[10px] text-dark-500">{label}</p><p className="mt-1 text-lg text-white">{overview?.counts?.[status as keyof QueueOverview['counts']] || 0}</p></div>)}</div>
    <div className="mt-3 max-h-52 overflow-y-auto divide-y divide-dark-700">{Array.isArray(overview?.recent) && overview.recent.length ? overview.recent.map((job, index) => <div key={String(job.id || index)} className="grid grid-cols-[1fr_auto] gap-3 py-2 text-xs"><span className="min-w-0 text-dark-300"><span className="block truncate">{userNames.get(String(job.userId || '')) || String(job.userId || '未知用户')} · {String(job.modelId || '未知模型')}</span><small className="text-dark-500">{job.createdAt ? new Date(job.createdAt).toLocaleString() : '时间未知'} · {String(job.id || '').slice(0, 8)}</small></span><span className={job.status === 'failed' ? 'text-red-400' : job.status === 'completed' ? 'text-green-400' : 'text-cyan-400'}>{labels[job.status] || job.status || '未知状态'}{job.status === 'processing' && Number(job.progress || 0) ? ` ${Number(job.progress)}%` : ''}{job.errorCode ? ` · ${job.errorCode}` : ''}</span></div>) : <p className="py-5 text-center text-xs text-dark-500">暂无视频队列任务</p>}</div>
  </section>;
}

function AdminPaymentOrders({ orders, users, currentPassword, act }: { orders: PaymentOrder[]; users: AuthUser[]; currentPassword: string; act: (job: () => Promise<unknown>, success: string) => Promise<void> }) {
  const names = new Map(users.map((user) => [user.id, user.username]));
  return <section><h3 className="mb-2 text-sm font-medium text-white">在线支付与退款</h3><div className="max-h-64 divide-y divide-dark-700 overflow-y-auto">{orders.length ? orders.map((order) => <div key={order.id} className="grid grid-cols-[1fr_auto] items-center gap-3 py-2 text-sm"><span className="text-dark-300">{names.get(order.userId || '') || order.userId} · {order.provider === 'alipay' ? '支付宝' : '微信支付'} · {yuan(order.amountCents)}<small className="block text-dark-500">{new Date(order.createdAt).toLocaleString()} · {order.status}</small></span>{order.status === 'paid' && <button className="border border-red-500/40 px-2 py-1 text-xs text-red-300" onClick={() => void act(() => apiRequest(`/api/payments/admin/orders/${order.id}/refund`, { method: 'POST', body: JSON.stringify({ currentPassword }) }), '退款已提交')}>原路退款</button>}</div>) : <p className="py-4 text-xs text-dark-500">暂无在线支付订单</p>}</div></section>;
}

function AdminUsers({ users, currentUserId, recharges, pricing, accessUserId, accessDraft, setAccessDraft, balanceAdjustments, setBalanceAdjustments, currentPassword, act, loadModelAccess, saveModelAccess }: AdminUsersProps) {
  return <section className="grid lg:grid-cols-2 gap-6"><div><h3 className="text-sm font-medium text-white mb-2">用户、权限与余额</h3><div className="divide-y divide-dark-700">{users.map((item: AuthUser) => <div key={item.id} className="py-2 grid grid-cols-[1fr_auto] gap-2 items-center text-sm"><span className="text-dark-200">{item.username}<small className="block text-dark-500">{item.email} · {yuan(item.balanceCents)} · {item.accountType === 'special' ? '特殊用户' : item.role === 'system' ? '系统用户' : '普通用户'}</small></span><div className="flex gap-2"><button title="配置特殊用户模型" className="px-2 py-1 border border-primary-500 text-primary-300" onClick={() => void loadModelAccess(item.id)}>模型权限</button><div className="flex"><input className="w-24 px-2 py-1 bg-dark-900 border border-dark-600 rounded-l text-white" type="number" step="0.01" value={balanceAdjustments[item.id] || ''} onChange={(e) => setBalanceAdjustments({ ...balanceAdjustments, [item.id]: e.target.value })} placeholder="增减元" /><button title="调整余额" className="px-2 bg-dark-700 border border-dark-600 rounded-r text-green-400" onClick={() => act(() => apiRequest(`/api/admin/users/${item.id}/balance`, { method: 'POST', body: JSON.stringify({ amountCents: Math.round(Number(balanceAdjustments[item.id]) * 100), description: '系统后台调整余额', currentPassword }) }), '用户余额已调整')}><Coins className="w-4 h-4" /></button></div><select className="bg-dark-900 border border-dark-600 rounded px-2 py-1 text-dark-200" disabled={item.id === currentUserId} value={item.role} onChange={(e) => act(() => apiRequest(`/api/admin/users/${item.id}/role`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value, currentPassword }) }), '用户角色已更新')}><option value="user">普通用户</option><option value="system">系统用户</option></select></div></div>)}</div>{accessUserId && <div className="mt-4 border border-dark-600 p-3 space-y-2"><div className="text-sm text-white">特殊用户模型权限</div>{pricing.map((item) => { const draft = accessDraft[item.id] || { enabled: false, price: String(item.unitPriceCents / 100) }; return <label key={item.id} className="flex items-center gap-2 text-xs text-dark-300"><input type="checkbox" checked={draft.enabled} onChange={(event) => setAccessDraft((current) => ({ ...current, [item.id]: { ...draft, enabled: event.target.checked } }))} /><span className="flex-1">{item.displayName}</span><input className="w-20 px-1 py-1 bg-dark-900 border border-dark-600 text-white" type="number" min="0" step="0.01" value={draft.price} onChange={(event) => setAccessDraft((current) => ({ ...current, [item.id]: { ...draft, price: event.target.value } }))} /></label>; })}<button onClick={() => void saveModelAccess()} className="px-3 py-1.5 bg-primary-600 text-white text-xs">保存模型权限</button></div>}</div><div><h3 className="text-sm font-medium text-white mb-2">充值审核</h3><div className="divide-y divide-dark-700">{recharges.filter((item: Recharge) => item.status === 'pending').map((item: Recharge) => <div key={item.id} className="py-2 flex justify-between items-center text-sm"><span className="text-dark-200">{item.user?.username || item.user?.email}<small className="block text-dark-500">{yuan(item.amountCents)} · {item.note || '无备注'}</small></span><div className="flex gap-1"><button title="通过并入账" className="p-2 text-green-400" onClick={() => act(() => apiRequest(`/api/admin/recharges/${item.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }), '充值已入账')}><Check className="w-4 h-4" /></button><button title="拒绝" className="p-2 text-red-400" onClick={() => act(() => apiRequest(`/api/admin/recharges/${item.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'rejected' }) }), '充值申请已拒绝')}><X className="w-4 h-4" /></button></div></div>)}</div></div></section>;
}
