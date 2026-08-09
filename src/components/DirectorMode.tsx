import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, CheckSquare2, Clapperboard, Copy, FileText, Loader2, Play, Plus, RefreshCw, Square, Upload, X } from 'lucide-react';
import { apiRequest } from '@/services/apiClient';
import { generateAIStoryboard, getStoryboardSourceBatches, mergeRegeneratedStoryboardShots, parseDirectorScript, type DirectorDurationMode } from '@/services/directorAIService';
import { generateDirectorVideos, resolveDirectorVideoModel, type DirectorClipGeneration } from '@/services/directorVideoService';
import { copyDirectorText, formatStoryboardForClipboard, readDirectorScriptFile } from '@/services/directorDocumentService';
import { createInitialDirectorAssets } from '@/services/directorAssetService';
import useProjectStore from '@/store/useProjectStore';
import type { StoryboardPlan } from '@/types/director';
import type { DirectorAsset } from '@/types/directorAsset';
import type { UserSkill } from '@/types/skill';
import DirectorAssetPreparation from '@/components/DirectorAssetPreparation';
import VideoDurationControl from '@/components/VideoDurationControl';
import { normalizeModelDuration, videoDurationRules } from '@/services/modelDuration';

interface DirectorModeProps {
  isOpen: boolean;
  onClose: () => void;
}

const voiceOptions = [
  ['naturalist', '观察式自然主义'],
  ['classicist', '构图古典主义'],
  ['visceral', '动势写实'],
  ['minimalist', '亲密极简'],
  ['formalist', '图形式构成'],
];

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const planDuration = (plan: StoryboardPlan | null) => plan?.shots.reduce((sum, shot) => sum + shot.targetDurationSec, 0) || 0;

export default function DirectorMode({ isOpen, onClose }: DirectorModeProps) {
  const { project, addNode, onConnect, updateNodeData } = useProjectStore();
  const [story, setStory] = useState('');
  const [voice, setVoice] = useState('naturalist');
  const [durationMode, setDurationMode] = useState<DirectorDurationMode>('ai');
  const [manualDurationSec, setManualDurationSec] = useState(60);
  const [plan, setPlan] = useState<StoryboardPlan | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStage, setGenerationStage] = useState('');
  const [generationProgress, setGenerationProgress] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scriptFileName, setScriptFileName] = useState('');
  const [isDraggingScript, setIsDraggingScript] = useState(false);
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedBatchIndexes, setSelectedBatchIndexes] = useState<number[]>([]);
  const [selectedShotIds, setSelectedShotIds] = useState<string[]>([]);
  const [clipGenerations, setClipGenerations] = useState<Record<string, DirectorClipGeneration>>({});
  const [isGeneratingDrama, setIsGeneratingDrama] = useState(false);
  const [previewClipId, setPreviewClipId] = useState<string | null>(null);
  const [showAssetPreparation, setShowAssetPreparation] = useState(false);
  const [directorAssets, setDirectorAssets] = useState<DirectorAsset[]>([]);
  const storyboardController = useRef<AbortController | null>(null);
  const videoController = useRef<AbortController | null>(null);
  const scriptFileInput = useRef<HTMLInputElement | null>(null);
  const scriptDragDepth = useRef(0);

  const completedClips = useMemo(() => plan?.shots
    .map((shot) => clipGenerations[shot.clipId])
    .filter((clip): clip is DirectorClipGeneration & { videoUrl: string } => clip?.status === 'completed' && Boolean(clip.videoUrl)) || [], [plan, clipGenerations]);
  const previewClip = completedClips.find((clip) => clip.clipId === previewClipId) || completedClips[0];
  const totalDurationSec = planDuration(plan);
  const parsedScript = useMemo(() => parseDirectorScript(story), [story]);
  const sourceBatches = useMemo(() => getStoryboardSourceBatches(story), [story]);
  const configuredVideoModel = project?.settings.multiModel?.videoModel || project?.settings.aiModel;
  const configuredDurationRules = videoDurationRules(configuredVideoModel);
  const normalizeShotDuration = (duration: number) => Math.round(normalizeModelDuration(duration, configuredDurationRules, 5, 15));
  const normalizePlanForModel = (sourcePlan: StoryboardPlan): StoryboardPlan => {
    const shots = sourcePlan.shots.map((shot) => ({ ...shot, targetDurationSec: normalizeShotDuration(shot.targetDurationSec) }));
    return { ...sourcePlan, shots, targetDurationSec: shots.reduce((sum, shot) => sum + shot.targetDurationSec, 0) };
  };

  useEffect(() => {
    if (!isOpen) return;
    apiRequest<{ skills: UserSkill[] }>('/api/skills').then((result) => setSkills(result.skills)).catch(() => setSkills([]));
  }, [isOpen]);

  useEffect(() => {
    setSelectedBatchIndexes(sourceBatches.map((batch) => batch.index));
  }, [sourceBatches]);

  useEffect(() => () => {
    storyboardController.current?.abort();
    videoController.current?.abort();
  }, []);

  if (!isOpen || !project) return null;

  const generate = async () => {
    setError('');
    setNotice('');
    setPlan(null);
    setClipGenerations({});
    setPreviewClipId(null);
    setSelectedShotIds([]);
    setShowAssetPreparation(false);
    setDirectorAssets([]);
    setIsGenerating(true);
    setGenerationProgress(1);
    setGenerationStage('正在将完整剧本发送给文本模型读取…');
    const controller = new AbortController();
    storyboardController.current = controller;
    try {
      const generatedPlan = await generateAIStoryboard({
        project,
        story,
        voice,
        durationMode,
        manualDurationSec: durationMode === 'manual' ? manualDurationSec : undefined,
        skills: skills.filter((skill) => selectedSkillIds.includes(skill.id)),
        selectedBatchIndexes,
        signal: controller.signal,
        onProgress: (message, progress) => {
          setGenerationStage(message);
          setGenerationProgress(progress);
        },
      });
      const completePlan = normalizePlanForModel(generatedPlan);
      setGenerationStage('AI 已完成节奏分析，正在逐镜头校验与呈现…');
      setGenerationProgress(92);
      setPlan({ ...completePlan, shots: [] });
      for (let index = 0; index < completePlan.shots.length; index += 1) {
        if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError');
        const visibleShots = completePlan.shots.slice(0, index + 1);
        setPlan({ ...completePlan, shots: visibleShots, targetDurationSec: visibleShots.reduce((sum, shot) => sum + shot.targetDurationSec, 0) });
        setGenerationStage(`正在呈现镜头 ${index + 1}/${completePlan.shots.length}…`);
        setGenerationProgress(92 + Math.round(((index + 1) / completePlan.shots.length) * 8));
        await wait(120);
      }
      setGenerationStage('');
      setGenerationProgress(100);
      setDirectorAssets(createInitialDirectorAssets(completePlan));
      setNotice(`AI 分镜完成：${completePlan.shots.length} 个镜头，共 ${planDuration(completePlan)} 秒`);
    } catch (generationError) {
      if (generationError instanceof Error && generationError.name === 'AbortError') {
        setNotice('已取消导演分镜');
      } else {
        setError(generationError instanceof Error ? generationError.message : '导演方案生成失败');
      }
      setPlan(null);
    } finally {
      storyboardController.current = null;
      setIsGenerating(false);
      setGenerationStage('');
    }
  };

  const regenerateSelectedShots = async () => {
    if (!plan || !selectedShotIds.length) return;
    const selectedIds = new Set(selectedShotIds);
    const affectedSourceIds = new Set(plan.shots.filter((shot) => selectedIds.has(shot.clipId)).flatMap((shot) => shot.sourceSegmentIds));
    if (!affectedSourceIds.size) {
      setError('所选镜头没有原文来源标记，无法局部重出');
      return;
    }
    setError('');
    setNotice('');
    setIsGenerating(true);
    setGenerationProgress(1);
    setGenerationStage('正在准备重出所选分镜…');
    const controller = new AbortController();
    storyboardController.current = controller;
    try {
      const generatedReplacement = await generateAIStoryboard({
        project,
        story,
        voice,
        durationMode: 'ai',
        skills: skills.filter((skill) => selectedSkillIds.includes(skill.id)),
        selectedSourceSegmentIds: [...affectedSourceIds],
        signal: controller.signal,
        onProgress: (message, progress) => {
          setGenerationStage(message);
          setGenerationProgress(progress);
        },
      });
      const replacement = normalizePlanForModel(generatedReplacement);
      setGenerationStage('正在替换并重新编号所选分镜…');
      setGenerationProgress(96);
      setPlan((current) => current ? mergeRegeneratedStoryboardShots(current, replacement, [...affectedSourceIds]) : current);
      setClipGenerations({});
      setPreviewClipId(null);
      setSelectedShotIds([]);
      setGenerationProgress(100);
      setNotice(`局部分镜重出完成：生成 ${replacement.shots.length} 个新镜头`);
    } catch (generationError) {
      if (generationError instanceof Error && generationError.name === 'AbortError') setNotice('已取消局部分镜重出');
      else setError(generationError instanceof Error ? generationError.message : '局部分镜重出失败');
    } finally {
      storyboardController.current = null;
      setIsGenerating(false);
      setGenerationStage('');
    }
  };

  const cancelStoryboardGeneration = () => {
    if (!storyboardController.current) return;
    setGenerationStage('正在取消导演分镜…');
    storyboardController.current.abort();
  };

  const importScriptFile = async (file?: File) => {
    if (!file) return;
    setError('');
    setNotice('');
    try {
      const importedStory = await readDirectorScriptFile(file);
      setStory(importedStory);
      setScriptFileName(file.name);
      setPlan(null);
      setNotice(`已读取 ${file.name}，共 ${importedStory.length} 个字符`);
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : '剧本文件导入失败');
    } finally {
      if (scriptFileInput.current) scriptFileInput.current.value = '';
    }
  };

  const handleScriptDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    scriptDragDepth.current += 1;
    setIsDraggingScript(true);
  };

  const handleScriptDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    scriptDragDepth.current = Math.max(0, scriptDragDepth.current - 1);
    if (scriptDragDepth.current === 0) setIsDraggingScript(false);
  };

  const handleScriptDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    scriptDragDepth.current = 0;
    setIsDraggingScript(false);
    void importScriptFile(event.dataTransfer.files?.[0]);
  };

  const updateShotDuration = (clipId: string, duration: number) => {
    const nextDuration = normalizeShotDuration(duration);
    setPlan((current) => {
      if (!current) return current;
      const shots = current.shots.map((shot) => shot.clipId === clipId ? { ...shot, targetDurationSec: nextDuration } : shot);
      return { ...current, shots, targetDurationSec: shots.reduce((sum, shot) => sum + shot.targetDurationSec, 0) };
    });
  };

  const copyPlan = async () => {
    if (!plan) return;
    setError('');
    try {
      await copyDirectorText(formatStoryboardForClipboard(plan));
      setNotice('导演方案已复制');
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : '复制失败');
    }
  };

  const copyShotPrompt = async (title: string, prompt: string) => {
    setError('');
    try {
      await copyDirectorText(prompt);
      setNotice(`${title}提示词已复制`);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : '复制失败');
    }
  };

  const addShotsToCanvas = (asVideo = false) => {
    if (!plan) return;
    const ids: string[] = [];
    plan.shots.forEach((shot, index) => {
      const id = `${plan.projectId}-${shot.clipId}`;
      ids.push(id);
      if (!project.nodes.some((node) => node.id === id)) {
        addNode({
          id,
          type: 'sceneNode',
          position: { x: 80 + (index % 4) * 340, y: 100 + Math.floor(index / 4) * 280 },
          data: {
            label: `${shot.title} · ${shot.arcPosition}`,
            type: asVideo ? 'video' : 'text',
            content: asVideo ? '等待批量生成' : shot.narrativeJob,
            duration: shot.targetDurationSec,
            prompt: shot.prompt,
            settings: { style: project.settings.defaultStyle, mood: shot.feltIntent, camera: shot.camera, lighting: shot.lighting, directorContract: shot },
            status: asVideo ? 'generating' : 'idle',
            progress: 0,
          },
        });
      } else if (asVideo) {
        updateNodeData(id, { type: 'video', duration: shot.targetDurationSec, status: 'generating', progress: 0, content: '等待批量生成' });
      }
      if (index > 0 && !project.edges.some((edge) => edge.source === ids[index - 1] && edge.target === id)) {
        onConnect({ source: ids[index - 1], target: id, sourceHandle: null, targetHandle: null });
      }
    });
    return ids;
  };

  const updateClipGeneration = (update: DirectorClipGeneration) => {
    setClipGenerations((current) => ({ ...current, [update.clipId]: update }));
    if (!plan) return;
    const nodeId = `${plan.projectId}-${update.clipId}`;
    if (update.status === 'generating') {
      updateNodeData(nodeId, { type: 'video', status: 'generating', progress: 30, content: '正在生成视频…' });
    } else if (update.status === 'completed') {
      updateNodeData(nodeId, { type: 'video', status: 'completed', progress: 100, generatedContent: update.videoUrl, thumbnail: update.thumbnail, content: '导演批量生成完成 - 点击预览' });
      setPreviewClipId((current) => current || update.clipId);
    } else {
      updateNodeData(nodeId, { type: 'video', status: 'error', progress: 0, error: update.error, content: update.error || '视频生成失败' });
    }
  };

  const openAssetPreparation = () => {
    if (!plan || isGeneratingDrama) return;
    setError('');
    if (!directorAssets.length) setDirectorAssets(createInitialDirectorAssets(plan));
    setShowAssetPreparation(true);
  };

  const generateShortDrama = async () => {
    if (!plan || isGeneratingDrama) return;
    if (!resolveDirectorVideoModel(project)) return;
    setError('');
    setShowAssetPreparation(false);
    setPreviewClipId(null);
    setClipGenerations(Object.fromEntries(plan.shots.map((shot) => [shot.clipId, { clipId: shot.clipId, status: 'queued' }])));
    addShotsToCanvas(true);
    const controller = new AbortController();
    videoController.current = controller;
    setIsGeneratingDrama(true);
    try {
      await generateDirectorVideos({ plan, project, assets: directorAssets, signal: controller.signal, onUpdate: updateClipGeneration });
      if (controller.signal.aborted) setNotice('短剧生成已停止');
    } catch (generationError) {
      if (controller.signal.aborted || (generationError instanceof Error && generationError.name === 'AbortError')) {
        setNotice('短剧生成已停止');
      } else {
        setError(generationError instanceof Error ? generationError.message : '短剧生成失败');
      }
    } finally {
      videoController.current = null;
      setIsGeneratingDrama(false);
    }
  };

  const stopVideoGeneration = () => {
    videoController.current?.abort();
    setClipGenerations((current) => Object.fromEntries(Object.entries(current).map(([clipId, item]) => (
      item.status === 'queued' || item.status === 'generating' ? [clipId, { clipId, status: 'error', error: '生成已停止' }] : [clipId, item]
    ))));
    if (plan) {
      plan.shots.forEach((shot) => {
        const item = clipGenerations[shot.clipId];
        if (item?.status === 'queued' || item?.status === 'generating') {
          updateNodeData(`${plan.projectId}-${shot.clipId}`, { status: 'error', progress: 0, error: '生成已停止', content: '生成已停止' });
        }
      });
    }
  };

  const handleClose = () => {
    storyboardController.current?.abort();
    if (isGeneratingDrama) stopVideoGeneration();
    onClose();
  };

  const playNextClip = () => {
    if (!previewClip) return;
    const next = completedClips[completedClips.findIndex((clip) => clip.clipId === previewClip.clipId) + 1];
    if (next) setPreviewClipId(next.clipId);
  };

  return (
    <div className="fixed inset-0 z-[320] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-6xl max-h-[92vh] bg-dark-900 border border-dark-600 rounded-lg shadow-2xl overflow-hidden flex flex-col">
        <header className="h-16 px-5 border-b border-dark-700 flex items-center justify-between">
          <div className="flex items-center gap-3"><Clapperboard className="w-5 h-5 text-primary-400" /><div><h2 className="font-semibold">导演模式</h2><p className="text-xs text-dark-400">{plan ? `${plan.shots.length} 个镜头 · ${totalDurationSec} 秒 · ${plan.directorVoice.name}` : 'AI 全剧本分镜'}</p></div></div>
          <button onClick={handleClose} className="p-2 rounded-md hover:bg-dark-700" title="关闭"><X className="w-5 h-5" /></button>
        </header>

        <div className="flex-1 overflow-hidden grid lg:grid-cols-[360px_1fr]">
          <aside className="p-5 border-r border-dark-700 space-y-5 overflow-y-auto">
            <div onDragEnter={handleScriptDragEnter} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDragLeave={handleScriptDragLeave} onDrop={handleScriptDrop} className={`relative rounded-lg transition-colors ${isDraggingScript ? 'bg-primary-500/10 ring-2 ring-primary-500' : ''}`}>
              <div className="flex items-center justify-between gap-3"><span className="text-xs text-dark-300">完整剧本</span><button type="button" onClick={() => scriptFileInput.current?.click()} className="h-8 px-2.5 rounded-md border border-dark-700 bg-dark-800 hover:bg-dark-700 text-xs flex items-center gap-1.5"><Upload className="w-3.5 h-3.5" />导入</button><input ref={scriptFileInput} type="file" accept=".txt,.md,.markdown,.fountain,.json,.doc,.docx,text/plain,text/markdown,application/json,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => void importScriptFile(event.target.files?.[0])} className="hidden" /></div>
              <textarea aria-label="完整剧本" value={story} onChange={(event) => { setStory(event.target.value); setScriptFileName(''); setPlan(null); }} rows={12} placeholder="粘贴完整剧本，或拖入 TXT、Markdown、Fountain、JSON、DOC、DOCX 文件…" className="mt-2 w-full p-3 bg-dark-950 border border-dark-700 rounded-lg text-sm resize-none outline-none focus:border-primary-500" />
              {scriptFileName && <p className="mt-1.5 text-xs text-dark-500 flex items-center gap-1.5 truncate"><FileText className="w-3.5 h-3.5 shrink-0" />{scriptFileName}</p>}
              {parsedScript.hasStructuredSections && <p className={`mt-1.5 text-xs ${parsedScript.shootableText.length >= 20 ? 'text-green-300' : 'text-yellow-300'}`}>已识别可拍摄正文 {parsedScript.shootableText.length} 字{parsedScript.excludedSectionTitles.length ? `；已排除 ${parsedScript.excludedSectionTitles.join('、')}` : ''}</p>}
              {isDraggingScript && <div className="absolute inset-0 z-10 rounded-lg bg-dark-950/90 border-2 border-dashed border-primary-400 flex flex-col items-center justify-center gap-2 pointer-events-none"><Upload className="w-6 h-6 text-primary-300" /><span className="text-sm text-primary-200">松开以读取剧本</span></div>}
            </div>

            <label className="block"><span className="text-xs text-dark-300">导演声音</span><select value={voice} onChange={(event) => setVoice(event.target.value)} className="mt-2 w-full h-10 px-3 bg-dark-950 border border-dark-700 rounded-lg text-sm">{voiceOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>

            <div><span className="text-xs text-dark-300">总时长</span><div className="mt-2 grid grid-cols-2 h-10 rounded-md border border-dark-700 overflow-hidden" role="group" aria-label="总时长模式"><button type="button" onClick={() => setDurationMode('ai')} className={durationMode === 'ai' ? 'bg-primary-600 text-white text-sm' : 'bg-dark-950 text-dark-300 text-sm hover:bg-dark-800'}>AI 推荐</button><button type="button" onClick={() => setDurationMode('manual')} className={durationMode === 'manual' ? 'bg-primary-600 text-white text-sm' : 'bg-dark-950 text-dark-300 text-sm hover:bg-dark-800'}>手动指定</button></div>{durationMode === 'manual' && <label className="mt-3 flex items-center justify-between gap-3"><span className="text-xs text-dark-400">目标秒数</span><input aria-label="目标总时长（秒）" type="number" min={10} max={600} value={manualDurationSec} onChange={(event) => setManualDurationSec(Math.min(600, Math.max(10, Number(event.target.value) || 10)))} className="w-28 h-9 px-3 bg-dark-950 border border-dark-700 rounded-md text-sm" /></label>}</div>

            {story.trim().length >= 20 && <fieldset><div className="mb-2 text-xs text-dark-300">生成批次</div><div className="mb-2 grid grid-cols-2 gap-2"><button type="button" onClick={() => setSelectedBatchIndexes(sourceBatches.map((batch) => batch.index))} disabled={isGenerating || selectedBatchIndexes.length === sourceBatches.length} className="h-9 px-2 rounded-md border border-dark-600 bg-dark-800 text-xs text-dark-200 hover:border-primary-500 hover:bg-primary-500/10 disabled:opacity-40 flex items-center justify-center gap-1.5"><CheckSquare2 className="w-3.5 h-3.5" />全选批次</button><button type="button" onClick={() => setSelectedBatchIndexes([])} disabled={isGenerating || selectedBatchIndexes.length === 0} className="h-9 px-2 rounded-md border border-dark-600 bg-dark-800 text-xs text-dark-200 hover:border-red-500/60 hover:bg-red-500/10 disabled:opacity-40 flex items-center justify-center gap-1.5"><Square className="w-3.5 h-3.5" />取消全选</button></div><div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">{sourceBatches.map((batch) => { const selected = selectedBatchIndexes.includes(batch.index); const firstId = batch.segments[0]?.id; const lastId = batch.segments[batch.segments.length - 1]?.id; const preview = batch.segments.map((segment) => segment.text).join(' ').slice(0, 46); return <label key={batch.index} className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs cursor-pointer ${selected ? 'border-primary-500/50 bg-primary-500/10 text-dark-200' : 'border-dark-700 bg-dark-950 text-dark-400'}`}><input type="checkbox" checked={selected} disabled={isGenerating} onChange={() => setSelectedBatchIndexes((current) => current.includes(batch.index) ? current.filter((index) => index !== batch.index) : [...current, batch.index].sort((a, b) => a - b))} className="mt-0.5 accent-primary-500" /><span className="min-w-0"><span className="block text-primary-300">批次 {batch.index + 1} · {firstId}{firstId !== lastId ? `–${lastId}` : ''}</span><span className="mt-0.5 block truncate">{preview}</span></span></label>; })}</div></fieldset>}

            {skills.length > 0 && <fieldset><legend className="text-xs text-dark-300 mb-2">应用 Skill</legend><div className="space-y-2 max-h-32 overflow-y-auto">{skills.map((skill) => <label key={skill.id} className="flex items-center gap-2 text-sm text-dark-300"><input type="checkbox" checked={selectedSkillIds.includes(skill.id)} onChange={() => setSelectedSkillIds((current) => current.includes(skill.id) ? current.filter((id) => id !== skill.id) : [...current, skill.id])} className="accent-primary-500" /><span className="truncate">{skill.name}</span></label>)}</div></fieldset>}
            {notice && <p role="status" className="text-sm text-green-300 bg-green-500/10 border border-green-500/30 rounded-md p-3">{notice}</p>}
            {error && <p role="alert" className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md p-3">{error}</p>}
            {isGenerating
              ? <button type="button" onClick={cancelStoryboardGeneration} className="w-full min-h-10 px-3 border border-red-500/50 bg-red-500/10 hover:bg-red-500/20 text-red-300 rounded-md font-medium flex items-center justify-center gap-2"><Square className="w-4 h-4" />取消分镜</button>
              : <button onClick={() => void generate()} disabled={story.trim().length < 20 || selectedBatchIndexes.length === 0} className="w-full min-h-10 px-3 bg-primary-600 hover:bg-primary-500 disabled:opacity-50 rounded-md font-medium flex items-center justify-center gap-2"><Clapperboard className="w-4 h-4" />生成所选批次</button>}
          </aside>

          <section className="p-5 overflow-y-auto">
            {!plan && !isGenerating ? <div className="h-full min-h-80 flex items-center justify-center text-dark-500"><Clapperboard className="w-10 h-10" /></div> : <div className="space-y-5">
              {isGenerating && <div role="status" className="space-y-2" aria-live="polite"><div className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 flex items-center gap-2 text-primary-300"><Loader2 className="w-4 h-4 animate-spin shrink-0" /><span className="truncate">{generationStage}</span></span><span className="text-xs tabular-nums text-dark-300 shrink-0">{generationProgress}%</span></div><div className="h-2 w-full overflow-hidden rounded-sm bg-dark-700" role="progressbar" aria-label="导演分镜生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={generationProgress}><div className="h-full bg-primary-500 transition-[width] duration-300" style={{ width: `${generationProgress}%` }} /></div></div>}
              {plan && <>
                <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium">AI 导演方案</h3><p className="text-xs text-dark-400 mt-1">{plan.durationRecommendationReason}</p></div><div className="flex items-center gap-2">{selectedShotIds.length > 0 && <button type="button" onClick={() => void regenerateSelectedShots()} disabled={isGenerating} className="h-8 px-2.5 rounded-md bg-primary-600 hover:bg-primary-500 disabled:opacity-50 text-xs flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" />重出选中 ({selectedShotIds.length})</button>}<button type="button" onClick={() => setSelectedShotIds(selectedShotIds.length === plan.shots.length ? [] : plan.shots.map((shot) => shot.clipId))} disabled={isGenerating} className="h-8 px-2.5 rounded-md border border-dark-700 bg-dark-800 hover:bg-dark-700 disabled:opacity-50 text-xs">{selectedShotIds.length === plan.shots.length ? '取消全选' : '全选镜头'}</button><button type="button" onClick={() => void copyPlan()} disabled={isGenerating} className="h-8 px-2.5 rounded-md border border-dark-700 bg-dark-800 hover:bg-dark-700 disabled:opacity-50 text-xs flex items-center gap-1.5"><Copy className="w-3.5 h-3.5" />复制全部</button></div></div>
                <div className="grid md:grid-cols-3 gap-3 text-sm"><div className="bg-dark-800 border border-dark-700 rounded-md p-3"><p className="text-dark-500 text-xs">故事承诺</p><p className="mt-1">{plan.storyPromise}</p></div><div className="bg-dark-800 border border-dark-700 rounded-md p-3"><p className="text-dark-500 text-xs">最终结果</p><p className="mt-1">{plan.finalOutcome}</p></div><div className="bg-dark-800 border border-dark-700 rounded-md p-3"><p className="text-dark-500 text-xs">当前总时长</p><p className="mt-1">{totalDurationSec} 秒</p></div></div>
                {previewClip && <div className="border border-dark-700 rounded-md overflow-hidden bg-black"><video key={previewClip.clipId} src={previewClip.videoUrl} controls autoPlay onEnded={playNextClip} className="w-full aspect-video bg-black" /><div className="h-11 px-3 flex items-center gap-2 overflow-x-auto bg-dark-950">{completedClips.map((clip, index) => <button key={clip.clipId} onClick={() => setPreviewClipId(clip.clipId)} className={`h-7 px-2 rounded-md text-xs flex items-center gap-1.5 shrink-0 ${previewClip.clipId === clip.clipId ? 'bg-primary-600 text-white' : 'bg-dark-800 text-dark-300 hover:text-white'}`}><Play className="w-3 h-3" />{index + 1}</button>)}</div></div>}
                <div className="space-y-3">{plan.shots.map((shot) => {
                  const generation = clipGenerations[shot.clipId];
                  const isSelected = selectedShotIds.includes(shot.clipId);
                  return <article key={shot.clipId} className={`border rounded-md p-4 bg-dark-950/60 ${isSelected ? 'border-primary-500/70' : 'border-dark-700'}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0 flex items-start gap-2"><input aria-label={`选择${shot.title}`} type="checkbox" checked={isSelected} disabled={isGenerating || isGeneratingDrama} onChange={() => setSelectedShotIds((current) => current.includes(shot.clipId) ? current.filter((id) => id !== shot.clipId) : [...current, shot.clipId])} className="mt-1 accent-primary-500" /><div className="min-w-0"><p className="text-xs text-primary-400">{shot.sceneId} / {shot.clipId} / {shot.arcPosition}</p><h3 className="font-medium mt-1">{shot.narrativeJob}</h3></div></div><div className="flex items-center gap-2 shrink-0"><label className="flex items-center gap-2 text-xs text-dark-400"><span>时长</span><VideoDurationControl value={shot.targetDurationSec} onChange={(duration) => updateShotDuration(shot.clipId, duration)} rules={configuredDurationRules} fallbackMin={5} fallbackMax={15} compact disabled={isGenerating || isGeneratingDrama} ariaLabel={`${shot.title}时长`} /></label><button type="button" onClick={() => void copyShotPrompt(shot.title, shot.prompt)} className="w-8 h-8 rounded-md border border-dark-700 bg-dark-800 hover:bg-dark-700 flex items-center justify-center" title="复制镜头提示词"><Copy className="w-3.5 h-3.5" /></button></div></div><div className="grid md:grid-cols-2 gap-3 mt-3 text-xs text-dark-400"><p>镜头：{shot.camera}</p><p>结束状态：{shot.plannedEndState}</p></div>{generation?.error && <p className="mt-3 text-xs text-red-300">{generation.error}</p>}<div className="mt-3 bg-dark-900 border border-dark-700 rounded-md p-3 text-sm text-dark-200 leading-relaxed">{shot.prompt}</div><div className="mt-3 flex justify-end"><span className={`text-[10px] px-2 py-1 rounded-full flex items-center gap-1 ${generation?.status === 'completed' ? 'bg-green-500/15 text-green-300' : generation?.status === 'error' ? 'bg-red-500/15 text-red-300' : generation ? 'bg-primary-500/15 text-primary-300' : shot.status === 'ready' ? 'bg-green-500/15 text-green-300' : 'bg-yellow-500/15 text-yellow-300'}`}>{generation?.status === 'completed' ? <CheckCircle2 className="w-3 h-3" /> : generation?.status === 'error' ? <AlertCircle className="w-3 h-3" /> : generation ? <Loader2 className={`w-3 h-3 ${generation.status === 'generating' ? 'animate-spin' : ''}`} /> : null}{generation ? ({ queued: '排队中', generating: '生成中', completed: '已完成', error: '失败' }[generation.status]) : shot.status === 'ready' ? '可生成' : '待上一镜验收'}</span></div></article>;
                })}</div>
              </>}
            </div>}
          </section>
        </div>
        {plan && !isGenerating && <footer className="min-h-16 px-5 py-3 border-t border-dark-700 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-dark-400">{plan.shots.length} 段 · 共 {totalDurationSec} 秒 · 已完成 {completedClips.length}/{plan.shots.length}</p><div className="flex items-center gap-2">{isGeneratingDrama ? <button onClick={stopVideoGeneration} className="h-10 px-4 rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10 flex items-center gap-2"><Square className="w-4 h-4" />停止生成</button> : <button onClick={openAssetPreparation} className="h-10 px-4 rounded-md bg-green-600 hover:bg-green-500 flex items-center gap-2"><Clapperboard className="w-4 h-4" />一键生成短剧</button>}<button onClick={() => { addShotsToCanvas(false); onClose(); }} disabled={isGeneratingDrama} className="h-10 px-4 rounded-md bg-primary-600 hover:bg-primary-500 disabled:opacity-50 flex items-center gap-2"><Plus className="w-4 h-4" />仅加入分镜</button></div></footer>}
      </div>
      {showAssetPreparation && plan && <DirectorAssetPreparation project={project} assets={directorAssets} videoModelAvailable={Boolean(resolveDirectorVideoModel(project))} onChange={setDirectorAssets} onClose={() => setShowAssetPreparation(false)} onConfirm={() => void generateShortDrama()} />}
    </div>
  );
}
