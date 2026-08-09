import type { AIModelConfig } from '@/types';
import { apiRequest } from '@/services/apiClient';

type CatalogModel = AIModelConfig & { category?: 'text' | 'image' | 'video' };

function sameManagedModel(cached: AIModelConfig, current: CatalogModel): boolean {
  if (cached.id && current.id === cached.id) return true;
  return current.modelId === cached.modelId && current.baseUrl === cached.baseUrl;
}

export async function refreshManagedModel(model: AIModelConfig): Promise<AIModelConfig> {
  if (!model.managed) return model;

  const { models } = await apiRequest<{ models: CatalogModel[] }>('/api/catalog/models');
  const current = models.find((candidate) => sameManagedModel(model, candidate));
  if (!current) {
    throw new Error('当前系统模型已停用或定价配置已删除，请重新选择系统模型');
  }
  const hasFixedDurations = Array.isArray(current.allowedDurationsSec) && current.allowedDurationsSec.length > 0;
  const hasDurationRange = Number(current.minDurationSec) > 0 && Number(current.maxDurationSec) > 0;
  if (current.category === 'video' && !hasFixedDurations && !hasDurationRange) {
    throw new Error(`系统模型 ${current.name || current.modelId} 尚未配置有效时长，请系统用户在模型定价中填写固定时长或完整范围`);
  }

  return {
    ...model,
    ...current,
    apiKey: '',
    managed: true,
    parameters: model.parameters || {},
  };
}
