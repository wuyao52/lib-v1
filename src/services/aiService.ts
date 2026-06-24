import { AIModelConfig, GenerationRequest, GenerationResponse } from '@/types';

// 安全地解析 JSON 响应
async function safeJsonParse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text || text.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// 验证 URL 是否有效
function isValidUrl(url: string): boolean {
  if (url.startsWith('/')) {
    return true;
  }
  try {
    new URL(url);
    return url.startsWith('http://') || url.startsWith('https://');
  } catch {
    return false;
  }
}

// 分析 fetch 错误原因
function analyzeFetchError(error: any, url: string): string {
  const message = error.message || '';

  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return `无法连接到 ${url}

可能原因：
1. 网络不通
2. CORS 跨域限制
3. API 地址错误
4. 服务不可用`;
  }

  if (message.includes('ERR_CONNECTION_REFUSED')) {
    return `连接被拒绝 ${url}，服务未运行`;
  }

  if (message.includes('timeout') || message.includes('Timeout')) {
    return '请求超时，请稍后重试';
  }

  return `连接失败: ${message}`;
}

// AI 服务基类
export class AIService {
  protected config: AIModelConfig;

  constructor(config: AIModelConfig) {
    this.config = config;
    console.log('AIService 初始化配置:', {
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      hasApiKey: !!config.apiKey,
      modelId: config.modelId,
    });
  }

  updateConfig(config: AIModelConfig) {
    this.config = config;
  }

  async generateVideo(prompt: string, settings: Record<string, any>): Promise<GenerationResponse> {
    throw new Error('请使用具体的模型服务类');
  }

  async generateImage(prompt: string, settings: Record<string, any>): Promise<GenerationResponse> {
    throw new Error('请使用具体的模型服务类');
  }

  async generate(request: GenerationRequest): Promise<GenerationResponse> {
    const { type, prompt, settings } = request;
    switch (type) {
      case 'video':
        return this.generateVideo(prompt, settings);
      case 'image':
        return this.generateImage(prompt, settings);
      default:
        return { success: false, error: `不支持的生成类型: ${type}` };
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      if (!this.config.baseUrl || !isValidUrl(this.config.baseUrl)) {
        return { success: false, message: `无效的 API 地址: "${this.config.baseUrl}"` };
      }

      if (!this.config.apiKey) {
        return { success: false, message: '请先输入 API Key' };
      }

      // 确保 baseUrl 不以 /v1 结尾（避免重复路径）
      const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');
      const url = `${baseUrl}/v1/models`;
      console.log('测试连接:', url);
      console.log('Base URL 处理:', this.config.baseUrl, '->', baseUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'X-API-Key': this.config.apiKey,
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        console.log('响应状态:', response.status);

        const data = await safeJsonParse(response);
        console.log('响应数据:', data);

        if (response.ok) {
          // 尝试多种数据格式
          let models = [];
          if (data.data?.models) {
            models = data.data.models;
          } else if (data.models) {
            models = data.models;
          } else if (Array.isArray(data.data)) {
            models = data.data;
          } else if (Array.isArray(data)) {
            models = data;
          }

          const modelCount = models.length;
          console.log('解析到的模型:', models);
          console.log('模型数量:', modelCount);

          return { success: true, message: `连接成功！可用模型 ${modelCount} 个` };
        } else {
          return {
            success: false,
            message: `连接失败: ${data.message || data.error?.message || `HTTP ${response.status}`}`
          };
        }
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        console.error('Fetch 错误:', fetchError);

        if (fetchError.name === 'AbortError') {
          return { success: false, message: '连接超时（30秒）' };
        }

        return { success: false, message: analyzeFetchError(fetchError, url) };
      }
    } catch (error: any) {
      console.error('测试连接错误:', error);
      return { success: false, message: `连接失败: ${error.message}` };
    }
  }
}

// 红鸟AI API 服务
export class SeedanceService extends AIService {

  // 获取可用模型列表
  async getAvailableModels(type?: string): Promise<any[]> {
    try {
      const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');
      const url = `${baseUrl}/v1/models`;
      console.log('获取模型列表:', url);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'X-API-Key': this.config.apiKey,
        },
      });

      if (response.ok) {
        const data = await safeJsonParse(response);
        console.log('模型列表响应:', data);
        const models = data.data?.models || [];
        console.log('可用模型:', models.map((m: any) => ({ id: m.id, name: m.name, type: m.type })));

        if (type) {
          return models.filter((m: any) => m.type === type);
        }
        return models;
      } else {
        console.warn('获取模型列表失败:', response.status);
        return [];
      }
    } catch (error) {
      console.warn('获取模型列表错误:', error);
      return [];
    }
  }

  // 创建视频任务
  async generateVideo(prompt: string, settings: Record<string, any> = {}): Promise<GenerationResponse> {
    try {
      if (!this.config.baseUrl || !isValidUrl(this.config.baseUrl)) {
        throw new Error(`无效的 API 地址: "${this.config.baseUrl}"`);
      }

      if (!this.config.apiKey) {
        throw new Error('请先配置 API Key');
      }

      // 获取可用的视频模型
      const videoModels = await this.getAvailableModels('video_generation');
      let modelId = this.config.modelId;

      if (videoModels.length > 0) {
        // 使用第一个可用的视频模型
        modelId = videoModels[0].id;
        console.log('使用视频模型:', modelId, videoModels[0].name);
      } else {
        console.log('未找到视频模型，使用配置的模型:', modelId);
      }

      // 确保 baseUrl 不以 /v1 结尾
      const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');
      const url = `${baseUrl}/v1/videos`;

      // 构建请求体 - seconds 是必需参数
      // 根据 API 文档，某些模型可能不支持太短的时长
      const secondsValue = String(settings.seconds || settings.duration || '10');
      const requestBody: any = {
        model: modelId,
        prompt: prompt,
        aspect_ratio: settings.aspect_ratio || '16:9',
        resolution: settings.resolution || '1080p',
        seconds: secondsValue,  // 使用 10 秒作为默认值
      };

      // 可选参数：参考图片
      if (settings.images && settings.images.length > 0) {
        requestBody.images = settings.images;
      }

      console.log('调用视频生成 API:', url);
      console.log('请求参数:', requestBody);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'X-API-Key': this.config.apiKey,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const data = await safeJsonParse(response);
        console.log('API 响应:', data);

        if (!response.ok) {
          throw new Error(data.message || data.error?.message || `请求失败: ${response.status}`);
        }

        // 异步任务 - 轮询结果
        if (data.id && (data.status === 'queued' || data.status === 'processing')) {
          console.log('任务已创建，taskId:', data.id);
          return await this.pollVideoResult(data.id);
        }

        // 同步返回
        const videoUrl = data.video_url || data.result?.video_url || data.url;
        return {
          success: true,
          data: { url: videoUrl, thumbnail: data.thumbnail_url, metadata: data },
        };
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('请求超时（60秒）');
        }
        throw new Error(analyzeFetchError(fetchError, url));
      }
    } catch (error: any) {
      console.error('视频生成失败:', error);
      return { success: false, error: error.message || '视频生成失败' };
    }
  }

  // 轮询视频任务
  private async pollVideoResult(taskId: string): Promise<GenerationResponse> {
    const maxAttempts = 60;
    const pollInterval = 3000;
    const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const url = `${baseUrl}/v1/videos/${taskId}`;
      console.log(`轮询视频任务 (${attempt + 1}/${maxAttempts}):`, url);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'X-API-Key': this.config.apiKey,
          },
        });

        const data = await safeJsonParse(response);
        console.log('轮询响应:', data);

        if (data.status === 'completed') {
          const videoUrl = data.video_url || data.result?.video_url || data.url;
          return {
            success: true,
            data: { url: videoUrl, thumbnail: data.thumbnail_url, metadata: data },
          };
        }

        if (data.status === 'failed') {
          throw new Error(data.error?.message || '视频生成失败');
        }

        if (data.progress !== undefined) {
          console.log(`生成进度: ${data.progress}%`);
        }
      } catch (error: any) {
        if (error.message.includes('视频生成失败')) {
          throw error;
        }
        console.warn('轮询失败:', error.message);
      }
    }

    throw new Error('视频生成超时');
  }

  // 创建图片任务
  async generateImage(prompt: string, settings: Record<string, any> = {}): Promise<GenerationResponse> {
    try {
      if (!this.config.baseUrl || !isValidUrl(this.config.baseUrl)) {
        throw new Error(`无效的 API 地址: "${this.config.baseUrl}"`);
      }

      if (!this.config.apiKey) {
        throw new Error('请先配置 API Key');
      }

      // 获取可用的图片模型
      const imageModels = await this.getAvailableModels('image_generation');
      let modelId = this.config.modelId;

      if (imageModels.length > 0) {
        modelId = imageModels[0].id;
        console.log('使用图片模型:', modelId, imageModels[0].name);
      } else {
        console.log('未找到图片模型，使用配置的模型:', modelId);
      }

      // 确保 baseUrl 不以 /v1 结尾
      const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');
      const url = `${baseUrl}/v1/images`;
      const requestBody: any = {
        model: modelId,
        prompt: prompt,
        aspect_ratio: settings.aspect_ratio || '1:1',
        resolution: settings.resolution || '720p',  // 使用 720p 作为默认值
      };

      if (settings.images && settings.images.length > 0) {
        requestBody.images = settings.images;
      }

      console.log('调用图片生成 API:', url);
      console.log('请求参数:', requestBody);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'X-API-Key': this.config.apiKey,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const data = await safeJsonParse(response);
        console.log('API 响应:', data);

        if (!response.ok) {
          throw new Error(data.message || data.error?.message || `请求失败: ${response.status}`);
        }

        // 异步任务 - 轮询结果
        if (data.id && (data.status === 'queued' || data.status === 'processing')) {
          console.log('任务已创建，taskId:', data.id);
          return await this.pollImageResult(data.id);
        }

        // 同步返回
        const imageUrl = data.url || data.images?.[0] || data.result?.image_url || data.result?.images?.[0];
        return {
          success: true,
          data: { url: imageUrl, thumbnail: imageUrl, metadata: data },
        };
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('请求超时（60秒）');
        }
        throw new Error(analyzeFetchError(fetchError, url));
      }
    } catch (error: any) {
      console.error('图片生成失败:', error);
      return { success: false, error: error.message || '图片生成失败' };
    }
  }

  // 轮询图片任务
  private async pollImageResult(taskId: string): Promise<GenerationResponse> {
    const maxAttempts = 30;
    const pollInterval = 3000;
    const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const url = `${baseUrl}/v1/images/${taskId}`;
      console.log(`轮询图片任务 (${attempt + 1}/${maxAttempts}):`, url);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'X-API-Key': this.config.apiKey,
          },
        });

        const data = await safeJsonParse(response);
        console.log('轮询响应:', data);

        if (data.status === 'completed') {
          const imageUrl = data.url || data.images?.[0] || data.result?.image_url || data.result?.images?.[0];
          return {
            success: true,
            data: { url: imageUrl, thumbnail: imageUrl, metadata: data },
          };
        }

        if (data.status === 'failed') {
          throw new Error(data.error?.message || '图片生成失败');
        }

        if (data.progress !== undefined) {
          console.log(`生成进度: ${data.progress}%`);
        }
      } catch (error: any) {
        if (error.message.includes('图片生成失败')) {
          throw error;
        }
        console.warn('轮询失败:', error.message);
      }
    }

    throw new Error('图片生成超时');
  }
}

// Google Gemini API 服务
export class GeminiService extends AIService {
  async generateVideo(prompt: string, settings: Record<string, any> = {}): Promise<GenerationResponse> {
    try {
      if (!this.config.baseUrl || !isValidUrl(this.config.baseUrl)) {
        throw new Error(`无效的 API 地址: "${this.config.baseUrl}"`);
      }

      const url = `${this.config.baseUrl}/models/${this.config.modelId || 'gemini-pro'}:generateContent`;
      console.log('调用 Gemini 视频生成 API:', url);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Generate a video: ${prompt}` }] }],
          generationConfig: settings,
        }),
      });

      const data = await safeJsonParse(response);
      console.log('API 响应:', data);

      if (!response.ok) {
        throw new Error(data.message || data.error?.message || `请求失败: ${response.status}`);
      }

      return {
        success: true,
        data: {
          url: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
          metadata: data,
        },
      };
    } catch (error: any) {
      console.error('Gemini 视频生成失败:', error);
      return { success: false, error: error.message || 'Gemini 视频生成失败' };
    }
  }

  async generateImage(prompt: string, settings: Record<string, any> = {}): Promise<GenerationResponse> {
    try {
      if (!this.config.baseUrl || !isValidUrl(this.config.baseUrl)) {
        throw new Error(`无效的 API 地址: "${this.config.baseUrl}"`);
      }

      const url = `${this.config.baseUrl}/models/${this.config.modelId || 'gemini-pro-vision'}:generateContent`;
      console.log('调用 Gemini 图片生成 API:', url);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Generate an image: ${prompt}` }] }],
          generationConfig: settings,
        }),
      });

      const data = await safeJsonParse(response);
      console.log('API 响应:', data);

      if (!response.ok) {
        throw new Error(data.message || data.error?.message || `请求失败: ${response.status}`);
      }

      return {
        success: true,
        data: {
          url: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
          metadata: data,
        },
      };
    } catch (error: any) {
      console.error('Gemini 图片生成失败:', error);
      return { success: false, error: error.message || 'Gemini 图片生成失败' };
    }
  }
}

// 创建服务实例的工厂函数
export function createAIService(config: AIModelConfig): AIService {
  if (config.id.includes('gemini') || config.provider === 'Google') {
    return new GeminiService(config);
  }
  return new SeedanceService(config);
}

export default AIService;
