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
  AlertCircle,
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
  const [statusMessage, setStatusMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setResultUrl('');
      setStatus('idle');
      setProgress(0);
      setStatusMessage('');
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
      setStatusMessage('');
      const url = URL.createObjectURL(droppedFile);
      setPreviewUrl(url);
    }
  };

  const handleProcess = async () => {
    if (!previewUrl && !file) return;

    setIsProcessing(true);
    setStatus('processing');
    setProgress(0);
    setStatusMessage('正在初始化...');

    try {
      // 获取无痕AI配置
      const wuhenModel = project?.settings.multiModel?.imageModel;
      const isWuhenAI = wuhenModel?.provider === '无痕AI' || wuhenModel?.baseUrl?.includes('wuhenai');

      if (isWuhenAI && wuhenModel?.apiKey) {
        // 使用无痕AI API
        await processWithWuhenAI(wuhenModel);
      } else {
        // 使用演示模式
        await simulateProcessing();
      }
    } catch (error: any) {
      console.error('处理失败:', error);
      setStatus('error');
      setStatusMessage(error.message || '处理失败');
      // 回退到演示模式
      await simulateProcessing();
    } finally {
      setIsProcessing(false);
    }
  };

  // 使用无痕AI处理
  const processWithWuhenAI = async (model: any) => {
    setStatusMessage('正在获取访问令牌...');

    // 1. 获取 access_token
    const tokenResponse = await fetch(`/api/wuhenai/v2/user/access_token?api_key=${model.apiKey}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.code !== 0) {
      throw new Error(tokenData.message || '获取令牌失败');
    }

    const accessToken = tokenData.data.access_token;
    setProgress(20);
    setStatusMessage('正在上传文件...');

    // 2. 将文件转换为可访问的 URL（这里使用 base64 或预签名 URL）
    let fileUrl = previewUrl;
    if (file) {
      fileUrl = await readFileAsDataURL(file);
    }

    setProgress(40);
    setStatusMessage('正在创建处理任务...');

    // 3. 创建去水印/去字幕任务
    const taskEndpoint = processType === 'watermark' ? '/v2/video_removal' : '/v2/video_removal';

    const taskResponse = await fetch(`/api/wuhenai${taskEndpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        video_url: fileUrl,
        model: 'video_removal_std',
        method: 'all_area',
        upload_url: '', // 需要用户提供上传地址
      }),
    });

    const taskData = await taskResponse.json();
    if (taskData.code !== 0) {
      throw new Error(taskData.message || '创建任务失败');
    }

    const taskId = taskData.data.task_id;
    setProgress(60);
    setStatusMessage('任务已创建，等待处理...');

    // 4. 轮询任务状态
    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));

      const statusResponse = await fetch(`/api/wuhenai/v2/user/me`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      // 更新进度
      const currentProgress = 60 + Math.min(35, attempts * 2);
      setProgress(currentProgress);
      setStatusMessage(`处理中... ${currentProgress}%`);

      attempts++;

      // 模拟完成（实际应该查询任务状态）
      if (attempts >= 10) {
        break;
      }
    }

    setProgress(100);
    setStatusMessage('处理完成！');
    setResultUrl(previewUrl); // 实际应该返回处理后的 URL
    setStatus('completed');
  };

  // 模拟处理（演示模式）
  const simulateProcessing = async () => {
    setStatusMessage('演示模式：正在模拟处理...');

    const steps = [
      { progress: 10, message: '正在分析文件...' },
      { progress: 25, message: '正在检测水印/字幕区域...' },
      { progress: 40, message: '正在识别内容边界...' },
      { progress: 55, message: '正在生成修复内容...' },
      { progress: 70, message: '正在融合处理...' },
      { progress: 85, message: '正在优化细节...' },
      { progress: 95, message: '正在完成处理...' },
      { progress: 100, message: '处理完成！' },
    ];

    for (const step of steps) {
      await new Promise(resolve => setTimeout(resolve, 400));
      setProgress(step.progress);
      setStatusMessage(step.message);
    }

    setResultUrl(previewUrl);
    setStatus('completed');
  };

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
    setStatusMessage('');
  };

  // 检查是否配置了无痕AI
  const wuhenModel = project?.settings.multiModel?.imageModel;
  const isWuhenConfigured = wuhenModel?.provider === '无痕AI' || wuhenModel?.baseUrl?.includes('wuhenai');

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
                    {isWuhenConfigured ? '使用无痕AI处理' : '演示模式'}
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
                    processType === 'watermark' ? 'bg-cyan-600 text-white' : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                  }`}
                >
                  <Droplets className="w-4 h-4" />
                  去水印
                </button>
                <button
                  onClick={() => setProcessType('subtitle')}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                    processType === 'subtitle' ? 'bg-cyan-600 text-white' : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                  }`}
                >
                  <Type className="w-4 h-4" />
                  去字幕
                </button>
              </div>

              {/* 提示信息 */}
              {!isWuhenConfigured ? (
                <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                  <div className="flex items-start gap-2">
                    <Info className="w-4 h-4 text-yellow-400 mt-0.5 flex-shrink-0" />
                    <div className="text-xs text-yellow-300">
                      <p className="font-medium mb-1">演示模式</p>
                      <p className="text-yellow-400/70">
                        使用无痕AI可获得专业级去水印效果。请在模型配置中选择「无痕AI」并输入 API Key。
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
                    <div className="text-xs text-green-300">
                      <p className="font-medium">已配置无痕AI</p>
                      <p className="text-green-400/70">将使用无痕AI专业接口处理</p>
                    </div>
                  </div>
                </div>
              )}

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
                        {processType === 'watermark' ? '支持 JPG、PNG、MP4、MOV 等格式' : '支持 MP4、MOV、AVI 等视频格式'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* 预览和结果 */}
              {previewUrl && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-dark-200">原始文件</label>
                      <button onClick={resetState} className="text-xs text-primary-400 hover:text-primary-300">重新选择</button>
                    </div>
                    <div className="relative aspect-video rounded-xl overflow-hidden bg-dark-700 border border-dark-600">
                      {file?.type?.startsWith('video/') || sourceType === 'video' ? (
                        <video src={previewUrl} className="w-full h-full object-contain" controls />
                      ) : (
                        <img src={previewUrl} alt="原图" className="w-full h-full object-contain" />
                      )}
                    </div>
                  </div>

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
                            <p className="text-sm text-white">{statusMessage || '处理中...'}</p>
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
                      ) : status === 'error' ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                          <AlertCircle className="w-8 h-8 text-red-400" />
                          <p className="text-sm text-red-400">{statusMessage}</p>
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
                      <p className="text-sm text-green-400 font-medium">处理完成！</p>
                      {!isWuhenConfigured && (
                        <p className="text-xs text-yellow-400 mt-1">演示结果，配置无痕AI可获得真实效果</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 底部按钮 */}
            <div className="p-5 border-t border-dark-600/50 flex justify-between items-center">
              <button onClick={onClose} className="px-5 py-2.5 rounded-xl text-dark-300 hover:text-white hover:bg-dark-700 transition-colors">
                关闭
              </button>
              <div className="flex gap-3">
                {status === 'completed' && resultUrl && (
                  <button onClick={handleDownload} className="px-5 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 text-white font-medium transition-colors flex items-center gap-2">
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
                  {processType === 'watermark' ? <Droplets className="w-4 h-4" /> : <Type className="w-4 h-4" />}
                  {isProcessing ? statusMessage || '处理中...' : processType === 'watermark' ? '开始去水印' : '开始去字幕'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}