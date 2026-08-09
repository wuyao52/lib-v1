const FORWARDED_HEADERS = ['accept', 'authorization', 'content-type', 'cookie', 'origin', 'user-agent', 'x-api-key'];
const PROTECTED_API_PATH = /^\/api\/(?:auth|director|skills|projects|assets|admin|billing|catalog|system-ai)(?:\/|$)/;
const PROTECTED_API_SCOPES = new Set(['auth', 'director', 'skills', 'projects', 'assets', 'admin', 'billing', 'catalog', 'system-ai']);

function getHeader(headers, name) {
  const matchingKey = Object.keys(headers || {}).find((key) => key.toLowerCase() === name);
  return matchingKey ? headers[matchingKey] : undefined;
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('set-cookie');
  return value ? [value] : [];
}

function normalizeApiPath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  const normalizedPath = `/${value.replace(/^\/+/, '')}`;
  if (normalizedPath.startsWith('/api/')) return normalizedPath;
  const functionMatch = normalizedPath.match(/^\/\.netlify\/functions\/backend\/(auth|director|skills|projects|assets|admin|billing|catalog|system-ai)(?:\/(.*))?$/);
  if (functionMatch) return `/api/${functionMatch[1]}${functionMatch[2] ? `/${functionMatch[2]}` : ''}`;
  return normalizedPath;
}

function resolveApiPath(event) {
  const query = event.queryStringParameters || {};
  const directCandidates = [
    event.path,
    event.rawUrl ? (() => { try { return new URL(event.rawUrl).pathname; } catch { return ''; } })() : '',
    query.path,
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeApiPath(candidate);
    if (PROTECTED_API_PATH.test(normalized)) return normalized;
  }

  const rawPath = String(query.path || '').trim();
  const normalizedPath = rawPath ? `/${rawPath.replace(/^\/+/, '')}` : '';
  if (normalizedPath.startsWith('/api/')) return normalizedPath;

  const scope = String(query.scope || '').trim();
  if (!PROTECTED_API_SCOPES.has(scope)) return normalizedPath;
  return `/api/${scope}${normalizedPath || ''}`;
}

export async function handler(event) {
  const apiOrigin = String(process.env.API_ORIGIN || '').trim().replace(/\/+$/, '');
  const path = resolveApiPath(event);

  if (!PROTECTED_API_PATH.test(path)) {
    return {
      statusCode: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'INVALID_API_PATH', message: '不允许代理该 API 路径' }),
    };
  }
  if (!apiOrigin) {
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'BACKEND_NOT_CONFIGURED', message: '服务端 API 尚未配置' }),
    };
  }

  try {
    const target = new URL(path, `${apiOrigin}/`);
    for (const [key, value] of Object.entries(event.queryStringParameters || {})) {
      if (!['path', 'scope'].includes(key) && value != null) target.searchParams.set(key, value);
    }
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = getHeader(event.headers, name);
      if (value) headers.set(name, value);
    }
    const method = event.httpMethod || 'GET';
    const hasBody = event.body && !['GET', 'HEAD'].includes(method);
    const response = await fetch(target, {
      method,
      headers,
      body: hasBody ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined,
      redirect: 'manual',
    });
    const responseHeaders = {};
    for (const name of ['cache-control', 'content-type', 'location']) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    const setCookies = getSetCookies(response.headers);

    const contentType = response.headers.get('content-type') || '';
    const isTextResponse = /^(?:text\/)|(?:json|javascript|xml|svg)/i.test(contentType);
    const body = isTextResponse
      ? await response.text()
      : Buffer.from(await response.arrayBuffer()).toString('base64');

    return {
      statusCode: response.status,
      headers: responseHeaders,
      ...(setCookies.length ? { multiValueHeaders: { 'set-cookie': setCookies } } : {}),
      ...(isTextResponse ? {} : { isBase64Encoded: true }),
      body,
    };
  } catch (error) {
    console.error('Backend proxy failed:', error);
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'BACKEND_UNAVAILABLE', message: '服务端 API 暂时不可用' }),
    };
  }
}
