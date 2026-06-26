import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Upload,
  Droplets,
  Loader2,
  CheckCircle2,
  Download,
  Type,
  Info,
} from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';

interface RemoveWatermarkModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceUrl?: string;
  sourceType?: 'image' | 'video';
}

export default function RemoveWatermarkModal({
  isOpen,
  onClose,
  sourceUrl,
  sourceType = 'image',
}: RemoveWatermarkModalProps) {
  const { project } = useProjectStore();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>(sourceUrl || '');
  const [resultUrl, setResultUrl] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [processType, setProcessType] = useState<'watermark' | 'subtitle'>('watermark');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setResultUrl('');
      setStatus('idle');
      setProgress(0);
      const url = URL.createObjectURL(selectedFile);
      setPreviewUrl(url);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      setFile(droppedFile);
      setResultUrl('');
      setStatus('idle');
      setProgress(0);
      const url = URL.createObjectURL(droppedFile);
      setPreviewUrl(url);
    }
  };

  const handleProcess = async () => {
    if (!previewUrl && !file) return;

    setIsProcessing(true);
    setStatus('processing');
    setProgress(0);

    try {
      // 获取 API 配置
      const aiModel = project?.settings.multiModel?.imageModel || project?.settings.aiModel;

      if (!aiModel?.apiKey) {
        // 没有 API Key，使用演示模式
        await simulateProcessing();
        return;
      }

      setProgress(10);

      // 将文件转换为 base64
      let imageData = previewUrl;
      if (file) {
        imageData = await readFileAsDataURL(file);
      }

      setProgress(30);

      // 尝试调用图片编辑 API
      // 红鸟AI可能支持的端点
      const endpoints = [
        { url: `${aiModel.baseUrl}/v1/images/edits`, body: { image: imageData, prompt: `remove ${processType}`, n: 1, size: '1024x1024' } },
        { url: `${aiModel.baseUrl}/v1/images/variations`, body: { image: imageData, n: 1, size: '1024x1024' } },
        { url: `${aiModel.baseUrl}/v1/images/generations`, body: { prompt: `clean image without ${processType}, high quality`, model: aiModel.modelId, size: '1024x1024', images: [imageData] } },
      ];

      let apiSuccess = false;

      for (const endpoint of endpoints) {
        try {
          console.log('尝试 API 端点:', endpoint.url);
          const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${aiModel.apiKey}`,
              'X-API-Key': aiModel.apiKey,
            },
            body: JSON.stringify(endpoint.body),
          });

          if (response.ok) {
            const data = await response.json();
            console.log('API 响应:', data);

            // 尝试从响应中提取结果 URL
            const resultUrl = data.data?.[0]?.url ||
                             data.data?.[0]?.b64_json ||
                             data.output?.image_url ||
                             data.image_url ||
                             data.result?.image_url ||
                             data.url;

            if (resultUrl) {
              setProgress(100);
              setResultUrl(resultUrl.startsWith('data:') ? resultUrl : resultUrl);
              setStatus('completed');
              apiSuccess = true;
              break;
            }
          } else {
            console.log('API 返回错误:', response.status);
          }
        } catch (e) {
          console.log('端点失败:', endpoint.url, e);
        }
      }

      if (!apiSuccess) {
        // 所有 API 都失败，使用演示模式
        console.warn('所有 API 端点都失败，使用演示模式');
        await simulateProcessing();
      }
    } catch (error: any) {
      console.error('处理失败:', error);
      await simulateProcessing();
    } finally {
      setIsProcessing(false);
    }
  };

  // 读取文件为 Data URL
  const readFileAsDataURL = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleDownload = () => {
    if (resultUrl) {
      const link = document.createElement('a');
      link.href = resultUrl;
      link.download = `processed-${processType}-${Date.now()}.png`;
      link.click();
    }
  };

  const resetState = () => {
    setFile(null);
    setPreviewUrl(sourceUrl || '');
    setResultUrl('');
    setStatus('idle');
    setProgress(0);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[300] flex items-center justify-center p-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => e.preventDefault()}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            className="relative w-full max-w-3xl bg-dark-800 rounded-2xl border border-dark-600/50 shadow-2xl overflow-hidden"
          >
            {/* 头部 */}
            <div className="flex items-center justify-between p-5 border-b border-dark-600/50 bg-gradient-to-r from-cyan-600/10 to-blue-600/10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center">
                  {processType === 'watermark' ? (
                    <Droplets className="w-5 h-5 text-white" />
                  ) : (
                    <Type className="w-5 h-5 text-white" />
                  )}
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    {processType === 'watermark' ? '去除水印' : '去除字幕'}
                  </h2>
                  <p className="text-xs text-dark-400">
                    {processType === 'watermark' ? '智能识别并去除图片/视频中的水印' : '智能识别并去除视频中的字幕'}
                  </p>
                </div>
              </div>
              <button onClick={onClose} className="p-2 hover:bg-dark-700 rounded-lg transition-colors">
                <X className="w-5 h-5 text-dark-400" />
              </button>
            </div>

            {/* 内容 */}
            <div className="p-5 space-y-5">
              {/* 功能选择 */}
              <div className="flex gap-2">
                <button
                  onClick={() => setProcessType('watermark')}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                    processType === 'watermark'
                      ? 'bg-cyan-600 text-white'
                      : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                  }`}
                >
                  <Droplets className="w-4 h-4" />
                  去水印
                </button>
                <button
                  onClick={() => setProcessType('subtitle')}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                    processType === 'subtitle'
                      ? 'bg-cyan-600 text-white'
                      : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                  }`}
                >
                  <Type className="w-4 h-4" />
                  去字幕
                </button>
              </div>

              {/* 提示信息 */}
              <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                  <div className="text-xs text-blue-300">
                    <p className="font-medium mb-1">演示模式</p>
                    <p className="text-blue-400/70">
                      当前使用演示模式展示功能效果。实际使用需要配置支持去水印/去字幕的专用 API。
                    </p>
                  </div>
                </div>
              </div>

              {/* 上传区域 */}
              {!previewUrl && (
                <div
                  onDrop={handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                  className="border-2 border-dashed border-dark-600 rounded-2xl p-10 hover:border-primary-500/50 transition-colors cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={processType === 'watermark' ? 'image/*,video/*' : 'video/*'}
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-16 h-16 rounded-2xl bg-dark-700 flex items-center justify-center">
                      <Upload className="w-8 h-8 text-dark-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-white font-medium">拖拽文件到此处或点击上传</p>
                      <p className="text-sm text-dark-400 mt-1">
                        {processType === 'watermark'
                          ? '支持 JPG、PNG、GIF、MP4、MOV 等格式'
                          : '支持 MP4、MOV、AVI 等视频格式'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* 预览和结果 */}
              {previewUrl && (
                <div className="grid grid-cols-2 gap-4">
                  {/* 原图 */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-dark-200">原始文件</label>
                      <button onClick={resetState} className="text-xs text-primary-400 hover:text-primary-300">
                        重新选择
                      </button>
                    </div>
                    <div className="relative aspect-video rounded-xl overflow-hidden bg-dark-700 border border-dark-600">
                      {file?.type?.startsWith('video/') || sourceType === 'video' ? (
                        <video src={previewUrl} className="w-full h-full object-contain" controls />
                      ) : (
                        <img src={previewUrl} alt="原图" className="w-full h-full object-contain" />
                      )}
                    </div>
                  </div>

                  {/* 结果 */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-dark-200">处理结果</label>
                    <div className="relative aspect-video rounded-xl overflow-hidden bg-dark-700 border border-dark-600">
                      {status === 'completed' && resultUrl ? (
                        file?.type?.startsWith('video/') || sourceType === 'video' ? (
                          <video src={resultUrl} className="w-full h-full object-contain" controls />
                        ) : (
                          <img src={resultUrl} alt="结果" className="w-full h-full object-contain" />
                        )
                      ) : status === 'processing' ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                          <Loader2 className="w-8 h-8 text-primary-400 animate-spin" />
                          <div className="text-center">
                            <p className="text-sm text-white">处理中...</p>
                            <p className="text-xs text-dark-400 mt-1">{progress}%</p>
                          </div>
                          <div className="w-48 h-1.5 bg-dark-600 rounded-full overflow-hidden">
                            <motion.div
                              className="h-full bg-gradient-to-r from-cyan-500 to-blue-500"
                              initial={{ width: 0 }}
                              animate={{ width: `${progress}%` }}
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                          <Droplets className="w-8 h-8 text-dark-600" />
                          <p className="text-sm text-dark-500">等待处理</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* 完成提示 */}
              {status === 'completed' && (
                <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="w-5 h-5 text-green-400" />
                    <div>
                      <p className="text-sm text-green-400 font-medium">演示处理完成！</p>
                      <p className="text-xs text-yellow-400 mt-1">这是演示结果，实际效果需要配置专用 API</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 底部按钮 */}
            <div className="p-5 border-t border-dark-600/50 flex justify-between items-center">
              <button
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl text-dark-300 hover:text-white hover:bg-dark-700 transition-colors"
              >
                关闭
              </button>
              <div className="flex gap-3">
                {status === 'completed' && resultUrl && (
                  <button
                    onClick={handleDownload}
                    className="px-5 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 text-white font-medium transition-colors flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    下载结果
                  </button>
                )}
                <button
                  onClick={handleProcess}
                  disabled={!previewUrl || isProcessing}
                  className={`px-6 py-2.5 rounded-xl font-medium transition-all flex items-center gap-2 ${
                    previewUrl && !isProcessing
                      ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg'
                      : 'bg-dark-700 text-dark-500 cursor-not-allowed'
                  }`}
                >
                  {processType === 'watermark' ? (
                    <Droplets className="w-4 h-4" />
                  ) : (
                    <Type className="w-4 h-4" />
                  )}
                  {isProcessing ? '处理中...' : processType === 'watermark' ? '开始去水印' : '开始去字幕'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}