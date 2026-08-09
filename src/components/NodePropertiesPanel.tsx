import { motion, AnimatePresence } from 'framer-motion';
import { X, Type, Image, Video, Music, Wand2, Clock, Sparkles } from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';
import PromptMentionEditor from './PromptMentionEditor';
import VideoDurationControl from './VideoDurationControl';
import { videoDurationRules } from '@/services/modelDuration';

const typeIcons: Record<string, React.ReactNode> = {
  text: <Type className="w-5 h-5" />,
  image: <Image className="w-5 h-5" />,
  video: <Video className="w-5 h-5" />,
  audio: <Music className="w-5 h-5" />,
  transition: <Wand2 className="w-5 h-5" />,
};

export default function NodePropertiesPanel() {
  const { selectedNode, project, updateNodeData, setSelectedNode } = useProjectStore();

  if (!project) return null;

  const node = project.nodes.find((n) => n.id === selectedNode);
  if (!node) return null;

  const data = node.data as any;
  const mentionableNodes = project.nodes
    .filter((candidate) => candidate.id !== selectedNode)
    .map((candidate) => ({
      id: candidate.id,
      label: candidate.data.label,
      type: candidate.data.type,
      imageUrl: candidate.data.type === 'image' ? candidate.data.generatedContent : undefined,
    }));
  const configuredVideoModel = project.settings.multiModel?.videoModel || project.settings.aiModel;

  return (
    <AnimatePresence>
      {selectedNode && (
        <motion.div
          initial={{ x: -300, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -300, opacity: 0 }}
          className="absolute left-4 top-20 bottom-4 w-80 z-40"
        >
          <div className="h-full bg-dark-800/95 backdrop-blur-xl rounded-2xl border border-dark-600/50 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-dark-600/50 bg-gradient-to-r from-dark-800 to-dark-700">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary-600/20 text-primary-400">
                  {typeIcons[data.type]}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">{data.label}</h3>
                  <span className="text-xs text-dark-400 capitalize">{data.type} 场景</span>
                </div>
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                className="p-2 hover:bg-dark-600 rounded-lg transition-colors"
              >
                <X className="w-4 h-4 text-dark-400" />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4 overflow-y-auto h-[calc(100%-72px)]">
              {/* 场景名称 */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300">场景名称</label>
                <input
                  type="text"
                  value={data.label}
                  onChange={(e) => updateNodeData(selectedNode, { label: e.target.value })}
                  className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg
                    text-white text-sm focus:outline-none focus:border-primary-500"
                />
              </div>

              {/* AI 提示词 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-dark-300 flex items-center gap-2">
                    <Sparkles className="w-3 h-3 text-primary-400" />
                    AI 提示词
                  </label>
                  <span className="text-[10px] text-dark-500">输入 @ 引用其他节点</span>
                </div>
                <PromptMentionEditor
                  value={data.prompt || data.content || ''}
                  onChange={(value) => updateNodeData(selectedNode, { prompt: value, content: value })}
                  nodes={mentionableNodes}
                  placeholder="输入提示词，输入 @ 引用其他画布目标"
                  minHeightClass="min-h-32"
                />
                <div className="text-[10px] text-dark-500">
                  输入 @ 后选择目标，图片引用将在当前位置显示为缩略图
                </div>
              </div>

              {/* 时长设置 */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300 flex items-center gap-2">
                  <Clock className="w-3 h-3 text-primary-400" />
                  时长（秒）
                </label>
                <VideoDurationControl
                  value={data.duration}
                  onChange={(duration) => updateNodeData(selectedNode, { duration })}
                  rules={videoDurationRules(configuredVideoModel)}
                  fallbackMin={1}
                  fallbackMax={30}
                  ariaLabel="组件时长"
                />
              </div>

              {/* 风格设置 */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300">风格</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'cinematic', label: '电影感' },
                    { id: 'anime', label: '动漫风' },
                    { id: 'realistic', label: '写实风' },
                    { id: 'artistic', label: '艺术风' },
                    { id: 'vintage', label: '复古风' },
                    { id: 'modern', label: '现代风' },
                  ].map((style) => (
                    <button
                      key={style.id}
                      onClick={() => updateNodeData(selectedNode, { settings: { ...data.settings, style: style.id } })}
                      className={`py-1.5 rounded-lg text-[10px] font-medium transition-colors
                        ${data.settings.style === style.id
                          ? 'bg-primary-600 text-white'
                          : 'bg-dark-700 text-dark-400 hover:bg-dark-600'
                        }`}
                    >
                      {style.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
