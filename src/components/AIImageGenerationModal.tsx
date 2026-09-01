import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Download, ImagePlus, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import type { AIModelConfig } from '@/types';
import { apiRequest } from '@/services/apiClient';
import { createAIService } from '@/services/aiService';
import { archiveGeneratedImage } from '@/services/assetService';
import { refreshManagedModel } from '@/services/managedModelCatalog';

type ImageCatalogModel = AIModelConfig & {
  category: 'image';
  apiName?: string;
};

interface AIImageGenerationModalProps {
  isOpen: boolean;
  projectId: string;
  onClose: () => void;
  onAddToCanvas: (result: { url: string; prompt: string; model: ImageCatalogModel; aspectRatio: string; resolution: string }) => void;
}

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const DEFAULT_RESOLUTIONS = ['720p', '1080p', '2K', '4K'];

const billingUnitLabel = (unit?: AIModelConfig['billingUnit']) => (
  unit === 'second' ? '秒' : unit === 'request' ? '次' : '张'
);

export default function AIImageGenerationModal({ isOpen, projectId, onClose, onAddToCanvas }: AIImageGenerationModalProps) {
  const controllerRef = useRef<AbortController | null>(null);
  const [models, setModels] = useState<ImageCatalogModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [resolution, setResolution] = useState('720p');
  const [loadingModels, setLoadingModels] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [resultUrl, setResultUrl] = useState('');
  const [addedToCanvas, setAddedToCanvas] = useState(false);

  const selectedModel = models.find((model) => model.id === selectedModelId) || null;
  const resolutions = useMemo(() => {
    const configured = selectedModel?.allowedResolutions?.filter(Boolean) || [];
    return configured.length ? configured : DEFAULT_RESOLUTIONS;
  }, [selectedModel]);

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

  useEffect(() => {
    if (!isOpen) return;
    setResultUrl('');
    setAddedToCanvas(false);
    setError('');
    void loadModels();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!resolutions.includes(resolution)) setResolution(resolutions.includes('720p') ? '720p' : resolutions[0]);
  }, [resolutions, resolution]);

  const generate = async () => {
    const cleanPrompt = prompt.trim();
    if (!selectedModel) return setError('请先选择一个可用的图片模型');
    if (!cleanPrompt) return setError('请输入图片提示词');

    const controller = new AbortController();
    controllerRef.current = controller;
    setGenerating(true);
    setError('');
    setResultUrl('');
    setAddedToCanvas(false);
    try {
      const effectiveModel = await refreshManagedModel(selectedModel);
      const response = await createAIService(effectiveModel).generateImage(cleanPrompt, {
        aspect_ratio: aspectRatio,
        resolution,
        _client: { projectId },
      }, controller.signal);
      if (!response.success || !response.data?.url) throw new Error(response.error || '图片模型未返回可用图片');
      const durableUrl = await archiveGeneratedImage(response.data.url, controller.signal);
      setResultUrl(durableUrl);
      await apiRequest('/api/generation-history', {
        method: 'POST',
        body: JSON.stringify({ projectId, type: 'image', prompt: cleanPrompt, url: durableUrl, thumbnail: durableUrl }),
        signal: controller.signal,
      }).catch((historyError) => console.warn('保存图片生成历史失败:', historyError));
    } catch (generationError) {
      if (!controller.signal.aborted) setError(generationError instanceof Error ? generationError.message : 'AI 生图失败');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setGenerating(false);
      window.dispatchEvent(new Event('billing:changed'));
    }
  };

  const cancel = () => controllerRef.current?.abort();

  const addToCanvas = () => {
    if (!resultUrl || !selectedModel || addedToCanvas) return;
    onAddToCanvas({ url: resultUrl, prompt: prompt.trim(), model: selectedModel, aspectRatio, resolution });
    setAddedToCanvas(true);
  };

  const download = () => {
    if (!resultUrl) return;
    const link = document.createElement('a');
    link.href = resultUrl;
    link.download = `ai-image-${Date.now()}.png`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.click();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div className="fixed inset-0 z-[1000] flex items-center justify-center p-3 sm:p-5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={generating ? undefined : onClose} />
          <motion.section
            data-testid="ai-image-generation-modal"
            aria-label="AI 生图"
            initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }}
            className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-dark-600 bg-dark-800 shadow-2xl"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-dark-600 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-fuchsia-500/15 text-fuchsia-300"><Sparkles className="h-5 w-5" /></span>
                <div className="min-w-0"><h2 className="text-base font-semibold text-white">AI 生图</h2><p className="truncate text-xs text-dark-400">选择图片模型并生成画布素材</p></div>
              </div>
              <button type="button" onClick={onClose} disabled={generating} title="关闭" className="rounded-md p-2 text-dark-400 hover:bg-dark-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"><X className="h-5 w-5" /></button>
            </header>

            <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
              <div className="space-y-5 p-4 sm:p-5">
                <section>
                  <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium text-dark-100">图片模型</h3><button type="button" onClick={() => void loadModels()} disabled={loadingModels || generating} title="刷新模型" className="rounded-md p-1.5 text-dark-400 hover:bg-dark-700 hover:text-white disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loadingModels ? 'animate-spin' : ''}`} /></button></div>
                  {loadingModels ? (
                    <div className="flex h-24 items-center justify-center gap-2 rounded-md border border-dark-600 text-sm text-dark-400"><Loader2 className="h-4 w-4 animate-spin" />正在加载图片模型</div>
                  ) : models.length ? (
                    <div data-testid="image-model-list" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {models.map((model) => {
                        const selected = model.id === selectedModelId;
                        return <button key={model.id} type="button" disabled={generating} onClick={() => { setSelectedModelId(model.id); setResultUrl(''); setAddedToCanvas(false); setError(''); }} className={`min-h-20 rounded-md border p-3 text-left transition-colors ${selected ? 'border-fuchsia-400 bg-fuchsia-500/10' : 'border-dark-600 bg-dark-900/40 hover:border-dark-500'} disabled:cursor-not-allowed`}>
                          <span className="block break-words text-sm font-medium text-white">{model.name || model.modelId}</span>
                          <span className="mt-1 block break-words text-xs text-dark-400">{model.provider || '兼容接口'}</span>
                          <span className="mt-2 block text-xs text-green-400">¥{((model.unitPriceCents || 0) / 100).toFixed(2)} / {billingUnitLabel(model.billingUnit)}</span>
                        </button>;
                      })}
                    </div>
                  ) : (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">当前没有可用的图片模型。请联系系统用户发布图片模型；特殊用户还需要获得该模型授权。</div>
                  )}
                </section>

                <label className="block"><span className="mb-2 block text-sm font-medium text-dark-100">提示词</span><textarea aria-label="图片提示词" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={generating} maxLength={10000} rows={6} placeholder="描述主体、场景、构图、光线和风格" className="w-full resize-y rounded-md border border-dark-600 bg-dark-900 px-3 py-2 text-sm text-white outline-none placeholder:text-dark-500 focus:border-fuchsia-400 disabled:opacity-60" /><span className="mt-1 block text-right text-xs text-dark-500">{prompt.length}/10000</span></label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div><span className="mb-2 block text-sm font-medium text-dark-100">画面比例</span><div className="grid grid-cols-3 gap-2">{ASPECT_RATIOS.map((ratio) => <button key={ratio} type="button" aria-pressed={ratio === aspectRatio} disabled={generating} onClick={() => setAspectRatio(ratio)} className={`h-9 rounded-md border text-xs ${ratio === aspectRatio ? 'border-fuchsia-400 bg-fuchsia-500/15 text-white' : 'border-dark-600 text-dark-300 hover:border-dark-500'}`}>{ratio}</button>)}</div></div>
                  <label><span className="mb-2 block text-sm font-medium text-dark-100">分辨率</span><select aria-label="图片分辨率" value={resolution} disabled={generating} onChange={(event) => setResolution(event.target.value)} className="h-9 w-full rounded-md border border-dark-600 bg-dark-900 px-3 text-sm text-white outline-none focus:border-fuchsia-400">{resolutions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                </div>

                {error && <div role="alert" className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="break-words">{error}</span></div>}
              </div>

              <aside className="flex min-h-[320px] flex-col border-t border-dark-600 bg-dark-900/40 p-4 lg:border-l lg:border-t-0 sm:p-5">
                <h3 className="mb-2 text-sm font-medium text-dark-100">生成结果</h3>
                <div className="relative flex min-h-[260px] flex-1 items-center justify-center overflow-hidden rounded-md border border-dark-600 bg-dark-950">
                  {resultUrl ? <img src={resultUrl} alt="AI 生成结果" className="h-full max-h-[56vh] w-full object-contain" /> : generating ? <div className="flex flex-col items-center gap-3 text-center"><Loader2 className="h-9 w-9 animate-spin text-fuchsia-300" /><p className="text-sm text-white">图片生成并归档中</p><p className="text-xs text-dark-400">请勿关闭窗口</p></div> : <div className="flex flex-col items-center gap-3 text-center text-dark-500"><ImagePlus className="h-10 w-10" /><p className="text-sm">生成结果将在这里显示</p></div>}
                </div>
                {resultUrl && <div className="mt-3 flex items-center gap-2 rounded-md border border-green-500/20 bg-green-500/10 p-2 text-xs text-green-300"><CheckCircle2 className="h-4 w-4" />图片已生成并保存到站内素材</div>}
              </aside>
            </div>

            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-dark-600 px-4 py-3 sm:px-5">
              <button type="button" onClick={generating ? cancel : onClose} className="rounded-md px-4 py-2 text-sm text-dark-300 hover:bg-dark-700 hover:text-white">{generating ? '取消生成' : '关闭'}</button>
              <div className="flex flex-wrap justify-end gap-2">
                {resultUrl && <><button type="button" onClick={download} className="flex items-center gap-2 rounded-md border border-dark-600 px-4 py-2 text-sm text-dark-200 hover:bg-dark-700"><Download className="h-4 w-4" />下载</button><button type="button" onClick={addToCanvas} disabled={addedToCanvas} className="flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-500 disabled:cursor-default disabled:bg-green-900 disabled:text-green-300"><ImagePlus className="h-4 w-4" />{addedToCanvas ? '已添加到画布' : '添加到画布'}</button></>}
                <button type="button" onClick={() => void generate()} disabled={generating || loadingModels || !selectedModel || !prompt.trim()} className="flex items-center gap-2 rounded-md bg-fuchsia-600 px-5 py-2 text-sm font-medium text-white hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:bg-dark-700 disabled:text-dark-500">{generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{resultUrl ? '重新生成' : '生成图片'}</button>
              </div>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
