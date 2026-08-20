import { useCallback, useEffect, useState } from 'react';
import { CheckSquare, Cloud, Database, HardDrive, Image, Loader2, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { apiRequest } from '@/services/apiClient';

type AssetItem = {
  id: string;
  url: string;
  mimeType: string;
  byteSize: number;
  storageProvider: string;
  createdAt: string;
  referenced: boolean;
  expiresAt: string | null;
};

type AssetOverview = {
  assets: AssetItem[];
  usedBytes: number;
  quotaBytes: number;
  storageProvider: string;
  retentionDays: number;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
};

const storageProviderLabel = (provider: string) => ({
  r2: 'Cloudflare R2',
  'aliyun-oss': '阿里云 OSS',
  database: '数据库兼容存储',
}[provider] || provider || '数据库兼容存储');

export default function AssetManager({ onClose }: { onClose: () => void }) {
  const [overview, setOverview] = useState<AssetOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const next = await apiRequest<AssetOverview>('/api/assets'); setOverview(next); setSelectedIds((current) => current.filter((id) => next.assets.some((asset) => asset.id === id && !asset.referenced))); }
    catch (loadError: any) { setError(loadError.message || '素材列表加载失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const remove = async (asset: AssetItem) => {
    if (asset.referenced || !window.confirm('确定删除这项云端素材吗？此操作不可撤销。')) return;
    setDeletingId(asset.id); setError('');
    try {
      await apiRequest(`/api/assets/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
      await load();
    } catch (deleteError: any) {
      setError(deleteError.message || '素材删除失败');
    } finally {
      setDeletingId('');
    }
  };

  const toggleSelected = (asset: AssetItem) => {
    if (asset.referenced) return;
    setSelectedIds((current) => current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id]);
  };

  const removeSelected = async () => {
    if (!selectedIds.length || !window.confirm(`确定删除选中的 ${selectedIds.length} 项素材吗？删除后可在 7 天内恢复。`)) return;
    setBatchDeleting(true); setError('');
    try {
      const result = await apiRequest<{ deleted: number; skipped: string[] }>('/api/assets/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: selectedIds }) });
      if (result.skipped.length) setError(`${result.deleted} 项已移入恢复期；${result.skipped.length} 项仍被项目或历史记录使用，未删除。`);
      setSelectedIds([]); await load();
    } catch (deleteError: any) { setError(deleteError.message || '批量删除失败'); }
    finally { setBatchDeleting(false); }
  };

  const usedPercent = overview?.quotaBytes
    ? Math.min(100, (overview.usedBytes / overview.quotaBytes) * 100)
    : 0;

  return <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
    <button className="absolute inset-0 bg-black/70" onClick={onClose} aria-label="关闭素材管理" />
    <section className="relative flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-dark-600 bg-dark-800 shadow-2xl">
      <header className="flex min-h-16 items-center justify-between border-b border-dark-600 px-5">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-cyan-500/10 p-2 text-cyan-400"><HardDrive className="h-5 w-5" /></div>
          <div><h2 className="font-semibold text-white">云端素材</h2><p className="text-xs text-dark-400">{overview?.assets.length || 0} 项</p></div>
        </div>
          <div className="flex items-center gap-1">
            {selectedIds.length > 0 && <button onClick={() => void removeSelected()} disabled={batchDeleting} className="flex h-8 items-center gap-1 rounded bg-red-500/15 px-2 text-xs text-red-300 hover:bg-red-500/25 disabled:opacity-50" title="批量删除未引用素材">{batchDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}删除 {selectedIds.length}</button>}
          <button onClick={() => void load()} disabled={loading} className="p-2 text-dark-400 hover:text-white disabled:opacity-40" title="刷新"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
          <button onClick={onClose} className="p-2 text-dark-400 hover:text-white" title="关闭"><X className="h-4 w-4" /></button>
        </div>
      </header>

      <div className="overflow-y-auto p-5">
        {overview && <div className="mb-5 grid gap-4 border-b border-dark-700 pb-5 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <div className="mb-2 flex items-center justify-between text-xs"><span className="text-dark-300">{formatBytes(overview.usedBytes)} / {formatBytes(overview.quotaBytes)}</span><span className="text-dark-500">{usedPercent.toFixed(1)}%</span></div>
            <div className="h-2 overflow-hidden rounded bg-dark-700"><div className={`h-full ${usedPercent >= 90 ? 'bg-red-500' : usedPercent >= 70 ? 'bg-amber-500' : 'bg-cyan-500'}`} style={{ width: `${usedPercent}%` }} /></div>
            <p className="mt-2 text-xs text-dark-500">未引用素材保留 {overview.retentionDays} 天，到期后进入 7 天恢复期；项目或有效生成历史正在使用的素材不会删除。</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-dark-300">{overview.storageProvider === 'database' ? <Database className="h-4 w-4 text-amber-400" /> : <Cloud className="h-4 w-4 text-cyan-400" />}{storageProviderLabel(overview.storageProvider)}</div>
        </div>}

        {error && <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        {loading && !overview ? <div className="flex h-52 items-center justify-center text-dark-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" />加载素材...</div>
          : overview?.assets.length ? <><div className="mb-3 flex items-center justify-between text-xs text-dark-400"><span>仅未引用素材可多选删除</span><button onClick={() => setSelectedIds(overview.assets.filter((asset) => !asset.referenced).map((asset) => asset.id))} className="hover:text-white">全选未引用</button></div><div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {overview.assets.map((asset) => <article key={asset.id} className={`overflow-hidden rounded-md border bg-dark-900 ${selectedIds.includes(asset.id) ? 'border-cyan-400' : 'border-dark-600'}`}>
              <div className="aspect-video bg-dark-950"><img src={asset.url} alt="云端素材" loading="lazy" className="h-full w-full object-cover" /></div>
              <div className="space-y-2 p-3">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-xs text-dark-200">{asset.mimeType.replace('image/', '').toUpperCase()}</p><p className="mt-0.5 text-[10px] text-dark-500">{formatBytes(asset.byteSize)} · {new Date(asset.createdAt).toLocaleDateString('zh-CN')}</p>{asset.expiresAt && <p className="mt-1 text-[10px] text-amber-400">{new Date(asset.expiresAt).toLocaleDateString('zh-CN')} 自动删除</p>}</div><button onClick={() => toggleSelected(asset)} disabled={asset.referenced} className="text-cyan-300 disabled:text-dark-600" title={asset.referenced ? '素材正在使用，不能删除' : '选择素材'}>{selectedIds.includes(asset.id) ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}</button><span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${asset.referenced ? 'bg-green-500/10 text-green-400' : 'bg-dark-700 text-dark-400'}`}>{asset.referenced ? '使用中' : '未引用'}</span></div>
                <button onClick={() => void remove(asset)} disabled={asset.referenced || deletingId === asset.id} className="flex h-8 w-full items-center justify-center gap-1.5 rounded bg-dark-700 text-xs text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:text-dark-600" title={asset.referenced ? '素材仍被项目或生成历史使用' : '删除素材'}>{deletingId === asset.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}删除</button>
              </div>
            </article>)}
          </div></> : <div className="flex h-52 flex-col items-center justify-center text-dark-500"><Image className="mb-3 h-8 w-8" /><p className="text-sm">暂无云端素材</p></div>}
      </div>
    </section>
  </div>;
}
