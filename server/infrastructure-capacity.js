import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_MS = 5 * 60 * 1000;

const signatureFor = (secret, timestamp, bytes) => createHmac('sha256', secret).update(`${timestamp}.`).update(bytes).digest('hex');

export function signCapacityReport(secret, timestamp, bytes) {
  return signatureFor(String(secret), String(timestamp), Buffer.from(bytes));
}

export function verifyCapacityReport({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (String(secret || '').length < 24) return { ok: false, error: 'CAPACITY_REPORT_NOT_CONFIGURED' };
  const parsedTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(parsedTimestamp) || Math.abs(now - parsedTimestamp) > MAX_SKEW_MS) return { ok: false, error: 'CAPACITY_REPORT_EXPIRED' };
  const expected = Buffer.from(signatureFor(String(secret), String(timestamp), Buffer.from(rawBody || '')), 'hex');
  const actual = Buffer.from(String(signature || ''), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, error: 'CAPACITY_REPORT_SIGNATURE_INVALID' };
  let body;
  try { body = JSON.parse(Buffer.from(rawBody || '').toString('utf8')); } catch { return { ok: false, error: 'CAPACITY_REPORT_INVALID' }; }
  const source = String(body.source || '').trim();
  const usedBytes = Number(body.usedBytes); const totalBytes = Number(body.totalBytes);
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(source) || !Number.isSafeInteger(usedBytes) || !Number.isSafeInteger(totalBytes) || usedBytes < 0 || totalBytes <= 0 || usedBytes > totalBytes) {
    return { ok: false, error: 'CAPACITY_REPORT_INVALID' };
  }
  return { ok: true, report: { source, usedBytes, totalBytes, usagePercent: Number(((usedBytes / totalBytes) * 100).toFixed(2)), reportedAt: new Date(parsedTimestamp).toISOString() } };
}

export function latestInfrastructureCapacity(db, env = process.env, now = Date.now()) {
  const latest = (db.read('auditLogs') || []).filter((item) => item.action === 'infrastructure_capacity_reported' && item.targetType === 'capacity')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) return null;
  const staleMinutes = Math.max(5, Number(env.INFRA_CAPACITY_STALE_MINUTES || 30));
  const reportedAt = String(latest.metadata?.reportedAt || latest.createdAt);
  return {
    source: latest.targetId,
    usedBytes: Number(latest.metadata?.usedBytes || 0),
    totalBytes: Number(latest.metadata?.totalBytes || 0),
    usagePercent: Number(latest.metadata?.usagePercent || 0),
    reportedAt,
    stale: now - Date.parse(reportedAt) >= staleMinutes * 60 * 1000,
    staleMinutes,
  };
}
