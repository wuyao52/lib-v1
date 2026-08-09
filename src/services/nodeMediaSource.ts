import type { SceneNodeData } from '@/types';

const IMAGE_FILE_NAME = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;

export function isUploadedImageNode(data: SceneNodeData): boolean {
  if (data.type !== 'image' || !data.generatedContent) return false;
  if (data.mediaSource === 'uploaded') return true;
  if (data.mediaSource === 'generated') return false;

  // Older projects stored the original upload name in content.
  return !String(data.prompt || '').trim() && IMAGE_FILE_NAME.test(String(data.content || '').trim());
}
