import { createAIService } from '@/services/aiService';
import type { AIModelConfig, DramaProject } from '@/types';
import type { DirectorShot, StoryboardPlan } from '@/types/director';
import type { DirectorAsset } from '@/types/directorAsset';
import { compileDirectorAssetContext, getDirectorAssetReferenceImages, validateDirectorAssets } from '@/services/directorAssetService';

export type DirectorClipStatus = 'queued' | 'generating' | 'completed' | 'error';

export interface DirectorClipGeneration {
  clipId: string;
  status: DirectorClipStatus;
  videoUrl?: string;
  thumbnail?: string;
  error?: string;
}

interface GenerateDirectorVideosOptions {
  plan: StoryboardPlan;
  project: DramaProject;
  signal: AbortSignal;
  onUpdate: (update: DirectorClipGeneration) => void;
  assets: DirectorAsset[];
}

export const clampDirectorClipDuration = (duration: number) => Math.min(15, Math.max(5, Number(duration) || 5));

export function resolveDirectorVideoModel(project: DramaProject): AIModelConfig | null {
  const candidates = [project.settings.multiModel?.videoModel, project.settings.aiModel];
  return candidates.find((model): model is AIModelConfig => Boolean(model?.apiKey && model.baseUrl && model.modelId)) || null;
}

function generationSettings(project: DramaProject, model: AIModelConfig, shot: DirectorShot, assets: DirectorAsset[]) {
  const images = getDirectorAssetReferenceImages(assets);
  return {
    aspect_ratio: project.settings.aspectRatio,
    resolution: model.parameters?.resolution || '720p',
    duration: clampDirectorClipDuration(shot.targetDurationSec),
    seconds: clampDirectorClipDuration(shot.targetDurationSec),
    style: project.settings.defaultStyle,
    ...(images.length ? { images } : {}),
  };
}

export async function generateDirectorVideos({ plan, project, signal, onUpdate, assets }: GenerateDirectorVideosOptions) {
  const model = resolveDirectorVideoModel(project);
  if (!model) throw new Error('请先在模型设置中配置可用的视频模型、API 地址和 API Key');
  const service = createAIService(model);
  const validation = validateDirectorAssets(assets);
  if (!validation.valid) throw new Error(`资产准备未完成：${validation.errors.join('；')}`);
  const assetContext = compileDirectorAssetContext(assets);
  const results: DirectorClipGeneration[] = [];

  for (const shot of plan.shots) {
    if (signal.aborted) break;
    onUpdate({ clipId: shot.clipId, status: 'generating' });
    const prompt = `${shot.prompt}\n\n资产连续性合同（不得擅自改变）：\n${assetContext}`;
    const response = await service.generateVideo(prompt, generationSettings(project, model, shot, assets), signal);
    if (signal.aborted) break;

    const update: DirectorClipGeneration = response.success && response.data?.url
      ? { clipId: shot.clipId, status: 'completed', videoUrl: response.data.url, thumbnail: response.data.thumbnail }
      : { clipId: shot.clipId, status: 'error', error: response.error || '视频生成失败' };
    results.push(update);
    onUpdate(update);
  }

  return results;
}
