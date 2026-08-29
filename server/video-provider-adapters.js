import { lookup } from 'node:dns/promises';
import { assertPublicHost } from './api-discovery.js';
import { readLimitedBody } from './resource-guard.js';

const MAX_REFERENCE_FILE_BYTES = 12 * 1024 * 1024;

function buildTarget(api, suffix) {
  const base = new URL(`${api.baseUrl.replace(/\/+$/, '')}/`);
  const target = new URL(String(suffix || '').replace(/^\/+/, ''), base);
  const expectedPath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if (target.protocol !== 'https:' || target.origin !== base.origin || !target.pathname.startsWith(expectedPath)) {
    throw new Error('队列上游请求路径无效');
  }
  return target;
}

function boyesirTarget(api, suffix) {
  const base = new URL(api.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const relative = String(suffix || '').replace(/^\/+/, '');
  const path = basePath.endsWith('/v1') && relative.startsWith('v1/') ? relative.slice(3) : relative;
  return buildTarget(api, path);
}

export function isShishikejiVideoApi(api) {
  try { return new URL(api.baseUrl).hostname.toLowerCase() === 'api.shishikeji.com'; }
  catch { return false; }
}

export function isBoyesirVideoApi(api) {
  try {
    const hostname = new URL(api.baseUrl).hostname.toLowerCase();
    return hostname === 'boyesir.icu' || hostname === 'www.boyesir.icu';
  } catch { return false; }
}

function referenceUrl(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const field = ['url', 'image_url', 'image'].find((key) => typeof value[key] === 'string');
  return field ? value[field] : '';
}

function boyesirRequestBody(requestBody) {
  const prompt = String(requestBody.prompt || '')
    .replace(/@\[([^\]]+)\]\([^)]*\)/g, ' $1')
    .replace(/[ \t]{2,}/g, ' ').trim();
  const images = Array.isArray(requestBody.images)
    ? requestBody.images.map(referenceUrl).filter(Boolean)
    : [];
  const body = {
    model: requestBody.model,
    prompt,
    ...(requestBody.duration !== undefined || requestBody.seconds !== undefined
      ? { duration: Number(requestBody.duration ?? requestBody.seconds) }
      : {}),
    ...(requestBody.ratio || requestBody.aspect_ratio ? { ratio: requestBody.ratio ?? requestBody.aspect_ratio } : {}),
    ...(requestBody.resolution ? { resolution: requestBody.resolution } : {}),
    ...(images.length ? { images } : {}),
  };
  return body;
}

function openAiCompatibleRequestBody(requestBody) {
  // H3 encodes its fixed resolution in the model ID. Its API rejects both
  // lowercase and uppercase resolution values when the field is submitted.
  if (/^minimax-h3-768p$/i.test(String(requestBody?.model || ''))) {
    const { resolution: _resolution, ...body } = requestBody;
    return body;
  }
  return requestBody;
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
  return { blob: new Blob([bytes], { type: mimeType }), filename: `参考图${index + 1}.${extension}` };
}

async function shishikejiForm(requestBody, dependencies) {
  const form = new FormData();
  // @[label](internal-node-id) is editor-only syntax. Sending the node ID to
  // the provider can change prompt interpretation, so expose only the label.
  const prompt = String(requestBody.prompt || '').replace(/@\[([^\]]+)\]\([^)]*\)/g, ' $1').replace(/[ \t]{2,}/g, ' ').trim();
  const fields = {
    prompt,
    duration: requestBody.duration ?? requestBody.seconds,
    ratio: requestBody.ratio ?? requestBody.aspect_ratio,
    resolution: requestBody.resolution,
    model: requestBody.model,
    protect_stripe: requestBody.protect_stripe ?? true,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && String(value).trim()) form.append(key, String(value));
  }
  // The managed gateway validates the configured per-model limit before a job is queued.
  const images = Array.isArray(requestBody.images) ? requestBody.images : [];
  for (let index = 0; index < images.length; index += 1) {
    const url = referenceUrl(images[index]);
    if (!url) throw new Error('时时科技参考图片参数格式无效');
    const file = await downloadReference(url, index, dependencies);
    form.append('files', file.blob, file.filename);
  }
  return form;
}

export function createVideoProviderAdapter(api, { fetchImpl = fetch, resolveHost = lookup } = {}) {
  if (isBoyesirVideoApi(api)) {
    const headers = () => new Headers({
      accept: 'application/json', authorization: `Bearer ${api.apiKey}`,
    });
    return {
      kind: 'boyesir',
      async submit(requestBody, idempotencyKey, signal) {
        const requestHeaders = headers();
        requestHeaders.set('content-type', 'application/json');
        requestHeaders.set('idempotency-key', idempotencyKey);
        return fetchImpl(boyesirTarget(api, '/v1/videos/generations'), {
          method: 'POST', redirect: 'manual', headers: requestHeaders,
          body: JSON.stringify(boyesirRequestBody(requestBody)), signal,
        });
      },
      poll(taskId, signal) {
        return fetchImpl(boyesirTarget(api, `/v1/tasks/${encodeURIComponent(taskId)}`), {
          method: 'GET', redirect: 'manual', headers: headers(), signal,
        });
      },
      cancel() { return null; },
      resultHeaders() { return headers(); },
      refreshResult: null,
    };
  }
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
          body: JSON.stringify(openAiCompatibleRequestBody(requestBody)), signal,
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
      resultHeaders() {
        return headers();
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
    resultHeaders() {
      return headers();
    },
    refreshResult(taskId, signal) {
      return fetchImpl(buildTarget(api, `/api/task/${encodeURIComponent(taskId)}/video-link?refresh=1`), {
        method: 'GET', redirect: 'manual', headers: headers(), signal,
      });
    },
  };
}
