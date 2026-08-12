export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const inFlightAdminBalanceRequests = new Map<string, Promise<unknown>>();

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isAdminBalanceAdjustment = options.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/balance$/.test(path);
  const requestKey = isAdminBalanceAdjustment ? `${path}:${String(options.body || '')}` : '';
  const existing = requestKey ? inFlightAdminBalanceRequests.get(requestKey) : undefined;
  if (existing) return existing as Promise<T>;
  const idempotencyKey = isAdminBalanceAdjustment && !new Headers(options.headers).has('Idempotency-Key')
    ? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    : null;
  const request = (async () => {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const isBinaryBody = (typeof Blob !== 'undefined' && options.body instanceof Blob)
    || (typeof ArrayBuffer !== 'undefined' && (options.body instanceof ArrayBuffer || ArrayBuffer.isView(options.body as any)));
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body && !isFormData && !isBinaryBody ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...options.headers,
    },
  });

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') || '';
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload.message || `请求失败 (${response.status})`, response.status, payload.error);
  }
  if (!contentType.includes('application/json')) {
    throw new ApiError('服务端 API 返回异常，请检查后端部署或 Netlify API 代理配置', response.status);
  }
  return payload as T;
  })();
  if (requestKey) {
    inFlightAdminBalanceRequests.set(requestKey, request);
    try { return await request; } finally { inFlightAdminBalanceRequests.delete(requestKey); }
  }
  return request;
}
