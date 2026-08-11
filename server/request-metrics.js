const scopeOf = (path) => {
  if (path.startsWith('/api/system-ai/')) return 'managedAi';
  if (path.startsWith('/api/user-ai/')) return 'customAi';
  if (path.startsWith('/api/auth/')) return 'auth';
  if (path.startsWith('/api/assets/') || path.startsWith('/api/generated-media/')) return 'media';
  return 'api';
};

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};

const aggregate = (samples) => {
  const durations = samples.map((item) => item.durationMs);
  const errors = samples.filter((item) => item.status >= 400).length;
  const serverErrors = samples.filter((item) => item.status >= 500).length;
  return {
    total: samples.length,
    p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), p99Ms: percentile(durations, 0.99),
    errorRate: samples.length ? Number((errors / samples.length).toFixed(4)) : 0,
    serverErrorRate: samples.length ? Number((serverErrors / samples.length).toFixed(4)) : 0,
  };
};

const LATENCY_BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];
const latencyBucket = (durationMs) => LATENCY_BUCKETS.find((limit) => durationMs <= limit) || LATENCY_BUCKETS.at(-1);
const statusClass = (status) => status >= 500 ? '5xx' : status >= 400 ? '4xx' : 'ok';

const aggregateBuckets = (rows) => {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const errors = rows.filter((row) => row.statusClass !== 'ok').reduce((sum, row) => sum + row.count, 0);
  const serverErrors = rows.filter((row) => row.statusClass === '5xx').reduce((sum, row) => sum + row.count, 0);
  const latencyCounts = new Map();
  for (const row of rows) latencyCounts.set(row.latencyBucketMs, (latencyCounts.get(row.latencyBucketMs) || 0) + row.count);
  const percentileFromBuckets = (fraction) => {
    if (!total) return null;
    const target = Math.ceil(total * fraction);
    let cumulative = 0;
    for (const [upperBound, count] of [...latencyCounts.entries()].sort((a, b) => a[0] - b[0])) {
      cumulative += count;
      if (cumulative >= target) return upperBound;
    }
    return null;
  };
  return {
    total,
    p50Ms: percentileFromBuckets(0.5), p95Ms: percentileFromBuckets(0.95), p99Ms: percentileFromBuckets(0.99),
    errorRate: total ? Number((errors / total).toFixed(4)) : 0,
    serverErrorRate: total ? Number((serverErrors / total).toFixed(4)) : 0,
  };
};

export function createRequestMetrics({ maxSamples = 20_000, store = null, flushIntervalMs = 5000 } = {}) {
  const samples = [];
  let pending = new Map();
  let flushPromise = null;
  const flush = async () => {
    if (!store?.writeRequestMetricBuckets || !pending.size) return;
    if (flushPromise) return flushPromise;
    const batch = pending;
    pending = new Map();
    flushPromise = store.writeRequestMetricBuckets([...batch.values()]).catch((error) => {
      for (const [key, value] of batch) {
        const existing = pending.get(key);
        pending.set(key, existing ? { ...existing, count: existing.count + value.count, durationTotalMs: existing.durationTotalMs + value.durationTotalMs } : value);
      }
      throw error;
    }).finally(() => { flushPromise = null; });
    return flushPromise;
  };
  const timer = store?.writeRequestMetricBuckets ? setInterval(() => flush().catch(() => undefined), Math.max(100, flushIntervalMs)) : null;
  timer?.unref?.();
  const record = ({ path, status, durationMs, timestamp = Date.now() }) => {
    if (!String(path || '').startsWith('/api/')) return;
    const sample = { scope: scopeOf(String(path)), status: Number(status || 0), durationMs: Math.max(0, Math.round(Number(durationMs || 0))), timestamp: Number(timestamp) };
    samples.push(sample);
    if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
    if (store?.writeRequestMetricBuckets) {
      const bucketStart = Math.floor(sample.timestamp / 60000) * 60000;
      const item = { bucketStart, scope: sample.scope, statusClass: statusClass(sample.status), latencyBucketMs: latencyBucket(sample.durationMs), count: 1, durationTotalMs: sample.durationMs };
      const key = `${item.bucketStart}:${item.scope}:${item.statusClass}:${item.latencyBucketMs}`;
      const existing = pending.get(key);
      pending.set(key, existing ? { ...existing, count: existing.count + 1, durationTotalMs: existing.durationTotalMs + item.durationTotalMs } : item);
    }
  };
  const snapshot = ({ windowMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) => {
    const recent = samples.filter((item) => item.timestamp >= now - windowMs);
    return { windowHours: Math.round(windowMs / 3_600_000), ...aggregate(recent), managedAi: aggregate(recent.filter((item) => item.scope === 'managedAi')), customAi: aggregate(recent.filter((item) => item.scope === 'customAi')) };
  };
  const snapshotPersistent = async ({ windowMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) => {
    if (!store?.readRequestMetricBuckets) return snapshot({ windowMs, now });
    await flush();
    const rows = await store.readRequestMetricBuckets(now - windowMs);
    return { windowHours: Math.round(windowMs / 3_600_000), ...aggregateBuckets(rows), managedAi: aggregateBuckets(rows.filter((item) => item.scope === 'managedAi')), customAi: aggregateBuckets(rows.filter((item) => item.scope === 'customAi')) };
  };
  const close = async () => { if (timer) clearInterval(timer); await flush(); };
  return { record, snapshot, snapshotPersistent, flush, close, get size() { return samples.length; }, get pendingSize() { return pending.size; } };
}
