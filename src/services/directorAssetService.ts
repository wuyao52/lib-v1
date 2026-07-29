import { createAIService } from '@/services/aiService';
import type { AIModelConfig, DramaProject } from '@/types';
import type { StoryboardPlan } from '@/types/director';
import type { DirectorAsset, DirectorAssetKind, DirectorAssetValidation } from '@/types/directorAsset';

const assetLabels: Record<DirectorAssetKind, string> = {
  scene: '场景',
  character: '主要人物',
  prop: '道具',
};

let assetSequence = 0;

const makeAssetId = (kind: DirectorAssetKind, suffix: string) =>
  `${kind}-${suffix.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || Date.now()}`;

export function createDirectorAsset(kind: DirectorAssetKind, suffix = `${Date.now()}-${assetSequence += 1}`): DirectorAsset {
  return {
    id: makeAssetId(kind, suffix),
    kind,
    name: '',
    description: '',
    continuityLocks: [],
    status: 'draft',
  };
}

export function createInitialDirectorAssets(plan: StoryboardPlan): DirectorAsset[] {
  const scenes = plan.scenes.map((scene, index) => ({
    ...createDirectorAsset('scene', `${scene.sceneId}-${index}`),
    name: scene.sceneId,
    description: scene.narrativeFunction,
    continuityLocks: ['空间布局、主光方向和时间状态在关联镜头中保持一致'],
  }));

  return [
    ...scenes,
    { ...createDirectorAsset('character', 'main-1'), continuityLocks: ['脸部、发型、服装和体态跨镜头保持一致'] },
    createDirectorAsset('prop', 'prop-1'),
  ];
}

export function resolveDirectorImageModel(project: DramaProject): AIModelConfig | null {
  const candidates = [project.settings.multiModel?.imageModel, project.settings.aiModel];
  return candidates.find((model): model is AIModelConfig => Boolean(model?.apiKey && model.baseUrl && model.modelId)) || null;
}

export function validateDirectorAssets(assets: DirectorAsset[]): DirectorAssetValidation {
  const usable = assets.filter((asset) => asset.name.trim() || asset.description.trim() || asset.referenceImage);
  const scenes = usable.filter((asset) => asset.kind === 'scene');
  const characters = usable.filter((asset) => asset.kind === 'character');
  const errors: string[] = [];

  if (!scenes.length) errors.push('至少需要一个场景资产');
  if (!characters.length) errors.push('至少需要一个主要人物资产');
  for (const asset of [...scenes, ...characters, ...usable.filter((item) => item.kind === 'prop')]) {
    if (!asset.name.trim()) errors.push(`${assetLabels[asset.kind]}缺少名称`);
    if (!asset.description.trim()) errors.push(`${assetLabels[asset.kind]}“${asset.name || '未命名'}”缺少外观或连续性描述`);
  }
  if (usable.some((asset) => asset.status === 'generating')) errors.push('仍有资产正在生成');

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function buildDirectorAssetPrompt(asset: DirectorAsset, project: DramaProject): string {
  const locks = asset.continuityLocks.filter(Boolean).join('；') || '保持主体外观与空间关系稳定';
  const purpose = asset.kind === 'scene'
    ? '生成干净的场景设定参考图，不出现无关人物，清楚展示空间布局、入口、主要光源和可拍摄区域'
    : asset.kind === 'character'
      ? '生成角色定妆参考图，正面或四分之三视角，清晰呈现脸部、发型、服装、体态，不添加其他角色'
      : '生成干净的道具设定参考图，主体完整、比例明确，不出现无关物件或文字水印';
  return [
    `${assetLabels[asset.kind]}资产：${asset.name.trim()}`,
    `设定：${asset.description.trim()}`,
    `连续性锁定：${locks}`,
    `用途：${purpose}`,
    `项目视觉风格：${project.settings.defaultStyle || '写实短剧'}`,
  ].join('\n');
}

export async function generateDirectorAssetImage(asset: DirectorAsset, project: DramaProject, signal: AbortSignal): Promise<string> {
  const model = resolveDirectorImageModel(project);
  if (!model) throw new Error('请先配置图片模型，或为资产上传参考图');
  if (!asset.name.trim() || !asset.description.trim()) throw new Error('请先填写资产名称和描述');
  const response = await createAIService(model).generateImage(buildDirectorAssetPrompt(asset, project), {
    aspect_ratio: asset.kind === 'character' ? '3:4' : '16:9',
    resolution: model.parameters?.resolution || '720p',
    images: asset.referenceImage ? [asset.referenceImage] : undefined,
  }, signal);
  if (!response.success || !response.data?.url) throw new Error(response.error || '图片模型未返回资产图片');
  return response.data.url;
}

export function compileDirectorAssetContext(assets: DirectorAsset[]): string {
  let referenceIndex = 0;
  return assets
    .filter((asset) => asset.name.trim() && asset.description.trim())
    .map((asset) => {
      const locks = asset.continuityLocks.filter(Boolean).join('；');
      const referenceRole = asset.referenceImage ? `\n参考图角色：第 ${referenceIndex += 1} 张图仅用于锁定该${assetLabels[asset.kind]}` : '';
      return `[${assetLabels[asset.kind]}:${asset.name.trim()}]\n设定：${asset.description.trim()}${locks ? `\n连续性锁定：${locks}` : ''}${referenceRole}`;
    })
    .join('\n\n');
}

export function getDirectorAssetReferenceImages(assets: DirectorAsset[]): string[] {
  return [...new Set(assets.map((asset) => asset.referenceImage).filter((image): image is string => Boolean(image)))];
}
