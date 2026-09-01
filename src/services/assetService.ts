import { ApiError, apiRequest } from './apiClient';
import { compressImageDataUrl } from '@/utils/imageCompression';

type AssetUploadResponse = {
  asset: {
    id: string;
    url: string;
  };
};

type AssetImportResponse = {
  asset?: AssetUploadResponse['asset'];
  importJob?: { id: string; status: 'processing' | 'completed' | 'failed' };
};

function waitForImportPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout = 0;
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason || new DOMException('操作已取消', 'AbortError'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timeout = window.setTimeout(() => { cleanup(); resolve(); }, 1000);
  });
}

const ASSET_PATH = /\/api\/assets\/public\/([^/?#]+)/i;
const GENERATED_MEDIA_PATH = /\/api\/generated-media\/([^/?#]+)/i;
const signedAssetCache = new Map<string, { url: string; expiresAt: number }>();
const playbackUrlCache = new Map<string, { url: string; expiresAt: number }>();

export function needsResolvedMediaUrl(source: string): boolean {
  try {
    const path = new URL(source, window.location.origin).pathname;
    return ASSET_PATH.test(path) || GENERATED_MEDIA_PATH.test(path);
  } catch {
    return false;
  }
}

export async function getSignedAssetUrl(image: string, signal?: AbortSignal, forceRefresh = false): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(image, window.location.origin); } catch { return image; }
  const assetId = parsed.pathname.match(ASSET_PATH)?.[1];
  if (!assetId) return image;
  const cacheKey = decodeURIComponent(assetId);
  const cached = signedAssetCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.url;
  const response = await apiRequest<{ url: string; expiresAt?: string }>(`/api/assets/${encodeURIComponent(assetId)}/signed-url`, { signal });
  const absoluteUrl = new URL(response.url, window.location.origin).toString();
  signedAssetCache.set(cacheKey, {
    url: absoluteUrl,
    expiresAt: Date.parse(response.expiresAt || '') || Date.now() + 10 * 60_000,
  });
  return absoluteUrl;
}

export async function getPlayableMediaUrl(source: string, signal?: AbortSignal, forceRefresh = false): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(source, window.location.origin); } catch { return source; }
  const assetId = parsed.pathname.match(ASSET_PATH)?.[1];
  const mediaId = parsed.pathname.match(GENERATED_MEDIA_PATH)?.[1];
  if (!assetId && !mediaId) return source;
  // Keep generated videos on the same origin. Browser video elements often
  // reject cross-origin signed OSS URLs when CORS or range headers differ;
  // the backend media route already handles auth, ranges and Content-Type.
  if (mediaId) return `${parsed.pathname}${parsed.search}`;
  const cacheKey = `${assetId ? 'asset' : 'media'}:${decodeURIComponent(assetId || mediaId || '')}`;
  const cached = playbackUrlCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.url;
  const path = assetId
    ? `/api/assets/${encodeURIComponent(assetId)}/playback-url`
    : `/api/generated-media/${encodeURIComponent(mediaId!)}/playback-url`;
  const response = await apiRequest<{ url: string; expiresAt?: string }>(path, { signal });
  playbackUrlCache.set(cacheKey, { url: response.url, expiresAt: Date.parse(response.expiresAt || '') || Date.now() + 10 * 60_000 });
  return response.url;
}

// Leaves headroom for Base64/JSON expansion before Netlify forwards the request.
const NETLIFY_SAFE_ASSET_BYTES = 2.5 * 1024 * 1024;
const ASSET_UPLOAD_TIMEOUT_MS = 60_000;

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error('压缩后的图片格式无效');
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}

function uploadSignal(parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException('图片上传超时，请检查网络后重试', 'TimeoutError')), ASSET_UPLOAD_TIMEOUT_MS);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      window.clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export async function materializeReferenceImages(images: string[], signal?: AbortSignal): Promise<string[]> {
  const materialized: string[] = [];
  for (const image of images) {
    if (!/^data:image\//i.test(image)) {
      materialized.push(await getSignedAssetUrl(image, signal));
      continue;
    }
    const prepared = await compressImageDataUrl(image, {
      maxBytes: NETLIFY_SAFE_ASSET_BYTES,
      maxDimension: 4096,
      outputMimeType: 'image/webp',
      signal,
      errorLabel: '上传图片',
    });
    const upload = uploadSignal(signal);
    try {
      const response = await apiRequest<AssetUploadResponse>('/api/assets', {
        method: 'POST',
        body: dataUrlToBlob(prepared),
        signal: upload.signal,
      });
      materialized.push(response.asset.url);
    } catch (error) {
      if (upload.signal.aborted && !signal?.aborted) throw new Error('图片上传超时，请检查网络或后端对象存储后重试');
      if (error instanceof ApiError && error.status === 413 && error.code !== 'ASSET_QUOTA_EXCEEDED') {
        throw new Error('图片超过云端上传限制，请使用尺寸更小的图片');
      }
      throw error;
    } finally {
      upload.dispose();
    }
  }
  return materialized;
}

export async function uploadAssetFile(file: File, signal?: AbortSignal): Promise<string> {
  const sha256 = await crypto.subtle.digest('SHA-256', await file.arrayBuffer()).then((value) => Array.from(new Uint8Array(value)).map((byte) => byte.toString(16).padStart(2, '0')).join(''));
  const request = await apiRequest<{ uploadUrl?: string; token?: string; headers?: Record<string, string>; asset?: { url: string } }>('/api/assets/direct-upload', {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, mimeType: file.type, byteSize: file.size, sha256 }),
    signal,
  });
  if ('asset' in request && request.asset) return request.asset.url;
  if (!request.uploadUrl || !request.token || !request.headers) throw new Error('素材直传凭证无效');
  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(request.uploadUrl, { method: 'PUT', body: file, headers: request.headers, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('素材直传 OSS 失败，请检查 OSS 跨域规则是否允许当前网站执行 PUT');
  }
  if (!uploadResponse.ok) throw new Error(`素材直传 OSS 失败 (${uploadResponse.status})`);
  const completed = await apiRequest<AssetUploadResponse>('/api/assets/direct-upload/complete', {
    method: 'POST', body: JSON.stringify({ token: request.token }), signal,
  });
  return completed.asset.url;
}

export const uploadVideoAsset = uploadAssetFile;

export async function archiveGeneratedImage(source: string, signal?: AbortSignal): Promise<string> {
  if (/^\/api\/assets\/public\//i.test(source)) return source;
  const response = await apiRequest<AssetImportResponse>('/api/assets/import-image', {
    method: 'POST', body: JSON.stringify({ source }), signal,
  });
  if (response.asset?.url) return response.asset.url;
  if (!response.importJob?.id) throw new Error('图片归档任务创建失败');

  for (let attempt = 0; attempt < 130; attempt += 1) {
    await waitForImportPoll(signal);
    const status = await apiRequest<AssetImportResponse>(`/api/assets/import-image/${encodeURIComponent(response.importJob.id)}`, { signal });
    if (status.asset?.url) return status.asset.url;
  }
  throw new Error('图片已生成，但归档处理超时，请稍后在生成记录中刷新');
}
