import { createHmac, randomUUID } from 'node:crypto';
import { summarizeStoredObjects } from './object-storage.js';
import { latestInfrastructureCapacity } from './infrastructure-capacity.js';
import { generationFailureAlertConfig, shouldAlertGenerationFailures, summarizeGenerationFailures, summarizeOperationalFailureCodes } from './generation-failure-policy.js';

const nowIso = () => new Date().toISOString();

function publicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function operationSnapshot(db, env = process.env, now = Date.now(), capacity = {}) {
  const since = now - 24 * 60 * 60 * 1000;
  const recent = db.read('generationJobs').filter((job) => Date.parse(job.createdAt) >= since);
  const backlog = db.read('generationJobs').filter((job) => ['queued', 'submitting', 'processing'].includes(job.status)).length;
  const failures = summarizeGenerationFailures(recent);
  const queueThreshold = Math.max(1, Number.parseInt(env.ALERT_QUEUE_BACKLOG || '25', 10) || 25);
  const failureAlert = generationFailureAlertConfig(env);
  const failureSince = now - failureAlert.windowMinutes * 60 * 1000;
  const failureWindowJobs = recent.filter((job) => Date.parse(job.completedAt || job.updatedAt || job.createdAt) >= failureSince);
  const alertFailures = summarizeGenerationFailures(failureWindowJobs);
  const failureCodes = summarizeOperationalFailureCodes(failureWindowJobs);
  const backupMaxAgeHours = Math.max(1, Number.parseInt(env.ALERT_BACKUP_MAX_AGE_HOURS || '12', 10) || 12);
  const restoreDrillMaxAgeHours = Math.max(1, Number.parseInt(env.ALERT_RESTORE_DRILL_MAX_AGE_HOURS || '840', 10) || 840);
  const backupEvents = (db.read('auditLogs') || []).filter((item) => item.targetType === 'backup');
  const latestBackup = backupEvents.filter((item) => item.action === 'backup_completed').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const latestFailure = backupEvents.filter((item) => item.action === 'backup_failed').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const latestRestoreDrill = backupEvents.filter((item) => ['mysql_restore_drill_completed', 'backup_drill_completed'].includes(item.action)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const latestRestoreFailure = backupEvents.filter((item) => ['mysql_restore_drill_failed', 'backup_drill_failed'].includes(item.action)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const backupStale = !latestBackup || now - Date.parse(latestBackup.createdAt) >= backupMaxAgeHours * 60 * 60 * 1000;
  const backupFailed = latestFailure && (!latestBackup || latestFailure.createdAt > latestBackup.createdAt);
  const restoreDrillStale = !latestRestoreDrill || now - Date.parse(latestRestoreDrill.createdAt) >= restoreDrillMaxAgeHours * 60 * 60 * 1000;
  const restoreDrillFailed = latestRestoreFailure && (!latestRestoreDrill || latestRestoreFailure.createdAt > latestRestoreDrill.createdAt);
  const databaseThreshold = Math.max(0, Number(env.ALERT_DATABASE_WARNING_BYTES || 0));
  const objectStorageThreshold = Math.max(0, Number(env.OBJECT_STORAGE_WARNING_BYTES || 0));
  const infrastructure = latestInfrastructureCapacity(db, env, now);
  const infrastructureThreshold = Math.min(100, Math.max(1, Number(env.ALERT_INFRA_VOLUME_USAGE_PERCENT || 85)));
  const infrastructureRequired = String(env.INFRA_CAPACITY_REPORT_REQUIRED || '').toLowerCase() === 'true';
  const alerts = [
    ...(backlog >= queueThreshold ? [{ code: 'QUEUE_BACKLOG', count: backlog, threshold: queueThreshold }] : []),
    ...(failureAlert.emailEnabled && shouldAlertGenerationFailures(alertFailures, failureAlert)
      ? [{ code: 'GENERATION_FAILURE_RATE', count: alertFailures.operationalFailed, total: alertFailures.eligibleTerminalJobs, rate: alertFailures.operationalFailureRate, threshold: failureAlert.threshold, minimumCount: failureAlert.minimumCount, minimumSamples: failureAlert.minimumSamples, criticalCount: failureAlert.criticalCount, windowMinutes: failureAlert.windowMinutes, errorCodes: failureCodes }]
      : []),
    ...(backupFailed ? [{ code: 'BACKUP_FAILED', occurredAt: latestFailure.createdAt }] : []),
    ...(backupStale ? [{ code: 'BACKUP_STALE', thresholdHours: backupMaxAgeHours, lastSuccessAt: latestBackup?.createdAt || null }] : []),
    ...(restoreDrillFailed ? [{ code: 'RESTORE_DRILL_FAILED', occurredAt: latestRestoreFailure.createdAt }] : []),
    ...(restoreDrillStale ? [{ code: 'RESTORE_DRILL_STALE', thresholdHours: restoreDrillMaxAgeHours, lastSuccessAt: latestRestoreDrill?.createdAt || null }] : []),
    ...(databaseThreshold > 0 && Number(capacity.database?.bytes || 0) >= databaseThreshold ? [{ code: 'DATABASE_CAPACITY_WARNING', bytes: capacity.database.bytes, threshold: databaseThreshold }] : []),
    ...(objectStorageThreshold > 0 && Number(capacity.objectStorage?.bytes || 0) >= objectStorageThreshold ? [{ code: 'OBJECT_STORAGE_CAPACITY_WARNING', bytes: capacity.objectStorage.bytes, threshold: objectStorageThreshold }] : []),
    ...(infrastructure && infrastructure.usagePercent >= infrastructureThreshold ? [{ code: 'INFRA_VOLUME_CAPACITY_WARNING', usagePercent: infrastructure.usagePercent, threshold: infrastructureThreshold }] : []),
    ...(infrastructureRequired && (!infrastructure || infrastructure.stale) ? [{ code: 'INFRA_CAPACITY_REPORT_STALE', lastReportedAt: infrastructure?.reportedAt || null, thresholdMinutes: infrastructure?.staleMinutes || Number(env.INFRA_CAPACITY_STALE_MINUTES || 30) }] : []),
  ];
  return {
    alerts, backlog, failed: failures.totalFailed, total: recent.length, failureRate: failures.operationalFailureRate,
    generationFailures: { ...failures, alertWindow: alertFailures, errorCodes: failureCodes, ...failureAlert },
    backup: { lastSuccessAt: latestBackup?.createdAt || null, lastFailureAt: latestFailure?.createdAt || null },
    restoreDrill: { lastSuccessAt: latestRestoreDrill?.createdAt || null, lastFailureAt: latestRestoreFailure?.createdAt || null },
    capacity: { ...capacity, infrastructure },
  };
}

export function createMonitoringService({ db, storage = null, fetchImpl = fetch, env = process.env, emailSender = null } = {}) {
  const endpoint = publicHttpsUrl(env.ALERT_WEBHOOK_URL);
  const secret = String(env.ALERT_WEBHOOK_SECRET || '');
  const intervalMs = Math.max(60_000, (Number.parseInt(env.MONITORING_INTERVAL_MINUTES || '5', 10) || 5) * 60_000);
  const repeatMs = Math.max(60 * 60 * 1000, (Number.parseInt(env.ALERT_REPEAT_HOURS || '24', 10) || 24) * 60 * 60 * 1000);
  let localAlertFingerprint = null;
  let localRecoverySent = true;
  let localTestSent = false;
  let timer = null;
  let capacity = {};

  const refreshCapacity = async () => {
    const [databaseResult, storageResult] = await Promise.allSettled([
      typeof db.storageStats === 'function' ? db.storageStats() : null,
      storage && typeof storage.list === 'function' ? storage.list('') : null,
    ]);
    if (databaseResult.status === 'fulfilled' && databaseResult.value) capacity.database = databaseResult.value;
    if (storageResult.status === 'fulfilled' && storageResult.value) capacity.objectStorage = { provider: storage.provider || 'unknown', ...summarizeStoredObjects(storageResult.value) };
    return capacity;
  };

  const lock = async (namespace, value, windowMs) => {
    if (!db.consumeRateLimit) return true;
    const key = createHmac('sha256', 'monitoring-notification-lock').update(`${namespace}:${value}`).digest('hex');
    return (await db.consumeRateLimit(key, 1, windowMs)).allowed;
  };

  const latestNotification = () => (db.read('auditLogs') || [])
    .filter((item) => item.targetType === 'monitoring' && ['monitoring_alert_sent', 'monitoring_recovered_sent'].includes(item.action))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;

  const recordNotification = async (action, event, fingerprint, snapshot) => {
    if (typeof db.mutate !== 'function') return;
    await db.mutate((data) => data.auditLogs.push({
      id: randomUUID(), userId: null, action, targetType: 'monitoring', targetId: null,
      ipAddress: 'system', userAgent: 'monitoring',
      metadata: { event, fingerprint, alertCodes: snapshot.alerts.map((item) => item.code) },
      createdAt: nowIso(),
    }));
  };

  const emailRecipients = () => {
    const configured = String(env.ALERT_EMAIL_RECIPIENTS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    const systemUsers = (db.read('users') || []).filter((user) => user.role === 'system').map((user) => String(user.email || '').trim().toLowerCase()).filter(Boolean);
    return [...new Set([...configured, ...systemUsers])];
  };

  const dispatch = async (event, payload) => {
    const envelope = { id: randomUUID(), event, occurredAt: nowIso(), service: 'ai-drama-studio', ...payload };
    const channels = [];
    if (endpoint && secret.length >= 24) {
      const body = JSON.stringify(envelope);
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-signature': `sha256=${signature}`, 'x-ai-drama-event': event }, body });
      if (!response.ok) throw new Error(`alert webhook returned HTTP ${response.status}`);
      channels.push('webhook');
    }
    const recipients = emailSender ? emailRecipients() : [];
    if (recipients.length) {
      const codes = event === 'operations.test'
        ? 'TEST'
        : (payload.operations?.alerts || []).map((item) => item.code).join(', ') || 'RECOVERED';
      const subjectType = event === 'operations.test' ? '运维测试' : event === 'operations.recovered' ? '运维恢复' : '运维告警';
      const failure = payload.operations?.alerts?.find((item) => item.code === 'GENERATION_FAILURE_RATE');
      const failureDetails = failure ? [
        `生成失败：${failure.count}/${failure.total}（${(failure.rate * 100).toFixed(1)}%）`,
        `统计窗口：最近 ${failure.windowMinutes} 分钟`,
        `错误分类：${failure.errorCodes?.map((item) => `${item.code}×${item.count}`).join('、') || 'UNKNOWN'}`,
      ] : [];
      const text = [`服务：ai-drama-studio`, `事件：${event}`, `时间：${envelope.occurredAt}`, `状态：${codes}`, ...failureDetails, '', '请登录系统管理控制台查看脱敏指标和任务标识。'].join('\n');
      await Promise.all(recipients.map((to) => emailSender({ to, subject: `[AI Drama Studio] ${subjectType}：${codes}`, text })));
      channels.push('email');
    }
    return channels.length ? { delivered: true, channels, recipients: recipients.length } : { delivered: false, reason: 'NOT_CONFIGURED' };
  };

  const check = async () => {
    if (typeof db.refreshCollections === 'function') await db.refreshCollections(['generationJobs', 'auditLogs', 'users']);
    await refreshCapacity();
    const snapshot = operationSnapshot(db, env, Date.now(), capacity);
    const alertTypes = snapshot.alerts.map((item) => item.code).sort();
    const fingerprint = createHmac('sha256', 'monitoring-alert-fingerprint').update(JSON.stringify(alertTypes)).digest('hex');
    const latest = latestNotification();

    if (!snapshot.alerts.length) {
      const needsRecovery = latest?.action === 'monitoring_alert_sent' || (!db.mutate && !localRecoverySent);
      if (!needsRecovery) return { changed: false, snapshot, reason: 'HEALTHY' };
      if (!(await lock('recovery', latest?.id || localAlertFingerprint || fingerprint, 30 * 24 * 60 * 60 * 1000))) {
        localRecoverySent = true;
        return { changed: false, snapshot, shared: true };
      }
      const event = 'operations.recovered';
      const delivery = await dispatch(event, { operations: snapshot });
      localRecoverySent = true;
      localAlertFingerprint = null;
      if (delivery.delivered) await recordNotification('monitoring_recovered_sent', event, fingerprint, snapshot);
      return { changed: Boolean(delivery.delivered), event, delivery, snapshot };
    }

    const generationOnly = snapshot.alerts.length === 1 && snapshot.alerts[0].code === 'GENERATION_FAILURE_RATE';
    if (generationOnly && failureAlertConfirmations(env) > 1 && db.consumeRateLimit) {
      const confirmationWindow = Math.max(intervalMs * (failureAlertConfirmations(env) + 1), 15 * 60 * 1000);
      const confirmation = await db.consumeRateLimit(`monitoring-confirm:${fingerprint}`, 1000, confirmationWindow);
      if (confirmation.count < failureAlertConfirmations(env)) return { changed: false, snapshot, reason: 'AWAITING_CONFIRMATION' };
    }

    if (!db.consumeRateLimit && localAlertFingerprint === fingerprint) return { changed: false, snapshot };
    if (!(await lock('alert', fingerprint, repeatMs))) {
      localAlertFingerprint = fingerprint;
      localRecoverySent = false;
      return { changed: false, snapshot, shared: true };
    }
    const event = 'operations.alert';
    const delivery = await dispatch(event, { operations: snapshot });
    localAlertFingerprint = fingerprint;
    localRecoverySent = false;
    if (delivery.delivered) await recordNotification('monitoring_alert_sent', event, fingerprint, snapshot);
    return { changed: Boolean(delivery.delivered), event, delivery, snapshot };
  };

  const testOnce = async () => {
    const deployment = String(env.RAILWAY_DEPLOYMENT_ID || env.APP_RELEASE || 'local');
    if (localTestSent || !(await lock('test', deployment, 30 * 24 * 60 * 60 * 1000))) return { delivered: false, reason: 'ALREADY_SENT' };
    localTestSent = true;
    return dispatch('operations.test', { operations: operationSnapshot(db, env, Date.now(), capacity) });
  };

  return {
    check,
    snapshot: () => operationSnapshot(db, env, Date.now(), capacity),
    test: () => dispatch('operations.test', { operations: operationSnapshot(db, env, Date.now(), capacity) }),
    testOnce,
    start() { if (!timer) { timer = setInterval(() => void check().catch((error) => console.error('Monitoring notification failed:', error.message)), intervalMs); timer.unref?.(); } return intervalMs; },
    stop() { if (timer) clearInterval(timer); timer = null; },
    configured: Boolean((endpoint && secret.length >= 24) || (emailSender && emailRecipients().length)),
    channels: { webhook: Boolean(endpoint && secret.length >= 24), email: Boolean(emailSender && emailRecipients().length) },
    intervalMs,
    repeatMs,
    refreshCapacity,
  };
}

function failureAlertConfirmations(env) {
  return generationFailureAlertConfig(env).confirmations;
}
