import { createHmac, randomUUID } from 'node:crypto';

const nowIso = () => new Date().toISOString();

function publicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function operationSnapshot(db, env = process.env, now = Date.now()) {
  const since = now - 24 * 60 * 60 * 1000;
  const recent = db.read('generationJobs').filter((job) => Date.parse(job.createdAt) >= since);
  const backlog = db.read('generationJobs').filter((job) => ['queued', 'submitting', 'processing'].includes(job.status)).length;
  const failed = recent.filter((job) => job.status === 'failed').length;
  const failureRate = recent.length ? failed / recent.length : 0;
  const queueThreshold = Math.max(1, Number.parseInt(env.ALERT_QUEUE_BACKLOG || '25', 10) || 25);
  const failureThreshold = Math.min(1, Math.max(0.01, Number(env.ALERT_FAILURE_RATE || '0.2') || 0.2));
  const alerts = [
    ...(backlog >= queueThreshold ? [{ code: 'QUEUE_BACKLOG', count: backlog, threshold: queueThreshold }] : []),
    ...(recent.length && failureRate >= failureThreshold ? [{ code: 'GENERATION_FAILURE_RATE', count: failed, total: recent.length, rate: Number(failureRate.toFixed(4)), threshold: failureThreshold }] : []),
  ];
  return { alerts, backlog, failed, total: recent.length, failureRate: Number(failureRate.toFixed(4)) };
}

export function createMonitoringService({ db, fetchImpl = fetch, env = process.env } = {}) {
  const endpoint = publicHttpsUrl(env.ALERT_WEBHOOK_URL);
  const secret = String(env.ALERT_WEBHOOK_SECRET || '');
  const intervalMs = Math.max(60_000, (Number.parseInt(env.MONITORING_INTERVAL_MINUTES || '5', 10) || 5) * 60_000);
  let lastFingerprint = null;
  let timer = null;

  const dispatch = async (event, payload) => {
    if (!endpoint || secret.length < 24) return { delivered: false, reason: 'NOT_CONFIGURED' };
    const body = JSON.stringify({ id: randomUUID(), event, occurredAt: nowIso(), service: 'ai-drama-studio', ...payload });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-signature': `sha256=${signature}`, 'x-ai-drama-event': event }, body });
    if (!response.ok) throw new Error(`alert webhook returned HTTP ${response.status}`);
    return { delivered: true };
  };

  const check = async () => {
    const snapshot = operationSnapshot(db, env);
    const fingerprint = JSON.stringify(snapshot.alerts);
    const fingerprintKey = createHmac('sha256', 'monitoring-alert-fingerprint').update(fingerprint).digest('hex');
    if (db.consumeRateLimit) {
      // The shared rate-limit primary key is CHAR(64); the HMAC is already namespace-specific.
      const lock = await db.consumeRateLimit(fingerprintKey, 1, Math.max(intervalMs * 2, 60_000));
      if (!lock.allowed) return { changed: false, snapshot, shared: true };
    } else if (fingerprint === lastFingerprint) return { changed: false, snapshot };
    const event = snapshot.alerts.length ? 'operations.alert' : 'operations.recovered';
    const delivery = await dispatch(event, { operations: snapshot });
    lastFingerprint = fingerprint;
    return { changed: true, event, delivery, snapshot };
  };

  return {
    check,
    start() { if (!timer) { timer = setInterval(() => void check().catch((error) => console.error('Monitoring notification failed:', error.message)), intervalMs); timer.unref?.(); } return intervalMs; },
    stop() { if (timer) clearInterval(timer); timer = null; },
    configured: Boolean(endpoint && secret.length >= 24),
    intervalMs,
  };
}
