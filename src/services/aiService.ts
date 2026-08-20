import { AIModelConfig, GenerationRequest, GenerationResponse } from '@/types';
import { compressImageDataUrl, dataUrlByteLength } from '@/utils/imageCompression';

const browserConsole = globalThis.console;
// Provider payloads can contain credentials, API responses or Base64 images.
const console = {
  log: (..._args: unknown[]) => undefined,
  warn: (..._args: unknown[]) => undefined,
  error: (...args: unknown[]) => browserConsole.error(args.map((value) => (
    typeof value === 'string' ? value : value instanceof Error ? value.message : '[detail]'
  )).join(' ').slice(0, 500) || 'AI request failed'),
};

const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_MAX_ATTEMPTS = 240;
const MANAGED_VIDEO_POLL_MAX_ATTEMPTS = 1440;
const VIDEO_POLL_TIMEOUT_MESSAGE = '视频任务等待超时（约 20 分钟），服务商任务可能仍在处理中';
const MANAGED_VIDEO_POLL_TIMEOUT_MESSAGE = '视频任务等待超时（约 2 小时），服务商任务可能仍在处理中';

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

function publicProviderError(value: unknown): string {
  let message = String(value || '').trim();
  // Some compatible gateways put their real error object into a JSON string.
  // Extract the readable message so request IDs and provider-only payloads do
  // not leak into the canvas error state.
  try {
    const parsed = JSON.parse(message);
    message = String(parsed?.error?.message || parsed?.message || parsed?.msg || message).trim();
  } catch {
    // The provider returned a regular text message.
  }
  if (message === '错误：余额不足' || message === '错误：99') return message;
  if (/privacyinformation|real\s*(?:person|human|face)|真人|人脸|肖像/i.test(message)) {
    return '参考图片疑似包含真人，当前服务商不支持将真人肖像用作视频参考图。请移除该参考图，或改用原创角色素材后重试';
  }
  if (/moderation|content[_ -]?policy|safety|sensitive|审核|敏感/i.test(message)) {
    return '内容审核未通过，请检查提示词和参考图片后重试';
  }
  return /余额不足|insufficient[_ -]?(?:balance|credit)|当前余额.*(?:需要|需支付)|需要\s*[¥￥]/i.test(message)
    ? '错误：99'
    : message;
}

// 分析 fetch 错误原因
function analyzeFetchError(error: any, url: string): string {
  const message = publicProviderError(error.message || '');

  if (message.startsWith('错误：')) return message;

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

async function compressReferenceImage(value: string): Promise<string> {
  return compressImageDataUrl(value, {
    maxBytes: 350 * 1024,
    maxDimension: 960,
    outputMimeType: 'image/jpeg',
    background: '#ffffff',
    errorLabel: '参考图',
  });
}

export async function prepareReferenceImages(images: unknown): Promise<string[]> {
  if (!Array.isArray(images)) return [];
  const prepared: string[] = [];
  let embeddedBytes = 0;
  // The caller has already applied the active model's reference-image capability.
  // Do not reintroduce a provider-agnostic hard limit here.
  for (const value of images) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const image = await compressReferenceImage(value.trim());
    if (/^data:/i.test(image)) {
      const bytes = dataUrlByteLength(image);
      if (prepared.length && embeddedBytes + bytes > 700 * 1024) continue;
      embeddedBytes += bytes;
    }
    prepared.push(image);
  }
  return prepared;
}

function providerErrorMessage(data: any): string | null {
  if (data?.success === false) return publicProviderError(data.message || data.msg || data.error?.message || data.error || '服务商返回失败');
  if (data?.code !== undefined && !['0', '200', '20000', 'SUCCESS'].includes(String(data.code).toUpperCase())) {
    return publicProviderError(data.message || data.msg || data.error?.message || data.error || `服务商错误码 ${data.code}`);
  }
  return null;
}

function terminalProviderError(data: any): Error {
  const payload = data?.data && typeof data.data === 'object' ? data.data : data;
  const values = [
    payload?.error?.message, payload?.error?.code, payload?.error,
    data?.error?.message, data?.error?.code, data?.message, data?.msg, data?.error,
  ];
  const rawMessage = String(values.find((value) => typeof value === 'string' && value.trim()) || '视频生成失败');
  const message = /privacyinformation|real\s*(?:person|human|face)|真人|人脸|肖像/i.test(rawMessage)
    ? '参考图片疑似包含真人，当前服务商不支持将真人肖像用作视频参考图。请移除该参考图，或改用原创角色素材后重试'
    : /moderation|content[_ -]?policy|safety|sensitive|审核|敏感/i.test(rawMessage)
    ? (rawMessage.includes('本次扣款') ? rawMessage : '内容审核未通过，请检查提示词、参考图片以及画面中的敏感内容后重试')
    : rawMessage;
  const error = new Error(message);
  error.name = 'ProviderTaskFailed';
  return error;
}

export function resolveVideoResolution(modelId: string, requested: unknown): string {
  const modelResolution = modelId.match(/(?:^|[-_])(480|720|1080)p(?:$|[-_])/i)?.[1];
  if (modelResolution) return `${modelResolution}p`;

  const requestedResolution = String(requested || '').trim().toLowerCase();
  // Seedance 2.0 Mini does not offer a universal 1080p tier. Third-party
  // providers can differ, but 720p is its documented interoperable baseline.
  if (/seedance.*(?:[-_.]2(?:[-_.]?0)?)?[-_.]?mini/i.test(modelId) && (!requestedResolution || requestedResolution === '1080p')) {
    return '720p';
  }
  return requestedResolution || '1080p';
}

export function extractVideoResult(response: any): { url: string; thumbnail?: string } {
  const payload = response?.data && typeof response.data === 'object' && !Array.isArray(response.data)
    ? response.data
    : response;
  const urls = [
    payload?.video_url, payload?.videoUrl, payload?.url, response?.video_url, response?.videoUrl, response?.url,
    response?.result?.video_url, response?.result?.videoUrl, response?.result?.url,
    response?.result?.data?.[0]?.video_url, response?.result?.data?.[0]?.videoUrl, response?.result?.data?.[0]?.url,
    response?.result_url, response?.content,
    response?.data?.result_url, response?.data?.content,
    response?.result?.result_url, response?.result?.content,
    response?.output?.video_url, response?.output?.videoUrl, response?.output?.url,
    response?.output?.data?.[0]?.video_url, response?.output?.data?.[0]?.videoUrl, response?.output?.data?.[0]?.url,
    response?.data?.result?.video_url, response?.data?.result?.videoUrl, response?.data?.result?.url,
    response?.data?.result?.data?.[0]?.url, response?.data?.output?.video_url, response?.data?.output?.url,
    response?.videos?.[0]?.url, response?.data?.videos?.[0]?.url,
  ];
  const thumbnails = [payload?.thumbnail_url, payload?.thumbnailUrl, response?.thumbnail_url, response?.thumbnailUrl, response?.result?.thumbnail_url, response?.result?.thumbnailUrl, response?.output?.thumbnail_url, response?.output?.thumbnailUrl];
  const url = urls.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()))?.trim() || '';
  const thumbnail = thumbnails.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()))?.trim();
  return { url, ...(thumbnail ? { thumbnail } : {}) };
}

function isCompletedVideoStatus(value: unknown): boolean {
  return ['completed', 'complete', 'success', 'succeeded', 'done', 'finished'].includes(String(value || '').toLowerCase());
}

function isFailedVideoStatus(value: unknown): boolean {
  return ['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled'].includes(String(value || '').toLowerCase());
}

function isDirectVideoAssetUrl(value: string): boolean {
  try {
    return /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

export function isCompletedVideoResponse(status: unknown, response: any): boolean {
  const result = extractVideoResult(response);
  if (!result.url || isFailedVideoStatus(status)) return false;
  return !status || isCompletedVideoStatus(status) || isDirectVideoAssetUrl(result.url);
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

  async resumeVideo(_taskId: string, _signal?: AbortSignal, _onProgress?: (update: { taskId: string; status: string; progress: number; queuePosition: number | null }) => void): Promise<GenerationResponse> {
    throw new Error('当前模型服务不支持恢复视频任务');
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

      if (!this.config.apiKey && !this.config.managed && !this.config.credentialManaged) {
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

      if (!this.config.apiKey && !this.config.managed && !this.config.credentialManaged) {
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
      if (this.config.managed && settings._client) requestBody._client = settings._client;

      // 可选参数：参考图片
      const preparedImages = await prepareReferenceImages(settings.images);
      if (preparedImages.length > 0) requestBody.images = preparedImages;
      const referenceVideos = Array.isArray(settings.videos) ? settings.videos.filter((value: unknown): value is string => typeof value === 'string' && /^https:\/\//i.test(value.trim())) : [];
      const referenceAudios = Array.isArray(settings.audios) ? settings.audios.filter((value: unknown): value is string => typeof value === 'string' && /^https:\/\//i.test(value.trim())) : [];
      if (referenceVideos.length) requestBody.videos = referenceVideos;
      if (referenceAudios.length) requestBody.audios = referenceAudios;

      console.log('调用视频生成 API:', url);
      console.log('请求参数摘要:', { ...requestBody, images: preparedImages.map((image) => ({ kind: image.startsWith('data:') ? 'data-url' : 'url', bytes: image.startsWith('data:') ? dataUrlByteLength(image) : undefined })) });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      const abortFromCaller = () => controller.abort();
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      const idempotencyKey = this.config.managed
        ? String(settings._idempotencyKey || (settings._idempotencyKey = crypto.randomUUID()))
        : '';

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'X-API-Key': this.config.apiKey,
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const data = await safeJsonParse(response);
        console.log('API 响应摘要:', {
          code: data?.code,
          status: data?.status || data?.data?.status,
          message: publicProviderError(data?.message || data?.msg || data?.error?.message || data?.error || ''),
        });

        const businessError = providerErrorMessage(data);
        if (!response.ok || businessError) throw new Error(businessError || data.message || data.msg || data.error?.message || `请求失败: ${response.status}`);

        const payload = data.data && typeof data.data === 'object' ? data.data : data;
        const taskId = payload.id || payload.task_id || payload.taskId || payload.job_id || payload.jobId || data.id || data.task_id || data.taskId || data.job_id || data.jobId;
        const taskStatus = payload.status || payload.state || data.status;
        const result = extractVideoResult(data);

        // Compatible providers may synchronously return { result: { data: [{ url }] } }
        // without a task ID. Treat that URL as the completed video immediately.
        if (result.url && !isFailedVideoStatus(taskStatus)) {
          return { success: true, data: { ...result, metadata: data } };
        }

        // 异步任务 - 轮询结果
        if (taskId && !isFailedVideoStatus(taskStatus)) {
          console.log('任务已创建，taskId:', taskId);
          const onProgress = typeof settings._onProgress === 'function' ? settings._onProgress : undefined;
          onProgress?.({ taskId: String(taskId), status: String(taskStatus || 'queued').toLowerCase(), progress: Number(payload.progress || 0), queuePosition: Number(payload.queue_position || 0) || null });
          return await this.pollVideoResult(String(taskId), signal, onProgress);
        }

        throw new Error('服务商未返回视频地址或可轮询的任务 ID');
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          if (signal?.aborted) throw userCancellationError();
          throw new Error('请求超时（60秒）');
        }
        if (['ProviderError', 'ProviderTaskFailed', 'ProviderTaskTimeout'].includes(fetchError.name)) throw fetchError;
        throw new Error(analyzeFetchError(fetchError, url));
      } finally {
        signal?.removeEventListener('abort', abortFromCaller);
      }
    } catch (error: any) {
      if (error?.name === 'CancellationFailed') {
        return { success: false, error: error.message };
      }
      if (isUserCancellation(error, signal)) {
        return { success: false, error: '用户取消生成' };
      }
      const publicMessage = publicProviderError(error.message || '视频生成失败');
      console.error('视频生成失败:', publicMessage);
      return { success: false, error: publicMessage };
    }
  }

  private async cancelVideoTask(taskId: string): Promise<void> {
    const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');
    const response = await fetch(`${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'X-API-Key': this.config.apiKey,
      },
    });
    if (response.ok) return;
    const data = await safeJsonParse(response);
    const error = new Error(data.message || '服务商未确认取消，任务仍在处理中且暂不退款');
    error.name = 'CancellationFailed';
    throw error;
  }

  // 轮询视频任务
  async resumeVideo(taskId: string, signal?: AbortSignal, onProgress?: (update: { taskId: string; status: string; progress: number; queuePosition: number | null }) => void): Promise<GenerationResponse> {
    return this.pollVideoResult(taskId, signal, onProgress);
  }

  private async pollVideoResult(taskId: string, signal?: AbortSignal, onProgress?: (update: { taskId: string; status: string; progress: number; queuePosition: number | null }) => void): Promise<GenerationResponse> {
    const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '');
    const maxAttempts = this.config.managed ? MANAGED_VIDEO_POLL_MAX_ATTEMPTS : VIDEO_POLL_MAX_ATTEMPTS;

    console.log('开始轮询视频任务:', taskId);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) {
        await this.cancelVideoTask(taskId);
        throw userCancellationError();
      }
      await new Promise(resolve => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
      if (signal?.aborted) {
        await this.cancelVideoTask(taskId);
        throw userCancellationError();
      }

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
        onProgress?.({
          taskId,
          status: String(status || 'processing').toLowerCase(),
          progress: Number(payload.progress || payload.percent || data.progress || data.percent || 0),
          queuePosition: Number(payload.queue_position || data.queue_position || 0) || null,
        });

        const result = extractVideoResult(data);
        if (isCompletedVideoResponse(status, data)) {
          const videoUrl = result.url;

          console.log('找到视频 URL:', videoUrl);

          if (videoUrl) {
            return {
              success: true,
              data: {
                url: videoUrl,
                thumbnail: result.thumbnail,
                metadata: { ...data, taskId },
              },
            };
          } else {
            // 如果没有找到 URL，返回完整响应供调试
            console.warn('完成但未找到视频 URL，完整响应:', data);
            throw new Error('视频生成完成但未返回视频 URL');
          }
        }

        if (isFailedVideoStatus(status)) {
          throw terminalProviderError(data);
        }

        // 更新进度
        const progress = payload.progress || payload.percent || data.progress || data.percent || 0;
        if (progress > 0) {
          console.log(`生成进度: ${progress}%`);
        }
      } catch (error: any) {
        if (isUserCancellation(error, signal)) {
          await this.cancelVideoTask(taskId);
          throw userCancellationError();
        }
        if (['ProviderError', 'ProviderTaskFailed', 'ProviderTaskTimeout'].includes(error.name)) throw error;
        if (error.message.includes('视频生成失败') || error.message.includes('未返回视频 URL')) {
          throw error;
        }
        console.warn('轮询请求失败:', error.message);
      }
    }

    const timeoutError = new Error(this.config.managed
      ? MANAGED_VIDEO_POLL_TIMEOUT_MESSAGE
      : VIDEO_POLL_TIMEOUT_MESSAGE);
    timeoutError.name = 'ProviderTaskTimeout';
    throw timeoutError;
  }

  // 创建图片任务
  async generateImage(prompt: string, settings: Record<string, any> = {}, signal?: AbortSignal): Promise<GenerationResponse> {
    try {
      if (!this.config.baseUrl || !isValidUrl(this.config.baseUrl)) {
        throw new Error(`无效的 API 地址: "${this.config.baseUrl}"`);
      }

      if (!this.config.apiKey && !this.config.managed && !this.config.credentialManaged) {
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
