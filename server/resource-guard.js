const DEFAULTS = {
  globalConcurrency: 16,
  userConcurrency: 4,
  requestsPerMinute: 60,
  maxResponseBytes: 8 * 1024 * 1024,
  timeoutMs: 90_000,
  textTimeoutMs: 300_000,
};

const integerEnv = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

export const resourceGuardConfig = () => ({
  globalConcurrency: integerEnv('AI_REQUEST_GLOBAL_CONCURRENCY', DEFAULTS.globalConcurrency, 1, 200),
  userConcurrency: integerEnv('AI_REQUEST_USER_CONCURRENCY', DEFAULTS.userConcurrency, 1, 50),
  requestsPerMinute: integerEnv('AI_REQUESTS_PER_MINUTE', DEFAULTS.requestsPerMinute, 1, 1000),
  maxResponseBytes: integerEnv('AI_MAX_RESPONSE_BYTES', DEFAULTS.maxResponseBytes, 1024, 64 * 1024 * 1024),
  timeoutMs: integerEnv('AI_UPSTREAM_TIMEOUT_MS', DEFAULTS.timeoutMs, 1000, 10 * 60 * 1000),
  textTimeoutMs: integerEnv('AI_TEXT_UPSTREAM_TIMEOUT_MS', DEFAULTS.textTimeoutMs, 10_000, 10 * 60 * 1000),
});

export function createResourceGuard({ db, config = resourceGuardConfig() } = {}) {
  const activeByUser = new Map();
  let active = 0;
  const acquire = async (userId) => {
    const key = String(userId || 'anonymous');
    if (active >= config.globalConcurrency || (activeByUser.get(key) || 0) >= config.userConcurrency) {
      const error = new Error('当前生成请求较多，请稍后重试');
      error.code = 'AI_CONCURRENCY_LIMIT';
      throw error;
    }
    active += 1; activeByUser.set(key, (activeByUser.get(key) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true; active -= 1;
      const next = (activeByUser.get(key) || 1) - 1;
      if (next > 0) activeByUser.set(key, next); else activeByUser.delete(key);
    };
  };
  const rateLimit = async (userId, now = Date.now()) => {
    if (!db?.consumeRateLimit) return { allowed: true };
    return db.consumeRateLimit(`ai:${userId || 'anonymous'}`, config.requestsPerMinute, 60_000, now);
  };
  return { acquire, rateLimit, config, get active() { return active; } };
}

export async function fetchWithTimeout(fetchImpl, target, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(target, { ...options, signal: controller.signal });
  } finally { clearTimeout(timer); }
}

export async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    const error = new Error('上游响应超过大小限制'); error.code = 'UPSTREAM_RESPONSE_TOO_LARGE'; throw error;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) { const error = new Error('上游响应超过大小限制'); error.code = 'UPSTREAM_RESPONSE_TOO_LARGE'; throw error; }
    return bytes;
  }
  const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); const error = new Error('上游响应超过大小限制'); error.code = 'UPSTREAM_RESPONSE_TOO_LARGE'; throw error; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
