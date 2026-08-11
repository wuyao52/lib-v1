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

export function createRequestMetrics({ maxSamples = 20_000 } = {}) {
  const samples = [];
  const record = ({ path, status, durationMs, timestamp = Date.now() }) => {
    if (!String(path || '').startsWith('/api/')) return;
    samples.push({ scope: scopeOf(String(path)), status: Number(status || 0), durationMs: Math.max(0, Math.round(Number(durationMs || 0))), timestamp: Number(timestamp) });
    if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
  };
  const snapshot = ({ windowMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) => {
    const recent = samples.filter((item) => item.timestamp >= now - windowMs);
    return { windowHours: Math.round(windowMs / 3_600_000), ...aggregate(recent), managedAi: aggregate(recent.filter((item) => item.scope === 'managedAi')), customAi: aggregate(recent.filter((item) => item.scope === 'customAi')) };
  };
  return { record, snapshot, get size() { return samples.length; } };
}
