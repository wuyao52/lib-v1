import { useEffect, useState } from 'react';
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
  MessageSquareText,
  Trash2,
} from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';
import { createAIService, SeedanceService } from '@/services/aiService';
import type { AIModelConfig } from '@/types';
import { apiRequest } from '@/services/apiClient';
import { describeModelDuration } from '@/services/modelDuration';

// 预设模型
const presetModels = {
  text: [
    { id: 'gpt-4o-mini', name: 'OpenAI GPT-4o mini', provider: 'OpenAI', baseUrl: 'https://api.openai.com/v1', description: '结构化文本分析' },
    { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', description: '长文本与中文剧本' },
    { id: 'custom-text', name: '自定义文本模型', provider: 'Custom', baseUrl: '', description: 'OpenAI-compatible' },
  ],
  video: [
    { id: 'sora-2', name: 'Sora2 (ToAPIs)', provider: 'ToAPIs', baseUrl: '/api/toapis', description: 'OpenAI 视频' },
    { id: 'veo-3', name: 'VEO3 (ToAPIs)', provider: 'ToAPIs', baseUrl: '/api/toapis', description: 'Google 视频' },
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

type ModelCategory = 'text' | 'video' | 'image';
type UserApiConfig = { id: string; name: string; provider: string; baseUrl: string; hasApiKey: boolean };

export default function ModelConfigPanel() {
  const { showModelConfig, toggleModelConfig, project, updateProjectSettings } = useProjectStore();
  const [activeTab, setActiveTab] = useState<ModelCategory>('text');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [copied, setCopied] = useState(false);

  // API 返回的模型列表
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [managedModels, setManagedModels] = useState<Array<AIModelConfig & { category: ModelCategory }>>([]);
  const [userApiConfigs, setUserApiConfigs] = useState<UserApiConfig[]>([]);
  const [draftApiKey, setDraftApiKey] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [savingCredentials, setSavingCredentials] = useState(false);

  useEffect(() => {
    if (!showModelConfig) return;
    void Promise.all([
      apiRequest<{ models: Array<AIModelConfig & { category: ModelCategory }> }>('/api/catalog/models')
        .then(({ models }) => setManagedModels(models.map((model) => ({ ...model, apiKey: '', parameters: {} })))).catch(() => setManagedModels([])),
      apiRequest<{ configs: UserApiConfig[] }>('/api/user-api-configs')
        .then(({ configs }) => setUserApiConfigs(configs)).catch(() => setUserApiConfigs([])),
    ]);
  }, [showModelConfig]);

  if (!project) return null;

  // 获取当前多模型配置
  const multiModel = project.settings.multiModel || {
    textModel: { id: 'custom-text', name: '自定义文本模型', provider: 'Custom', apiKey: '', baseUrl: '', modelId: '', parameters: {} },
    videoModel: { id: 'hongniao-seedance', name: '红鸟AI Seedance', provider: '红鸟AI', apiKey: '', baseUrl: '/api/hongniaoai', modelId: 'hongniao-seedance', parameters: {} },
    imageModel: { id: 'hongniao-seedance', name: '红鸟AI Seedance', provider: '红鸟AI', apiKey: '', baseUrl: '/api/hongniaoai', modelId: 'hongniao-seedance', parameters: {} },
  };

  const activeModel = activeTab === 'text'
    ? multiModel.textModel
    : activeTab === 'video' ? multiModel.videoModel : multiModel.imageModel;

  // 更新配置（独立更新当前标签对应的模型）
  const updateActiveModel = (updates: Partial<AIModelConfig>) => {
    const newMultiModel = { ...multiModel };
    // 只更新当前标签对应的模型，不互相影响
    if (activeTab === 'text') {
      newMultiModel.textModel = { ...newMultiModel.textModel, ...updates };
    } else if (activeTab === 'video') {
      newMultiModel.videoModel = { ...newMultiModel.videoModel, ...updates };
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
      apiKey: activeModel.managed ? '' : activeModel.apiKey,
      managed: false,
      credentialManaged: false,
      credentialConfigId: undefined,
    });
    setDraftBaseUrl(preset.baseUrl);
    setDraftApiKey('');
    setSelectedModelId('');
    setTestStatus('idle');
    setTestMessage('');
  };

  // 获取可用模型列表
  const fetchAvailableModels = async () => {
    if (!activeModel.apiKey && !activeModel.managed && !activeModel.credentialManaged) {
      setTestMessage('请先输入 API Key');
      return;
    }

    setIsLoadingModels(true);
    try {
      const aiService = new SeedanceService(activeModel);
      const models = await aiService.getAvailableModels(activeTab === 'text' ? undefined : activeTab === 'image' ? 'image_generation' : 'video_generation');
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

  const selectUserApiConfig = (config: UserApiConfig) => {
    updateActiveModel({
      baseUrl: config.baseUrl,
      apiKey: '',
      managed: false,
      credentialManaged: true,
      credentialConfigId: config.id,
      provider: config.provider,
    });
    setDraftApiKey('');
    setDraftBaseUrl('');
    setTestStatus('idle');
    setTestMessage('');
  };

  const savePrivateCredentials = async () => {
    setSavingCredentials(true);
    setTestStatus('testing');
    setTestMessage('正在加密保存...');
    try {
      const { config } = await apiRequest<{ config: UserApiConfig }>('/api/user-api-configs', {
        method: 'POST',
        body: JSON.stringify({
          name: `${activeModel.provider || 'Custom'} API`,
          provider: activeModel.provider || 'Custom',
          baseUrl: draftBaseUrl || activeModel.baseUrl,
          apiKey: draftApiKey,
        }),
      });
      setUserApiConfigs((items) => [...items, config]);
      selectUserApiConfig(config);
      setTestStatus('success');
      setTestMessage('凭据已加密保存，浏览器中的 API Key 已清除');
    } catch (error: any) {
      setTestStatus('error');
      setTestMessage(error.message || '保存失败');
    } finally {
      setSavingCredentials(false);
    }
  };

  const deleteUserApiConfig = async (config: UserApiConfig) => {
    await apiRequest(`/api/user-api-configs/${config.id}`, { method: 'DELETE' });
    setUserApiConfigs((items) => items.filter((item) => item.id !== config.id));
    if (activeModel.credentialConfigId === config.id) {
      updateActiveModel({ baseUrl: '', apiKey: '', credentialManaged: false, credentialConfigId: undefined });
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
      await navigator.clipboard.writeText(draftApiKey);
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
    { id: 'text' as ModelCategory, label: '文本分析', icon: <MessageSquareText className="w-4 h-4" /> },
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
              <button aria-label="关闭 AI 模型配置" onClick={toggleModelConfig} className="p-2 hover:bg-dark-700 rounded-lg transition-colors">
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
                    setDraftApiKey('');
                    setDraftBaseUrl('');
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
              {managedModels.some((model) => model.category === activeTab) && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-dark-300">系统模型</label>
                  <div className="space-y-2">
                    {managedModels.filter((model) => model.category === activeTab).map((model) => (
                      <button key={model.id} onClick={() => updateActiveModel({ ...model, apiKey: '', managed: true, credentialManaged: false, credentialConfigId: undefined })} className={`w-full p-3 rounded-lg border text-left ${activeModel.managed && activeModel.id === model.id ? 'border-green-500 bg-green-500/10' : 'border-dark-600 bg-dark-700 hover:border-dark-400'}`}>
                        <div className="flex items-center justify-between gap-3"><span className="text-sm text-white">{model.name}</span><span className="text-xs text-green-400">¥{((model.unitPriceCents || 0) / 100).toFixed(2)} / {model.billingUnit === 'second' ? '秒' : model.billingUnit === 'image' ? '张' : '次'}</span></div>
                        <div className="text-[10px] text-dark-400 mt-1">{model.provider} · 密钥由系统安全托管</div>
                        {model.category === 'video' && <div className="mt-1 text-[10px] text-primary-300">{describeModelDuration(model)}</div>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {userApiConfigs.length > 0 && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-dark-300">我的加密 API</label>
                  <div className="space-y-2">
                    {userApiConfigs.map((config) => (
                      <div key={config.id} className={`flex items-center gap-2 border p-2 ${activeModel.credentialConfigId === config.id ? 'border-primary-500 bg-primary-500/10' : 'border-dark-600 bg-dark-700'}`}>
                        <button className="min-w-0 flex-1 text-left" onClick={() => selectUserApiConfig(config)}>
                          <span className="block truncate text-xs text-white">{config.name}</span>
                          <span className="block truncate text-[10px] text-dark-400">{config.provider} · 密钥已托管</span>
                        </button>
                        <button title="删除私有 API" className="p-1.5 text-red-400" onClick={() => void deleteUserApiConfig(config)}><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
              {!activeModel.managed && !activeModel.credentialManaged && <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300 flex items-center gap-2">
                  <Key className="w-3 h-3 text-primary-400" />
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={draftApiKey}
                    onChange={(e) => setDraftApiKey(e.target.value)}
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
              </div>}

              {/* API 地址 */}
              {activeModel.managed ? (
                <div className="space-y-1 p-3 rounded-lg border border-green-500/30 bg-green-500/5 text-sm text-green-300"><p>系统模型已启用。API 地址和 API Key 由服务端安全托管，当前用户不可查看、复制或修改。</p>{activeTab === 'video' && <p className="text-xs text-primary-300">{describeModelDuration(activeModel)}</p>}</div>
              ) : activeModel.credentialManaged ? (
                <div className="space-y-1 border border-primary-500/30 bg-primary-500/5 p-3 text-sm text-primary-300">
                  <p>自定义 API 凭据已加密托管，项目只保存配置 ID 和代理地址。</p>
                  <p className="text-xs text-dark-400">API Key 与真实根地址不会返回浏览器。</p>
                </div>
              ) : <div className="space-y-2">
                <label className="text-xs font-medium text-dark-300 flex items-center gap-2">
                  <Globe className="w-3 h-3 text-primary-400" />
                  API 地址
                </label>
                <input
                  type="text"
                  value={draftBaseUrl || activeModel.baseUrl}
                  onChange={(e) => setDraftBaseUrl(e.target.value)}
                  placeholder="https://api.example.com"
                  className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-white text-sm focus:outline-none focus:border-primary-500"
                />
              </div>}

              {!activeModel.managed && !activeModel.credentialManaged && (
                <button
                  onClick={savePrivateCredentials}
                  disabled={savingCredentials || !draftApiKey || !(draftBaseUrl || activeModel.baseUrl)}
                  className="w-full bg-primary-600 py-2.5 text-sm font-medium text-white disabled:bg-dark-700 disabled:text-dark-500"
                >
                  {savingCredentials ? '正在加密保存...' : '加密保存并使用'}
                </button>
              )}

              {activeTab === 'video' && !activeModel.managed && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-dark-300 flex items-center gap-2">
                    <Video className="w-3 h-3 text-primary-400" />
                    视频分辨率
                  </label>
                  <select
                    data-testid="video-resolution"
                    value={String(activeModel.parameters?.resolution || '')}
                    onChange={(event) => {
                      const resolution = event.target.value;
                      const parameters = { ...(activeModel.parameters || {}) };
                      if (resolution) parameters.resolution = resolution;
                      else delete parameters.resolution;
                      updateActiveModel({
                        parameters,
                      });
                    }}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-white text-sm focus:outline-none focus:border-primary-500"
                  >
                    <option value="">服务默认</option>
                    <option value="480p">480p</option>
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                  </select>
                  <p className="text-[10px] text-dark-400">请按服务商的模型计费表选择。Seedance 2.0 Mini 未选择时会自动使用 720p，避免发送不支持的 1080p。</p>
                </div>
              )}

              {/* 测试连接 */}
              <button
                onClick={handleTestConnection}
                disabled={testStatus === 'testing' || (!activeModel.apiKey && !activeModel.managed && !activeModel.credentialManaged)}
                className={`w-full py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                  (!activeModel.apiKey && !activeModel.managed && !activeModel.credentialManaged)
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
