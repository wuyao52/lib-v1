import React, { memo, useState, useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Type,
  Image,
  Video,
  Music,
  Wand2,
  Trash2,
  Copy,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  X,
  Download,
  Gauge,
  AtSign,
} from 'lucide-react';
import type { SceneNodeData } from '@/types';
import useProjectStore from '@/store/useProjectStore';
import { PromptMentionContent } from './PromptMentionEditor';
import { isUploadedImageNode } from '@/services/nodeMediaSource';

const typeIcons: Record<string, React.ReactNode> = {
  text: <Type className="w-4 h-4" />,
  image: <Image className="w-4 h-4" />,
  video: <Video className="w-4 h-4" />,
  audio: <Music className="w-4 h-4" />,
  transition: <Wand2 className="w-4 h-4" />,
};

const typeColors: Record<string, string> = {
  text: 'from-blue-500 to-cyan-500',
  image: 'from-purple-500 to-pink-500',
  video: 'from-orange-500 to-red-500',
  audio: 'from-green-500 to-emerald-500',
  transition: 'from-yellow-500 to-amber-500',
};

const typeLabels: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  transition: '转场',
};

// 风格中文名称映射
const styleLabels: Record<string, string> = {
  cinematic: '电影感',
  anime: '动漫风',
  realistic: '写实风',
  artistic: '艺术风',
  vintage: '复古风',
  modern: '现代风',
};

// 播放速度选项
const playbackSpeeds = [0.5, 0.75, 1, 1.25, 1.5, 2];

function SceneNodeComponent({ id, data, selected }: NodeProps) {
  const { updateNodeData, deleteNode, duplicateNode, setSelectedNode, startGeneration, project } =
    useProjectStore();

  // 类型断言
  const nodeData = data as unknown as SceneNodeData;

  // 视频播放状态
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // @引用状态
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');

  const handleGenerate = async () => {
    startGeneration(id);
  };

  // 视频播放控制
  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current && nodeData.generatedContent) {
      try {
        if (isPlaying) {
          videoRef.current.pause();
          setIsPlaying(false);
        } else {
          // 检查视频源是否有效
          if (videoRef.current.src || videoRef.current.currentSrc) {
            const playPromise = videoRef.current.play();
            if (playPromise !== undefined) {
              playPromise
                .then(() => {
                  setIsPlaying(true);
                })
                .catch((error) => {
                  console.warn('视频播放失败:', error);
                  setIsPlaying(false);
                });
            }
          } else {
            console.warn('视频源无效');
          }
        }
      } catch (error) {
        console.warn('视频播放错误:', error);
        setIsPlaying(false);
      }
    }
  };

  // 静音控制
  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  // 设置播放速度
  const handleSetSpeed = (speed: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
      setPlaybackSpeed(speed);
      setShowSpeedMenu(false);
    }
  };

  // 下载视频
  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (nodeData.generatedContent) {
      const link = document.createElement('a');
      link.href = nodeData.generatedContent;
      link.download = `${nodeData.label || 'video'}-${Date.now()}.mp4`;
      link.click();
    }
  };

  // 全屏预览
  const openPreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowPreview(true);
  };

  const closePreview = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setShowPreview(false);
    if (videoRef.current) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  // 处理@引用
  const handleMention = (nodeId: string, nodeLabel: string) => {
    const mentionText = `@[${nodeLabel}](${nodeId})`;
    updateNodeData(id, {
      content: (nodeData.content || '') + mentionText,
    });
    setShowMentionMenu(false);
    setMentionFilter('');
  };

  // 获取可引用的节点列表
  const getMentionableNodes = () => {
    if (!project) return [];
    return project.nodes
      .filter(n => n.id !== id)
      .filter(n => {
        if (!mentionFilter) return true;
        return n.data.label?.toLowerCase().includes(mentionFilter.toLowerCase());
      });
  };

  // 解析内容中的@引用
  const renderContentWithMentions = (content: string) => {
    if (!content || !project) return null;
    return <PromptMentionContent value={content} nodes={project.nodes.map((candidate) => ({
      id: candidate.id,
      label: candidate.data.label,
      type: candidate.data.type,
      imageUrl: candidate.data.type === 'image' ? candidate.data.generatedContent : undefined,
    }))} />;
  };

  const isUploadedImage = isUploadedImageNode(nodeData);
  const progress = nodeData.progress || 0;
  const isGenerating = !isUploadedImage && nodeData.status === 'generating';
  const isCompleted = !isUploadedImage && nodeData.status === 'completed';
  const isError = !isUploadedImage && nodeData.status === 'error';
  const hasContent = nodeData.generatedContent || nodeData.content;
  const canGenerate = !isUploadedImage && Boolean(nodeData.generatedContent || String(nodeData.prompt || nodeData.content || '').trim());

  return (
    <>
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        whileHover={{ scale: 1.02 }}
        className={`relative group ${selected ? 'z-10' : 'z-0'}`}
        onClick={() => setSelectedNode(id)}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!bg-primary-500 !w-3 !h-3 !border-2 !border-dark-800"
        />

        <div
          className={`
            w-80 rounded-xl overflow-hidden
            bg-dark-800/90 backdrop-blur-xl
            border-2 transition-all duration-300
            ${selected
              ? 'border-primary-500 shadow-lg shadow-primary-500/20'
              : isGenerating
              ? 'border-yellow-500/50 shadow-lg shadow-yellow-500/10'
              : isCompleted
              ? 'border-green-500/50'
              : isError
              ? 'border-red-500/50'
              : 'border-dark-600/50 hover:border-dark-400/50'
            }
          `}
        >
          {/* Header */}
          <div className={`bg-gradient-to-r ${typeColors[nodeData.type]} p-3`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-white">
                {typeIcons[nodeData.type]}
                <span className="font-medium text-sm">{nodeData.label}</span>
              </div>
              <div className="flex items-center gap-1">
                {/* 状态图标 */}
                {isGenerating && (
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                )}
                {isCompleted && (
                  <CheckCircle2 className="w-4 h-4 text-white" />
                )}
                {isError && (
                  <AlertCircle className="w-4 h-4 text-white" />
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicateNode(id);
                  }}
                  className="p-1 hover:bg-white/20 rounded transition-colors"
                >
                  <Copy className="w-3 h-3 text-white/80" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteNode(id);
                  }}
                  className="p-1 hover:bg-white/20 rounded transition-colors"
                >
                  <Trash2 className="w-3 h-3 text-white/80" />
                </button>
              </div>
            </div>
          </div>

          {/* 进度条 */}
          {isGenerating && (
            <div className="relative h-1.5 bg-dark-700">
              <motion.div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-yellow-500 to-orange-500"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-[10px] font-bold text-white drop-shadow-lg">
                  {progress}%
                </span>
              </div>
            </div>
          )}

          {/* Content */}
          <div className="p-3 space-y-2">
            {/* 视频预览区域 */}
            {(nodeData.type === 'video' || nodeData.generatedContent?.includes('.mp4') ||
              nodeData.generatedContent?.includes('.webm') || nodeData.generatedContent?.includes('.mov')) && (
              <div className="relative aspect-video rounded-lg overflow-hidden bg-dark-900 group/video">
                {nodeData.generatedContent ? (
                  <>
                    <video
                      ref={videoRef}
                      src={nodeData.generatedContent}
                      className="w-full h-full object-cover"
                      muted={isMuted}
                      loop
                      playsInline
                      preload="metadata"
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                      onError={(e) => {
                        console.warn('视频加载失败:', e);
                        setIsPlaying(false);
                      }}
                      poster={nodeData.thumbnail}
                    />

                    {/* 视频控制层 */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent
                      opacity-0 group-hover/video:opacity-100 transition-opacity flex flex-col justify-end p-2">
                      {/* 进度条（可选） */}
                      <div className="flex items-center gap-1.5 mb-1">
                        <button
                          onClick={togglePlay}
                          className="p-1.5 bg-white/20 rounded-full hover:bg-white/30 transition-colors"
                        >
                          {isPlaying ? (
                            <Pause className="w-3 h-3 text-white" />
                          ) : (
                            <Play className="w-3 h-3 text-white" />
                          )}
                        </button>
                        <button
                          onClick={toggleMute}
                          className="p-1.5 bg-white/20 rounded-full hover:bg-white/30 transition-colors"
                        >
                          {isMuted ? (
                            <VolumeX className="w-3 h-3 text-white" />
                          ) : (
                            <Volume2 className="w-3 h-3 text-white" />
                          )}
                        </button>

                        {/* 播放速度 */}
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowSpeedMenu(!showSpeedMenu);
                            }}
                            className="p-1.5 bg-white/20 rounded-full hover:bg-white/30 transition-colors
                              flex items-center gap-0.5"
                          >
                            <Gauge className="w-3 h-3 text-white" />
                            <span className="text-[10px] text-white">{playbackSpeed}x</span>
                          </button>

                          {/* 速度选择菜单 */}
                          {showSpeedMenu && (
                            <div className="absolute bottom-full left-0 mb-1 bg-dark-800 border border-dark-600
                              rounded-lg shadow-xl overflow-hidden z-10">
                              {playbackSpeeds.map((speed) => (
                                <button
                                  key={speed}
                                  onClick={(e) => handleSetSpeed(speed, e)}
                                  className={`w-full px-3 py-1.5 text-xs text-left transition-colors
                                    ${playbackSpeed === speed
                                      ? 'bg-primary-600 text-white'
                                      : 'text-dark-300 hover:bg-dark-700'
                                    }`}
                                >
                                  {speed}x {speed === 1 ? '(正常)' : ''}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex-1" />

                        {/* 下载按钮 */}
                        <button
                          onClick={handleDownload}
                          className="p-1.5 bg-white/20 rounded-full hover:bg-white/30 transition-colors"
                          title="下载视频"
                        >
                          <Download className="w-3 h-3 text-white" />
                        </button>

                        <button
                          onClick={openPreview}
                          className="p-1.5 bg-white/20 rounded-full hover:bg-white/30 transition-colors"
                          title="全屏预览"
                        >
                          <Maximize2 className="w-3 h-3 text-white" />
                        </button>
                      </div>
                    </div>

                    {/* 播放按钮覆盖层 */}
                    {!isPlaying && (
                      <div
                        className="absolute inset-0 flex items-center justify-center cursor-pointer"
                        onClick={togglePlay}
                      >
                        <div className="w-12 h-12 rounded-full bg-white/30 backdrop-blur-sm flex items-center justify-center
                          hover:bg-white/40 transition-colors">
                          <Play className="w-6 h-6 text-white ml-1" />
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Video className="w-10 h-10 text-dark-600" />
                  </div>
                )}
              </div>
            )}

            {/* 图片预览区域 */}
            {nodeData.type === 'image' && nodeData.generatedContent && !nodeData.generatedContent?.includes('.mp4') && (
              <div className="relative aspect-video rounded-lg overflow-hidden bg-dark-900 group/image">
                <img
                  src={nodeData.generatedContent}
                  alt={nodeData.label}
                  className="w-full h-full object-cover cursor-pointer"
                  onClick={openPreview}
                />
                {/* 图片控制层 */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent
                  opacity-0 group-hover/image:opacity-100 transition-opacity flex flex-col justify-end p-2">
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1" />
                    {/* 下载按钮 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (nodeData.generatedContent) {
                          const link = document.createElement('a');
                          link.href = nodeData.generatedContent;
                          link.download = `${nodeData.label || 'image'}-${Date.now()}.png`;
                          link.click();
                        }
                      }}
                      className="p-1.5 bg-white/20 rounded-full hover:bg-white/30 transition-colors"
                      title="下载图片"
                    >
                      <Download className="w-3 h-3 text-white" />
                    </button>
                    <button
                      onClick={openPreview}
                      className="p-1.5 bg-white/20 rounded-full hover:bg-white/30 transition-colors"
                      title="全屏预览"
                    >
                      <Maximize2 className="w-3 h-3 text-white" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 进度显示 */}
            {isGenerating && (
              <div className="bg-dark-700/50 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-dark-300 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin text-yellow-400" />
                    AI 生成中...
                  </span>
                  <span className="text-sm font-bold text-yellow-400">
                    {progress}%
                  </span>
                </div>
                <div className="w-full h-2 bg-dark-600 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-yellow-500 to-orange-500 rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                  />
                </div>
                <p className="text-[10px] text-dark-400 mt-2">
                  {nodeData.generationMessage || `正在调用 ${nodeData.settings?.style === 'cinematic' ? 'Seedance 2.0' : 'AI'} 生成${typeLabels[nodeData.type]}内容...`}
                </p>
              </div>
            )}

            {/* 完成状态 */}
            {isCompleted && !nodeData.generatedContent && (
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3">
                <div className="flex items-center gap-2 text-green-400">
                  <CheckCircle2 className="w-4 h-4" />
                  <span className="text-xs font-medium">生成完成</span>
                </div>
              </div>
            )}

            {/* 错误状态 */}
            {isError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                <div className="flex items-center gap-2 text-red-400">
                  <AlertCircle className="w-4 h-4" />
                  <span className="text-xs font-medium">生成失败</span>
                </div>
                {nodeData.error && (
                  <p className="text-[10px] text-red-400/70 mt-1 line-clamp-2">{nodeData.error}</p>
                )}
              </div>
            )}

            {/* 提示词/内容（支持@引用） */}
            {!isUploadedImage && (nodeData.prompt || nodeData.content) && !isGenerating && (
              <div className="relative">
                <div className="text-xs text-dark-300 line-clamp-3 leading-relaxed">
                  {renderContentWithMentions(nodeData.prompt || nodeData.content)}
                </div>
                {/* @引用按钮 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMentionMenu(!showMentionMenu);
                  }}
                  className="absolute top-0 right-0 p-1 text-dark-500 hover:text-primary-400 transition-colors"
                  title="添加@引用"
                >
                  <AtSign className="w-3 h-3" />
                </button>

                {/* @引用菜单 */}
                {showMentionMenu && (
                  <div className="absolute top-full right-0 mt-1 w-48 bg-dark-800 border border-dark-600
                    rounded-lg shadow-xl z-20 overflow-hidden">
                    <div className="p-2 border-b border-dark-600">
                      <input
                        type="text"
                        value={mentionFilter}
                        onChange={(e) => setMentionFilter(e.target.value)}
                        placeholder="搜索节点..."
                        className="w-full px-2 py-1 bg-dark-700 border border-dark-600 rounded text-xs
                          text-white placeholder:text-dark-500 focus:outline-none focus:border-primary-500"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                    <div className="max-h-32 overflow-y-auto">
                      {getMentionableNodes().length > 0 ? (
                        getMentionableNodes().map((node) => (
                          <button
                            key={node.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMention(node.id, node.data.label || '未命名');
                            }}
                            className="w-full px-3 py-2 text-xs text-left text-dark-300
                              hover:bg-dark-700 transition-colors flex items-center gap-2"
                          >
                            <span className="text-primary-400">@</span>
                            <span className="truncate">{node.data.label || '未命名'}</span>
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-2 text-xs text-dark-500">
                          没有可引用的节点
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 时长和风格标签 */}
            {!isUploadedImage && <div className="flex items-center justify-between">
              <span className="text-[10px] px-2 py-1 rounded-full bg-dark-700 text-dark-300">
                {nodeData.duration}秒
              </span>
              {nodeData.settings?.style && (
                <span className="text-[10px] px-2 py-1 rounded-full bg-primary-500/20 text-primary-300">
                  {styleLabels[nodeData.settings.style] || nodeData.settings.style}
                </span>
              )}
            </div>}

            {/* 生成按钮 */}
            {!isUploadedImage && !isGenerating && !isCompleted && (
              <button
                disabled={!canGenerate}
                title={canGenerate ? 'AI 生成' : '请先填写提示词或添加素材'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (canGenerate) handleGenerate();
                }}
                className="w-full py-2 rounded-lg text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40
                  bg-gradient-to-r from-primary-600 to-primary-500
                  hover:from-primary-500 hover:to-primary-400
                  text-white shadow-lg shadow-primary-500/20
                  transition-all duration-300"
              >
                <span className="flex items-center justify-center gap-2">
                  <Wand2 className="w-3 h-3" />
                  AI 生成
                </span>
              </button>
            )}

            {/* 重新生成按钮 */}
            {!isUploadedImage && (isCompleted || isError) && (
              <button
                disabled={!canGenerate}
                title={canGenerate ? '重新生成' : '请先填写提示词或添加素材'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (canGenerate) handleGenerate();
                }}
                className="w-full py-2 rounded-lg text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40
                  bg-dark-700 hover:bg-dark-600 text-dark-300 hover:text-white
                  transition-all duration-300"
              >
                <span className="flex items-center justify-center gap-2">
                  <Wand2 className="w-3 h-3" />
                  重新生成
                </span>
              </button>
            )}
          </div>
        </div>

        <Handle
          type="source"
          position={Position.Right}
          className="!bg-primary-500 !w-3 !h-3 !border-2 !border-dark-800"
        />
      </motion.div>

      {/* 全屏预览模态框 */}
      <AnimatePresence>
        {showPreview && nodeData.generatedContent && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm"
            onClick={closePreview}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative max-w-[90vw] max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* 关闭按钮 */}
              <button
                onClick={closePreview}
                className="absolute -top-12 right-0 p-2 text-white/70 hover:text-white transition-colors"
              >
                <X className="w-6 h-6" />
              </button>

              {/* 视频预览 */}
              {(nodeData.type === 'video' || nodeData.generatedContent?.includes('.mp4')) && (
                <div className="relative">
                  <video
                    src={nodeData.generatedContent}
                    className="max-w-full max-h-[85vh] rounded-lg shadow-2xl"
                    controls
                    autoPlay
                    loop
                    playsInline
                  />
                  {/* 下载按钮 */}
                  <button
                    onClick={handleDownload}
                    className="absolute bottom-4 right-4 px-4 py-2 bg-white/20 backdrop-blur-sm
                      rounded-lg hover:bg-white/30 transition-colors flex items-center gap-2"
                  >
                    <Download className="w-4 h-4 text-white" />
                    <span className="text-white text-sm">下载视频</span>
                  </button>
                </div>
              )}

              {/* 图片预览 */}
              {nodeData.type === 'image' && !nodeData.generatedContent?.includes('.mp4') && (
                <div className="relative">
                  <img
                    src={nodeData.generatedContent}
                    alt={nodeData.label}
                    className="max-w-full max-h-[85vh] rounded-lg shadow-2xl object-contain"
                  />
                  {/* 下载按钮 */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (nodeData.generatedContent) {
                        const link = document.createElement('a');
                        link.href = nodeData.generatedContent;
                        link.download = `${nodeData.label || 'image'}-${Date.now()}.png`;
                        link.click();
                      }
                    }}
                    className="absolute bottom-4 right-4 px-4 py-2 bg-white/20 backdrop-blur-sm
                      rounded-lg hover:bg-white/30 transition-colors flex items-center gap-2"
                  >
                    <Download className="w-4 h-4 text-white" />
                    <span className="text-white text-sm">下载图片</span>
                  </button>
                </div>
              )}

              {/* 信息栏 */}
              <div className="mt-4 text-center">
                <h3 className="text-white font-medium">{nodeData.label}</h3>
                {nodeData.prompt && (
                  <p className="text-dark-300 text-sm mt-1">{renderContentWithMentions(nodeData.prompt)}</p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default memo(SceneNodeComponent);
