import { motion, AnimatePresence } from 'framer-motion';
import { X, Type, Image, Video, Music, Wand2, Clock, Sparkles } from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';
import PromptMentionEditor from './PromptMentionEditor';
import VideoDurationControl from './VideoDurationControl';
import { videoDurationRules } from '@/services/modelDuration';
import { isUploadedImageNode } from '@/services/nodeMediaSource';
import { useEffect, useState } from 'react';
import { getPlayableMediaUrl, needsResolvedMediaUrl } from '@/services/assetService';

function ResolvedVideo({ source, poster }: { source: string; poster?: string }) {
  const [url, setUrl] = useState(needsResolvedMediaUrl(source) ? '' : source);
  useEffect(() => {
    const controller = new AbortController();
    setUrl(needsResolvedMediaUrl(source) ? '' : source);
    void getPlayableMediaUrl(source, controller.signal).then(setUrl).catch(() => undefined);
    return () => controller.abort();
  }, [source]);
  return url
    ? <video src={url} poster={poster} controls preload="metadata" className="aspect-video w-full rounded bg-black" />
    : <div className="flex aspect-video items-center justify-center rounded bg-black text-xs text-dark-400">正在读取视频</div>;
}

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
  const isUploadedImage = isUploadedImageNode(node.data);
  const incomingIds = new Set(project.edges.filter((edge) => edge.target === selectedNode).map((edge) => edge.source));
  const mentionableNodes = project.nodes
    .filter((candidate) => incomingIds.has(candidate.id))
    .map((candidate) => ({
      id: candidate.id,
      label: candidate.data.label,
      type: candidate.data.type,
      imageUrl: candidate.data.type === 'image' ? candidate.data.generatedContent : undefined,
    }));
  const configuredVideoModel = project.settings.multiModel?.videoModel || project.settings.aiModel;
  const savedReferences = [...incomingIds]
    .map((id: string) => project.nodes.find((candidate) => candidate.id === id))
    .filter(Boolean);

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

              {data.type === 'video' && data.generatedContent && (
                <section className="space-y-3 border border-dark-600 rounded-lg bg-dark-900/60 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-white">生成视频详情</span>
                    <span className={data.status === 'error' ? 'text-[10px] text-red-300' : 'text-[10px] text-green-300'}>
                      {data.status === 'error' ? '生成失败' : '已生成'}
                    </span>
                  </div>
                  <ResolvedVideo source={data.generatedContent} poster={data.thumbnail} />
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <div className="col-span-2"><dt className="text-dark-500">视频组件 ID</dt><dd className="mt-0.5 break-all font-mono text-[10px] text-dark-200">{node.id}</dd></div>
                    {data.generationMeta?.taskId && <div className="col-span-2"><dt className="text-dark-500">生成任务 ID</dt><dd className="mt-0.5 break-all font-mono text-[10px] text-dark-200">{data.generationMeta.taskId}</dd></div>}
                    <div><dt className="text-dark-500">时长</dt><dd className="mt-0.5 text-dark-200">{data.duration || '-'} 秒</dd></div>
                    <div><dt className="text-dark-500">模型</dt><dd className="mt-0.5 truncate text-dark-200" title={data.generationMeta?.modelName || configuredVideoModel.name}>{data.generationMeta?.modelName || configuredVideoModel.name || configuredVideoModel.modelId || '-'}</dd></div>
                    <div><dt className="text-dark-500">风格</dt><dd className="mt-0.5 text-dark-200">{data.settings?.style || '默认'}</dd></div>
                    <div><dt className="text-dark-500">来源</dt><dd className="mt-0.5 text-dark-200">{data.mediaSource === 'uploaded' ? '上传素材' : 'AI 生成'}</dd></div>
                  </dl>
                  {(data.prompt || data.content) && <div><p className="text-[10px] text-dark-500">提示词</p><p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-dark-300">{data.prompt || data.content}</p></div>}
                  {data.generationMeta?.completedAt && <p className="text-[10px] text-dark-500">完成时间：{new Date(data.generationMeta.completedAt).toLocaleString()}</p>}
                  {data.error && <p className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">错误：{data.error}</p>}
                </section>
              )}

              {!isUploadedImage && <>
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
                {savedReferences.length > 0 && (
                  <div className="flex flex-wrap gap-1.5" data-testid="node-saved-references">
                    {savedReferences.map((reference: any) => (
                      <span key={reference.id} className="inline-flex items-center rounded border border-primary-500/30 bg-primary-500/10 px-2 py-1 text-[10px] text-primary-200">
                        @{reference.data.label}
                      </span>
                    ))}
                  </div>
                )}
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
              </>}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
