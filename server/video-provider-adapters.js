import { lookup } from 'node:dns/promises';
import { assertPublicHost } from './api-discovery.js';
import { readLimitedBody } from './resource-guard.js';

const MAX_REFERENCE_FILE_BYTES = 12 * 1024 * 1024;
const MAX_REFERENCE_FILES = 4;

function buildTarget(api, suffix) {
  const base = new URL(`${api.baseUrl.replace(/\/+$/, '')}/`);
  const target = new URL(String(suffix || '').replace(/^\/+/, ''), base);
  const expectedPath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if (target.protocol !== 'https:' || target.origin !== base.origin || !target.pathname.startsWith(expectedPath)) {
    throw new Error('队列上游请求路径无效');
  }
  return target;
}

export function isShishikejiVideoApi(api) {
  try { return new URL(api.baseUrl).hostname.toLowerCase() === 'api.shishikeji.com'; }
  catch { return false; }
}

function referenceUrl(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const field = ['url', 'image_url', 'image'].find((key) => typeof value[key] === 'string');
  return field ? value[field] : '';
}

async function downloadReference(urlValue, index, { fetchImpl, resolveHost, signal }) {
  let target;
  try { target = new URL(urlValue); } catch { throw new Error('时时科技参考图片地址无效'); }
  if (target.protocol !== 'https:') throw new Error('时时科技参考图片必须使用 HTTPS 地址');
  await assertPublicHost(target.hostname, resolveHost);
  const response = await fetchImpl(target, { method: 'GET', redirect: 'error', signal });
  if (!response.ok || !response.body) throw new Error(`读取时时科技参考图片失败 (${response.status})`);
  const mimeType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!/^image\/(?:png|jpe?g|webp|gif)$/.test(mimeType)) throw new Error('时时科技参考文件不是受支持的图片');
  const bytes = await readLimitedBody(response, MAX_REFERENCE_FILE_BYTES);
  const extension = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : mimeType.includes('gif') ? 'gif' : 'jpg';
  return { blob: new Blob([bytes], { type: mimeType }), filename: `reference-${index + 1}.${extension}` };
}

async function shishikejiForm(requestBody, dependencies) {
  const form = new FormData();
  const fields = {
    prompt: requestBody.prompt,
    duration: requestBody.duration ?? requestBody.seconds,
    ratio: requestBody.ratio ?? requestBody.aspect_ratio,
    resolution: requestBody.resolution,
    model: requestBody.model,
    protect_stripe: requestBody.protect_stripe ?? true,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && String(value).trim()) form.append(key, String(value));
  }
  const images = Array.isArray(requestBody.images) ? requestBody.images.slice(0, MAX_REFERENCE_FILES) : [];
  for (let index = 0; index < images.length; index += 1) {
    const url = referenceUrl(images[index]);
    if (!url) throw new Error('时时科技参考图片参数格式无效');
    const file = await downloadReference(url, index, dependencies);
    form.append('files', file.blob, file.filename);
  }
  return form;
}

export function createVideoProviderAdapter(api, { fetchImpl = fetch, resolveHost = lookup } = {}) {
  if (!isShishikejiVideoApi(api)) {
    const headers = () => new Headers({
      accept: 'application/json', authorization: `Bearer ${api.apiKey}`, 'x-api-key': api.apiKey,
    });
    return {
      kind: 'openai-compatible',
      async submit(requestBody, idempotencyKey, signal) {
        const requestHeaders = headers();
        requestHeaders.set('content-type', 'application/json');
        requestHeaders.set('idempotency-key', idempotencyKey);
        return fetchImpl(buildTarget(api, '/v1/videos'), {
          method: 'POST', redirect: 'manual', headers: requestHeaders,
          body: JSON.stringify(requestBody), signal,
        });
      },
      poll(taskId, signal) {
        return fetchImpl(buildTarget(api, `/v1/videos/${encodeURIComponent(taskId)}`), {
          method: 'GET', redirect: 'manual', headers: headers(), signal,
        });
      },
      cancel(taskId, signal) {
        return fetchImpl(buildTarget(api, `/v1/videos/${encodeURIComponent(taskId)}`), {
          method: 'DELETE', redirect: 'manual', headers: headers(), signal,
        });
      },
      refreshResult: null,
    };
  }

  const headers = () => new Headers({ accept: 'application/json', 'x-license-key': api.apiKey });
  return {
    kind: 'shishikeji',
    async submit(requestBody, idempotencyKey, signal) {
      const form = await shishikejiForm(requestBody, { fetchImpl, resolveHost, signal });
      const requestHeaders = headers();
      requestHeaders.set('idempotency-key', idempotencyKey);
      return fetchImpl(buildTarget(api, '/api/generate-video'), {
        method: 'POST', redirect: 'manual', headers: requestHeaders, body: form, signal,
      });
    },
    poll(taskId, signal) {
      return fetchImpl(buildTarget(api, `/api/task/${encodeURIComponent(taskId)}`), {
        method: 'GET', redirect: 'manual', headers: headers(), signal,
      });
    },
    cancel() {
      return null;
    },
    refreshResult(taskId, signal) {
      return fetchImpl(buildTarget(api, `/api/task/${encodeURIComponent(taskId)}/video-link?refresh=1`), {
        method: 'GET', redirect: 'manual', headers: headers(), signal,
      });
    },
  };
}
