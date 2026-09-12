import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getPlayableMediaUrl, needsResolvedMediaUrl } from '@/services/assetService';

interface ResolvedImageProps {
  source: string;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
}

/**
 * Internal asset URLs must be exchanged for a short-lived object-storage URL
 * before a browser requests the image. This avoids sending large image bytes
 * through the Netlify function proxy.
 */
export default function ResolvedImage({ source, alt, className = '', loading = 'lazy' }: ResolvedImageProps) {
  const [url, setUrl] = useState(needsResolvedMediaUrl(source) ? '' : source);

  useEffect(() => {
    const controller = new AbortController();
    const requiresResolution = needsResolvedMediaUrl(source);
    setUrl(requiresResolution ? '' : source);
    void getPlayableMediaUrl(source, controller.signal).then(setUrl).catch(() => undefined);
    return () => controller.abort();
  }, [source]);

  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-dark-950 text-dark-500" aria-label="正在读取图片">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return <img src={url} alt={alt} loading={loading} className={className} />;
}
