import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Clock3, Download, Eye, ImagePlus, Loader2, RefreshCw, Sparkles, Square, X } from 'lucide-react';
import type { AIModelConfig, GenerationResponse } from '@/types';
import { useAuth } from '@/auth/AuthContext';
import { apiRequest } from '@/services/apiClient';
import { createAIService } from '@/services/aiService';
import { archiveGeneratedImageBestEffort, getPlayableMediaUrl } from '@/services/assetService';
import { refreshManagedModel } from '@/services/managedModelCatalog';
import ResolvedImage from './ResolvedImage';

type ImageCatalogModel = AIModelConfig & { category: 'image'; apiName?: string };
type ImageHistoryItem = { id: string; type: string; prompt: string; url: string; thumbnail?: string | null; createdAt: string; expiresAt: string };
type ImageGenerationTask = {
  id: string;
  status: 'generating' | 'completed' | 'error' | 'cancelled';
  prompt: string;
  aspectRatio: string;
  resolution: string;
  createdAt: string;
  expiresAt?: string;
  taskId?: string;
  sourceUrl?: string;
  url?: string;
  archiveStatus?: 'pending' | 'completed' | 'failed';
  archiveError?: string;
  error?: string;
  model?: ImageCatalogModel;
  modelName: string;
};

interface AIImageGenerationModalProps {
  isOpen: boolean;
  projectId: string;
  onClose: () => void;
  onAddToCanvas: (result: { url: string; prompt: string; model: ImageCatalogModel; aspectRatio: string; resolution: string }) => void;
}

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const billingUnitLabel = (unit?: AIModelConfig['billingUnit']) => unit === 'second' ? '秒' : unit === 'request' ? '次' : '张';
const localTaskId = () => typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const IMAGE_TASK_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const IMAGE_TASK_STALE_MS = 2 * 60 * 60 * 1000;
const imageTaskStorageKey = (userId: string, projectId: string) => `ai-image-generation-tasks:${userId}:${projectId}`;

function readPersistedImageTasks(key: string): ImageGenerationTask[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter((task): task is ImageGenerationTask => (
        task && typeof task === 'object'
        && typeof task.id === 'string'
        && ['generating', 'completed', 'error', 'cancelled'].includes(task.status)
        && typeof task.prompt === 'string'
        && typeof task.createdAt === 'string'
      ))
      .map((task) => {
        const createdAt = Date.parse(task.createdAt);
        if (task.status === 'generating' && Number.isFinite(createdAt) && now - createdAt > IMAGE_TASK_STALE_MS) {
          return { ...task, status: 'error' as const, error: '生成任务已超时，请重新生成' };
        }
        return task;
      })
      .filter((task) => !task.expiresAt || Date.parse(task.expiresAt) > now)
      .slice(0, 100);
  } catch {
    return [];
  }
}

function writePersistedImageTasks(key: string, tasks: ImageGenerationTask[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(tasks.slice(0, 100)));
  } catch {
    // A full or disabled browser storage must not prevent image generation.
  }
}

export default function AIImageGenerationModal({ isOpen, projectId, onClose, onAddToCanvas }: AIImageGenerationModalProps) {
  const { user } = useAuth();
  const controllersRef = useRef(new Map<string, AbortController>());
  const archiveTaskIdsRef = useRef(new Set<string>());
  const resumedTaskIdsRef = useRef(new Set<string>());
  const skipPersistRef = useRef(false);
  const [models, setModels] = useState<ImageCatalogModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [resolution, setResolution] = useState('');
  const [quality, setQuality] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [tasks, setTasks] = useState<ImageGenerationTask[]>([]);
  const [previewTaskId, setPreviewTaskId] = useState('');
  const [addedTaskIds, setAddedTaskIds] = useState<Set<string>>(() => new Set());
  const taskStorageKey = useMemo(
    () => imageTaskStorageKey(user?.id || 'anonymous', projectId),
    [projectId, user?.id],
  );

  const selectedModel = models.find((model) => model.id === selectedModelId) || null;
  const previewTask = tasks.find((task) => (
    task.id === previewTaskId
    && task.status !== 'generating'
    && task.status !== 'cancelled'
    && (task.url || task.sourceUrl)
  )) || null;
  const activeCount = tasks.filter((task) => task.status === 'generating').length;
  const resolutions = useMemo(() => {
    return [...new Set((selectedModel?.allowedResolutions || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  }, [selectedModel]);
  const qualities = useMemo(() => {
    return [...new Set((selectedModel?.allowedQualities || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  }, [selectedModel]);

  const updateTask = (id: string, updates: Partial<ImageGenerationTask>) => {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...updates } : task));
    const persisted = readPersistedImageTasks(taskStorageKey);
    if (persisted.some((task) => task.id === id)) {
      writePersistedImageTasks(taskStorageKey, persisted.map((task) => task.id === id ? { ...task, ...updates } : task));
    }
  };

  useEffect(() => {
    skipPersistRef.current = true;
    setTasks(readPersistedImageTasks(taskStorageKey));
    setAddedTaskIds(new Set());
    resumedTaskIdsRef.current.clear();
  }, [taskStorageKey]);

  useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    writePersistedImageTasks(taskStorageKey, tasks);
  }, [taskStorageKey, tasks]);

  const loadModels = async () => {
    setLoadingModels(true);
    setError('');
    try {
      const response = await apiRequest<{ models: Array<AIModelConfig & { category?: string; apiName?: string }> }>('/api/catalog/models');
      const imageModels = (Array.isArray(response.models) ? response.models : [])
        .filter((model): model is ImageCatalogModel => model.category === 'image')
        .map((model) => ({ ...model, apiKey: '', parameters: model.parameters || {} }));
      setModels(imageModels);
      setSelectedModelId((current) => imageModels.some((model) => model.id === current) ? current : imageModels[0]?.id || '');
    } catch (loadError) {
      setModels([]);
      setSelectedModelId('');
      setError(loadError instanceof Error ? loadError.message : '图片模型加载失败');
    } finally {
      setLoadingModels(false);
    }
  };

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const response = await apiRequest<{ history: ImageHistoryItem[] }>('/api/generation-history?type=image&limit=100');
      const historyTasks: ImageGenerationTask[] = response.history.map((item) => ({
        id: `history-${item.id}`,
        status: 'completed',
        prompt: item.prompt,
        aspectRatio: '',
        resolution: '',
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        url: item.url,
        archiveStatus: 'completed',
        modelName: '历史记录',
      }));
      setTasks((current) => {
        const urls = new Set(current.flatMap((task) => [task.url, task.sourceUrl]).filter(Boolean));
        return [...current, ...historyTasks.filter((task) => !urls.has(task.url))]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
      setHistoryError('');
    } catch (loadError) {
      setHistoryError(loadError instanceof Error ? loadError.message : '图片历史加载失败');
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    void Promise.all([loadModels(), loadHistory()]);
  }, [isOpen]);

  const archiveTask = async (taskId: string, sourceUrl: string) => {
    if (!sourceUrl || archiveTaskIdsRef.current.has(taskId)) return;
    archiveTaskIdsRef.current.add(taskId);
    updateTask(taskId, { archiveStatus: 'pending', archiveError: undefined });
    try {
      const result = await archiveGeneratedImageBestEffort(sourceUrl);
      if (result.archived) {
        updateTask(taskId, { url: result.url, archiveStatus: 'completed', archiveError: undefined });
      } else {
        updateTask(taskId, {
          url: sourceUrl,
          archiveStatus: 'failed',
          archiveError: '图片已返回，云端归档暂时不可用，可稍后重试',
        });
      }
    } catch (archiveError) {
      updateTask(taskId, {
        url: sourceUrl,
        archiveStatus: 'failed',
        archiveError: archiveError instanceof Error ? archiveError.message : '图片归档失败',
      });
    } finally {
      archiveTaskIdsRef.current.delete(taskId);
    }
  };

  const completeTask = async (
    task: ImageGenerationTask,
    response: GenerationResponse,
    controller: AbortController,
  ) => {
    if (!response.success || !response.data?.url) throw new Error(response.error || '图片模型未返回可用图片');
    const sourceUrl = response.data.url;
    const expiresAt = new Date(Date.now() + IMAGE_TASK_RETENTION_MS).toISOString();
    // Show the successful provider result immediately. Archiving is a
    // best-effort background step and must not block the result card.
    updateTask(task.id, {
      status: 'completed',
      sourceUrl,
      url: sourceUrl,
      expiresAt,
      archiveStatus: 'pending',
      archiveError: undefined,
      error: undefined,
    });
    void apiRequest<{ item: ImageHistoryItem }>('/api/generation-history', {
      method: 'POST',
      body: JSON.stringify({ projectId, type: 'image', prompt: task.prompt, url: sourceUrl, thumbnail: sourceUrl }),
    }).then((history) => {
      if (history.item?.expiresAt) updateTask(task.id, { expiresAt: history.item.expiresAt });
    }).catch((historySaveError) => {
      console.warn('保存图片生成历史失败:', historySaveError);
      setHistoryError('图片已生成，但历史记录暂时保存失败；请先下载或添加到画布');
    });
    void archiveTask(task.id, sourceUrl);
  };

  const retryArchive = async (task: ImageGenerationTask) => {
    if (!task.sourceUrl || controllersRef.current.has(task.id) || archiveTaskIdsRef.current.has(task.id)) return;
    await archiveTask(task.id, task.sourceUrl);
  };

  const resumeTask = async (task: ImageGenerationTask) => {
    if (!task.taskId || !task.model || controllersRef.current.has(task.id) || resumedTaskIdsRef.current.has(task.id)) return;
    resumedTaskIdsRef.current.add(task.id);
    const controller = new AbortController();
    controllersRef.current.set(task.id, controller);
    try {
      const effectiveModel = await refreshManagedModel(task.model);
      const response = await createAIService(effectiveModel).resumeImage(task.taskId, controller.signal);
      await completeTask(task, response, controller);
    } catch (generationError) {
      updateTask(task.id, controller.signal.aborted
        ? { status: 'cancelled', error: '已取消生成' }
        : { status: 'error', error: generationError instanceof Error ? generationError.message : 'AI 生图失败' });
    } finally {
      controllersRef.current.delete(task.id);
      resumedTaskIdsRef.current.delete(task.id);
      window.dispatchEvent(new Event('billing:changed'));
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    tasks.filter((task) => task.status === 'generating' && task.taskId).forEach((task) => {
      void resumeTask(task);
    });
  }, [isOpen, tasks]);

  useEffect(() => {
    if (!resolutions.includes(resolution)) setResolution(resolutions.includes('720p') ? '720p' : (resolutions[0] || ''));
  }, [resolutions, resolution]);
  useEffect(() => {
    const defaultQuality = String(selectedModel?.defaultQuality || '').trim().toLowerCase();
    if (!qualities.includes(quality)) setQuality(defaultQuality && qualities.includes(defaultQuality) ? defaultQuality : (qualities[0] || ''));
  }, [qualities, quality, selectedModel?.defaultQuality]);

  const generate = async () => {
    const cleanPrompt = prompt.trim();
    if (!selectedModel) return setError('请先选择一个可用的图片模型');
    if (!cleanPrompt) return setError('请输入图片提示词');

    const id = localTaskId();
    const model = { ...selectedModel, parameters: { ...(selectedModel.parameters || {}) } };
    const task: ImageGenerationTask = {
      id,
      status: 'generating',
      prompt: cleanPrompt,
      aspectRatio,
      resolution,
      createdAt: new Date().toISOString(),
      model,
      modelName: model.name || model.modelId,
    };
    const controller = new AbortController();
    controllersRef.current.set(id, controller);
    setTasks((current) => [task, ...current]);
    const persisted = readPersistedImageTasks(taskStorageKey).filter((item) => item.id !== id);
    writePersistedImageTasks(taskStorageKey, [task, ...persisted]);
    setError('');

    try {
      const effectiveModel = await refreshManagedModel(model);
      const response = await createAIService(effectiveModel).generateImage(cleanPrompt, {
        aspect_ratio: task.aspectRatio,
        resolution: task.resolution,
        ...(quality ? { quality } : {}),
        _client: { projectId },
        _onTaskId: (taskId: string) => updateTask(id, { taskId }),
      }, controller.signal);
      await completeTask(task, response, controller);
    } catch (generationError) {
      updateTask(id, controller.signal.aborted
        ? { status: 'cancelled', error: '已取消生成' }
        : { status: 'error', error: generationError instanceof Error ? generationError.message : 'AI 生图失败' });
    } finally {
      controllersRef.current.delete(id);
      window.dispatchEvent(new Event('billing:changed'));
    }
  };

  const cancelTask = (id: string) => {
    const controller = controllersRef.current.get(id);
    if (controller) controller.abort();
    else updateTask(id, { status: 'cancelled', error: '已取消生成' });
  };
  const removeTask = (id: string) => {
    setTasks((current) => current.filter((task) => task.id !== id));
    writePersistedImageTasks(taskStorageKey, readPersistedImageTasks(taskStorageKey).filter((task) => task.id !== id));
    if (previewTaskId === id) setPreviewTaskId('');
  };
  const addToCanvas = (task: ImageGenerationTask) => {
    const resultUrl = task.url || task.sourceUrl;
    if (!resultUrl || !task.model || addedTaskIds.has(task.id)) return;
    onAddToCanvas({ url: resultUrl, prompt: task.prompt, model: task.model, aspectRatio: task.aspectRatio, resolution: task.resolution });
    setAddedTaskIds((current) => new Set(current).add(task.id));
  };
  const download = async (task: ImageGenerationTask) => {
    const resultUrl = task.url || task.sourceUrl;
    if (!resultUrl) return;
    const playableUrl = await getPlayableMediaUrl(resultUrl).catch(() => resultUrl);
    const link = document.createElement('a');
    link.href = playableUrl;
    link.download = `ai-image-${Date.now()}.png`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.click();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div className="fixed inset-0 z-[1000] flex items-center justify-center p-3 sm:p-5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
          <motion.section data-testid="ai-image-generation-modal" aria-label="AI 生图" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} className="relative flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-dark-600 bg-dark-800 shadow-2xl">
            <header className="flex shrink-0 items-center justify-between border-b border-dark-600 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-fuchsia-500/15 text-fuchsia-300"><Sparkles className="h-5 w-5" /></span><div className="min-w-0"><h2 className="text-base font-semibold text-white">AI 生图</h2><p className="truncate text-xs text-dark-400">并发生成 · 结果保留 3 天</p></div></div>
              <button type="button" onClick={onClose} title="关闭" className="rounded-md p-2 text-dark-400 hover:bg-dark-700 hover:text-white"><X className="h-5 w-5" /></button>
            </header>

            <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,0.95fr)_minmax(360px,1.05fr)]">
              <div className="space-y-5 p-4 sm:p-5">
                <section>
                  <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium text-dark-100">图片模型</h3><button type="button" onClick={() => void loadModels()} disabled={loadingModels} title="刷新模型" className="rounded-md p-1.5 text-dark-400 hover:bg-dark-700 hover:text-white disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loadingModels ? 'animate-spin' : ''}`} /></button></div>
                  {loadingModels ? <div className="flex h-24 items-center justify-center gap-2 rounded-md border border-dark-600 text-sm text-dark-400"><Loader2 className="h-4 w-4 animate-spin" />正在加载图片模型</div> : models.length ? <div data-testid="image-model-list" className="grid grid-cols-1 gap-2 sm:grid-cols-2">{models.map((model) => { const selected = model.id === selectedModelId; return <button key={model.id} type="button" onClick={() => { setSelectedModelId(model.id); setError(''); }} className={`min-h-20 rounded-md border p-3 text-left transition-colors ${selected ? 'border-fuchsia-400 bg-fuchsia-500/10' : 'border-dark-600 bg-dark-900/40 hover:border-dark-500'}`}><span className="block break-words text-sm font-medium text-white">{model.name || model.modelId}</span><span className="mt-1 block break-words text-xs text-dark-400">{model.provider || '兼容接口'}</span><span className="mt-2 block text-xs text-green-400">¥{((model.unitPriceCents || 0) / 100).toFixed(2)} / {billingUnitLabel(model.billingUnit)}</span></button>; })}</div> : <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">当前没有可用的图片模型。请联系系统用户发布图片模型；特殊用户还需要获得该模型授权。</div>}
                </section>

                <label className="block"><span className="mb-2 block text-sm font-medium text-dark-100">提示词</span><textarea aria-label="图片提示词" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={10000} rows={5} placeholder="描述主体、场景、构图、光线和风格" className="w-full resize-y rounded-md border border-dark-600 bg-dark-900 px-3 py-2 text-sm text-white outline-none placeholder:text-dark-500 focus:border-fuchsia-400" /><span className="mt-1 block text-right text-xs text-dark-500">{prompt.length}/10000</span></label>
                <div className="grid gap-4 sm:grid-cols-2"><div><span className="mb-2 block text-sm font-medium text-dark-100">画面比例</span><div className="grid grid-cols-3 gap-2">{ASPECT_RATIOS.map((ratio) => <button key={ratio} type="button" aria-pressed={ratio === aspectRatio} onClick={() => setAspectRatio(ratio)} className={`h-9 rounded-md border text-xs ${ratio === aspectRatio ? 'border-fuchsia-400 bg-fuchsia-500/15 text-white' : 'border-dark-600 text-dark-300 hover:border-dark-500'}`}>{ratio}</button>)}</div></div><div><span className="mb-2 block text-sm font-medium text-dark-100">分辨率</span>{resolutions.length ? <><select aria-label="图片分辨率" value={resolution} disabled={resolutions.length <= 1} onChange={(event) => setResolution(event.target.value)} className="h-9 w-full rounded-md border border-dark-600 bg-dark-900 px-3 text-sm text-white outline-none focus:border-fuchsia-400 disabled:cursor-default disabled:text-dark-300">{resolutions.map((item) => <option key={item} value={item}>{item}</option>)}</select><span className="mt-1 block text-[10px] text-dark-500">{resolutions.length > 1 ? '该模型支持多个分辨率' : '该模型使用固定分辨率'}</span></> : <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">系统用户尚未配置此模型的分辨率</div>}</div>{selectedModel?.qualityRequired && !qualities.length ? <div className="sm:col-span-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">该模型要求质量参数，但系统用户尚未配置支持的质量值</div> : qualities.length ? <div className="sm:col-span-2"><span className="mb-2 block text-sm font-medium text-dark-100">质量</span><select aria-label="图片质量" value={quality} disabled={qualities.length <= 1} onChange={(event) => setQuality(event.target.value)} className="h-9 w-full rounded-md border border-dark-600 bg-dark-900 px-3 text-sm text-white outline-none focus:border-fuchsia-400 disabled:cursor-default disabled:text-dark-300">{qualities.map((item) => <option key={item} value={item}>{item}</option>)}</select><span className="mt-1 block text-[10px] text-dark-500">{qualities.length > 1 ? '该模型支持多个质量档位' : '该模型使用固定质量'}</span></div> : null}</div>
                {error && <div role="alert" className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="break-words">{error}</span></div>}
              </div>

              <aside className="flex min-h-[360px] flex-col border-t border-dark-600 bg-dark-900/40 p-4 lg:border-l lg:border-t-0 sm:p-5">
                <div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-sm font-medium text-dark-100">生成结果</h3><p className="mt-0.5 text-xs text-dark-500">成功记录将在 3 天后自动清除</p></div><div className="flex items-center gap-2">{activeCount > 0 && <span className="rounded-full bg-fuchsia-500/15 px-2 py-1 text-xs text-fuchsia-300">{activeCount} 个生成中</span>}<button type="button" onClick={() => void loadHistory()} disabled={loadingHistory} title="刷新结果" className="rounded-md p-1.5 text-dark-400 hover:bg-dark-700 hover:text-white"><RefreshCw className={`h-4 w-4 ${loadingHistory ? 'animate-spin' : ''}`} /></button></div></div>
                {historyError && <div role="alert" className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">历史加载失败：{historyError}</div>}
                <div data-testid="image-generation-results" className="grid content-start gap-3 sm:grid-cols-2">
                  {tasks.map((task) => { const resultUrl = task.url || task.sourceUrl; const completed = Boolean(resultUrl && task.status !== 'generating' && task.status !== 'cancelled'); const added = addedTaskIds.has(task.id); return <article key={task.id} className={`overflow-hidden rounded-md border ${task.status === 'error' ? 'border-red-500/30' : task.status === 'generating' ? 'border-fuchsia-500/40' : 'border-dark-600'} bg-dark-900`}>
                    <button type="button" disabled={!completed} onClick={() => completed && setPreviewTaskId(task.id)} className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-dark-950 disabled:cursor-default">{completed ? <ResolvedImage source={resultUrl!} alt="AI 生成结果" className="h-full w-full object-cover" /> : task.status === 'generating' ? <div className="flex flex-col items-center gap-2 text-fuchsia-300"><Loader2 className="h-7 w-7 animate-spin" /><span className="text-xs">生成中</span></div> : task.status === 'cancelled' ? <span className="text-xs text-dark-500">已取消</span> : <div className="flex flex-col items-center gap-2 px-3 text-center text-red-300"><AlertCircle className="h-6 w-6" /><span className="line-clamp-2 text-xs">{task.error || '生成失败'}</span></div>}{completed && <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-transparent transition-colors hover:bg-black/45 hover:text-white"><Eye className="h-6 w-6" /></span>}</button>
                    <div className="space-y-2 p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-xs font-medium text-dark-200">{task.modelName}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-dark-400">{task.prompt || '无提示词'}</p></div>{task.status === 'generating' ? <button type="button" title="取消此任务" onClick={() => cancelTask(task.id)} className="shrink-0 rounded p-1 text-dark-400 hover:bg-dark-700 hover:text-red-300"><Square className="h-3.5 w-3.5" /></button> : <span className="flex shrink-0 items-center gap-1">{task.sourceUrl && task.archiveStatus !== 'completed' && <button type="button" title={task.archiveStatus === 'pending' ? '正在归档' : '重试归档'} disabled={task.archiveStatus === 'pending'} onClick={() => void retryArchive(task)} className="rounded p-1 text-primary-300 hover:bg-dark-700 hover:text-white disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${task.archiveStatus === 'pending' ? 'animate-spin' : ''}`} /></button>}{task.status !== 'completed' && <button type="button" title="移除此记录" onClick={() => removeTask(task.id)} className="rounded p-1 text-dark-500 hover:bg-dark-700 hover:text-white"><X className="h-3.5 w-3.5" /></button>}{task.status === 'completed' && task.archiveStatus === 'failed' && <span className="max-w-32 truncate text-[10px] text-amber-300" title={task.archiveError}>{task.archiveError || '归档失败'}</span>}</span>}</div>
                    <div className="flex items-center justify-between gap-2 text-[10px] text-dark-500"><span className="flex min-w-0 items-center gap-1"><Clock3 className="h-3 w-3 shrink-0" /><span className="truncate">{new Date(task.createdAt).toLocaleString()}</span></span>{completed && <span className="flex shrink-0 gap-1"><button type="button" onClick={() => setPreviewTaskId(task.id)} title="查看" className="rounded p-1.5 text-primary-300 hover:bg-dark-700 hover:text-white"><Eye className="h-3.5 w-3.5" /></button><button type="button" onClick={() => void download(task)} title="下载" className="rounded p-1.5 text-green-300 hover:bg-dark-700"><Download className="h-3.5 w-3.5" /></button>{task.model && <button type="button" onClick={() => addToCanvas(task)} disabled={added} title={added ? '已添加到画布' : '添加到画布'} className="rounded p-1.5 text-fuchsia-300 hover:bg-dark-700 disabled:text-green-400"><ImagePlus className="h-3.5 w-3.5" /></button>}</span>}</div></div>
                  </article>; })}
                  {!loadingHistory && tasks.length === 0 && <div className="col-span-full flex min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-dark-600 text-center text-dark-500"><ImagePlus className="h-9 w-9" /><p className="text-sm">最近 3 天没有生图记录</p></div>}
                  {loadingHistory && tasks.length === 0 && <div className="col-span-full flex min-h-60 items-center justify-center gap-2 text-sm text-dark-400"><Loader2 className="h-5 w-5 animate-spin" />正在加载生图记录</div>}
                </div>
              </aside>
            </div>

            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-dark-600 px-4 py-3 sm:px-5"><div><button type="button" onClick={onClose} className="rounded-md px-4 py-2 text-sm text-dark-300 hover:bg-dark-700 hover:text-white">关闭</button>{activeCount > 0 && <span className="ml-2 text-xs text-dark-500">关闭窗口后任务继续运行</span>}</div><button type="button" onClick={() => void generate()} disabled={loadingModels || !selectedModel || !prompt.trim() || !resolutions.length || Boolean(selectedModel.qualityRequired && !qualities.length)} className="flex items-center gap-2 rounded-md bg-fuchsia-600 px-5 py-2 text-sm font-medium text-white hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:bg-dark-700 disabled:text-dark-500"><Sparkles className="h-4 w-4" />生成图片</button></footer>
          </motion.section>

          {previewTask && <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 p-4" onClick={() => setPreviewTaskId('')}><div className="relative flex max-h-[92vh] max-w-[92vw] flex-col items-center gap-3" onClick={(event) => event.stopPropagation()}><ResolvedImage source={(previewTask.url || previewTask.sourceUrl)!} alt="AI 图片大图预览" className="max-h-[78vh] max-w-[92vw] rounded-md object-contain shadow-2xl" loading="eager" /><div className="flex flex-wrap items-center justify-center gap-2"><button type="button" onClick={() => void download(previewTask)} className="flex items-center gap-2 rounded-md bg-dark-700 px-4 py-2 text-sm text-white hover:bg-dark-600"><Download className="h-4 w-4" />下载</button>{previewTask.model && <button type="button" onClick={() => addToCanvas(previewTask)} disabled={addedTaskIds.has(previewTask.id)} className="flex items-center gap-2 rounded-md bg-fuchsia-600 px-4 py-2 text-sm text-white hover:bg-fuchsia-500 disabled:bg-green-800"><ImagePlus className="h-4 w-4" />{addedTaskIds.has(previewTask.id) ? '已添加到画布' : '添加到画布'}</button>}<button type="button" onClick={() => setPreviewTaskId('')} className="rounded-md border border-dark-600 bg-dark-900 px-4 py-2 text-sm text-dark-200">关闭预览</button></div></div></div>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
