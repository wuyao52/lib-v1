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
import { createAIService, prepareReferenceImages, SeedanceService } from '@/services/aiService';
import { ApiError, apiRequest } from '@/services/apiClient';
import { materializeReferenceImages } from '@/services/assetService';
import { planGenerationTarget } from './generationPolicy';
import { normalizeModelDuration, videoDurationRules } from '@/services/modelDuration';
import { refreshManagedModel } from '@/services/managedModelCatalog';
import { isUploadedImageNode } from '@/services/nodeMediaSource';

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
let saveQueuedWhileBusy = false;
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
      // 上传素材使用云端项目数据持久化，不能在退出时清空 data URL
      generatedContent: node.data.generatedContent,
      thumbnail: node.data.thumbnail,
    },
  })),
});

const restoreProjectSecrets = (project: DramaProject): DramaProject => project;

// 保存项目数据到本地存储。失败时绝不删除其他项目。
const saveProjectDataToStorage = (project: DramaProject): boolean => {
  try {
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

const saveProjectToCloud = async (project: DramaProject): Promise<ProjectInfo> => {
  const persistable = createPersistableProject(project);
  const result = await apiRequest<{ project: ProjectInfo }>(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ project: persistable, expectedVersion: Number(project.version || 0) }),
  });
  return result.project;
};

const loadProjectFromCloud = async (projectId: string): Promise<DramaProject> => {
  const result = await apiRequest<{ project: DramaProject }>(`/api/projects/${encodeURIComponent(projectId)}`);
  return restoreProjectSecrets(result.project);
};

const loadProjectListFromCloud = async (): Promise<ProjectInfo[]> => {
  const result = await apiRequest<{ projects: ProjectInfo[] }>('/api/projects');
  return result.projects;
};

const materializeProjectImages = async (project: DramaProject): Promise<DramaProject> => {
  const pendingNodes = project.nodes.filter((node) => /^data:image\//i.test(String(node.data.generatedContent || '')));
  if (!pendingNodes.length) return project;

  const urls = await materializeReferenceImages(pendingNodes.map((node) => String(node.data.generatedContent)));
  const replacements = new Map(pendingNodes.map((node, index) => [node.id, urls[index]]));
  return {
    ...project,
    nodes: project.nodes.map((node) => {
      const url = replacements.get(node.id);
      return url ? {
        ...node,
        data: {
          ...node.data,
          generatedContent: url,
          mediaSource: node.data.mediaSource || (String(node.data.prompt || '').trim() ? 'generated' : 'uploaded'),
        },
      } : node;
    }),
  };
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
    version: 0,
  };
};

const requiresReferenceImage = (result: { success: boolean; error?: string }) =>
  !result.success && /images?\s*(?:不能为空|cannot be empty|required)|参数\s*images/i.test(result.error || '');

function collectReferenceImages(
  project: DramaProject,
  node: Node<SceneNodeData>,
  promptOverride = '',
  additionalNodeIds: string[] = [],
): string[] {
  const referencedIds = new Set<string>([node.id, ...additionalNodeIds]);
  const prompt = `${String(node.data.prompt || node.data.content || '')} ${promptOverride}`;
  for (const match of prompt.matchAll(/@\[[^\]]+\]\(([^)]+)\)/g)) referencedIds.add(match[1]);
  for (const edge of project.edges) {
    if (edge.source === node.id) referencedIds.add(edge.target);
    if (edge.target === node.id) referencedIds.add(edge.source);
  }
  return [...new Set(project.nodes
    .filter((candidate) => referencedIds.has(candidate.id) && candidate.data.type === 'image' && candidate.data.generatedContent)
    .map((candidate) => String(candidate.data.generatedContent)))]
    .slice(0, 4);
}

async function generateVideoWithFallback(
  videoService: ReturnType<typeof createAIService>,
  imageModel: AIModelConfig,
  prompt: string,
  settings: Record<string, any>,
  signal: AbortSignal,
  onFallback: () => void,
) {
  const firstAttempt = await videoService.generateVideo(prompt, settings, signal);
  if (!requiresReferenceImage(firstAttempt) || settings.images?.length) return firstAttempt;
  if ((!imageModel.apiKey && !imageModel.managed && !imageModel.credentialManaged) || !imageModel.modelId) {
    return { success: false, error: '当前视频模型要求参考图，请先配置图片模型，系统将自动生成首帧后重试' };
  }
  onFallback();
  const firstFrame = await createAIService(imageModel).generateImage(prompt, { aspect_ratio: '16:9', resolution: '1080p' }, signal);
  if (!firstFrame.success || !firstFrame.data?.url) {
    return { success: false, error: `视频模型要求参考图，自动生成首帧失败：${firstFrame.error || '图片模型未返回图片'}` };
  }
  return videoService.generateVideo(prompt, { ...settings, images: [firstFrame.data.url] }, signal);
}

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
      referenceNodeIds?: string[];
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
const notifyBillingChanged = () => window.dispatchEvent(new CustomEvent('billing:changed'));

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
    void saveProjectToCloud(newProject).then((saved) => set((state) => ({
      project: state.project?.id === newProject.id ? { ...state.project, version: saved.version } : state.project,
      projects: state.projects.map((item) => item.id === newProject.id ? { ...item, version: saved.version } : item),
    }))).catch((error) => console.error('云端创建项目失败，本地副本已保留', error));

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
      const cloudProject = await loadProjectFromCloud(projectId);
      projectData = await materializeProjectImages(cloudProject);
      saveProjectDataToStorage(projectData);
      if (projectData !== cloudProject) {
        const migrated = projectData;
        void saveProjectToCloud(migrated).then((saved) => set((state) => ({
          project: state.project?.id === migrated.id ? { ...state.project, version: saved.version } : state.project,
        }))).catch((error) => console.error('旧图片云端迁移保存失败', error));
      }
    } catch (error) {
      console.warn('云端项目读取失败，使用本地缓存', error);
      projectData = loadProjectDataFromStorage(projectId);
      if (projectData) {
        try {
          projectData = await materializeProjectImages(projectData);
          saveProjectDataToStorage(projectData);
          void saveProjectToCloud(projectData).catch((saveError) => console.error('本地旧图片迁移保存失败', saveError));
        } catch (migrationError) {
          console.error('本地旧图片云端迁移失败', migrationError);
        }
      }
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
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith('ai-drama-project-secrets:'))
      .forEach((key) => sessionStorage.removeItem(key));
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
    if (isUploadedImageNode(node.data)) return;
    if (node.data.status === 'generating' || hasActiveGenerationFromSource(project, nodeId, get().activeGenerations)) return;
    const nodePrompt = String(node.data.prompt || node.data.content || '').trim();
    if (!nodePrompt && !node.data.generatedContent) return;

    // 创建新的生成结果节点
    const generationTarget = planGenerationTarget(nodeId, node.data.type, generateId);
    const generateInPlace = generationTarget.inPlace;
    const newNodeId = generationTarget.targetNodeId;
    if (generateInPlace) {
      get().updateNodeData(nodeId, { status: 'generating', error: undefined, progress: 0 });
    } else if (node.data.status === 'error') {
      get().updateNodeData(nodeId, {
        status: node.data.generatedContent ? 'completed' : 'idle',
        error: undefined,
        progress: node.data.generatedContent ? 100 : 0,
      });
    }
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
    if (!generateInPlace) get().addNode(newNode);

    // 添加连接边
    const newEdge: Edge = {
      id: `edge-${nodeId}-${newNodeId}`,
      source: nodeId,
      target: newNodeId,
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#8b5cf6', strokeWidth: 2 },
    };

    if (!generateInPlace) set({ project: { ...get().project!, edges: [...get().project!.edges, newEdge] }, isGenerating: true });
    else set({ isGenerating: true });

    launchGenerationTask({
      sourceNodeId: nodeId, targetNodeId: newNodeId, sourceNode: node,
      requestType: node.data.type === 'image' ? 'image' : 'video',
      prompt: nodePrompt,
      style: node.data.settings?.style,
      duration: node.data.duration,
      generateInPlace,
    }, get, set);
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
    if (node.data.status === 'generating' || hasActiveGenerationFromSource(project, nodeId, get().activeGenerations)) return;
    if (!String(settings.prompt || '').trim() && !node.data.generatedContent) return;

    if (node.data.status === 'error') {
      get().updateNodeData(nodeId, {
        status: node.data.generatedContent ? 'completed' : 'idle',
        error: undefined,
        progress: node.data.generatedContent ? 100 : 0,
      });
    }

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
    const sourceNodeIds = [...new Set([nodeId, ...(settings.referenceNodeIds || [])])]
      .filter((sourceId) => project.nodes.some((candidate) => candidate.id === sourceId));
    const newEdges: Edge[] = sourceNodeIds.map((sourceId) => ({
      id: `edge-${sourceId}-${newNodeId}`,
      source: sourceId,
      target: newNodeId,
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#8b5cf6', strokeWidth: 2 },
    }));

    set({
      project: {
        ...get().project!,
        edges: [...get().project!.edges, ...newEdges],
      },
      isGenerating: true,
    });

    launchGenerationTask({
      sourceNodeId: nodeId, targetNodeId: newNodeId, sourceNode: node,
      requestType: type,
      prompt: settings.prompt,
      style: settings.style,
      duration: settings.duration,
      referenceNodeIds: settings.referenceNodeIds,
      strength: settings.strength,
      negativePrompt: settings.negativePrompt,
      generateInPlace: false,
    }, get, set);
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
    if (get().isSaving) { saveQueuedWhileBusy = true; return; }

    set({ isSaving: true });

    let projectToSave = project;
    try {
      const migratedProject = await materializeProjectImages(project);
      const latestProject = get().project;
      if (!latestProject || latestProject.id !== project.id) return set({ isSaving: false });
      const migratedUrls = new Map(migratedProject.nodes.map((node) => [node.id, node.data.generatedContent]));
      projectToSave = {
        ...latestProject,
        nodes: latestProject.nodes.map((node) => {
          const migratedUrl = migratedUrls.get(node.id);
          return /^data:image\//i.test(String(node.data.generatedContent || '')) && migratedUrl && !String(migratedUrl).startsWith('data:')
            ? {
                ...node,
                data: {
                  ...node.data,
                  generatedContent: migratedUrl,
                  mediaSource: node.data.mediaSource || (String(node.data.prompt || '').trim() ? 'generated' : 'uploaded'),
                },
              }
            : node;
        }),
      };
      if (projectToSave !== latestProject) set({ project: projectToSave });
    } catch (error) {
      console.error('项目图片云端迁移失败', error);
      set({ isSaving: false });
      if (saveQueuedWhileBusy) { saveQueuedWhileBusy = false; queueMicrotask(() => get().saveCurrentProject()); }
      return;
    }

    saveProjectDataToStorage(projectToSave);
    // 本地空间不足时仍继续上传云端，确保大图片素材不会丢失

    // 更新项目列表中的信息
    const updatedProjects = get().projects.map((p) =>
      p.id === projectToSave.id
        ? {
            ...p,
            title: projectToSave.title,
            description: projectToSave.description,
            updatedAt: projectToSave.updatedAt,
            sceneCount: projectToSave.nodes.length,
          }
        : p
    );
    saveProjectsToStorage(updatedProjects);
    try {
      const saved = await saveProjectToCloud(projectToSave);
      const versionedProjects = updatedProjects.map((item) => item.id === projectToSave.id ? { ...item, version: saved.version } : item);
      set((state) => ({
        project: state.project?.id === projectToSave.id ? { ...state.project, version: saved.version } : state.project,
        projects: versionedProjects,
        lastSaveTime: new Date().toISOString(),
        isSaving: false,
      }));
      saveProjectsToStorage(versionedProjects);
      if (saveQueuedWhileBusy || get().project?.updatedAt !== projectToSave.updatedAt) {
        saveQueuedWhileBusy = false;
        queueMicrotask(() => get().saveCurrentProject());
      }
    } catch (error) {
      console.error('云端保存失败，本地副本已保留', error);
      if (error instanceof ApiError && error.code === 'PROJECT_VERSION_CONFLICT') {
        set({ projects: updatedProjects, isSaving: false, autoSaveEnabled: false });
        alert('项目已在其他页面或设备更新。为避免覆盖，自动保存已暂停；请重新打开项目获取最新版本。');
      } else set({ projects: updatedProjects, isSaving: false });
      if (saveQueuedWhileBusy) { saveQueuedWhileBusy = false; queueMicrotask(() => get().saveCurrentProject()); }
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

type GenerationExecution = {
  sourceNodeId: string;
  targetNodeId: string;
  sourceNode: Node<SceneNodeData>;
  requestType: 'video' | 'image' | 'img2img';
  prompt: string;
  style?: string;
  duration?: number;
  referenceNodeIds?: string[];
  strength?: number;
  negativePrompt?: string;
  generateInPlace: boolean;
};

function hasModelCredentials(model: AIModelConfig) {
  return Boolean(model.apiKey || model.managed || model.credentialManaged);
}

function launchGenerationTask(
  execution: GenerationExecution,
  get: () => ProjectStore,
  set: (partial: Partial<ProjectStore>) => void,
) {
  const project = get().project;
  if (!project) return;
  let multiModel = project.settings.multiModel;
  if (!multiModel) {
    const baseModel = project.settings.aiModel;
    multiModel = { textModel: { ...baseModel }, videoModel: { ...baseModel }, imageModel: { ...baseModel } };
    get().updateProjectSettings({ multiModel });
  }
  const isImage = execution.requestType === 'image' || execution.requestType === 'img2img';
  let selectedModel = isImage ? multiModel.imageModel : multiModel.videoModel;
  if (!hasModelCredentials(selectedModel)) {
    selectedModel = [multiModel.videoModel, multiModel.imageModel, project.settings.aiModel].find(hasModelCredentials) || selectedModel;
  }
  if (!hasModelCredentials(selectedModel)) {
    markGenerationFailed(execution.sourceNodeId, execution.targetNodeId, '请先配置 API Key', get, set);
    return;
  }

  const controller = new AbortController();
  const activeGenerations = new Map(get().activeGenerations);
  activeGenerations.set(execution.targetNodeId, controller);
  set({ activeGenerations });

  void (async () => {
    try {
      const effectiveModel = await refreshManagedModel(selectedModel);
      const aiService = createAIService(effectiveModel);
      const currentMultiModel = get().project?.settings.multiModel;
      if (selectedModel.managed && currentMultiModel) {
        const currentSlot = isImage ? currentMultiModel.imageModel : currentMultiModel.videoModel;
        if (currentSlot.id === selectedModel.id) {
          get().updateProjectSettings({
            multiModel: isImage
              ? { ...currentMultiModel, imageModel: effectiveModel }
              : { ...currentMultiModel, videoModel: effectiveModel },
          });
        }
      }
      const latestProject = get().project;
      if (!latestProject) throw new Error('项目已关闭');
      if (execution.generateInPlace && execution.sourceNode.data.generatedContent) {
        await apiRequest('/api/generation-history', { method: 'POST', body: JSON.stringify({
          projectId: latestProject.id, nodeId: execution.sourceNodeId,
          type: execution.requestType, prompt: execution.prompt,
          url: execution.sourceNode.data.generatedContent, thumbnail: execution.sourceNode.data.thumbnail,
        }) }).catch((error) => console.warn('保存生成历史失败:', error));
      }
      get().updateNodeData(execution.targetNodeId, { progress: 10, ...(execution.generateInPlace ? {} : { content: '正在调用 AI API...' }) });

      const requestDuration = normalizeModelDuration(Number(execution.duration) || 5, videoDurationRules(effectiveModel), 1, 15);
      if (!isImage && requestDuration !== execution.duration) get().updateNodeData(execution.targetNodeId, { duration: requestDuration });
      const generationSettings: any = {
        style: execution.style || latestProject.settings.defaultStyle,
        resolution: isImage ? undefined : '1080p',
        aspect_ratio: isImage ? '1:1' : '16:9',
        duration: requestDuration,
        seconds: requestDuration,
        _client: { projectId: latestProject.id, nodeId: execution.targetNodeId },
        _onProgress: ({ status, progress, queuePosition }: { status: string; progress: number; queuePosition: number | null }) => get().updateNodeData(execution.targetNodeId, {
          progress: progress > 0 ? progress : status === 'queued' ? 10 : 30,
          generationMessage: status === 'queued'
            ? `视频任务排队中${queuePosition ? `，当前第 ${queuePosition} 位` : ''}`
            : status === 'submitting' ? '正在提交到视频服务...' : progress > 0 ? `视频生成中 ${progress}%` : '视频正在生成中...',
        }),
      };
      const images = await materializeReferenceImages(
        await prepareReferenceImages(collectReferenceImages(latestProject, execution.sourceNode, execution.prompt, execution.referenceNodeIds)),
        controller.signal,
      );
      if (images.length) generationSettings.images = images;
      get().updateNodeData(execution.targetNodeId, { progress: 30, ...(execution.generateInPlace ? {} : { content: '正在生成内容...' }) });

      let result;
      if (execution.requestType === 'video') {
        result = await generateVideoWithFallback(aiService, multiModel.imageModel, execution.prompt, generationSettings, controller.signal, () => get().updateNodeData(execution.targetNodeId, { progress: 35, ...(execution.generateInPlace ? {} : { content: '视频模型需要参考图，正在自动生成首帧...' }) }));
      } else if (execution.requestType === 'img2img') {
        result = await aiService.generateImage(execution.prompt, {
          ...generationSettings,
          init_image: execution.sourceNode.data.generatedContent,
          strength: execution.strength || 0.7,
          negative_prompt: execution.negativePrompt,
        }, controller.signal);
      } else {
        result = await aiService.generateImage(execution.prompt, generationSettings, controller.signal);
      }
      get().updateNodeData(execution.targetNodeId, { progress: 80, ...(execution.generateInPlace ? {} : { content: '正在处理生成结果...' }) });
      if (!result.success || !result.data) {
        markGenerationFailed(execution.sourceNodeId, execution.targetNodeId, result.error || 'AI 生成失败', get, set);
        return;
      }
      get().updateNodeData(execution.targetNodeId, {
        status: 'completed', progress: 100, error: undefined, generationMessage: undefined,
        generatedContent: result.data.url,
        generationMeta: {
          modelId: effectiveModel.modelId,
          modelName: effectiveModel.name,
          provider: effectiveModel.provider,
          taskId: String(result.data.metadata?.taskId || ''),
          completedAt: new Date().toISOString(),
        },
        mediaSource: isImage ? 'generated' : execution.sourceNode.data.mediaSource,
        thumbnail: result.data.thumbnail,
        ...(execution.generateInPlace
          ? { prompt: execution.prompt, content: execution.sourceNode.data.content }
          : { content: 'AI 生成完成 - 点击预览' }),
      });
      await apiRequest('/api/generation-history', { method: 'POST', body: JSON.stringify({
        projectId: latestProject.id, nodeId: execution.targetNodeId,
        type: execution.requestType, prompt: execution.prompt,
        url: result.data.url, thumbnail: result.data.thumbnail,
      }) }).catch((error) => console.warn('保存生成历史失败:', error));
    } catch (error: any) {
      const message = controller.signal.aborted ? '用户取消生成' : error.message || 'AI 生成失败';
      markGenerationFailed(execution.sourceNodeId, execution.targetNodeId, message, get, set);
    } finally {
      finishGenerationTask(execution.targetNodeId, get, set);
      notifyBillingChanged();
    }
  })();
}

function markGenerationFailed(
  sourceNodeId: string,
  newNodeId: string,
  message: string,
  get: () => ProjectStore,
  set: (partial: Partial<ProjectStore>) => void
) {
  get().updateNodeData(newNodeId, {
    status: 'error', error: message, progress: 0,
    ...(newNodeId === sourceNodeId ? {} : { content: message }),
  });
  set({ isGenerating: false });
}

function hasActiveGenerationFromSource(
  project: DramaProject,
  sourceNodeId: string,
  activeGenerations: Map<string, AbortController>,
) {
  if (activeGenerations.has(sourceNodeId)) return true;
  return [...activeGenerations.keys()].some((targetNodeId) => (
    project.edges.find((edge) => edge.target === targetNodeId)?.source === sourceNodeId
  ));
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
