import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, History, ExternalLink, Film, ChevronDown } from 'lucide-react';
import { apiRequest } from '@/services/apiClient';
import useProjectStore from '@/store/useProjectStore';
import { PromptMentionContent } from './PromptMentionEditor';
import { getPlayableMediaUrl } from '@/services/assetService';

type HistoryItem = { id: string; type: string; prompt: string; url: string; thumbnail?: string | null; createdAt: string };

function HistoryThumbnail({ item }: { item: HistoryItem }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(item.type !== 'video' || Boolean(item.thumbnail));
  const [playbackUrl, setPlaybackUrl] = useState(item.url);
  useEffect(() => {
    if (visible || !containerRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || item.type !== 'video') return undefined;
    const controller = new AbortController();
    void getPlayableMediaUrl(item.url, controller.signal).then(setPlaybackUrl).catch(() => setPlaybackUrl(item.url));
    return () => controller.abort();
  }, [item.type, item.url, visible]);
  const className = 'h-full w-full object-cover';
  return <span ref={containerRef} className="flex h-full w-full items-center justify-center bg-black">{item.thumbnail
    ? <img src={item.thumbnail} alt="" loading="lazy" className={className} />
    : item.type === 'video'
      ? visible ? <video src={playbackUrl} muted preload="metadata" className={className} /> : <Film className="h-5 w-5 text-dark-500" />
      : <img src={item.url} alt="" loading="lazy" className={className} />}</span>;
}

export default function GenerationHistoryPanel({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((state) => state.project);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState('');
  const refresh = useCallback(() => {
    void apiRequest<{ history: HistoryItem[]; nextCursor: string | null }>('/api/generation-history?limit=50')
      .then((result) => {
        setItems(result.history);
        setNextCursor(result.nextCursor);
        setLoadError('');
      })
      .catch((error) => { console.warn('读取生成历史失败:', error); setLoadError(error instanceof Error ? error.message : '历史记录暂时无法加载'); });
  }, []);
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await apiRequest<{ history: HistoryItem[]; nextCursor: string | null }>(`/api/generation-history?limit=50&cursor=${encodeURIComponent(nextCursor)}`);
      setItems((current) => [...current, ...result.history.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setNextCursor(result.nextCursor);
    } catch (error) { console.warn('读取更多生成历史失败:', error); setLoadError(error instanceof Error ? error.message : '历史记录暂时无法加载'); }
    finally { setLoadingMore(false); }
  }, [loadingMore, nextCursor]);
  useEffect(() => {
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    refreshWhenVisible();
    const timer = window.setInterval(refreshWhenVisible, 20_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refresh]);
  const mentionNodes = useMemo(() => (project?.nodes || []).map((node) => ({ id: node.id, label: node.data.label, type: node.data.type, imageUrl: node.data.type === 'image' ? node.data.generatedContent : undefined })), [project?.nodes]);
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-black/70" onClick={onClose} aria-label="关闭" />
      <section data-testid="generation-history" className="relative flex max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-dark-600 bg-dark-800 shadow-2xl">
        <header className="flex items-center justify-between border-b border-dark-600 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><History className="h-4 w-4 text-primary-400" />最近 3 天生成历史</h2>
          <button onClick={onClose} className="p-2 text-dark-400 hover:text-white" title="关闭"><X className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 overflow-y-auto p-3 sm:p-4">
          <div className="space-y-2">
            {loadError && <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"><span>历史加载失败：{loadError}</span><button type="button" onClick={refresh} className="shrink-0 text-primary-300 hover:text-white">重试</button></div>}
            {items.map((item) => {
              const createdAt = new Date(item.createdAt);
              return (
                <a
                  key={item.id}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="grid min-h-20 grid-cols-[72px_92px_minmax(0,1fr)_28px] items-center gap-2 overflow-hidden rounded-lg border border-dark-600 bg-dark-900 p-2 transition-colors hover:border-primary-500 sm:grid-cols-[104px_140px_minmax(0,1fr)_36px] sm:gap-3"
                >
                  <span className="block h-16 w-[72px] shrink-0 overflow-hidden rounded-md bg-black sm:h-20 sm:w-[104px]">
                    <HistoryThumbnail item={item} />
                  </span>
                  <time dateTime={item.createdAt} className="min-w-0 text-[10px] leading-5 text-dark-400 sm:text-xs">
                    <span className="block truncate">{createdAt.toLocaleDateString()}</span>
                    <span className="block truncate text-dark-500">{createdAt.toLocaleTimeString()}</span>
                  </time>
                  <span className="min-w-0">
                    <span className="mb-1 block text-[10px] uppercase text-primary-400">{item.type}</span>
                    <span className="line-clamp-3 text-xs leading-5 text-dark-200">
                      {item.prompt ? <PromptMentionContent value={item.prompt} nodes={mentionNodes} /> : '无提示词'}
                    </span>
                  </span>
                  <ExternalLink className="h-4 w-4 justify-self-center text-dark-500" />
                </a>
              );
            })}
            {nextCursor && <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="flex h-10 w-full items-center justify-center gap-2 text-xs text-dark-300 hover:text-white disabled:opacity-50"><ChevronDown className="h-4 w-4" />{loadingMore ? '正在加载' : '加载更多'}</button>}
            {items.length === 0 && <p className="py-12 text-center text-sm text-dark-500">最近 3 天没有成功生成记录</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
