import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Cpu,
  Key,
  Globe,
  Settings,
  TestTube,
  CheckCircle,
  Video,
  Image,
  Eye,
  EyeOff,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';
import { createAIService, SeedanceService } from '@/services/aiService';
import type { AIModelConfig } from '@/types';

// 预设模型
const presetModels = {
  video: [
    { id: 'sora-2', name: 'Sora2 (ToAPIs)', provider: 'ToAPIs', baseUrl: '/api/toapis', description: 'OpenAI 视频' },
    { id: 'veo-3', name: 'VEO3 (ToAPIs)', provider: 'ToAPIs', baseUrl: '/api/toapis', description: 'Google 视频' },
    { id: 'hongniao-seedance', name: '红鸟AI Seedance', provider: '红鸟AI', baseUrl: '/api/hongniaoai', description: '🔥 推荐' },
    { id: 'wuhen-ai', name: '无痕AI', provider: '无痕AI', baseUrl: '/api/wuhenai', description: '去水印/消除' },
    { id: 'seedance-2.0', name: 'Seedance 2.0', provider: 'Seedance', baseUrl: '/api/seedance', description: 'Seedance 官方' },
    { id: 'seedream', name: 'Seedream', provider: 'Seedream', baseUrl: 'https://api.seedream.com', description: '创意视频' },
    { id: 'gemini-video', name: 'Gemini Video', provider: 'Google', baseUrl: 'https://generativelanguage.googleapis.com', description: 'Google 视频' },
    { id: 'runway-gen-3', name: 'Runway Gen-3', provider: 'Runway', baseUrl: 'https://api.runway.com', description: '专业级' },
    { id: 'kling', name: 'Kling', provider: 'Kuaishou', baseUrl: 'https://api.kling.com', description: '快手' },
    { id: 'pika-labs', name: 'Pika Labs', provider: 'Pika', baseUrl: 'https://api.pika.art', description: '快速生成' },
    { id: 'custom', name: '自定义模型', provider: 'Custom', baseUrl: '', description: '自定义' },
  ],
  image: [
    { id: 'gpt-4o-image', name: 'GPT-4o Image (ToAPIs)', provider: 'ToAPIs', baseUrl: '/api/toapis', description: 'OpenAI 图片' },
    { id: 'gemini-2.5-flash-image', name: 'Gemini Image (ToAPIs)', provider: 'ToAPIs', baseUrl: '/api/toapis', description: 'Google 图片' },
    { id: 'hongniao-seedance', name: '红鸟AI Seedance', provider: '红鸟AI', baseUrl: '/api/hongniaoai', description: '🔥 推荐' },
    { id: 'wuhen-ai', name: '无痕AI', provider: '无痕AI', baseUrl: '/api/wuhenai', description: '去水印/消除' },
    { id: 'seedance-2.0', name: 'Seedance 2.0', provider: 'Seedance', baseUrl: '/api/seedance', description: 'Seedance 官方' },
    { id: 'seedream', name: 'Seedream', provider: 'Seedream', baseUrl: 'https://api.seedream.com', description: '创意图片' },
    { id: 'gemini-image', name: 'Gemini Image', provider: 'Google', baseUrl: 'https://generativelanguage.googleapis.com', description: 'Google 图片' },
    { id: 'imagen-3', name: 'Imagen 3', provider: 'Google', baseUrl: 'https://generativelanguage.googleapis.com', description: 'Google 最新' },
    { id: 'midjourney', name: 'Midjourney', provider: 'Midjourney', baseUrl: 'https://api.midjourney.com', description: '艺术风格' },
    { id: 'stable-diffusion', name: 'Stable Diffusion', provider: 'Stability', baseUrl: 'https://api.stability.ai', description: '开源' },
    { id: 'custom', name: '自定义模型', provider: 'Custom', baseUrl: '', description: '自定义' },
  ],
};

type ModelCategory = 'video' | 'image';

export default function ModelConfigPanel() {
  const { showModelConfig, toggleModelConfig, project, updateProjectSettings } = useProjectStore();
  const [activeTab, setActiveTab] = useState<ModelCategory>('video');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [copied, setCopied] = useState(false);

  // API 返回的模型列表
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  if (!project) return null;

  // 获取当前多模型配置
  const multiModel = project.settings.multiModel || {
    textModel: { id: 'hongniao-seedance', name: '红鸟AI Seedance', provider: '红鸟AI', apiKey: '', baseUrl: '/api/hongniaoai', modelId: 'hongniao-seedance', parameters: {} },
    videoModel: { id: 'hongniao-seedance', name: '红鸟AI Seedance', provider: '红鸟AI', apiKey: '', baseUrl: '/api/hongniaoai', modelId: 'hongniao-seedance', parameters: {} },
    imageModel: { id: 'hongniao-seedance', name: '红鸟AI Seedance', provider: '红鸟AI', apiKey: '', baseUrl: '/api/hongniaoai', modelId: 'hongniao-seedance', parameters: {} },
  };

  const activeModel = activeTab === 'video' ? multiModel.videoModel : multiModel.imageModel;

  // 更新配置（独立更新当前标签对应的模型）
  const updateActiveModel = (updates: Partial<AIModelConfig>) => {
    const newMultiModel = { ...multiModel };
    // 只更新当前标签对应的模型，不互相影响
    if (activeTab === 'video') {
      newMultiModel.videoModel = { ...newMultiModel.videoModel, ...updates };
      newMultiModel.textModel = { ...newMultiModel.textModel, ...updates };
    } else {
      newMultiModel.imageModel = { ...newMultiModel.imageModel, ...updates };
    }
    updateProjectSettings({ multiModel: newMultiModel });
  };

  // 选择预设模型
  const handleSelectPreset = (preset: { id: string; name: string; provider: string; baseUrl: string }) => {
    updateActiveModel({
      id: preset.id,
      name: preset.name,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      modelId: preset.id,
    });
    setSelectedModelId('');
    setTestStatus('idle');
    setTestMessage('');
  };

  // 获取可用模型列表
  const fetchAvailableModels = async () => {
    if (!activeModel.apiKey) {
      setTestMessage('请先输入 API Key');
      return;
    }

    setIsLoadingModels(true);
    try {
      const aiService = new SeedanceService(activeModel);
      const models = await aiService.getAvailableModels(activeTab === 'video' ? 'video_generation' : 'image_generation');
      setAvailableModels(models);
      if (models.length > 0) {
        setSelectedModelId(models[0].id);
      }
    } catch (error: any) {
      console.error('获取模型列表失败:', error);
    } finally {
      setIsLoadingModels(false);
    }
  };

  // 选择 API 返回的模型
  const handleSelectApiModel = (modelId: string) => {
    setSelectedModelId(modelId);
    const model = availableModels.find(m => m.id === modelId);
    if (model) {
      updateActiveModel({
        modelId: model.id,
        name: model.name || model.id,
      });
    }
  };

  // 复制 API Key
  const handleCopyApiKey = async () => {
    try {
      await navigator.clipboard.writeText(activeModel.apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  // 测试连接
  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMessage('正在测试连接...');

    try {
      const aiService = createAIService(activeModel);
      const result = await aiService.testConnection();

      if (result.success) {
        setTestStatus('success');
        setTestMessage(result.message);
        // 自动获取模型列表
        await fetchAvailableModels();
      } else {
        setTestStatus('error');
        setTestMessage(result.message);
      }
    } catch (error: any) {
      setTestStatus('error');
      setTestMessage(error.message || '连接测试失败');
    }
  };

  const tabs = [
    { id: 'video' as ModelCategory, label: '视频生成', icon: <Video className="w-4 h-4" /> },
    { id: 'image' as ModelCategory, label: '图片生成', icon: <Image className="w-4 h-4" /> },
  ];

  return (
    <AnimatePresence>
      {showModelConfig && (
        <motion.div
          initial={{ x: 300, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 300, opacity: 0 }}
          className="absolute right-0 top-0 bottom-0 w-96 z-50"
        >
          <div className="h-full bg-dark-800/95 backdrop-blur-xl border-l border-dark-600/50 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-dark-600/50">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Cpu className="w-5 h-5 text-primary-400" />
                AI 模型配置
              </h2>
              <button onClick={toggleModelConfig} className="p-2 hover:bg-dark-700 rounded-lg transition-colors">
                <X className="w-4 h-4 text-dark-400" />
              </button>
            </div>

            {/* 标签页 */}
            <div className="flex border-b border-dark-600/50">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setTestStatus('idle');
                    setTestMessage('');
                    setAvailableModels([]);
                    setSelectedModelId('');
                  }}
                  className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors
                    ${activeTab === tab.id
                      ? 'text-primary-400 border-b-2 border-primary-400 bg-primary-400/5'
                      : 'text-dark-400 hover:text-dark-200'
                    }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 p-4 space-y-4 overflow-y-auto">
              {/* 预设模型 */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300">预设模型</label>
                <div className="grid grid-cols-2 gap-2">
                  {presetModels[activeTab].map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => handleSelectPreset(preset)}
                      className={`p-2 rounded-lg text-left text-xs transition-all ${
                        activeModel.id === preset.id
                          ? 'bg-primary-600/20 border border-primary-500 text-white'
                          : 'bg-dark-700 border border-dark-600 text-dark-300 hover:border-dark-400'
                      }`}
                    >
                      <div className="font-medium truncate">{preset.name}</div>
                      <div className="text-[10px] text-dark-500 mt-0.5">{preset.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* API Key */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300 flex items-center gap-2">
                  <Key className="w-3 h-3 text-primary-400" />
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={activeModel.apiKey}
                    onChange={(e) => updateActiveModel({ apiKey: e.target.value })}
                    placeholder="输入你的 API Key"
                    className="w-full px-3 py-2 pr-16 bg-dark-700 border border-dark-600 rounded-lg text-white text-sm focus:outline-none focus:border-primary-500"
                  />
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                    <button onClick={() => setShowApiKey(!showApiKey)} className="p-1.5 text-dark-400 hover:text-white">
                      {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={handleCopyApiKey} className="p-1.5 text-dark-400 hover:text-white">
                      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>

              {/* API 地址 */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300 flex items-center gap-2">
                  <Globe className="w-3 h-3 text-primary-400" />
                  API 地址
                </label>
                <input
                  type="text"
                  value={activeModel.baseUrl}
                  onChange={(e) => updateActiveModel({ baseUrl: e.target.value })}
                  placeholder="https://api.example.com"
                  className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-white text-sm focus:outline-none focus:border-primary-500"
                />
              </div>

              {/* 测试连接 */}
              <button
                onClick={handleTestConnection}
                disabled={testStatus === 'testing' || !activeModel.apiKey}
                className={`w-full py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                  !activeModel.apiKey
                    ? 'bg-dark-700 text-dark-500 cursor-not-allowed'
                    : testStatus === 'success'
                    ? 'bg-green-600 text-white'
                    : testStatus === 'error'
                    ? 'bg-red-600 text-white'
                    : 'bg-dark-700 text-dark-200 hover:bg-dark-600'
                }`}
              >
                <TestTube className="w-4 h-4" />
                {testStatus === 'testing' ? '测试中...' : testStatus === 'success' ? '连接成功' : '测试连接'}
              </button>

              {/* 测试结果 */}
              {testMessage && (
                <div className={`p-3 rounded-lg text-xs ${
                  testStatus === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                  : testStatus === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                  : 'bg-dark-700 text-dark-400'
                }`}>
                  <pre className="whitespace-pre-wrap font-sans">{testMessage}</pre>
                </div>
              )}

              {/* API 返回的模型列表 */}
              {availableModels.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-dark-300">
                      可用模型 ({availableModels.length})
                    </label>
                    <button onClick={fetchAvailableModels} className="p-1 text-dark-400 hover:text-white">
                      <RefreshCw className={`w-3 h-3 ${isLoadingModels ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1 bg-dark-900/50 rounded-lg p-2">
                    {availableModels.map((model) => (
                      <button
                        key={model.id}
                        onClick={() => handleSelectApiModel(model.id)}
                        className={`w-full px-3 py-2 rounded-lg text-xs text-left transition-all flex items-center justify-between ${
                          selectedModelId === model.id || activeModel.modelId === model.id
                            ? 'bg-primary-600/20 border border-primary-500 text-white'
                            : 'bg-dark-700 border border-dark-600 text-dark-300 hover:border-dark-400'
                        }`}
                      >
                        <div>
                          <div className="font-medium">{model.name || model.id}</div>
                          {model.type && (
                            <div className="text-[10px] text-dark-500 mt-0.5">{model.type}</div>
                          )}
                        </div>
                        {(selectedModelId === model.id || activeModel.modelId === model.id) && (
                          <CheckCircle className="w-4 h-4 text-primary-400" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Model ID */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300 flex items-center gap-2">
                  <Settings className="w-3 h-3 text-primary-400" />
                  当前模型 ID
                </label>
                <input
                  type="text"
                  value={activeModel.modelId}
                  onChange={(e) => updateActiveModel({ modelId: e.target.value })}
                  placeholder="模型标识符"
                  className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-white text-sm focus:outline-none focus:border-primary-500"
                />
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}