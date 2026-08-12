import { ApiError, apiRequest } from './apiClient';
import { compressImageDataUrl } from '@/utils/imageCompression';

type AssetUploadResponse = {
  asset: {
    id: string;
    url: string;
  };
};

const ASSET_PATH = /\/api\/assets\/public\/([^/?#]+)/i;

export async function getSignedAssetUrl(image: string, signal?: AbortSignal): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(image, window.location.origin); } catch { return image; }
  const assetId = parsed.pathname.match(ASSET_PATH)?.[1];
  if (!assetId) return image;
  const response = await apiRequest<{ url: string }>(`/api/assets/${encodeURIComponent(assetId)}/signed-url`, { signal });
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
