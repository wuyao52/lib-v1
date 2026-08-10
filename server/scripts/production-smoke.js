const baseUrl = String(process.env.SMOKE_BASE_URL || process.argv[2] || '').trim().replace(/\/+$/, '');
const concurrency = Math.min(50, Math.max(1, Number.parseInt(process.env.SMOKE_CONCURRENCY || '20', 10) || 20));

if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(baseUrl)) {
  throw new Error('SMOKE_BASE_URL must be a HTTPS URL or local loopback URL');
}

const request = async (path) => {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* Reported by the caller. */ }
  return { response, body, text };
};

const health = await request('/api/health');
if (health.response.status !== 200 || !health.body?.ok) throw new Error(`Health check failed with HTTP ${health.response.status}`);
if (health.response.headers.get('x-content-type-options') !== 'nosniff') throw new Error('Security headers are missing');
if (health.response.headers.get('cache-control') !== 'no-store') throw new Error('Health response is cacheable');

const operations = await request('/api/health/operations');
if (operations.response.status !== 200 || !operations.body?.ok) {
  throw new Error(`Operational readiness failed with HTTP ${operations.response.status}: ${(operations.body?.alerts || []).join(',')}`);
}

const [captchaOne, captchaTwo] = await Promise.all([request('/api/auth/captcha'), request('/api/auth/captcha')]);
for (const captcha of [captchaOne, captchaTwo]) {
  if (captcha.response.status !== 200 || !captcha.body?.captchaId || !String(captcha.body?.image || '').startsWith('data:image/svg+xml;base64,')) {
    throw new Error(`Captcha smoke check failed with HTTP ${captcha.response.status}`);
  }
}
if (captchaOne.body.captchaId === captchaTwo.body.captchaId || captchaOne.body.image === captchaTwo.body.image) throw new Error('Captcha refresh returned duplicate data');

const concurrent = await Promise.all(Array.from({ length: concurrency }, () => request('/api/health')));
const failed = concurrent.filter((item) => item.response.status !== 200 || !item.body?.ok);
if (failed.length) throw new Error(`${failed.length}/${concurrency} concurrent health checks failed`);

console.log('Production smoke completed:', JSON.stringify({
  baseUrl,
  release: operations.body.release || null,
  health: health.body.checks,
  operations: operations.body.checks,
  captchaRefresh: 'changed',
  concurrentHealthChecks: concurrency,
}));
