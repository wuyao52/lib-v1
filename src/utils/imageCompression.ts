type ImageCompressionOptions = {
  maxBytes: number;
  maxDimension: number;
  outputMimeType?: 'image/jpeg' | 'image/webp';
  background?: string;
  signal?: AbortSignal;
  errorLabel?: string;
};

const STORED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function dataUrlByteLength(value: string): number {
  const commaIndex = value.indexOf(',');
  if (commaIndex < 0) return 0;
  const payload = value.slice(commaIndex + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 0.75) - padding);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('用户取消上传', 'AbortError');
}

function loadImage(dataUrl: string, errorLabel: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const image = new window.Image();
    const abort = () => {
      image.src = '';
      reject(new DOMException('用户取消上传', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    image.onload = () => {
      signal?.removeEventListener('abort', abort);
      resolve(image);
    };
    image.onerror = () => {
      signal?.removeEventListener('abort', abort);
      reject(new Error(`${errorLabel}读取失败，请改用 PNG、JPEG、WebP 或 GIF 图片`));
    };
    image.src = dataUrl;
  });
}

export async function compressImageDataUrl(
  value: string,
  options: ImageCompressionOptions,
): Promise<string> {
  if (!/^data:image\//i.test(value)) return value;
  const {
    maxBytes,
    maxDimension,
    outputMimeType = 'image/webp',
    background,
    signal,
    errorLabel = '图片',
  } = options;
  const mimeType = value.slice(5, value.indexOf(';')).toLowerCase();
  if (STORED_IMAGE_MIME_TYPES.has(mimeType) && dataUrlByteLength(value) <= maxBytes) return value;

  const image = await loadImage(value, errorLabel, signal);
  throwIfAborted(signal);
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight) throw new Error(`${errorLabel}尺寸无效`);

  const initialScale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
  let width = Math.max(1, Math.round(naturalWidth * initialScale));
  let height = Math.max(1, Math.round(naturalHeight * initialScale));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`浏览器无法压缩${errorLabel}`);
  let smallest = '';
  let smallestBytes = Number.POSITIVE_INFINITY;

  for (let resizeAttempt = 0; resizeAttempt < 8; resizeAttempt += 1) {
    throwIfAborted(signal);
    canvas.width = width;
    canvas.height = height;
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);

    for (const quality of [0.86, 0.72, 0.58, 0.44, 0.32]) {
      throwIfAborted(signal);
      let encoded: string;
      try {
        encoded = canvas.toDataURL(outputMimeType, quality);
      } catch {
        throw new Error(`${errorLabel}无法在浏览器中转换，请改用 PNG、JPEG 或 WebP 图片`);
      }
      const encodedBytes = dataUrlByteLength(encoded);
      if (encodedBytes < smallestBytes) {
        smallest = encoded;
        smallestBytes = encodedBytes;
      }
      if (encodedBytes <= maxBytes) return encoded;
    }

    width = Math.max(1, Math.round(width * 0.78));
    height = Math.max(1, Math.round(height * 0.78));
  }

  if (smallest && smallestBytes <= maxBytes) return smallest;
  throw new Error(`${errorLabel}压缩后仍然过大，请使用尺寸更小的图片`);
}
