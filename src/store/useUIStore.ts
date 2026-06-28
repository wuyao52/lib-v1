import { create } from 'zustand';

// UI 状态 Store - 集中管理所有 UI 相关状态
interface UIStore {
  // 弹窗状态
  showSettings: boolean;
  showModelConfig: boolean;
  showGenerationModal: boolean;
  showWatermarkModal: boolean;

  // 画布状态
  isSelectionMode: boolean;
  isDraggingFile: boolean;

  // 生成状态
  isGenerating: boolean;
  generationSourceNode: string | null;
  generationPosition: { x: number; y: number };

  // 去水印状态
  watermarkSourceUrl: string;
  watermarkSourceType: 'image' | 'video';

  // 操作
  toggleSettings: () => void;
  toggleModelConfig: () => void;
  setShowGenerationModal: (show: boolean) => void;
  setShowWatermarkModal: (show: boolean) => void;
  setSelectionMode: (mode: boolean) => void;
  setDraggingFile: (dragging: boolean) => void;
  setGenerating: (generating: boolean) => void;
  setGenerationSource: (nodeId: string | null) => void;
  setGenerationPosition: (pos: { x: number; y: number }) => void;
  setWatermarkSource: (url: string, type: 'image' | 'video') => void;
}

export const useUIStore = create<UIStore>((set) => ({
  // 初始状态
  showSettings: false,
  showModelConfig: false,
  showGenerationModal: false,
  showWatermarkModal: false,
  isSelectionMode: false,
  isDraggingFile: false,
  isGenerating: false,
  generationSourceNode: null,
  generationPosition: { x: 0, y: 0 },
  watermarkSourceUrl: '',
  watermarkSourceType: 'image',

  // 操作
  toggleSettings: () => set((state) => ({ showSettings: !state.showSettings })),
  toggleModelConfig: () => set((state) => ({ showModelConfig: !state.showModelConfig })),
  setShowGenerationModal: (show) => set({ showGenerationModal: show }),
  setShowWatermarkModal: (show) => set({ showWatermarkModal: show }),
  setSelectionMode: (mode) => set({ isSelectionMode: mode }),
  setDraggingFile: (dragging) => set({ isDraggingFile: dragging }),
  setGenerating: (generating) => set({ isGenerating: generating }),
  setGenerationSource: (nodeId) => set({ generationSourceNode: nodeId }),
  setGenerationPosition: (pos) => set({ generationPosition: pos }),
  setWatermarkSource: (url, type) => set({ watermarkSourceUrl: url, watermarkSourceType: type }),
}));
