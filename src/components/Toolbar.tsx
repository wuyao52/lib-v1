import React from 'react';
import { motion } from 'framer-motion';
import {
  Plus,
  Video,
  Save,
  Download,
  Upload,
  Settings,
  Cpu,
} from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';
import { SceneNodeData, SceneNodeType } from '@/types';

const nodeTypes: { type: SceneNodeType; icon: React.ReactNode; label: string; color: string }[] = [
  { type: 'video', icon: <Video className="w-4 h-4" />, label: '视频', color: 'from-orange-500 to-red-500' },
];

export default function Toolbar() {
  const {
    addNode,
    project,
    saveCurrentProject,
    isSaving,
    exportProject,
    toggleSettings,
    toggleModelConfig,
  } = useProjectStore();

  const handleAddNode = (type: SceneNodeType) => {
    const position = {
      x: Math.random() * 500 + 100,
      y: Math.random() * 300 + 100,
    };

    const newNode = {
      id: `scene-${Date.now()}`,
      type: 'sceneNode',
      position,
      data: {
        label: `新场景 ${project.nodes.length + 1}`,
        type,
        content: '',
        duration: 5,
        prompt: '',
        settings: {
          style: project.settings.defaultStyle,
          mood: '',
          camera: '',
          lighting: '',
        },
        status: 'idle' as const,
      } as SceneNodeData,
    };

    addNode(newNode);
  };

  return (
    <motion.div
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="absolute top-4 left-1/2 -translate-x-1/2 z-50"
    >
      <div className="bg-dark-800/90 backdrop-blur-xl rounded-2xl border border-dark-600/50 p-2 shadow-2xl">
        <div className="flex items-center gap-1">
          {/* 添加节点按钮 */}
          <div className="flex items-center gap-1 px-2 py-1 bg-dark-700/50 rounded-xl">
            <div className="flex items-center gap-1 px-2 text-dark-400">
              <Plus className="w-4 h-4" />
              <span className="text-xs font-medium">添加</span>
            </div>
            <div className="w-px h-6 bg-dark-600" />
            {nodeTypes.map((nodeType) => (
              <button
                key={nodeType.type}
                data-testid={`add-${nodeType.type}-node`}
                onClick={() => handleAddNode(nodeType.type)}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                  text-xs font-medium text-white
                  bg-gradient-to-r ${nodeType.color}
                  hover:opacity-90 transition-opacity
                  active:scale-95
                `}
                title={nodeType.label}
              >
                {nodeType.icon}
                <span>{nodeType.label}</span>
              </button>
            ))}
          </div>

          <div className="w-px h-8 bg-dark-600 mx-2" />

          {/* 操作按钮 */}
          <div className="flex items-center gap-1">
            <button
              onClick={saveCurrentProject}
              disabled={isSaving}
              className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors disabled:opacity-40"
              title="保存项目"
            >
              <Save className="w-4 h-4" />
            </button>
            <button
              onClick={exportProject}
              className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors"
              title="导出项目"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors"
              title="导入项目"
            >
              <Upload className="w-4 h-4" />
            </button>

            <div className="w-px h-6 bg-dark-600 mx-1" />

            <button
              onClick={toggleModelConfig}
              className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors"
              title="AI模型配置"
            >
              <Cpu className="w-4 h-4" />
            </button>
            <button
              onClick={toggleSettings}
              className="p-2 rounded-lg hover:bg-dark-700 text-dark-300 hover:text-white transition-colors"
              title="项目设置"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>

        </div>
      </div>
    </motion.div>
  );
}
