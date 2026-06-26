import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Type, Image, Video, Music, Wand2, Clock, Sparkles, AtSign } from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';

const typeIcons: Record<string, React.ReactNode> = {
  text: <Type className="w-5 h-5" />,
  image: <Image className="w-5 h-5" />,
  video: <Video className="w-5 h-5" />,
  audio: <Music className="w-5 h-5" />,
  transition: <Wand2 className="w-5 h-5" />,
};

// 为节点生成简短名称
function getShortName(node: any, index: number): string {
  const typeNames: Record<string, string> = {
    text: '文本',
    image: '图片',
    video: '视频',
    audio: '音频',
    transition: '转场',
  };
  return `${typeNames[node.data.type] || '场景'}${index + 1}`;
}

export default function NodePropertiesPanel() {
  const { selectedNode, project, updateNodeData, setSelectedNode } = useProjectStore();
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursorPosition, setCursorPosition] = useState(0);

  if (!project) return null;

  const node = project.nodes.find((n) => n.id === selectedNode);
  if (!node) return null;

  const data = node.data as any;

  // 获取可引用的节点列表
  const getMentionableNodes = () => {
    if (!project) return [];

    const connectedNodeIds = new Set<string>();
    project.edges.forEach(edge => {
      if (edge.target === selectedNode) connectedNodeIds.add(edge.source);
      if (edge.source === selectedNode) connectedNodeIds.add(edge.target);
    });

    return project.nodes
      .filter(n => n.id !== selectedNode)
      .map((n, index) => ({
        ...n,
        shortName: getShortName(n, index),
        isConnected: connectedNodeIds.has(n.id),
      }))
      .filter(n => {
        if (!mentionFilter) return true;
        return n.shortName.toLowerCase().includes(mentionFilter.toLowerCase()) ||
               n.data.label?.toLowerCase().includes(mentionFilter.toLowerCase());
      })
      .sort((a, b) => (a.isConnected ? 0 : 1) - (b.isConnected ? 0 : 1));
  };

  // 处理文本变化
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;

    updateNodeData(selectedNode, {
      prompt: value,
      content: value,
    });

    setCursorPosition(cursorPos);

    // 检测@输入
    const textBeforeCursor = value.substring(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex !== -1) {
      const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);
      if (!textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
        setShowMentionMenu(true);
        setMentionFilter(textAfterAt);
      } else {
        setShowMentionMenu(false);
      }
    } else {
      setShowMentionMenu(false);
    }
  };

  // 插入引用
  const handleMention = (nodeId: string, shortName: string) => {
    const currentValue = data.prompt || data.content || '';
    const textBeforeCursor = currentValue.substring(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex !== -1) {
      const before = currentValue.substring(0, lastAtIndex);
      const after = currentValue.substring(cursorPosition);
      const mention = `@[${shortName}](${nodeId})`;
      const newValue = before + mention + ' ' + after;

      updateNodeData(selectedNode, {
        prompt: newValue,
        content: newValue,
      });
    }

    setShowMentionMenu(false);
    setMentionFilter('');

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }, 100);
  };

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setShowMentionMenu(false);
    }
  };

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
                <div className="relative">
                  <textarea
                    ref={textareaRef}
                    value={data.prompt || data.content || ''}
                    onChange={handleTextChange}
                    onKeyDown={handleKeyDown}
                    rows={5}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg
                      text-white text-sm focus:outline-none focus:border-primary-500 resize-none"
                    placeholder="输入提示词... 输入 @ 引用其他节点"
                  />

                  {/* @引用菜单 */}
                  <AnimatePresence>
                    {showMentionMenu && (
                      <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="absolute left-0 right-0 bottom-full mb-2 bg-dark-700 border border-dark-600
                          rounded-lg shadow-xl z-50 overflow-hidden"
                      >
                        <div className="p-2 border-b border-dark-600">
                          <input
                            type="text"
                            value={mentionFilter}
                            onChange={(e) => setMentionFilter(e.target.value)}
                            placeholder="搜索节点..."
                            className="w-full px-2 py-1 bg-dark-600 border border-dark-500 rounded text-xs
                              text-white placeholder:text-dark-400 focus:outline-none focus:border-primary-500"
                            autoFocus
                          />
                        </div>
                        <div className="max-h-48 overflow-y-auto">
                          {getMentionableNodes().length > 0 ? (
                            <>
                              {getMentionableNodes().filter(n => n.isConnected).length > 0 && (
                                <div className="px-3 py-1.5 text-[10px] text-primary-400 bg-primary-500/10 border-b border-dark-600">
                                  🔗 已连接的节点
                                </div>
                              )}
                              {getMentionableNodes().map((n) => (
                                <button
                                  key={n.id}
                                  onClick={() => handleMention(n.id, n.shortName)}
                                  className={`w-full px-3 py-2 text-xs text-left transition-colors flex items-center gap-2
                                    ${n.isConnected
                                      ? 'text-white hover:bg-primary-500/20 bg-primary-500/5'
                                      : 'text-dark-300 hover:bg-dark-600'
                                    }`}
                                >
                                  <span className="font-bold text-primary-400">@</span>
                                  <span className="flex-1 font-medium">{n.shortName}</span>
                                  <span className="text-[10px] text-dark-500 truncate max-w-[100px]">
                                    {n.data.label}
                                  </span>
                                  {n.isConnected && (
                                    <span className="text-[10px] text-primary-400">🔗</span>
                                  )}
                                </button>
                              ))}
                            </>
                          ) : (
                            <div className="px-3 py-3 text-xs text-dark-500 text-center">
                              暂无其他节点
                            </div>
                          )}
                        </div>
                        <div className="p-2 border-t border-dark-600 flex justify-between items-center">
                          <span className="text-[10px] text-dark-500">
                            共 {getMentionableNodes().length} 个节点
                          </span>
                          <button
                            onClick={() => setShowMentionMenu(false)}
                            className="px-2 py-0.5 text-[10px] text-dark-400 hover:text-white bg-dark-600 rounded"
                          >
                            ESC 关闭
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <div className="text-[10px] text-dark-500">
                  💡 输入 @ 自动弹出引用菜单，选择节点插入引用
                </div>
              </div>

              {/* 引用列表 */}
              {data.prompt && data.prompt.includes('@[') && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-dark-300">已引用的节点</label>
                  <div className="flex flex-wrap gap-1">
                    {project.nodes.map((n, index) => {
                      const shortName = getShortName(n, index);
                      const isReferenced = data.prompt.includes(`@[${shortName}](${n.id})`);
                      if (!isReferenced) return null;
                      return (
                        <span
                          key={n.id}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-primary-500/20 text-primary-300
                            rounded-md text-[10px] cursor-pointer hover:bg-primary-500/30"
                          onClick={() => setSelectedNode(n.id)}
                        >
                          <AtSign className="w-2.5 h-2.5" />
                          {shortName}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 时长设置 */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300 flex items-center gap-2">
                  <Clock className="w-3 h-3 text-primary-400" />
                  时长（秒）
                </label>
                <input
                  type="range"
                  min={1}
                  max={30}
                  value={data.duration}
                  onChange={(e) => updateNodeData(selectedNode, { duration: Number(e.target.value) })}
                  className="w-full accent-primary-500"
                />
                <div className="flex justify-between text-xs text-dark-400">
                  <span>1秒</span>
                  <span className="text-primary-400 font-medium">{data.duration}秒</span>
                  <span>30秒</span>
                </div>
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