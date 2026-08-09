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

  return {
    ...model,
    ...current,
    apiKey: '',
    managed: true,
    parameters: model.parameters || {},
  };
}
