const SERVICES = {
  hongniaoai: new URL('https://open.hongniaoai.com/api/'),
  wuhenai: new URL('https://api.wuhenai.com/'),
};

const corsHeaders = (origin) => ({
  'access-control-allow-origin': origin,
  vary: 'Origin',
  'access-control-allow-headers': 'Content-Type, Authorization, X-API-Key',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
});

function allowedOrigin(event) {
  const origin = String(getHeader(event.headers, 'origin') || '');
  const configured = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.LEGACY_AI_PROXY_ORIGIN]
    .filter(Boolean).map((value) => new URL(value).origin);
  if (process.env.NODE_ENV !== 'production') configured.push('http://localhost:3000', 'http://127.0.0.1:3000');
  return configured.includes(origin) ? origin : null;
}

function getHeader(headers, name) {
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function resolveTarget(event) {
  const query = event.queryStringParameters || {};
  const pathMatch = String(event.path || '').match(/\/api\/(hongniaoai|wuhenai)(?:\/(.*))?$/);
  const service = String(query.service || pathMatch?.[1] || '').toLowerCase();
  const baseUrl = SERVICES[service];
  const targetPath = String(query.path || pathMatch?.[2] || '').replace(/^\/+/, '');

  if (!baseUrl || !targetPath || targetPath.includes('..') || targetPath.includes('://') || targetPath.includes('\\')) {
    return null;
  }

  const target = new URL(targetPath, baseUrl);
  if (target.origin !== baseUrl.origin || !target.pathname.startsWith(baseUrl.pathname)) return null;
  for (const [key, value] of Object.entries(query)) {
    if (!['service', 'path'].includes(key) && value != null) target.searchParams.set(key, value);
  }
  return target;
}

export async function handler(event) {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  const origin = allowedOrigin(event);
  if (!origin) return { statusCode: 403, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: 'PROXY_ORIGIN_FORBIDDEN', message: '请求来源不被允许' }) };
  const cors = corsHeaders(origin);
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const target = resolveTarget(event);
  if (!target) {
    return {
      statusCode: 400,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'INVALID_PROXY_TARGET', message: '不允许代理该 API 路径' }),
    };
  }

  try {
    const requestHeaders = new Headers();
    for (const name of ['accept', 'authorization', 'content-type', 'x-api-key']) {
      const value = getHeader(event.headers, name);
      if (value) requestHeaders.set(name, value);
    }
    if (!requestHeaders.has('accept')) requestHeaders.set('accept', 'application/json');

    const hasBody = event.body && !['GET', 'HEAD'].includes(method);
    const response = await fetch(target, {
      method,
      headers: requestHeaders,
      body: hasBody ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined,
      redirect: 'manual',
    });

    const responseHeaders = { ...cors };
    for (const name of ['cache-control', 'content-type', 'retry-after']) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    return { statusCode: response.status, headers: responseHeaders, body: await response.text() };
  } catch (error) {
    console.error('AI API proxy failed:', error);
    return {
      statusCode: 502,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'UPSTREAM_UNAVAILABLE', message: 'AI API 暂时不可用' }),
    };
  }
}
