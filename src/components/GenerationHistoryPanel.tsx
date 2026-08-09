import { useCallback, useEffect, useState } from 'react';
import { X, History, ExternalLink } from 'lucide-react';
import { apiRequest } from '@/services/apiClient';
import useProjectStore from '@/store/useProjectStore';
import { PromptMentionContent } from './PromptMentionEditor';

type HistoryItem = { id: string; type: string; prompt: string; url: string; thumbnail?: string | null; createdAt: string };

function HistoryThumbnail({ item }: { item: HistoryItem }) {
  const className = 'h-full w-full object-cover';
  if (item.thumbnail) return <img src={item.thumbnail} alt="" loading="lazy" className={className} />;
  if (item.type === 'video') return <video src={item.url} muted preload="metadata" className={className} />;
  return <img src={item.url} alt="" loading="lazy" className={className} />;
}

export default function GenerationHistoryPanel({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((state) => state.project);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const refresh = useCallback(() => {
    void apiRequest<{ history: HistoryItem[] }>('/api/generation-history')
      .then((result) => setItems(result.history))
      .catch((error) => console.warn('读取生成历史失败:', error));
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const mentionNodes = (project?.nodes || []).map((node) => ({ id: node.id, label: node.data.label, type: node.data.type, imageUrl: node.data.type === 'image' ? node.data.generatedContent : undefined }));
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-black/70" onClick={onClose} aria-label="关闭" />
      <section className="relative flex max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-dark-600 bg-dark-800 shadow-2xl">
        <header className="flex items-center justify-between border-b border-dark-600 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><History className="h-4 w-4 text-primary-400" />最近 3 天生成历史</h2>
          <button onClick={onClose} className="p-2 text-dark-400 hover:text-white" title="关闭"><X className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 overflow-y-auto p-3 sm:p-4">
          <div className="space-y-2">
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
            {items.length === 0 && <p className="py-12 text-center text-sm text-dark-500">最近 3 天没有成功生成记录</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
