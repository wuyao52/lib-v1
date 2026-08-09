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

function isUserCancellation(error: any, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || error?.name === 'AbortError');
}

function userCancellationError(): DOMException {
  return new DOMException('用户取消生成', 'AbortError');
}

function dataUrlBytes(value: string): number {
  const payload = value.slice(value.indexOf(',') + 1);
  return Math.ceil(payload.length * 0.75);
}

async function compressReferenceImage(value: string): Promise<string> {
  if (!value.startsWith('data:image/') || dataUrlBytes(value) <= 350 * 1024) return value;
  const image = new window.Image();
  image.src = value;
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('参考图读取失败')); });
  const scale = Math.min(1, 960 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法压缩参考图');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let compressed = canvas.toDataURL('image/jpeg', 0.78);
  for (let quality = 0.65; dataUrlBytes(compressed) > 350 * 1024 && quality >= 0.35; quality -= 0.15) compressed = canvas.toDataURL('image/jpeg', quality);
  if (dataUrlBytes(compressed) > 600 * 1024) throw new Error('参考图压缩后仍然过大，请使用尺寸更小的图片');
  return compressed;
}

async function prepareReferenceImages(images: unknown): Promise<string[]> {
  if (!Array.isArray(images)) return [];
  const prepared: string[] = [];
  for (const value of images.slice(0, 4)) {
    if (typeof value === 'string' && value.trim()) prepared.push(await compressReferenceImage(value.trim()));
  }
  return prepared;
}

function providerErrorMessage(data: any): string | null {
  if (data?.success === false) return String(data.message || data.msg || data.error?.message || data.error || '服务商返回失败');
  if (data?.code !== undefined && !['0', '200', '20000', 'SUCCESS'].includes(String(data.code).toUpperCase())) {
    return String(data.message || data.msg || data.error?.message || data.error || `服务商错误码 ${data.code}`);
  }
  return null;
}

function resolveVideoResolution(modelId: string, requested: unknown): string {
  const modelResolution = modelId.match(/(?:^|[-_])(480|720|1080)p(?:$|[-_])/i)?.[1];
  return modelResolution ? `${modelResolution}p` : String(requested || '1080p');
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

  async generateVideo(prompt: string, settings: Record<string, any>, signal?: AbortSignal): Promise<GenerationResponse> {
    throw new Error('请使用具体的模型服务类');
  }

  async generateImage(prompt: string, settings: Record<string, any>, signal?: AbortSignal): Promise<GenerationResponse> {
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

      if (!this.config.apiKey && !this.config.managed) {
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
          console.log('解析响应数据:', JSON.stringify(data, null, 2));

          if (data.data?.models) {
            models = data.data.models;
            console.log('使用 data.data.models 格式');
          } else if (data.models) {
            models = data.models;
            console.log('使用 data.models 格式');
          } else if (Array.isArray(data.data)) {
            models = data.data;
            console.log('使用 data.data 数组格式');
          } else if (Array.isArray(data)) {
            models = data;
            console.log('使用 data 数组格式');
          } else if (data.data?.data) {
            models = data.data.data;
            console.log('使用 data.data.data 格式');
          } else if (data.items) {
            models = data.items;
            console.log('使用 data.items 格式');
          } else {
            console.log('未识别的数据格式，完整响应:', data);
            // 如果没有找到模型列表，返回成功但模型数为 0
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
        const models = data.data?.models || data.models || (Array.isArray(data.data) ? data.data : []);
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
  async generateVideo(prompt: string, settings: Record<string, any> = {}, signal?: AbortSignal): Promise<GenerationResponse> {
    try {
      if (!this.config.baseUrl || !isValidUrl(this.config.baseUrl)) {
        throw new Error(`无效的 API 地址: "${this.config.baseUrl}"`);
      }

      if (!this.config.apiKey && !this.config.managed) {
        throw new Error('请先配置 API Key');
      }

      let modelId = this.config.modelId;
      if (!modelId) throw new Error('请先选择视频模型');

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
        resolution: resolveVideoResolution(modelId, settings.resolution),
        seconds: secondsValue,  // 使用 10 秒作为默认值
      };

      // 可选参数：参考图片
      const preparedImages = await prepareReferenceImages(settings.images);
      if (preparedImages.length > 0) requestBody.images = preparedImages;

      console.log('调用视频生成 API:', url);
      console.log('请求参数摘要:', { ...requestBody, images: preparedImages.map((image) => ({ kind: image.startsWith('data:') ? 'data-url' : 'url', bytes: image.startsWith('data:') ? dataUrlBytes(image) : undefined })) });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      const abortFromCaller = () => controller.abort();
      signal?.addEventListener('abort', abortFromCaller, { once: true });

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

        const businessError = providerErrorMessage(data);
        if (!response.ok || businessError) throw new Error(businessError || data.message || data.msg || data.error?.message || `请求失败: ${response.status}`);

        const payload = data.data && typeof data.data === 'object' ? data.data : data;
        const taskId = payload.id || payload.task_id || payload.taskId || data.id;
        const taskStatus = payload.status || payload.state || data.status;

        // 异步任务 - 轮询结果
        if (taskId && (!taskStatus || ['queued', 'pending', 'processing', 'running'].includes(String(taskStatus).toLowerCase()))) {
          console.log('任务已创建，taskId:', taskId);
          return await this.pollVideoResult(String(taskId), signal);
        }

        // 同步返回
        const videoUrl = payload.video_url || payload.url || data.video_url || data.result?.video_url || data.url;
        if (!videoUrl) throw new Error('服务商未返回视频地址或可轮询的任务 ID');
        return {
          success: true,
          data: { url: videoUrl, thumbnail: payload.thumbnail_url || data.thumbnail_url, metadata: data },
        };
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          if (signal?.aborted) throw userCancellationError();
          throw new Error('请求超时（60秒）');
        }
        throw new Error(analyzeFetchError(fetchError, url));
      } finally {
        signal?.removeEventListener('abort', abortFromCaller);
      }
    } catch (error: any) {
      if (isUserCancellation(error, signal)) {
        return { success: false, error: '用户取消生成' };
      }
      console.error('视频生成失败:', error);
      return { success: false, error: error.message || '视频生成失败' };
    }
  }

  // 轮询视频任务
  private async pollVideoResult(taskId: string, signal?: AbortSignal): Promise<GenerationResponse> {
    const maxAttempts = 90; // 增加到 90 次（约 4.5 分钟）
    const pollInterval = 3000;
    const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');

    console.log('开始轮询视频任务:', taskId);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw new DOMException('用户取消生成', 'AbortError');
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
          signal,
        });

        const data = await safeJsonParse(response);
        const businessError = providerErrorMessage(data);
        if (!response.ok || businessError) {
          const providerError = new Error(businessError || data.message || data.msg || data.error?.message || `轮询失败: ${response.status}`);
          providerError.name = 'ProviderError';
          throw providerError;
        }
        const payload = data.data && typeof data.data === 'object' ? data.data : data;
        console.log('轮询响应摘要:', { code: data.code, status: payload.status || payload.state, progress: payload.progress || payload.percent });

        // 检查任务状态
        const status = payload.status || payload.state || data.status || data.state;
        console.log('任务状态:', status);

        if (status === 'completed' || status === 'success') {
          // 尝试所有可能的视频 URL 字段
          const videoUrl = payload.video_url ||
                          payload.url ||
                          data.result?.video_url ||
                          data.output?.video_url ||
                          data.data?.video_url ||
                          data.data?.url ||
                          data.url ||
                          data.result?.url ||
                          data.output?.url;

          console.log('找到视频 URL:', videoUrl);

          if (videoUrl) {
            return {
              success: true,
              data: {
                url: videoUrl,
                thumbnail: payload.thumbnail_url || data.thumbnail_url || data.result?.thumbnail_url,
                metadata: data,
              },
            };
          } else {
            // 如果没有找到 URL，返回完整响应供调试
            console.warn('完成但未找到视频 URL，完整响应:', data);
            throw new Error('视频生成完成但未返回视频 URL');
          }
        }

        if (status === 'failed' || status === 'error') {
          const errorMsg = data.error?.message || data.message || data.error || '视频生成失败';
          throw new Error(errorMsg);
        }

        // 更新进度
        const progress = payload.progress || payload.percent || data.progress || data.percent || 0;
        if (progress > 0) {
          console.log(`生成进度: ${progress}%`);
        }
      } catch (error: any) {
        if (isUserCancellation(error, signal)) throw userCancellationError();
        if (error.name === 'ProviderError') throw error;
        if (error.message.includes('视频生成失败') || error.message.includes('未返回视频 URL')) {
          throw error;
        }
        console.warn('轮询请求失败:', error.message);
      }
    }

    throw new Error('视频生成超时（约 4.5 分钟）');
  }

  // 创建图片任务
  async generateImage(prompt: string, settings: Record<string, any> = {}, signal?: AbortSignal): Promise<GenerationResponse> {
    try {
      if (!this.config.baseUrl || !isValidUrl(this.config.baseUrl)) {
        throw new Error(`无效的 API 地址: "${this.config.baseUrl}"`);
      }

      if (!this.config.apiKey && !this.config.managed) {
        throw new Error('请先配置 API Key');
      }

      let modelId = this.config.modelId;
      if (!modelId) throw new Error('请先选择图片模型');

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
      } else if (settings.init_image) {
        requestBody.images = [settings.init_image];
      }
      if (settings.strength !== undefined) requestBody.strength = settings.strength;
      if (settings.negative_prompt) requestBody.negative_prompt = settings.negative_prompt;

      console.log('调用图片生成 API:', url);
      console.log('请求参数:', requestBody);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      const abortFromCaller = () => controller.abort();
      signal?.addEventListener('abort', abortFromCaller, { once: true });

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
          return await this.pollImageResult(data.id, signal);
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
          if (signal?.aborted) throw userCancellationError();
          throw new Error('请求超时（60秒）');
        }
        throw new Error(analyzeFetchError(fetchError, url));
      } finally {
        signal?.removeEventListener('abort', abortFromCaller);
      }
    } catch (error: any) {
      if (isUserCancellation(error, signal)) {
        return { success: false, error: '用户取消生成' };
      }
      console.error('图片生成失败:', error);
      return { success: false, error: error.message || '图片生成失败' };
    }
  }

  // 轮询图片任务
  private async pollImageResult(taskId: string, signal?: AbortSignal): Promise<GenerationResponse> {
    const maxAttempts = 30;
    const pollInterval = 3000;
    const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw new DOMException('用户取消生成', 'AbortError');
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
          signal,
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
        if (isUserCancellation(error, signal)) throw userCancellationError();
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
  async generateVideo(prompt: string, settings: Record<string, any> = {}, signal?: AbortSignal): Promise<GenerationResponse> {
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
        signal,
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

  async generateImage(prompt: string, settings: Record<string, any> = {}, signal?: AbortSignal): Promise<GenerationResponse> {
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
        signal,
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
  if (config.managed) return new SeedanceService(config);
  if (config.id.includes('gemini') || config.provider === 'Google') {
    return new GeminiService(config);
  }
  return new SeedanceService(config);
}

export default AIService;
