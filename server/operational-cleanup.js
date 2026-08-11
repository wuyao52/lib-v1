const DAY = 24 * 60 * 60 * 1000;

const boundedDays = (value, fallback, minimum = 1, maximum = 3650) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

export async function cleanupOperationalData({ db, now = new Date(), auditRetentionDays, batchSize = 5000 } = {}) {
  const nowMs = now.getTime();
  const auditDays = boundedDays(auditRetentionDays ?? process.env.AUDIT_LOG_RETENTION_DAYS, 180, 30);
  const limit = Math.min(20_000, Math.max(100, Number(batchSize) || 5000));
  const expiredIds = (rows, predicate) => new Set(rows.filter(predicate)
    .sort((a, b) => Number(a.expiresAt || Date.parse(a.createdAt) || 0) - Number(b.expiresAt || Date.parse(b.createdAt) || 0))
    .slice(0, limit).map((item) => item.id));
  const removed = {};
  await db.mutate((data) => {
    const policies = {
      sessions: (item) => Number(item.expiresAt || 0) <= nowMs,
      emailVerifications: (item) => Number(item.expiresAt || 0) <= nowMs || (item.usedAt && Number(item.usedAt) <= nowMs - DAY),
      imageCaptchas: (item) => Number(item.expiresAt || 0) <= nowMs || (item.usedAt && Number(item.usedAt) <= nowMs - DAY),
      rateLimits: (item) => Number(item.resetAt || 0) <= nowMs,
      auditLogs: (item) => Date.parse(item.createdAt) <= nowMs - auditDays * DAY,
    };
    for (const [collection, predicate] of Object.entries(policies)) {
      const ids = expiredIds(data[collection] || [], predicate);
      data[collection] = (data[collection] || []).filter((item) => !ids.has(item.id));
      removed[collection] = ids.size;
    }
  });
  removed.requestMetricBuckets = typeof db.cleanupRequestMetricBuckets === 'function'
    ? await db.cleanupRequestMetricBuckets(nowMs - boundedDays(process.env.REQUEST_METRIC_RETENTION_DAYS, 7, 1, 90) * DAY)
    : 0;
  return { removed, auditRetentionDays: auditDays, batchSize: limit };
}
