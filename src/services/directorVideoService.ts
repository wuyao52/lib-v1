import { createAIService } from '@/services/aiService';
import type { AIModelConfig, DramaProject } from '@/types';
import type { DirectorShot, StoryboardPlan } from '@/types/director';
import type { DirectorAsset } from '@/types/directorAsset';
import { compileDirectorAssetContext, getDirectorAssetReferenceImages, validateDirectorAssets } from '@/services/directorAssetService';
import { normalizeModelDuration, videoDurationRules } from '@/services/modelDuration';
import { refreshManagedModel } from '@/services/managedModelCatalog';
import { apiRequest } from '@/services/apiClient';
import { materializeReferenceImages } from '@/services/assetService';

export type DirectorClipStatus = 'queued' | 'generating' | 'completed' | 'error';

export interface DirectorClipGeneration {
  clipId: string;
  status: DirectorClipStatus;
  previousClipId?: string;
  continuityMode?: 'asset-only' | 'provider-continuation';
  accepted?: boolean;
  tailFrameUrl?: string;
  continuityWarning?: string;
  videoUrl?: string;
  thumbnail?: string;
  error?: string;
}

interface GenerateDirectorVideosOptions {
  plan: StoryboardPlan;
  project: DramaProject;
  signal: AbortSignal;
  onUpdate: (update: DirectorClipGeneration) => void | Promise<DirectorClipGeneration | void>;
  assets: DirectorAsset[];
  clipIds?: string[];
}

export const clampDirectorClipDuration = (duration: number) => Math.min(15, Math.max(5, Number(duration) || 5));

export const directorClipIdempotencyKey = (projectId: string, planId: string, clipId: string) =>
  `director:${projectId}:${planId}:${clipId}`;

export const canGenerateNextDirectorClip = (result: DirectorClipGeneration) => result.status === 'completed';
export const canUseDirectorClipForContinuation = (result: DirectorClipGeneration) =>
  result.status === 'completed' && result.accepted === true && Boolean(result.tailFrameUrl);

export function estimateDirectorVideoCostCents(plan: StoryboardPlan, model: AIModelConfig): number | null {
  const unitPrice = Number(model.unitPriceCents);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return null;
  const unit = model.billingUnit || 'request';
  if (unit === 'second') return Math.ceil(plan.shots.reduce((sum, shot) => sum + clampDirectorClipDuration(shot.targetDurationSec), 0) * unitPrice);
  return Math.ceil(plan.shots.length * unitPrice);
}

export function summarizeDirectorClipResults(results: DirectorClipGeneration[], total: number) {
  const failed = results.filter((item) => item.status === 'error');
  return {
    completed: results.filter((item) => item.status === 'completed').length,
    failed: failed.length,
    pending: Math.max(0, total - results.length),
    failedClipIds: failed.map((item) => item.clipId),
  };
}

export function resolveDirectorVideoModel(project: DramaProject): AIModelConfig | null {
  const candidates = [project.settings.multiModel?.videoModel, project.settings.aiModel];
  return candidates.find((model): model is AIModelConfig => Boolean((model?.managed || model?.credentialManaged || model?.apiKey) && model.baseUrl && model.modelId)) || null;
}

function generationSettings(project: DramaProject, model: AIModelConfig, plan: StoryboardPlan, shot: DirectorShot, assets: DirectorAsset[], continuityImage?: string) {
  const images = [...getDirectorAssetReferenceImages(assets), ...(continuityImage ? [continuityImage] : [])];
  const duration = normalizeModelDuration(shot.targetDurationSec, videoDurationRules(model), 5, 15);
  return {
    aspect_ratio: project.settings.aspectRatio,
    resolution: model.parameters?.resolution || '720p',
    duration,
    seconds: duration,
    style: project.settings.defaultStyle,
    _client: { projectId: project.id, nodeId: `${project.id}-${shot.clipId}` },
    _idempotencyKey: directorClipIdempotencyKey(project.id, plan.projectId, shot.clipId),
    ...(images.length ? { images } : {}),
  };
}

export async function generateDirectorVideos({ plan, project, signal, onUpdate, assets, clipIds }: GenerateDirectorVideosOptions) {
  const configuredModel = resolveDirectorVideoModel(project);
  if (!configuredModel) throw new Error('请先在模型设置中配置可用的视频模型、API 地址和 API Key');
  const model = await refreshManagedModel(configuredModel);
  const service = createAIService(model);
  const validation = validateDirectorAssets(assets);
  if (!validation.valid) throw new Error(`资产准备未完成：${validation.errors.join('；')}`);
  const assetContext = compileDirectorAssetContext(assets);
  const results: DirectorClipGeneration[] = [];
  let previousTailFrameUrl: string | undefined;

  const selectedIds = clipIds?.length ? new Set(clipIds) : null;
  const shots = selectedIds ? plan.shots.filter((shot) => selectedIds.has(shot.clipId)) : plan.shots;
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index];
    if (signal.aborted) break;
    const previousClipId = index > 0 ? shots[index - 1].clipId : undefined;
    const continuityMode = previousTailFrameUrl ? 'provider-continuation' : 'asset-only';
    onUpdate({ clipId: shot.clipId, status: 'generating', previousClipId, continuityMode });
    const prompt = `${shot.prompt}\n\n资产连续性合同（不得擅自改变）：\n${assetContext}`;
    const response = await service.generateVideo(prompt, generationSettings(project, model, plan, shot, assets, previousTailFrameUrl), signal);
    if (signal.aborted) break;

    const update: DirectorClipGeneration = response.success && response.data?.url
      ? { clipId: shot.clipId, status: 'completed', previousClipId, continuityMode, videoUrl: response.data.url, thumbnail: response.data.thumbnail }
      : { clipId: shot.clipId, status: 'error', previousClipId, continuityMode, error: response.error || '视频生成失败' };
    results.push(update);
    onUpdate(update);
    if (!canGenerateNextDirectorClip(update)) break;
    try {
      const frame = await apiRequest<{ dataUrl: string }>('/api/director/tail-frame', { method: 'POST', body: JSON.stringify({ url: update.videoUrl }), signal });
      const [materializedFrame] = await materializeReferenceImages([frame.dataUrl], signal);
      previousTailFrameUrl = materializedFrame;
      const pendingAcceptance = { ...update, accepted: false, tailFrameUrl: materializedFrame, continuityMode: 'provider-continuation' as const };
      const acceptedResult = await onUpdate(pendingAcceptance);
      const accepted = Boolean(acceptedResult && acceptedResult.accepted === true);
      results[results.length - 1] = { ...pendingAcceptance, accepted };
      previousTailFrameUrl = canUseDirectorClipForContinuation(results[results.length - 1]) ? materializedFrame : undefined;
      if (!accepted) break;
      onUpdate(results[results.length - 1]);
    } catch (tailError) {
      previousTailFrameUrl = undefined;
      const pendingAcceptance = { ...update, accepted: false, continuityMode: 'asset-only' as const, continuityWarning: `已生成，但尾帧连续性不可用：${tailError instanceof Error ? tailError.message : '尾帧提取失败'}` };
      const acceptedResult = await onUpdate(pendingAcceptance);
      const accepted = Boolean(acceptedResult && acceptedResult.accepted === true);
      results[results.length - 1] = { ...pendingAcceptance, accepted };
      if (!accepted) break;
      onUpdate(results[results.length - 1]);
    }
  }

  const summary = summarizeDirectorClipResults(results, shots.length);
  if (summary.failed || summary.pending) {
    const error = new Error(`短剧批量生成未完整完成：成功 ${summary.completed}/${shots.length}，失败 ${summary.failed}，未执行 ${summary.pending}`);
    Object.assign(error, { code: 'DIRECTOR_PARTIAL_FAILURE', results, summary });
    throw error;
  }
  return results;
}
