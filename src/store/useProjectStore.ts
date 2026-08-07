import { create } from 'zustand';
import {
  Node,
  Edge,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  Connection,
} from '@xyflow/react';
import {
  SceneNodeData,
  AIModelConfig,
  DramaProject,
  ProjectSettings,
  ProjectInfo,
  GenerationProgress,
} from '@/types';
import { createAIService, SeedanceService } from '@/services/aiService';
import { apiRequest } from '@/services/apiClient';

// 默认AI模型配置
const defaultModel: AIModelConfig = {
  id: 'seedance-2.0',
  name: 'Seedance 2.0',
  provider: 'Seedance',
  apiKey: '',
  baseUrl: 'https://api.seedance.com/v1',
  modelId: 'seedance-2.0',
  parameters: {
    quality: 'high',
    style: 'cinematic',
  },
};

// 默认项目设置
const defaultSettings: ProjectSettings = {
  resolution: { width: 1920, height: 1080 },
  fps: 24,
  aspectRatio: '16:9',
  defaultStyle: 'cinematic',
  aiModel: defaultModel,
};

// 生成唯一ID
const generateId = () => `id-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

let storageScope = 'unscoped';
const getProjectListKey = () => `ai-drama-projects:${storageScope}`;
const getProjectDataKey = (projectId: string) => `ai-drama-project:${storageScope}:${projectId}`;

const migrateLegacyProjects = (targetScope: string) => {
  const migrationOwnerKey = 'ai-drama-projects:migration-owner';
  if (localStorage.getItem(migrationOwnerKey)) return;
  const legacyProjects = localStorage.getItem('ai-drama-projects');
  if (!legacyProjects) return;
  try {
    const projects: ProjectInfo[] = JSON.parse(legacyProjects);
    localStorage.setItem(`ai-drama-projects:${targetScope}`, legacyProjects);
    projects.forEach((project) => {
      const legacyData = localStorage.getItem(`ai-drama-project-${project.id}`);
      if (legacyData) localStorage.setItem(`ai-drama-project:${targetScope}:${project.id}`, legacyData);
    });
    localStorage.setItem(migrationOwnerKey, targetScope);
  } catch (error) {
    console.warn('旧项目迁移失败，原数据保持不变', error);
  }
};

// 获取存储的项目列表
const getStoredProjects = (): ProjectInfo[] => {
  try {
    const stored = localStorage.getItem(getProjectListKey());
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

// 保存项目列表到本地存储
const saveProjectsToStorage = (projects: ProjectInfo[]) => {
  localStorage.setItem(getProjectListKey(), JSON.stringify(projects));
};

const getSecretStorageKey = (projectId: string) => `ai-drama-project-secrets:${storageScope}:${projectId}`;

const storeProjectSecrets = (project: DramaProject) => {
  const { aiModel, multiModel } = project.settings;
  sessionStorage.setItem(getSecretStorageKey(project.id), JSON.stringify({
    aiModel: aiModel.apiKey,
    textModel: multiModel?.textModel.apiKey || '',
    videoModel: multiModel?.videoModel.apiKey || '',
    imageModel: multiModel?.imageModel.apiKey || '',
  }));
};

const createPersistableProject = (project: DramaProject): DramaProject => ({
  ...project,
  settings: {
    ...project.settings,
    aiModel: { ...project.settings.aiModel, apiKey: '' },
    multiModel: project.settings.multiModel ? {
      textModel: { ...project.settings.multiModel.textModel, apiKey: '' },
      videoModel: { ...project.settings.multiModel.videoModel, apiKey: '' },
      imageModel: { ...project.settings.multiModel.imageModel, apiKey: '' },
    } : undefined,
  },
  nodes: project.nodes.map(node => ({
    ...node,
    data: {
      ...node.data,
      generatedContent: node.data.generatedContent?.startsWith('data:') ? '' : node.data.generatedContent,
      thumbnail: node.data.thumbnail?.startsWith('data:') ? '' : node.data.thumbnail,
    },
  })),
});

const restoreProjectSecrets = (project: DramaProject): DramaProject => {
  try {
    const secrets = JSON.parse(sessionStorage.getItem(getSecretStorageKey(project.id)) || '{}');
    return {
      ...project,
      settings: {
        ...project.settings,
        aiModel: { ...project.settings.aiModel, apiKey: secrets.aiModel || '' },
        multiModel: project.settings.multiModel ? {
          textModel: { ...project.settings.multiModel.textModel, apiKey: secrets.textModel || '' },
          videoModel: { ...project.settings.multiModel.videoModel, apiKey: secrets.videoModel || '' },
          imageModel: { ...project.settings.multiModel.imageModel, apiKey: secrets.imageModel || '' },
        } : undefined,
      },
    };
  } catch {
    return project;
  }
};

// 保存项目数据到本地存储。失败时绝不删除其他项目。
const saveProjectDataToStorage = (project: DramaProject): boolean => {
  try {
    storeProjectSecrets(project);
    const dataStr = JSON.stringify(createPersistableProject(project));
    localStorage.setItem(getProjectDataKey(project.id), dataStr);
    return true;
  } catch (error: any) {
    if (error.name === 'QuotaExceededError') {
      console.error('localStorage 空间不足，项目未保存；未删除任何其他项目');
      alert('保存失败：浏览器存储空间不足。请先导出项目或主动删除不需要的项目。');
    } else {
      console.error('保存项目数据失败:', error);
    }
    return false;
  }
};

// 从本地存储加载项目数据
const loadProjectDataFromStorage = (projectId: string): DramaProject | null => {
  try {
    const stored = localStorage.getItem(getProjectDataKey(projectId));
    return stored ? restoreProjectSecrets(JSON.parse(stored)) : null;
  } catch {
    return null;
  }
};

const saveProjectToCloud = async (project: DramaProject) => {
  const persistable = createPersistableProject(project);
  await apiRequest(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ project: persistable }),
  });
};

const loadProjectFromCloud = async (projectId: string): Promise<DramaProject> => {
  const result = await apiRequest<{ project: DramaProject }>(`/api/projects/${encodeURIComponent(projectId)}`);
  return restoreProjectSecrets(result.project);
};

const loadProjectListFromCloud = async (): Promise<ProjectInfo[]> => {
  const result = await apiRequest<{ projects: ProjectInfo[] }>('/api/projects');
  return result.projects;
};

// 创建新项目
const createNewProject = (title: string, description: string): DramaProject => {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    title,
    description,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    settings: { ...defaultSettings },
  };
};

// 历史记录接口
interface HistoryState {
  nodes: Node<SceneNodeData>[];
  edges: Edge[];
}

interface ProjectStore {
  // 应用状态
  currentView: 'home' | 'project';
  projects: ProjectInfo[];
  project: DramaProject | null;
  selectedNode: string | null;
  isGenerating: boolean;
  showSettings: boolean;
  showModelConfig: boolean;
  generationProgress: Map<string, GenerationProgress>;

  // 撤销/重做状态
  history: HistoryState[];
  historyIndex: number;
  maxHistorySize: number;

  // 自动保存状态
  autoSaveEnabled: boolean;
  autoSaveTimer: ReturnType<typeof setTimeout> | null;
  lastSaveTime: string | null;
  isSaving: boolean;

  // 项目操作
  createProject: (title: string, description?: string) => void;
  openProject: (projectId: string) => void;
  closeProject: () => void;
  deleteProject: (projectId: string) => void;
  refreshProjects: () => void;
  setUserScope: (userId: string) => void;

  // 画布操作
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setSelectedNode: (nodeId: string | null) => void;
  addNode: (node: Node<SceneNodeData>) => void;
  updateNodeData: (nodeId: string, data: Partial<SceneNodeData>) => void;
  deleteNode: (nodeId: string) => void;
  duplicateNode: (nodeId: string) => void;

  // 生成操作
  activeGenerations: Map<string, AbortController>;
  startGeneration: (nodeId: string) => void;
  startGenerationWithType: (
    nodeId: string,
    type: 'video' | 'image' | 'img2img',
    settings: {
      prompt: string;
      style: string;
      duration?: number;
      strength?: number;
      negativePrompt?: string;
    },
    position?: { x: number; y: number }
  ) => void;
  cancelGeneration: (nodeId: string) => void;
  updateGenerationProgress: (nodeId: string, progress: GenerationProgress) => void;

  // 设置操作
  updateProjectSettings: (settings: Partial<ProjectSettings>) => void;
  updateAIModel: (model: Partial<AIModelConfig>) => void;
  toggleSettings: () => void;
  toggleModelConfig: () => void;

  // 保存/导出
  saveCurrentProject: () => void;
  exportProject: () => void;

  // 撤销/重做
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  pushToHistory: () => void;

  // 自动保存
  enableAutoSave: (enabled: boolean) => void;
  triggerAutoSave: () => void;
}

// 自动保存延迟时间（毫秒）
const AUTO_SAVE_DELAY = 2000;

const useProjectStore = create<ProjectStore>((set, get) => ({
  // 初始状态
  currentView: 'home',
  projects: getStoredProjects(),
  project: null,
  selectedNode: null,
  isGenerating: false,
  showSettings: false,
  showModelConfig: false,
  generationProgress: new Map(),
  activeGenerations: new Map(),

  // 撤销/重做初始状态
  history: [],
  historyIndex: -1,
  maxHistorySize: 50,

  // 自动保存初始状态
  autoSaveEnabled: true,
  autoSaveTimer: null,
  lastSaveTime: null,
  isSaving: false,

  // 项目操作
  createProject: (title, description = '') => {
    const newProject = createNewProject(title, description);
    const projectInfo: ProjectInfo = {
      id: newProject.id,
      title: newProject.title,
      description: newProject.description,
      createdAt: newProject.createdAt,
      updatedAt: newProject.updatedAt,
      sceneCount: 0,
    };

    // 保存到本地存储
    saveProjectDataToStorage(newProject);
    const updatedProjects = [...get().projects, projectInfo];
    saveProjectsToStorage(updatedProjects);
    void saveProjectToCloud(newProject).catch((error) => console.error('云端创建项目失败，本地副本已保留', error));

    set({
      projects: updatedProjects,
      project: newProject,
      currentView: 'project',
      history: [{ nodes: [], edges: [] }],
      historyIndex: 0,
    });
  },

  openProject: async (projectId) => {
    let projectData: DramaProject | null = null;
    try {
      projectData = await loadProjectFromCloud(projectId);
      saveProjectDataToStorage(projectData);
    } catch (error) {
      console.warn('云端项目读取失败，使用本地缓存', error);
      projectData = loadProjectDataFromStorage(projectId);
    }
    if (projectData) {
      set({
        project: projectData,
        currentView: 'project',
        history: [{ nodes: projectData.nodes, edges: projectData.edges }],
        historyIndex: 0,
      });
    }
  },

  closeProject: () => {
    // 保存当前项目
    const { project } = get();
    if (project) {
      saveProjectDataToStorage(project);
      void saveProjectToCloud(project).catch((error) => console.error('关闭项目时云端保存失败', error));
    }

    set({
      project: null,
      currentView: 'home',
      selectedNode: null,
      generationProgress: new Map(),
      history: [],
      historyIndex: -1,
      autoSaveTimer: null,
    });

    // 刷新项目列表
    get().refreshProjects();
  },

  deleteProject: (projectId) => {
    localStorage.removeItem(getProjectDataKey(projectId));
    sessionStorage.removeItem(getSecretStorageKey(projectId));
    const updatedProjects = get().projects.filter((p) => p.id !== projectId);
    saveProjectsToStorage(updatedProjects);
    set({ projects: updatedProjects });
    void apiRequest(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
      .catch((error) => console.error('云端删除项目失败', error));
  },

  refreshProjects: async () => {
    set({ projects: getStoredProjects() });
    try {
      const projects = await loadProjectListFromCloud();
      saveProjectsToStorage(projects);
      set({ projects });
    } catch (error) {
      console.warn('云端项目列表读取失败，保留本地缓存', error);
    }
  },

  setUserScope: async (userId) => {
    const nextScope = userId.replace(/[^a-zA-Z0-9-]/g, '');
    if (!nextScope || nextScope === storageScope) return;
    migrateLegacyProjects(nextScope);
    storageScope = nextScope;
    set({
      projects: getStoredProjects(),
      project: null,
      currentView: 'home',
      selectedNode: null,
      history: [],
      historyIndex: -1,
    });
    try {
      const remoteProjects = await loadProjectListFromCloud();
      const remoteById = new Map(remoteProjects.map((project) => [project.id, project]));
      const localProjects = getStoredProjects();
      for (const localInfo of localProjects) {
        const remoteInfo = remoteById.get(localInfo.id);
        if (!remoteInfo || localInfo.updatedAt > remoteInfo.updatedAt) {
          const localProject = loadProjectDataFromStorage(localInfo.id);
          if (localProject) await saveProjectToCloud(localProject);
        }
      }
      const synchronizedProjects = await loadProjectListFromCloud();
      saveProjectsToStorage(synchronizedProjects);
      set({ projects: synchronizedProjects });
    } catch (error) {
      console.warn('项目云同步失败，当前继续使用本地缓存', error);
    }
  },

  // 画布操作
  onNodesChange: (changes) => {
    const { project } = get();
    if (!project) return;

    const newNodes = applyNodeChanges(changes, project.nodes) as Node<SceneNodeData>[];

    set({
      project: {
        ...project,
        nodes: newNodes,
        updatedAt: new Date().toISOString(),
      },
    });

    // 触发自动保存
    get().triggerAutoSave();
  },

  onEdgesChange: (changes) => {
    const { project } = get();
    if (!project) return;

    const newEdges = applyEdgeChanges(changes, project.edges);

    set({
      project: {
        ...project,
        edges: newEdges,
        updatedAt: new Date().toISOString(),
      },
    });

    // 触发自动保存
    get().triggerAutoSave();
  },

  onConnect: (connection: Connection) => {
    const { project } = get();
    if (!project) return;

    const newEdges = addEdge(
      { ...connection, type: 'smoothstep', animated: true },
      project.edges
    );

    set({
      project: {
        ...project,
        edges: newEdges,
        updatedAt: new Date().toISOString(),
      },
    });

    // 推入历史记录
    get().pushToHistory();

    // 触发自动保存
    get().triggerAutoSave();
  },

  setSelectedNode: (nodeId) => set({ selectedNode: nodeId }),

  addNode: (node) => {
    const { project } = get();
    if (!project) return;

    set({
      project: {
        ...project,
        nodes: [...project.nodes, node],
        updatedAt: new Date().toISOString(),
      },
    });

    // 推入历史记录
    get().pushToHistory();

    // 触发自动保存
    get().triggerAutoSave();
  },

  updateNodeData: (nodeId, data) => {
    const { project } = get();
    if (!project) return;

    set({
      project: {
        ...project,
        nodes: project.nodes.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, ...data } }
            : node
        ),
        updatedAt: new Date().toISOString(),
      },
    });

    // 触发自动保存
    get().triggerAutoSave();
  },

  deleteNode: (nodeId) => {
    const { project } = get();
    if (!project) return;

    set({
      project: {
        ...project,
        nodes: project.nodes.filter((node) => node.id !== nodeId),
        edges: project.edges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId
        ),
        updatedAt: new Date().toISOString(),
      },
      selectedNode: get().selectedNode === nodeId ? null : get().selectedNode,
    });

    // 推入历史记录
    get().pushToHistory();

    // 触发自动保存
    get().triggerAutoSave();
  },

  duplicateNode: (nodeId) => {
    const { project } = get();
    if (!project) return;

    const node = project.nodes.find((n) => n.id === nodeId);
    if (node) {
      const newNode: Node<SceneNodeData> = {
        ...node,
        id: generateId(),
        position: {
          x: node.position.x + 50,
          y: node.position.y + 50,
        },
        data: {
          ...node.data,
          label: `${node.data.label} (副本)`,
          status: 'idle',
          progress: 0,
        },
      };
      get().addNode(newNode);
    }
  },

  // 生成操作
  startGeneration: (nodeId) => {
    const { project } = get();
    if (!project) return;

    const node = project.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    // 更新当前节点状态为生成中
    get().updateNodeData(nodeId, {
      status: 'generating',
      progress: 0,
    });

    // 创建新的生成结果节点
    const newNodeId = generateId();
    const newNode: Node<SceneNodeData> = {
      id: newNodeId,
      type: 'sceneNode',
      position: {
        x: node.position.x + 350,
        y: node.position.y,
      },
      data: {
        label: `${node.data.label} - 生成结果`,
        type: node.data.type === 'text' ? 'video' : node.data.type,
        content: '',
        duration: node.data.duration,
        prompt: node.data.prompt || node.data.content,
        settings: { ...node.data.settings },
        status: 'generating',
        progress: 0,
      },
    };

    // 添加新节点
    get().addNode(newNode);

    // 添加连接边
    const newEdge: Edge = {
      id: `edge-${nodeId}-${newNodeId}`,
      source: nodeId,
      target: newNodeId,
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#8b5cf6', strokeWidth: 2 },
    };

    set({
      project: {
        ...get().project!,
        edges: [...get().project!.edges, newEdge],
      },
      isGenerating: true,
    });

    // 根据生成类型选择正确的模型
    const latestProject = get().project!;
    const nodeType = node.data.type;
    let aiModel: AIModelConfig;

    // 获取多模型配置，如果不存在则创建
    let multiModel = latestProject.settings.multiModel;

    console.log('当前项目配置:', {
      hasMultiModel: !!multiModel,
      multiModel: multiModel,
      aiModel: latestProject.settings.aiModel,
    });

    if (!multiModel) {
      console.log('多模型配置不存在，从 aiModel 创建...');
      const baseModel = latestProject.settings.aiModel;
      multiModel = {
        textModel: { ...baseModel },
        videoModel: { ...baseModel },
        imageModel: { ...baseModel },
      };
      // 保存
      get().updateProjectSettings({ multiModel });
      console.log('已创建多模型配置:', multiModel);
    }

    // 选择正确的模型
    if (nodeType === 'image') {
      aiModel = multiModel.imageModel;
    } else {
      aiModel = multiModel.videoModel;
    }

    // 如果选中的模型 API Key 为空，尝试从其他模型同步
    if (!aiModel.apiKey) {
      console.log('当前模型 API Key 为空，尝试同步...');
      if (multiModel.videoModel.apiKey) {
        aiModel = multiModel.videoModel;
        console.log('从 videoModel 同步 API Key');
      } else if (multiModel.imageModel.apiKey) {
        aiModel = multiModel.imageModel;
        console.log('从 imageModel 同步 API Key');
      } else if (latestProject.settings.aiModel.apiKey) {
        aiModel = latestProject.settings.aiModel;
        console.log('从 aiModel 同步 API Key');
      } else {
        console.log('所有模型的 API Key 都为空');
      }
    }

    // 调试日志
    console.log('最终选择的 AI 模型:', {
      nodeType,
      modelId: aiModel.id,
      modelName: aiModel.name,
      provider: aiModel.provider,
      hasApiKey: !!aiModel.apiKey,
      apiKeyLength: aiModel.apiKey?.length || 0,
      baseUrl: aiModel.baseUrl,
    });

    // 检查是否有 API Key
    if (!aiModel.apiKey) {
      markGenerationFailed(nodeId, newNodeId, '请先配置 API Key', get, set);
      return;
    }

    // 使用工厂函数创建 AI 服务实例（根据模型自动选择）
    const aiService = createAIService(aiModel);
    const controller = new AbortController();
    const activeGenerations = new Map(get().activeGenerations);
    activeGenerations.set(newNodeId, controller);
    set({ activeGenerations });

    // 异步执行生成
    (async () => {
      try {
        // 更新进度：准备中
        get().updateNodeData(newNodeId, {
          progress: 10,
          content: '正在调用 AI API...',
        });

        // 调用 AI 生成
        const prompt = node.data.prompt || node.data.content;
        const latestProject = get().project!;

        // 根据节点类型使用正确的参数格式
        const isImage = node.data.type === 'image';
        console.log('节点类型:', node.data.type, '是否图片:', isImage);

        // 只传递 API 支持的参数，不传 duration/seconds
        const settings: any = {
          style: node.data.settings?.style || latestProject.settings.defaultStyle,
          resolution: '1080p',
          aspect_ratio: isImage ? '1:1' : '16:9',
        };

        console.log('生成设置:', { type: node.data.type, settings });

        // 更新进度：生成中
        get().updateNodeData(newNodeId, {
          progress: 30,
          content: '正在生成内容...',
        });

        let result;

        // 根据类型调用不同的生成方法
        if (node.data.type === 'video') {
          result = await aiService.generateVideo(prompt, settings, controller.signal);
        } else if (node.data.type === 'image') {
          result = await aiService.generateImage(prompt, settings, controller.signal);
        } else {
          // 文本类型默认生成视频
          result = await aiService.generateVideo(prompt, settings, controller.signal);
        }

        // 更新进度：处理结果
        get().updateNodeData(newNodeId, {
          progress: 80,
          content: '正在处理生成结果...',
        });

        if (result.success && result.data) {
          // 生成成功
          get().updateNodeData(nodeId, {
            status: 'completed',
            progress: 100,
          });

          get().updateNodeData(newNodeId, {
            status: 'completed',
            progress: 100,
            generatedContent: result.data.url,
            thumbnail: result.data.thumbnail,
            content: 'AI 生成完成 - 点击预览',
          });
        } else {
          markGenerationFailed(nodeId, newNodeId, result.error || 'AI 生成失败', get, set);
        }
      } catch (error: any) {
        const message = controller.signal.aborted ? '用户取消生成' : error.message || 'AI 生成失败';
        markGenerationFailed(nodeId, newNodeId, message, get, set);
      } finally {
        finishGenerationTask(newNodeId, get, set);
      }
    })();
  },

  // 取消生成
  cancelGeneration: (nodeId) => {
    const { activeGenerations, project } = get();
    if (!project) return;

    // 查找该节点相关的所有生成任务
    const nodesToCancel: string[] = [nodeId];

    // 查找所有由该节点生成的子节点
    project.edges.forEach(edge => {
      if (edge.source === nodeId) {
        const targetNode = project.nodes.find(n => n.id === edge.target);
        if (targetNode && targetNode.data.status === 'generating') {
          nodesToCancel.push(edge.target);
        }
      }
    });

    // 取消所有相关的生成任务
    nodesToCancel.forEach(id => {
      const controller = activeGenerations.get(id);
      if (controller) {
        controller.abort();
        activeGenerations.delete(id);
      }

      // 更新节点状态
      get().updateNodeData(id, {
        status: 'error',
        error: '用户取消生成',
        progress: 0,
      });
    });

    set({
      activeGenerations: new Map(activeGenerations),
      isGenerating: false,
    });
  },

  // 带类型的生成操作（用于拖拽到空白区域时的生成）
  startGenerationWithType: (nodeId, type, settings, position) => {
    const { project } = get();
    if (!project) return;

    const node = project.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    // 更新当前节点状态为生成中
    get().updateNodeData(nodeId, {
      status: 'generating',
      progress: 0,
    });

    // 创建新的生成结果节点
    const newNodeId = generateId();
    const newNode: Node<SceneNodeData> = {
      id: newNodeId,
      type: 'sceneNode',
      position: position || {
        x: node.position.x + 350,
        y: node.position.y,
      },
      data: {
        label: `${settings.style === 'anime' ? '动漫' : settings.style === 'realistic' ? '写实' : ''}${type === 'video' ? '视频' : type === 'img2img' ? '图生图' : '图片'} - 生成结果`,
        type: type === 'img2img' ? 'image' : type,
        content: '',
        duration: settings.duration || 5,
        prompt: settings.prompt,
        settings: {
          style: settings.style,
          mood: '',
          camera: '',
          lighting: '',
        },
        status: 'generating',
        progress: 0,
      },
    };

    // 添加新节点
    get().addNode(newNode);

    // 添加连接边
    const newEdge: Edge = {
      id: `edge-${nodeId}-${newNodeId}`,
      source: nodeId,
      target: newNodeId,
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#8b5cf6', strokeWidth: 2 },
    };

    set({
      project: {
        ...get().project!,
        edges: [...get().project!.edges, newEdge],
      },
      isGenerating: true,
    });

    // 根据生成类型选择正确的模型
    const latestProject = get().project!;
    let aiModel: AIModelConfig;

    // 获取多模型配置，如果不存在则创建
    let multiModel = latestProject.settings.multiModel;

    if (!multiModel) {
      console.log('多模型配置不存在，从 aiModel 创建...');
      const baseModel = latestProject.settings.aiModel;
      multiModel = {
        textModel: { ...baseModel },
        videoModel: { ...baseModel },
        imageModel: { ...baseModel },
      };
      get().updateProjectSettings({ multiModel });
    }

    // 选择正确的模型
    if (type === 'image') {
      aiModel = multiModel.imageModel;
    } else {
      aiModel = multiModel.videoModel;
    }

    // 如果选中的模型 API Key 为空，尝试从其他模型同步
    if (!aiModel.apiKey) {
      console.log('当前模型 API Key 为空，尝试同步...');
      if (multiModel.videoModel.apiKey) {
        aiModel = multiModel.videoModel;
        console.log('从 videoModel 同步 API Key');
      } else if (multiModel.imageModel.apiKey) {
        aiModel = multiModel.imageModel;
        console.log('从 imageModel 同步 API Key');
      } else if (latestProject.settings.aiModel.apiKey) {
        aiModel = latestProject.settings.aiModel;
        console.log('从 aiModel 同步 API Key');
      }
    }

    // 调试日志
    console.log('最终选择的 AI 模型 (startGenerationWithType):', {
      type,
      modelId: aiModel.id,
      modelName: aiModel.name,
      provider: aiModel.provider,
      hasApiKey: !!aiModel.apiKey,
      apiKeyLength: aiModel.apiKey?.length || 0,
      baseUrl: aiModel.baseUrl,
    });

    // 检查是否有 API Key
    if (!aiModel.apiKey) {
      markGenerationFailed(nodeId, newNodeId, '请先配置 API Key', get, set);
      return;
    }

    // 使用工厂函数创建 AI 服务实例（根据模型自动选择）
    const aiService = createAIService(aiModel);
    const controller = new AbortController();
    const activeGenerations = new Map(get().activeGenerations);
    activeGenerations.set(newNodeId, controller);
    set({ activeGenerations });

    // 异步执行生成
    (async () => {
      try {
        // 更新进度：准备中
        get().updateNodeData(newNodeId, {
          progress: 10,
          content: '正在调用 AI API...',
        });

        const latestProject = get().project!;

        // 根据类型使用正确的参数格式（不传 duration/seconds）
        const isImage = type === 'image' || type === 'img2img';
        const genSettings: any = {
          style: settings.style,
          resolution: isImage ? undefined : '1080p',
          aspect_ratio: isImage ? '1:1' : '16:9',
          duration: settings.duration,
          seconds: settings.duration,
        };

        console.log('生成设置 (startGenerationWithType):', { type, genSettings });

        // 更新进度：生成中
        get().updateNodeData(newNodeId, {
          progress: 30,
          content: '正在生成内容...',
        });

        let result;

        // 根据类型调用不同的生成方法
        if (type === 'video') {
          result = await aiService.generateVideo(settings.prompt, genSettings, controller.signal);
        } else if (type === 'img2img') {
          // 图生图：获取源图片 URL
          const sourceImageUrl = node.data.generatedContent;
          result = await aiService.generateImage(settings.prompt, {
            ...genSettings,
            init_image: sourceImageUrl,
            strength: settings.strength || 0.7,
            negative_prompt: settings.negativePrompt,
          }, controller.signal);
        } else {
          result = await aiService.generateImage(settings.prompt, genSettings, controller.signal);
        }

        // 更新进度：处理结果
        get().updateNodeData(newNodeId, {
          progress: 80,
          content: '正在处理生成结果...',
        });

        if (result.success && result.data) {
          // 生成成功
          get().updateNodeData(nodeId, {
            status: 'completed',
            progress: 100,
          });

          get().updateNodeData(newNodeId, {
            status: 'completed',
            progress: 100,
            generatedContent: result.data.url,
            thumbnail: result.data.thumbnail,
            content: 'AI 生成完成 - 点击预览',
          });
        } else {
          markGenerationFailed(nodeId, newNodeId, result.error || 'AI 生成失败', get, set);
        }
      } catch (error: any) {
        const message = controller.signal.aborted ? '用户取消生成' : error.message || 'AI 生成失败';
        markGenerationFailed(nodeId, newNodeId, message, get, set);
      } finally {
        finishGenerationTask(newNodeId, get, set);
      }
    })();
  },

  updateGenerationProgress: (nodeId, progress) => {
    const newMap = new Map(get().generationProgress);
    newMap.set(nodeId, progress);
    set({ generationProgress: newMap });
  },

  // 设置操作
  updateProjectSettings: (settings) => {
    const { project } = get();
    if (!project) return;

    set({
      project: {
        ...project,
        settings: { ...project.settings, ...settings },
        updatedAt: new Date().toISOString(),
      },
    });

    // 触发自动保存
    get().triggerAutoSave();
  },

  updateAIModel: (model) => {
    const { project } = get();
    if (!project) return;

    set({
      project: {
        ...project,
        settings: {
          ...project.settings,
          aiModel: { ...project.settings.aiModel, ...model },
        },
        updatedAt: new Date().toISOString(),
      },
    });

    // 触发自动保存
    get().triggerAutoSave();
  },

  toggleSettings: () => set({ showSettings: !get().showSettings }),
  toggleModelConfig: () => set({ showModelConfig: !get().showModelConfig }),

  // 保存当前项目
  saveCurrentProject: async () => {
    const { project } = get();
    if (!project) return;

    set({ isSaving: true });

    const saved = saveProjectDataToStorage(project);
    if (!saved) {
      set({ isSaving: false });
      return;
    }

    // 更新项目列表中的信息
    const updatedProjects = get().projects.map((p) =>
      p.id === project.id
        ? {
            ...p,
            title: project.title,
            description: project.description,
            updatedAt: project.updatedAt,
            sceneCount: project.nodes.length,
          }
        : p
    );
    saveProjectsToStorage(updatedProjects);
    try {
      await saveProjectToCloud(project);
      set({ projects: updatedProjects, lastSaveTime: new Date().toISOString(), isSaving: false });
    } catch (error) {
      console.error('云端保存失败，本地副本已保留', error);
      set({ projects: updatedProjects, isSaving: false });
    }
  },

  // 导出项目
  exportProject: () => {
    const { project } = get();
    if (!project) return;

    const dataStr = JSON.stringify(createPersistableProject(project), null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
    const exportFileDefaultName = `${project.title}.json`;

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
  },

  // 撤销操作
  undo: () => {
    const { historyIndex, history, project } = get();
    if (historyIndex <= 0 || !project) return;

    const newIndex = historyIndex - 1;
    const prevState = history[newIndex];

    set({
      historyIndex: newIndex,
      project: {
        ...project,
        nodes: [...prevState.nodes],
        edges: [...prevState.edges],
        updatedAt: new Date().toISOString(),
      },
    });

    // 触发自动保存
    get().triggerAutoSave();
  },

  // 重做操作
  redo: () => {
    const { historyIndex, history, project } = get();
    if (historyIndex >= history.length - 1 || !project) return;

    const newIndex = historyIndex + 1;
    const nextState = history[newIndex];

    set({
      historyIndex: newIndex,
      project: {
        ...project,
        nodes: [...nextState.nodes],
        edges: [...nextState.edges],
        updatedAt: new Date().toISOString(),
      },
    });

    // 触发自动保存
    get().triggerAutoSave();
  },

  // 检查是否可以撤销
  canUndo: () => {
    const { historyIndex } = get();
    return historyIndex > 0;
  },

  // 检查是否可以重做
  canRedo: () => {
    const { historyIndex, history } = get();
    return historyIndex < history.length - 1;
  },

  // 推入历史记录
  pushToHistory: () => {
    const { project, history, historyIndex, maxHistorySize } = get();
    if (!project) return;

    // 删除当前索引之后的历史记录（如果有新的分支）
    const newHistory = history.slice(0, historyIndex + 1);

    // 添加当前状态
    newHistory.push({
      nodes: [...project.nodes],
      edges: [...project.edges],
    });

    // 限制历史记录大小
    if (newHistory.length > maxHistorySize) {
      newHistory.shift();
    }

    set({
      history: newHistory,
      historyIndex: newHistory.length - 1,
    });
  },

  // 启用/禁用自动保存
  enableAutoSave: (enabled) => {
    set({ autoSaveEnabled: enabled });
  },

  // 触发自动保存（带防抖）
  triggerAutoSave: () => {
    const { autoSaveEnabled, autoSaveTimer } = get();

    if (!autoSaveEnabled) return;

    // 清除之前的定时器
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }

    // 设置新的定时器
    const newTimer = setTimeout(() => {
      get().saveCurrentProject();
      console.log('自动保存完成');
    }, AUTO_SAVE_DELAY);

    set({ autoSaveTimer: newTimer });
  },
}));

function markGenerationFailed(
  sourceNodeId: string,
  newNodeId: string,
  message: string,
  get: () => ProjectStore,
  set: (partial: Partial<ProjectStore>) => void
) {
  get().updateNodeData(sourceNodeId, { status: 'error', error: message, progress: 0 });
  get().updateNodeData(newNodeId, { status: 'error', error: message, progress: 0, content: message });
  set({ isGenerating: false });
}

function finishGenerationTask(
  nodeId: string,
  get: () => ProjectStore,
  set: (partial: Partial<ProjectStore>) => void
) {
  const activeGenerations = new Map(get().activeGenerations);
  activeGenerations.delete(nodeId);
  set({ activeGenerations, isGenerating: activeGenerations.size > 0 });
}

export default useProjectStore;
