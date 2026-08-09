import { ApiError, apiRequest } from './apiClient';
import { compressImageDataUrl } from '@/utils/imageCompression';

type AssetUploadResponse = {
  asset: {
    id: string;
    url: string;
  };
};

const ASSET_PATH = /\/api\/assets\/public\/([^/?#]+)/i;

async function refreshAssetUrl(image: string, signal?: AbortSignal): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(image, window.location.origin); } catch { return image; }
  const assetId = parsed.pathname.match(ASSET_PATH)?.[1];
  if (!assetId) return image;
  const response = await apiRequest<{ url: string }>(`/api/assets/${encodeURIComponent(assetId)}/signed-url`, { signal });
  return response.url;
}

// Leaves headroom for Base64/JSON expansion before Netlify forwards the request.
const NETLIFY_SAFE_ASSET_BYTES = 2.5 * 1024 * 1024;

export async function materializeReferenceImages(images: string[], signal?: AbortSignal): Promise<string[]> {
  const materialized: string[] = [];
  for (const image of images) {
    if (!/^data:image\//i.test(image)) {
      materialized.push(await refreshAssetUrl(image, signal));
      continue;
    }
    const prepared = await compressImageDataUrl(image, {
      maxBytes: NETLIFY_SAFE_ASSET_BYTES,
      maxDimension: 4096,
      outputMimeType: 'image/webp',
      signal,
      errorLabel: '上传图片',
    });
    try {
      const response = await apiRequest<AssetUploadResponse>('/api/assets', {
        method: 'POST',
        body: JSON.stringify({ dataUrl: prepared }),
        signal,
      });
      materialized.push(response.asset.url);
    } catch (error) {
      if (error instanceof ApiError && error.status === 413 && error.code !== 'ASSET_QUOTA_EXCEEDED') {
        throw new Error('图片超过云端上传限制，请使用尺寸更小的图片');
      }
      throw error;
    }
  }
  return materialized;
}
