import { Node, Edge } from '@xyflow/react';

// 场景节点类型
export type SceneNodeType = 'text' | 'image' | 'video' | 'audio' | 'transition';

// AI模型配置
export interface AIModelConfig {
  id: string;
  apiId?: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  parameters: Record<string, any>;
  managed?: boolean;
  credentialManaged?: boolean;
  credentialConfigId?: string;
  unitPriceCents?: number;
  billingUnit?: 'request' | 'image' | 'second';
  minDurationSec?: number | null;
  maxDurationSec?: number | null;
  allowedDurationsSec?: number[];
  allowedResolutions?: string[];
  maxReferenceImages?: number;
}

// 生成进度
export interface GenerationProgress {
  progress: number; // 0-100
  status: 'idle' | 'generating' | 'completed' | 'error';
  message?: string;
  startTime?: number;
  estimatedTime?: number;
}

// 场景节点数据
export interface SceneNodeData {
  label: string;
  type: SceneNodeType;
  content: string;
  duration: number; // 秒
  prompt?: string;
  referenceNodeIds?: string[];
  generatedContent?: string;
  settings: {
    style?: string;
    mood?: string;
    camera?: string;
    lighting?: string;
    [key: string]: any;
  };
  status: 'idle' | 'generating' | 'completed' | 'error';
  error?: string;
  thumbnail?: string;
  mediaSource?: 'uploaded' | 'generated';
  generationMeta?: {
    configId?: string;
    apiId?: string;
    modelId?: string;
    modelName?: string;
    provider?: string;
    taskId?: string;
    completedAt?: string;
  };
  progress?: any;  // 简化类型，支持数字或对象
  [key: string]: any;  // 添加索引签名
}

// 场景节点
export type SceneNode = Node<SceneNodeData>;

// 场景边
export type SceneEdge = Edge;

// 剧本项目
export interface DramaProject {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  nodes: SceneNode[];
  edges: SceneEdge[];
  settings: ProjectSettings;
  thumbnail?: string;
  tags?: string[];
  version?: number;
}

// 项目设置
export interface ProjectSettings {
  aspectRatio: string;
  defaultStyle: string;
  aiModel: AIModelConfig;
  // 多模型配置（可选）
  multiModel?: {
    textModel: AIModelConfig;   // 文本生成模型
    videoModel: AIModelConfig;  // 视频生成模型
    imageModel: AIModelConfig;  // 图片生成模型
  };
  directorSession?: import('./director').DirectorSession;
}

// 生成请求
export interface GenerationRequest {
  type: SceneNodeType;
  prompt: string;
  settings: Record<string, any>;
  model: AIModelConfig;
  sourceNodeId: string;
}

// 生成响应
export interface GenerationResponse {
  success: boolean;
  data?: {
    url: string;
    thumbnail?: string;
    metadata?: Record<string, any>;
  };
  error?: string;
}

// 项目信息（用于项目列表）
export interface ProjectInfo {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  sceneCount: number;
  thumbnail?: string;
  version?: number;
}
