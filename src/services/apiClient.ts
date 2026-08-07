export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
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
}
