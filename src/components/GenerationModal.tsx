import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Video,
  Image,
  Wand2,
  Sparkles,
  Camera,
  Film,
  Palette,
  Upload,
  XCircle,
} from 'lucide-react';
import PromptMentionEditor, { type PromptMentionNode } from './PromptMentionEditor';
import VideoDurationControl from './VideoDurationControl';
import { normalizeModelDuration, type DurationRules } from '@/services/modelDuration';
import { uploadVideoAsset } from '@/services/assetService';

interface GenerationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (type: 'video' | 'image' | 'img2img', settings: GenerationSettings) => void;
  sourceImageUrl?: string;
  sourceNodeType?: string;
  mentionableNodes?: PromptMentionNode[];
  initialReferences?: Array<{ id: string; label: string; type: string; imageUrl?: string; videoUrl?: string }>;
  durationRules?: DurationRules;
  maxReferenceImages?: number;
  maxReferenceVideos?: number;
}

export interface GenerationSettings {
  type: 'video' | 'image' | 'img2img';
  prompt: string;
  style: string;
  duration?: number;
  strength?: number; // 用于图生图的相似度
  negativePrompt?: string;
  referenceNodeIds?: string[];
  videos?: string[];
}

const styles = [
  { id: 'cinematic', label: '电影感', icon: '🎬' },
  { id: 'anime', label: '动漫风', icon: '🎌' },
  { id: 'realistic', label: '写实风', icon: '📷' },
  { id: 'artistic', label: '艺术风', icon: '🎨' },
  { id: 'vintage', label: '复古风', icon: '📽️' },
  { id: 'modern', label: '现代风', icon: '✨' },
  { id: 'watercolor', label: '水彩风', icon: '🖌️' },
  { id: 'oil-painting', label: '油画风', icon: '🖼️' },
];

export default function GenerationModal({
  isOpen,
  onClose,
  onSelect,
  sourceImageUrl,
  sourceNodeType,
  mentionableNodes = [],
  initialReferences = [],
  durationRules,
  maxReferenceImages = 4,
  maxReferenceVideos = 0,
}: GenerationModalProps) {
  const [selectedType, setSelectedType] = useState<'video' | 'image' | 'img2img'>('video');
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState('cinematic');
  const [duration, setDuration] = useState(5);
  const [strength, setStrength] = useState(0.7);
  const [negativePrompt, setNegativePrompt] = useState('');
  const [videoReferences, setVideoReferences] = useState<string[]>([]);
  const [videoUploadError, setVideoUploadError] = useState<string | null>(null);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const videoUploadRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    submittingRef.current = false;
    setIsSubmitting(false);
    setPrompt('');
    setVideoReferences([...new Set(initialReferences.filter((reference) => reference.type === 'video' && reference.videoUrl).map((reference) => reference.videoUrl!))].slice(0, Math.max(0, maxReferenceVideos)));
    setVideoUploadError(null);
    setIsUploadingVideo(false);
    return () => {
      videoUploadRef.current?.abort();
      videoUploadRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setDuration((current) => normalizeModelDuration(current, durationRules, 1, 15));
  }, [isOpen, durationRules?.managed, durationRules?.minDurationSec, durationRules?.maxDurationSec, JSON.stringify(durationRules?.allowedDurationsSec || [])]);

  const videoReferenceOptions = initialReferences.filter((reference) => reference.type === 'video' && reference.videoUrl);

  const handleVideoUpload = async (files: FileList | null) => {
    if (!files || maxReferenceVideos <= 0 || videoUploadRef.current) return;
    const remaining = Math.max(0, maxReferenceVideos - videoReferences.length);
    const selectedFiles = Array.from(files).filter((file) => file.type.startsWith('video/')).slice(0, remaining);
    if (!selectedFiles.length) {
      setVideoUploadError(remaining ? '请选择视频文件' : `该模型最多支持 ${maxReferenceVideos} 个参考视频`);
      return;
    }
    setVideoUploadError(null);
    setIsUploadingVideo(true);
    const controller = new AbortController();
    videoUploadRef.current = controller;
    try {
      for (const file of selectedFiles) {
        const uploaded = await uploadVideoAsset(file, controller.signal);
        if (controller.signal.aborted) return;
        setVideoReferences((current) => [...new Set([...current, uploaded])].slice(0, maxReferenceVideos));
      }
    } catch (error) {
      if (!controller.signal.aborted) setVideoUploadError(error instanceof Error ? error.message : '视频上传失败，请重试');
    } finally {
      if (videoUploadRef.current === controller) {
        videoUploadRef.current = null;
        setIsUploadingVideo(false);
      }
    }
  };

  const handleGenerate = () => {
    if (!prompt.trim() || submittingRef.current || videoUploadRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    onSelect(selectedType, {
      type: selectedType,
      prompt: prompt.trim(),
      style,
      duration,
      strength,
      negativePrompt: negativePrompt.trim(),
      referenceNodeIds: initialReferences.map((node) => node.id),
      videos: selectedType === 'video' ? videoReferences.slice(0, Math.max(0, maxReferenceVideos)) : undefined,
    });
  };

  const typeOptions = [
    {
      id: 'video' as const,
      label: '生成视频',
      description: '根据文字描述生成视频',
      icon: <Video className="w-6 h-6" />,
      color: 'from-orange-500 to-red-500',
      iconBg: 'bg-orange-500/20',
    },
    {
      id: 'image' as const,
      label: '生成图片',
      description: '根据文字描述生成图片',
      icon: <Image className="w-6 h-6" />,
      color: 'from-purple-500 to-pink-500',
      iconBg: 'bg-purple-500/20',
    },
    {
      id: 'img2img' as const,
      label: '图生图',
      description: '基于原图生成新的图片',
      icon: <Palette className="w-6 h-6" />,
      color: 'from-blue-500 to-cyan-500',
      iconBg: 'bg-blue-500/20',
      disabled: !sourceImageUrl,
    },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[300] flex items-center justify-center p-4"
        >
          {/* 背景遮罩 */}
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* 模态框 */}
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            className="relative w-full max-w-2xl bg-dark-800 rounded-2xl border border-dark-600/50
              shadow-2xl overflow-hidden"
          >
            {/* 头部 */}
            <div className="flex items-center justify-between p-5 border-b border-dark-600/50
              bg-gradient-to-r from-primary-600/10 to-purple-600/10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700
                  flex items-center justify-center">
                  <Wand2 className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">AI 内容生成</h2>
                  <p className="text-xs text-dark-400">选择生成类型并输入提示词</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 hover:bg-dark-700 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-dark-400" />
              </button>
            </div>

            {/* 内容 */}
            <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
              {/* 生成类型选择 */}
              <div className="space-y-3">
                <label className="text-sm font-medium text-dark-200">生成类型</label>
                <div className="grid grid-cols-3 gap-3">
                  {typeOptions.map((option) => (
                    <button
                      key={option.id}
                      onClick={() => !option.disabled && setSelectedType(option.id)}
                      disabled={option.disabled}
                      className={`
                        relative p-4 rounded-xl border-2 transition-all
                        ${option.disabled
                          ? 'border-dark-700 bg-dark-800/50 opacity-50 cursor-not-allowed'
                          : selectedType === option.id
                          ? 'border-primary-500 bg-primary-500/10'
                          : 'border-dark-600 hover:border-dark-400 bg-dark-700/50'
                        }
                      `}
                    >
                      <div className="flex flex-col items-center gap-2 text-center">
                        <div className={`p-3 rounded-xl ${option.iconBg} ${
                          selectedType === option.id ? 'text-primary-400' : 'text-dark-300'
                        }`}>
                          {option.icon}
                        </div>
                        <div>
                          <div className={`text-sm font-medium ${
                            selectedType === option.id ? 'text-white' : 'text-dark-200'
                          }`}>
                            {option.label}
                          </div>
                          <div className="text-[10px] text-dark-400 mt-1">
                            {option.description}
                          </div>
                        </div>
                      </div>
                      {option.disabled && (
                        <div className="absolute inset-0 flex items-center justify-center bg-dark-800/80 rounded-xl">
                          <span className="text-xs text-dark-500">需要源图片</span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* 源图片预览（图生图模式） */}
              {selectedType === 'img2img' && sourceImageUrl && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-dark-200">源图片</label>
                  <div className="relative w-32 h-20 rounded-lg overflow-hidden bg-dark-700 border border-dark-600">
                    <img
                      src={sourceImageUrl}
                      alt="源图片"
                      className="w-full h-full object-cover"
                    />
                  </div>
                </div>
              )}

              {/* 提示词 */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-dark-200 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary-400" />
                  提示词
                </label>
                <PromptMentionEditor
                  value={prompt}
                  onChange={setPrompt}
                  nodes={mentionableNodes}
                  placeholder={
                    selectedType === 'video'
                      ? '描述你想要生成的视频内容...'
                      : selectedType === 'img2img'
                      ? '描述你希望如何改变这张图片...'
                      : '描述你想要生成的图片内容...'
                  }
                />
                {mentionableNodes.length > 0 && <div className="mt-1 text-[10px] text-dark-500">输入 @ 可引用画布目标；当前视频模型最多使用 {maxReferenceImages} 张参考图</div>}
              </div>

              {/* 视频参考 */}
              {selectedType === 'video' && (
                <div className="space-y-2 rounded-xl border border-violet-500/25 bg-violet-500/5 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label className="text-sm font-medium text-dark-200">视频参考</label>
                      <p className="mt-1 text-[10px] text-dark-400">
                        {maxReferenceVideos > 0 ? `可上传或选择，最多 ${maxReferenceVideos} 个` : '当前模型未开启视频参考'}
                      </p>
                    </div>
                    <label className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors focus-within:ring-2 focus-within:ring-primary-400 ${maxReferenceVideos > videoReferences.length && !isUploadingVideo ? 'cursor-pointer border-violet-500/50 text-violet-200 hover:bg-violet-500/15' : 'cursor-not-allowed border-dark-700 text-dark-500'}`}>
                      <Upload className="h-3.5 w-3.5" />
                      {isUploadingVideo ? '上传中…' : '上传视频'}
                      <input aria-label="上传参考视频" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" multiple className="sr-only" disabled={maxReferenceVideos <= videoReferences.length || isUploadingVideo} onChange={(event) => { void handleVideoUpload(event.target.files); event.currentTarget.value = ''; }} />
                    </label>
                  </div>
                  {videoReferenceOptions.length > 0 && (
                    <div className="space-y-1.5">
                      {videoReferenceOptions.map((reference) => {
                        const url = reference.videoUrl!;
                        const selected = videoReferences.includes(url);
                        return <button key={reference.id} type="button" aria-pressed={selected} disabled={isUploadingVideo || (!selected && (maxReferenceVideos <= 0 || videoReferences.length >= maxReferenceVideos))} onClick={() => setVideoReferences((current) => selected ? current.filter((item) => item !== url) : [...current, url])} className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${selected ? 'border-violet-400/70 bg-violet-500/15 text-violet-100' : 'border-dark-600 bg-dark-800/60 text-dark-300 hover:border-violet-500/50'} disabled:cursor-not-allowed disabled:opacity-50`}><span className="flex min-w-0 items-center gap-2"><Film className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{reference.label}</span></span><span className="shrink-0">{selected ? '已选择' : '选择'}</span></button>;
                      })}
                    </div>
                  )}
                  {videoReferences.filter((url) => !videoReferenceOptions.some((reference) => reference.videoUrl === url)).map((url, index) => <div key={url} className="flex items-center justify-between rounded-lg border border-dark-600 bg-dark-800/60 px-3 py-2 text-xs text-dark-300"><span className="flex min-w-0 items-center gap-2"><Film className="h-3.5 w-3.5 shrink-0 text-violet-300" /><span className="truncate">已上传视频 {index + 1}</span></span><button type="button" aria-label={`移除已上传视频 ${index + 1}`} onClick={() => setVideoReferences((current) => current.filter((item) => item !== url))} className="text-dark-400 hover:text-white"><XCircle className="h-4 w-4" /></button></div>)}
                  {videoUploadError && <p role="alert" className="text-xs text-red-300">{videoUploadError}</p>}
                </div>
              )}

              {/* 反向提示词 */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-dark-200">
                  反向提示词 <span className="text-dark-400">(可选)</span>
                </label>
                <input
                  type="text"
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="描述你不想出现的内容..."
                  className="w-full px-4 py-2.5 bg-dark-700 border border-dark-600 rounded-xl
                    text-white placeholder:text-dark-500
                    focus:outline-none focus:border-primary-500"
                />
              </div>

              {/* 风格选择 */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-dark-200">风格</label>
                <div className="grid grid-cols-4 gap-2">
                  {styles.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setStyle(s.id)}
                      className={`
                        py-2 px-3 rounded-lg text-xs font-medium transition-colors
                        ${style === s.id
                          ? 'bg-primary-600 text-white'
                          : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                        }
                      `}
                    >
                      <span className="mr-1">{s.icon}</span>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 视频时长（仅视频模式） */}
              {selectedType === 'video' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-dark-200 flex items-center gap-2">
                    <Film className="w-4 h-4 text-primary-400" />
                    视频时长
                  </label>
                  <VideoDurationControl value={duration} onChange={setDuration} rules={durationRules} fallbackMin={1} fallbackMax={15} ariaLabel="生成视频时长" />
                </div>
              )}

              {/* 图生图相似度 */}
              {selectedType === 'img2img' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-dark-200 flex items-center gap-2">
                    <Camera className="w-4 h-4 text-primary-400" />
                    相似度：{Math.round(strength * 100)}%
                  </label>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={strength}
                    onChange={(e) => setStrength(Number(e.target.value))}
                    className="w-full accent-primary-500"
                  />
                  <div className="flex justify-between text-xs text-dark-400">
                    <span>更多变化</span>
                    <span>更像原图</span>
                  </div>
                </div>
              )}
            </div>

            {/* 底部按钮 */}
            <div className="p-5 border-t border-dark-600/50 flex justify-between items-center">
              <div className="text-xs text-dark-400">
                {!prompt.trim() && '请输入提示词后开始生成'}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="px-5 py-2.5 rounded-xl text-dark-300 hover:text-white
                    hover:bg-dark-700 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={!prompt.trim() || isSubmitting || isUploadingVideo}
                  className={`
                    px-6 py-2.5 rounded-xl font-medium transition-all flex items-center gap-2
                    ${prompt.trim() && !isSubmitting && !isUploadingVideo
                      ? `bg-gradient-to-r ${
                          selectedType === 'video'
                            ? 'from-orange-500 to-red-500'
                            : selectedType === 'img2img'
                            ? 'from-blue-500 to-cyan-500'
                            : 'from-purple-500 to-pink-500'
                        } text-white shadow-lg`
                      : 'bg-dark-700 text-dark-500 cursor-not-allowed'
                    }
                  `}
                >
                  <Wand2 className="w-4 h-4" />
                  {selectedType === 'video'
                    ? '生成视频'
                    : selectedType === 'img2img'
                    ? '图生图'
                    : '生成图片'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
