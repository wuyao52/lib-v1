import { create } from 'zustand';

// 项目信息
export interface ProjectInfo {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  sceneCount: number;
}

// 项目列表 Store
interface ProjectListStore {
  projects: ProjectInfo[];
  currentView: 'home' | 'project';
  currentProjectId: string | null;

  // 操作
  setView: (view: 'home' | 'project') => void;
  setCurrentProject: (id: string | null) => void;
  loadProjects: () => void;
  addProject: (project: ProjectInfo) => void;
  removeProject: (id: string) => void;
  updateProject: (id: string, updates: Partial<ProjectInfo>) => void;
}

// 从本地存储加载项目列表
const loadFromStorage = (): ProjectInfo[] => {
  try {
    const stored = localStorage.getItem('ai-drama-projects');
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

// 保存到本地存储
const saveToStorage = (projects: ProjectInfo[]) => {
  localStorage.setItem('ai-drama-projects', JSON.stringify(projects));
};

export const useProjectListStore = create<ProjectListStore>((set, get) => ({
  projects: [],
  currentView: 'home',
  currentProjectId: null,

  setView: (view) => set({ currentView: view }),

  setCurrentProject: (id) => set({ currentProjectId: id }),

  loadProjects: () => {
    set({ projects: loadFromStorage() });
  },

  addProject: (project) => {
    const updated = [...get().projects, project];
    saveToStorage(updated);
    set({ projects: updated });
  },

  removeProject: (id) => {
    localStorage.removeItem(`ai-drama-project-${id}`);
    const updated = get().projects.filter(p => p.id !== id);
    saveToStorage(updated);
    set({ projects: updated });
  },

  updateProject: (id, updates) => {
    const updated = get().projects.map(p =>
      p.id === id ? { ...p, ...updates } : p
    );
    saveToStorage(updated);
    set({ projects: updated });
  },
}));
