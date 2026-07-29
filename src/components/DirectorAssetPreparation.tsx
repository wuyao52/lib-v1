import { type Dispatch, type DragEvent, type SetStateAction, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ImagePlus, Loader2, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { createDirectorAsset, generateDirectorAssetImage, resolveDirectorImageModel, validateDirectorAssets } from '@/services/directorAssetService';
import type { DramaProject } from '@/types';
import type { DirectorAsset, DirectorAssetKind } from '@/types/directorAsset';

interface DirectorAssetPreparationProps {
  project: DramaProject;
  assets: DirectorAsset[];
  videoModelAvailable: boolean;
  onChange: Dispatch<SetStateAction<DirectorAsset[]>>;
  onClose: () => void;
  onConfirm: () => void;
}

const kindMeta: Record<DirectorAssetKind, { title: string; description: string }> = {
  scene: { title: '场景', description: '空间布局、时间、光线和环境连续性' },
  character: { title: '主要人物', description: '外貌、发型、服装、体态和身份标签' },
  prop: { title: '道具', description: '关键物件的材质、尺寸、状态和归属' },
};

const readImage = (file: File) => new Promise<string>((resolve, reject) => {
  if (!file.type.startsWith('image/')) return reject(new Error('请选择 JPG、PNG、WebP 等图片文件'));
  if (file.size > 10 * 1024 * 1024) return reject(new Error('单张参考图不能超过 10MB'));
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error('参考图读取失败'));
  reader.readAsDataURL(file);
});

export default function DirectorAssetPreparation({ project, assets, videoModelAvailable, onChange, onClose, onConfirm }: DirectorAssetPreparationProps) {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const imageModelAvailable = Boolean(resolveDirectorImageModel(project));
  const validation = useMemo(() => validateDirectorAssets(assets), [assets]);

  const updateAsset = (id: string, patch: Partial<DirectorAsset>) => {
    onChange((current) => current.map((asset) => asset.id === id ? { ...asset, ...patch } : asset));
  };

  const addAsset = (kind: DirectorAssetKind) => onChange((current) => [...current, createDirectorAsset(kind)]);
  const removeAsset = (id: string) => onChange((current) => current.filter((asset) => asset.id !== id));

  const uploadAssetImage = async (asset: DirectorAsset, file?: File) => {
    if (!file) return;
    setError('');
    try {
      const referenceImage = await readImage(file);
      updateAsset(asset.id, { referenceImage, imageSource: 'uploaded', status: 'ready', error: undefined });
      setNotice(`已为“${asset.name || '未命名资产'}”载入参考图`);
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : '参考图读取失败';
      updateAsset(asset.id, { status: 'error', error: message });
      setError(message);
    }
  };

  const generateOne = async (asset: DirectorAsset, sharedController?: AbortController) => {
    const activeController = sharedController || new AbortController();
    if (!sharedController) controller.current = activeController;
    updateAsset(asset.id, { status: 'generating', error: undefined });
    try {
      const referenceImage = await generateDirectorAssetImage(asset, project, activeController.signal);
      updateAsset(asset.id, { referenceImage, imageSource: 'generated', status: 'ready', error: undefined });
      return true;
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : '资产生成失败';
      updateAsset(asset.id, { status: 'error', error: message });
      if (generationError instanceof Error && generationError.name === 'AbortError') return false;
      setError(message);
      return false;
    } finally {
      if (!sharedController) controller.current = null;
    }
  };

  const generateAll = async () => {
    if (!imageModelAvailable || isGeneratingAll) return;
    const candidates = assets.filter((asset) => asset.name.trim() && asset.description.trim());
    if (!candidates.length) {
      setError('请先填写至少一个资产的名称和描述');
      return;
    }
    setError('');
    setNotice('');
    setIsGeneratingAll(true);
    const activeController = new AbortController();
    controller.current = activeController;
    let completed = 0;
    for (const asset of candidates) {
      if (activeController.signal.aborted) break;
      if (await generateOne(asset, activeController)) completed += 1;
    }
    controller.current = null;
    setIsGeneratingAll(false);
    if (!activeController.signal.aborted) setNotice(`资产生成完成：${completed}/${candidates.length}`);
  };

  const confirm = () => {
    setError('');
    if (!videoModelAvailable) {
      setError('尚未配置可用的视频模型，请在模型设置中补全 API 地址、模型 ID 和 API Key');
      return;
    }
    if (!validation.valid) {
      setError(validation.errors.join('；'));
      return;
    }
    onConfirm();
  };

  const close = () => {
    controller.current?.abort();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[360] bg-black/80 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="director-assets-title">
      <div className="w-full max-w-5xl max-h-[90vh] bg-dark-900 border border-dark-600 rounded-lg shadow-2xl overflow-hidden flex flex-col">
        <header className="min-h-16 px-5 py-3 border-b border-dark-700 flex items-center justify-between gap-4">
          <div><h2 id="director-assets-title" className="font-semibold">短剧资产准备</h2><p className="mt-1 text-xs text-dark-400">确认场景、主要人物和关键道具后，再按同一套资产连续生成全部镜头。</p></div>
          <button type="button" onClick={close} className="w-9 h-9 rounded-md hover:bg-dark-700 flex items-center justify-center" title="关闭资产准备"><X className="w-5 h-5" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {(['scene', 'character', 'prop'] as DirectorAssetKind[]).map((kind) => {
            const items = assets.filter((asset) => asset.kind === kind);
            return <section key={kind} aria-labelledby={`asset-kind-${kind}`}>
              <div className="mb-2 flex items-center justify-between gap-3"><div><h3 id={`asset-kind-${kind}`} className="text-sm font-medium">{kindMeta[kind].title}{kind !== 'prop' && <span className="ml-1 text-red-300">*</span>}</h3><p className="mt-0.5 text-xs text-dark-500">{kindMeta[kind].description}</p></div><button type="button" onClick={() => addAsset(kind)} className="h-8 px-2.5 rounded-md border border-dark-600 bg-dark-800 hover:bg-dark-700 text-xs flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" />添加</button></div>
              <div className="space-y-2">
                {items.map((asset) => <div key={asset.id} className="border border-dark-700 rounded-md bg-dark-950/60 p-3">
                  <div className="grid lg:grid-cols-[160px_1fr_150px_auto] gap-2 items-start">
                    <input aria-label={`${kindMeta[kind].title}名称`} value={asset.name} onChange={(event) => updateAsset(asset.id, { name: event.target.value, status: asset.referenceImage ? 'ready' : 'draft' })} placeholder="名称" className="h-10 px-3 bg-dark-900 border border-dark-600 rounded-md text-sm outline-none focus:border-primary-500" />
                    <textarea aria-label={`${asset.name || kindMeta[kind].title}描述`} value={asset.description} onChange={(event) => updateAsset(asset.id, { description: event.target.value, status: asset.referenceImage ? 'ready' : 'draft' })} placeholder={kind === 'character' ? '年龄、外貌、发型、服装、体态、身份特征' : kind === 'scene' ? '空间结构、时间、天气、光线、固定陈设' : '材质、尺寸、颜色、当前状态和使用者'} rows={2} className="min-h-10 px-3 py-2 bg-dark-900 border border-dark-600 rounded-md text-sm resize-y outline-none focus:border-primary-500" />
                    <label onDragOver={(event) => { event.preventDefault(); setDraggingId(asset.id); }} onDragLeave={() => setDraggingId(null)} onDrop={(event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); setDraggingId(null); void uploadAssetImage(asset, event.dataTransfer.files?.[0]); }} className={`h-20 border border-dashed rounded-md overflow-hidden cursor-pointer flex items-center justify-center ${draggingId === asset.id ? 'border-primary-400 bg-primary-500/10' : 'border-dark-600 bg-dark-900 hover:border-primary-500'}`}>
                      {asset.referenceImage ? <img src={asset.referenceImage} alt={`${asset.name || '资产'}参考图`} className="w-full h-full object-cover" /> : <span className="text-xs text-dark-400 flex flex-col items-center gap-1"><Upload className="w-4 h-4" />上传或拖入</span>}
                      <input type="file" accept="image/*" className="hidden" onChange={(event) => void uploadAssetImage(asset, event.target.files?.[0])} />
                    </label>
                    <div className="flex items-center gap-1">
                      <button type="button" disabled={!imageModelAvailable || asset.status === 'generating' || isGeneratingAll} onClick={() => void generateOne(asset)} className="w-9 h-9 rounded-md border border-dark-600 bg-dark-800 hover:bg-dark-700 disabled:opacity-40 flex items-center justify-center" title="AI 生成资产图">{asset.status === 'generating' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}</button>
                      <button type="button" onClick={() => removeAsset(asset.id)} disabled={asset.status === 'generating'} className="w-9 h-9 rounded-md text-dark-400 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 flex items-center justify-center" title="删除资产"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                  {asset.error && <p className="mt-2 text-xs text-red-300">{asset.error}</p>}
                  {asset.referenceImage && <p className="mt-2 text-xs text-green-300 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" />{asset.imageSource === 'generated' ? 'AI 资产图已生成' : '参考图已上传'}</p>}
                </div>)}
              </div>
            </section>;
          })}

          {!imageModelAvailable && <p className="text-sm text-yellow-200 bg-yellow-500/10 border border-yellow-500/30 rounded-md p-3 flex items-start gap-2"><AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />未配置图片模型，仍可上传参考图并使用文字资产描述。AI 生图需先配置图片模型。</p>}
          {notice && <p role="status" className="text-sm text-green-300 bg-green-500/10 border border-green-500/30 rounded-md p-3">{notice}</p>}
          {error && <p role="alert" className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md p-3">{error}</p>}
        </div>

        <footer className="min-h-16 px-5 py-3 border-t border-dark-700 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-dark-400">参考图可选；场景和主要人物的名称与描述必填，道具可按剧情添加。</p>
          <div className="flex items-center gap-2">
            {isGeneratingAll ? <button type="button" onClick={() => controller.current?.abort()} className="h-10 px-4 rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10">停止生成资产</button> : <button type="button" onClick={() => void generateAll()} disabled={!imageModelAvailable} className="h-10 px-4 rounded-md border border-dark-600 bg-dark-800 hover:bg-dark-700 disabled:opacity-40 flex items-center gap-2"><ImagePlus className="w-4 h-4" />生成全部资产图</button>}
            <button type="button" onClick={confirm} disabled={isGeneratingAll} className="h-10 px-4 rounded-md bg-green-600 hover:bg-green-500 disabled:opacity-40 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />确认资产并生成短剧</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
