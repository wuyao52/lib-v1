import { apiRequest } from './apiClient';

type AssetUploadResponse = {
  asset: {
    id: string;
    url: string;
  };
};

export async function materializeReferenceImages(images: string[], signal?: AbortSignal): Promise<string[]> {
  return Promise.all(images.map(async (image) => {
    if (!/^data:image\//i.test(image)) return image;
    const response = await apiRequest<AssetUploadResponse>('/api/assets', {
      method: 'POST',
      body: JSON.stringify({ dataUrl: image }),
      signal,
    });
    return response.asset.url;
  }));
}
