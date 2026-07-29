import { lazy, Suspense, useEffect, useCallback, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Film,
  ArrowLeft,
  Save,
  Download,
  Settings,
  Cpu,
  Sparkles,
  Undo2,
  Redo2,
  CheckCircle2,
  Loader2,
  Clapperboard,
  Library,
} from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';
import Canvas from './Canvas';
import Toolbar from './Toolbar';
import SettingsPanel from './SettingsPanel';
import ModelConfigPanel from './ModelConfigPanel';
import NodePropertiesPanel from './NodePropertiesPanel';

const DirectorMode = lazy(() => import('./DirectorMode'));
const SkillManager = lazy(() => import('./SkillManager'));

export default function ProjectEditor() {
  const [showDirectorMode, setShowDirectorMode] = useState(false);
  const [showSkillManager, setShowSkillManager] = useState(false);
  const {
    project,
    closeProject,
    saveCurrentProject,
    exportProject,
    toggleSettings,
    toggleModelConfig,
    undo,
    redo,
    canUndo,
    canRedo,
    isSaving,
    lastSaveTime,
  } = useProjectStore();

  // 快捷键处理
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentProject();
      }
    },
    [undo, redo, saveCurrentProject]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const formatSaveTime = (time: string | null) => {
    if (!time) return '';
    return new Date(time).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="w-screen h-screen flex flex-col bg-dark-950 overflow-hidden">
      {/* 顶部导航栏 */}
      <header className="relative z-50 h-14 flex items-center justify-between px-4 bg-dark-900/80 backdrop-blur-xl border-b border-dark-700/50">
        <div className="flex items-center gap-3">
          <button onClick={closeProject} className="p-2 rounded-lg hover:bg-dark-700 text-dark-400 hover:text-white transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="w-px h-6 bg-dark-600" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
              <Film className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white truncate max-w-[200px]">{project?.title || '未命名项目'}</h1>
              <div className="flex items-center gap-2">
                <p className="text-[10px] text-dark-400">AI 短剧项目</p>
                <AnimatePresence>
                  {isSaving ? (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1">
                      <Loader2 className="w-2.5 h-2.5 text-primary-400 animate-spin" />
                      <span className="text-[9px] text-primary-400">保存中...</span>
                    </motion.div>
                  ) : lastSaveTime ? (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-1">
                      <CheckCircle2 className="w-2.5 h-2.5 text-green-400" />
                      <span className="text-[9px] text-dark-500">已保存 {formatSaveTime(lastSaveTime)}</span>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>

        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary-400" />
          <span className="text-sm font-medium text-dark-200">无限画布 · AI 驱动 · 创意无限</span>
        </div>

        <div className="flex items-center gap-1">
          <button onClick={undo} disabled={!canUndo()} className={`p-2 rounded-lg transition-colors ${canUndo() ? 'hover:bg-dark-700 text-dark-300 hover:text-white' : 'text-dark-600 cursor-not-allowed'}`} title="撤销 (Ctrl+Z)">
            <Undo2 className="w-4 h-4" />
          </button>
          <button onClick={redo} disabled={!canRedo()} className={`p-2 rounded-lg transition-colors ${canRedo() ? 'hover:bg-dark-700 text-dark-300 hover:text-white' : 'text-dark-600 cursor-not-allowed'}`} title="重做 (Ctrl+Shift+Z)">
            <Redo2 className="w-4 h-4" />
          </button>
          <div className="w-px h-6 bg-dark-600 mx-1" />
          <button onClick={saveCurrentProject} className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors" title="保存 (Ctrl+S)">
            <Save className="w-4 h-4" />
          </button>
          <button onClick={exportProject} className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors" title="导出">
            <Download className="w-4 h-4" />
          </button>
          <div className="w-px h-6 bg-dark-600 mx-1" />
          <button onClick={toggleModelConfig} className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors" title="AI模型配置">
            <Cpu className="w-4 h-4" />
          </button>
          <button onClick={() => setShowDirectorMode(true)} className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors" title="导演模式">
            <Clapperboard className="w-4 h-4" />
          </button>
          <button onClick={() => setShowSkillManager(true)} className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors" title="Skill 工作区">
            <Library className="w-4 h-4" />
          </button>
          <button onClick={toggleSettings} className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors" title="项目设置">
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* 主内容区 */}
      <div className="flex-1 relative">
        <Canvas />
        <Toolbar />
        <NodePropertiesPanel />
        <SettingsPanel />
        <ModelConfigPanel />
        <Suspense fallback={null}>
          <DirectorMode isOpen={showDirectorMode} onClose={() => setShowDirectorMode(false)} />
          <SkillManager isOpen={showSkillManager} onClose={() => setShowSkillManager(false)} />
        </Suspense>

        {/* 底部状态栏 */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40">
          <div className="bg-dark-800/90 backdrop-blur-xl rounded-full px-4 py-2 border border-dark-600/50 shadow-xl">
            <div className="flex items-center gap-4 text-xs text-dark-400">
              <span>🎬 拖拽添加场景</span>
              <span className="w-px h-3 bg-dark-600" />
              <span>🖼️ 拖入图片/视频</span>
              <span className="w-px h-3 bg-dark-600" />
              <span>🔗 连接场景</span>
              <span className="w-px h-3 bg-dark-600" />
              <span>📦 框选多选</span>
              <span className="w-px h-3 bg-dark-600" />
              <span>↩️ Ctrl+Z 撤销</span>
              <span className="w-px h-3 bg-dark-600" />
              <span>💾 自动保存</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
