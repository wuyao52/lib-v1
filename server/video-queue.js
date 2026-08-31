import { randomUUID } from 'node:crypto';
import { createVideoProviderAdapter } from './video-provider-adapters.js';
import { isUpstreamBalanceError, upstreamErrorText } from './upstream-errors.js';

const ACTIVE_STATUSES = new Set(['submitting', 'processing', 'cancel_requested']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const CONFIRMED_POLL_BALANCE_FAILURES = 3;
const historyRetentionMs = () => intFromEnv('GENERATION_HISTORY_RETENTION_DAYS', 90, 3, 3650) * 24 * 60 * 60 * 1000;

const intFromEnv = (name, fallback, minimum, maximum) => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

const queueConfig = () => ({
  globalConcurrency: intFromEnv('VIDEO_QUEUE_GLOBAL_CONCURRENCY', 12, 1, 200),
  userConcurrency: intFromEnv('VIDEO_QUEUE_USER_CONCURRENCY', 4, 1, 50),
  apiConcurrency: intFromEnv('VIDEO_QUEUE_API_CONCURRENCY', 8, 1, 100),
  pollConcurrency: intFromEnv('VIDEO_QUEUE_POLL_CONCURRENCY', 12, 1, 200),
  maxQueuePerUser: intFromEnv('VIDEO_QUEUE_MAX_PENDING_PER_USER', 50, 1, 500),
  taskTimeoutMs: intFromEnv('VIDEO_QUEUE_TASK_TIMEOUT_MINUTES', 60, 5, 1440) * 60 * 1000,
  historyRetentionMs: intFromEnv('VIDEO_QUEUE_HISTORY_DAYS', 7, 1, 90) * 24 * 60 * 60 * 1000,
  leaseDurationMs: intFromEnv('VIDEO_QUEUE_LEASE_SECONDS', 120, 30, 600) * 1000,
});

const nowIso = () => new Date().toISOString();

async function jsonResponse(response) {
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

function payloadOf(body) {
  return body?.data && typeof body.data === 'object' ? body.data : body;
}

function nestedVideoUrl(root) {
  const pending = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  let inspected = 0;
  while (pending.length && inspected < 250) {
    const { value, depth } = pending.shift();
    inspected += 1;
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^https?:\/\//i.test(text) && /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i.test(text)) return text;
      if (depth < 8 && text.length <= 1024 * 1024 && /^[\[{]/.test(text)) {
        try { pending.push({ value: JSON.parse(text), depth: depth + 1 }); } catch { /* Not encoded JSON. */ }
      }
      continue;
    }
    if (!value || typeof value !== 'object' || depth >= 8 || seen.has(value)) continue;
    seen.add(value);
    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    for (const [, child] of entries) pending.push({ value: child, depth: depth + 1 });
  }
  return '';
}

function responseShape(value, depth = 0) {
  if (depth >= 3) return Array.isArray(value) ? `array(${value.length})` : typeof value;
  if (Array.isArray(value)) return { type: 'array', length: value.length, item: value.length ? responseShape(value[0], depth + 1) : null };
  if (!value || typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, child]) => [key, responseShape(child, depth + 1)]));
}

function safeDiagnosticText(value, requestBody) {
  const prompt = String(requestBody?.prompt || '').trim();
  return upstreamErrorText(value)
    .replaceAll(prompt, prompt ? '[redacted-prompt]' : '')
    .replace(/https?:\/\/[^\s"']+/gi, '[redacted-url]')
    .replace(/\b(?:Bearer\s+)?(?:sk|key|token)[-_A-Za-z0-9]{12,}\b/gi, '[redacted-secret]')
    .slice(0, 500);
}

export function upstreamFailureDiagnostic({ job, adapter, response, body }) {
  const request = job.requestBody || {};
  return {
    event: 'video_upstream_failure',
    jobId: job.id,
    apiId: job.apiId,
    modelId: job.modelId,
    adapter: adapter.kind,
    status: response.status,
    contentType: String(response.headers.get('content-type') || '').slice(0, 100),
    request: {
      hasPrompt: Boolean(String(request.prompt || '').trim()),
      promptLength: String(request.prompt || '').length,
      seconds: request.seconds ?? request.duration ?? null,
      aspectRatio: request.aspect_ratio ?? request.ratio ?? null,
      resolution: request.resolution ?? null,
      referenceImageCount: Array.isArray(request.images) ? request.images.length : 0,
    },
    responseShape: responseShape(body),
    errorText: safeDiagnosticText(body, request),
  };
}

function statusOf(body) {
  const payload = payloadOf(body);
  return String(payload?.status || payload?.state || body?.status || body?.state || '').toLowerCase();
}

function isBusinessFailure(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.success === false) return true;
  return body.code !== undefined && !['0', '200', '20000', 'SUCCESS'].includes(String(body.code).toUpperCase());
}

function taskIdOf(body) {
  const payload = payloadOf(body);
  return String(payload?.id || payload?.task_id || payload?.taskId || payload?.job_id || payload?.jobId || body?.id || body?.task_id || body?.taskId || body?.job_id || body?.jobId || '').trim();
}

function videoResultOf(body) {
  const payload = payloadOf(body);
  const urls = [
    payload?.video_url, payload?.official_video_url, payload?.videoUrl, payload?.url,
    payload?.result_url, payload?.content,
    body?.video_url, body?.official_video_url, body?.videoUrl, body?.url,
    body?.result_url, body?.content,
    body?.result?.video_url, body?.result?.videoUrl, body?.result?.url,
    body?.result?.result_url, body?.result?.content,
    body?.result?.data?.[0]?.video_url, body?.result?.data?.[0]?.videoUrl, body?.result?.data?.[0]?.url,
    body?.output?.video_url, body?.output?.videoUrl, body?.output?.url,
    body?.output?.data?.[0]?.video_url, body?.output?.data?.[0]?.videoUrl, body?.output?.data?.[0]?.url,
    body?.data?.result?.video_url, body?.data?.result?.videoUrl, body?.data?.result?.url,
    body?.data?.result?.result_url, body?.data?.result?.content,
    body?.data?.result?.data?.[0]?.url, body?.data?.output?.video_url, body?.data?.output?.url,
    body?.videos?.[0]?.url, body?.videos?.[0], body?.data?.videos?.[0]?.url, body?.data?.videos?.[0],
    body?.result?.videos?.[0]?.url, body?.result?.videos?.[0], body?.data?.result?.videos?.[0]?.url, body?.data?.result?.videos?.[0],
  ];
  const thumbnails = [payload?.thumbnail_url, payload?.thumbnailUrl, body?.thumbnail_url, body?.thumbnailUrl, body?.result?.thumbnail_url, body?.result?.thumbnailUrl, body?.output?.thumbnail_url, body?.output?.thumbnailUrl];
  return {
    url: urls.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()))?.trim() || nestedVideoUrl(body),
    thumbnail: thumbnails.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()))?.trim() || '',
  };
}

const completedVideoStatus = (status) => ['completed', 'complete', 'success', 'succeeded', 'done', 'finished'].includes(status);
const failedVideoStatus = (status) => ['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled'].includes(status);
const directVideoAssetUrl = (value) => {
  try { return /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i.test(new URL(value).pathname); }
  catch { return false; }
};
const completedVideoResponse = (status, result) => Boolean(result.url)
  && !failedVideoStatus(status)
  && (!status || completedVideoStatus(status) || directVideoAssetUrl(result.url));

function errorOf(body, statusCode) {
  const payload = payloadOf(body);
  const raw = upstreamErrorText(payload?.error?.detail || payload?.error?.details || payload?.details || payload?.detail
    || body?.error?.detail || body?.error?.details || body?.details || body?.detail
    || payload?.error?.message || payload?.error?.code || payload?.error
    || body?.error?.message || body?.error?.code || body?.message || body?.msg || body?.error || `上游请求失败 (${statusCode})`);
  if (/privacyinformation|real\s*(?:person|human|face)|真人|人脸|肖像/i.test(raw)) {
    return { code: 'PROVIDER_MODERATION_ERROR', message: '参考图片疑似包含真人，当前服务商不支持将真人肖像用作视频参考图。请移除该参考图，或改用原创角色素材后重试' };
  }
  if (/moderation|content[_ -]?policy|safety|sensitive|审核|敏感/i.test(raw)) {
    return { code: 'PROVIDER_MODERATION_ERROR', message: '内容审核未通过，请检查提示词和参考图片后重试' };
  }
  if (isUpstreamBalanceError(raw)) {
    return { code: 'UPSTREAM_BALANCE_INSUFFICIENT', message: '错误：99' };
  }
  return { code: 'UPSTREAM_VIDEO_FAILED', message: raw.slice(0, 500) };
}

function isProviderCapacityFailure(body) {
  const payload = payloadOf(body);
  const details = [
    body?.code, body?.message, body?.msg, body?.error?.code, body?.error?.message, body?.error,
    payload?.code, payload?.message, payload?.msg, payload?.error?.code, payload?.error?.message, payload?.error,
  ].filter((value) => typeof value === 'string').join(' ');
  return /最多同时运行|任务运行中|并发.*(?:已满|上限)|concurr(?:ency|ent).*(?:limit|full|exceed)|too many.*(?:tasks?|requests?)|capacity.*(?:full|limit|exceed)/i.test(details);
}

function nextPollDelay(job) {
  const age = Date.now() - Date.parse(job.createdAt);
  if (age < 5 * 60 * 1000) return 5000;
  if (age < 15 * 60 * 1000) return 10000;
  return 30000;
}

export function selectFairQueuedJobs(jobs, activeJobs, config, now = Date.now()) {
  let available = Math.max(0, config.globalConcurrency - activeJobs.length);
  if (!available) return [];
  const userCounts = new Map();
  const apiCounts = new Map();
  activeJobs.forEach((job) => {
    userCounts.set(job.userId, (userCounts.get(job.userId) || 0) + 1);
    apiCounts.set(job.apiId, (apiCounts.get(job.apiId) || 0) + 1);
  });
  const byUser = new Map();
  jobs.filter((job) => job.status === 'queued' && Number(job.nextPollAt || 0) <= now)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((job) => {
      if (!byUser.has(job.userId)) byUser.set(job.userId, []);
      byUser.get(job.userId).push(job);
    });
  const users = [...byUser.keys()].sort((a, b) => byUser.get(a)[0].createdAt.localeCompare(byUser.get(b)[0].createdAt));
  const selected = [];
  let madeProgress = true;
  while (available && madeProgress) {
    madeProgress = false;
    for (const userId of users) {
      if (!available) break;
      if ((userCounts.get(userId) || 0) >= config.userConcurrency) continue;
      const queue = byUser.get(userId);
      const index = queue.findIndex((job) => (apiCounts.get(job.apiId) || 0) < config.apiConcurrency);
      if (index < 0) continue;
      const [job] = queue.splice(index, 1);
      selected.push(job);
      userCounts.set(userId, (userCounts.get(userId) || 0) + 1);
      apiCounts.set(job.apiId, (apiCounts.get(job.apiId) || 0) + 1);
      available -= 1;
      madeProgress = true;
    }
  }
  return selected;
}

function publicJob(job, queuePosition = null) {
  const base = { id: job.id, status: job.status, progress: Number(job.progress || 0) };
  if (queuePosition != null) base.queue_position = queuePosition;
  if (job.status === 'completed') return { ...base, video_url: job.resultUrl, url: job.resultUrl, thumbnail_url: job.thumbnail || undefined };
  if (job.status === 'failed' || job.status === 'cancelled') {
    return { ...base, error: { code: job.errorCode || 'VIDEO_JOB_FAILED', message: job.errorMessage || '视频生成失败' }, message: job.errorMessage || '视频生成失败' };
  }
  return base;
}

export async function createVideoQueue({ db, vault, fetchImpl = fetch, autoStart = true, generatedMedia = null, resolveHost } = {}) {
  const config = queueConfig();
  const workerId = randomUUID();
  const submitting = new Set();
  const polling = new Set();
  const controllers = new Map();
  const unparsedCompletionLogged = new Set();
  const pollBalanceFailureStreaks = new Map();
  let ticking = false;
  let lastCleanupAt = 0;
  let accepting = true;
  let timer = null;

  const updateJob = async (jobId, patch) => {
    const job = db.read('generationJobs').find((item) => item.id === jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return null;
    const appliedPatch = { ...patch, updatedAt: nowIso() };
    if (db.patchGenerationJob) return db.patchGenerationJob(jobId, appliedPatch);
    return db.mutate((data) => {
      const stored = data.generationJobs.find((item) => item.id === jobId);
      if (!stored || TERMINAL_STATUSES.has(stored.status)) return null;
      Object.assign(stored, appliedPatch);
      return { ...stored };
    });
  };

  const refundJob = async (jobId, error, status = 'failed') => {
    unparsedCompletionLogged.delete(jobId);
    pollBalanceFailureStreaks.delete(jobId);
    const patch = {
      status, progress: 100, errorCode: error.code, errorMessage: error.message,
      completedAt: nowIso(), updatedAt: nowIso(), nextPollAt: 0, leaseOwner: null, leaseUntil: 0,
    };
    if (db.failGenerationJob) return db.failGenerationJob(jobId, patch);
    return db.mutate((data) => {
      const job = data.generationJobs.find((item) => item.id === jobId);
      if (!job || TERMINAL_STATUSES.has(job.status)) return null;
      if (job.chargeCents > 0 && job.billingReference) {
        const alreadyRefunded = data.balanceTransactions.some((item) => item.type === 'model_refund' && item.referenceId === job.billingReference);
        const user = data.users.find((item) => item.id === job.userId);
        if (!alreadyRefunded && user) {
          user.balanceCents = Number(user.balanceCents || 0) + Number(job.chargeCents);
          data.balanceTransactions.push({
            id: randomUUID(), userId: job.userId, amountCents: Number(job.chargeCents), type: 'model_refund',
            description: status === 'cancelled' ? '视频队列任务取消退款' : '视频队列任务失败退款', referenceId: job.billingReference, createdBy: null, createdAt: nowIso(),
          });
        }
      }
      Object.assign(job, patch);
      return { ...job };
    });
  };

  const completeJob = async (jobId, result) => {
    unparsedCompletionLogged.delete(jobId);
    pollBalanceFailureStreaks.delete(jobId);
    const job = db.read('generationJobs').find((item) => item.id === jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return null;
    let durableResult = result;
    if (generatedMedia) {
      try {
        // Authenticated provider result URLs are downloaded only on the
        // server. The credentials never enter the persisted job or browser.
        const api = apiForJob(job);
        const adapter = createVideoProviderAdapter(api, { fetchImpl, resolveHost });
        const downloadHeaders = adapter.resultHeaders ? adapter.resultHeaders() : undefined;
        durableResult = await generatedMedia.archive(job, result, { headers: downloadHeaders });
      }
      catch (error) {
        // A provider completion URL may require server-only credentials or expire quickly.
        // The provider has already completed and may have charged for the video. Keep
        // retrying server-side archiving instead of refunding or exposing its transient URL.
        console.error(`视频 ${job.id} 归档失败:`, error);
        return updateJob(job.id, {
          status: 'processing', progress: 100, resultUrl: result.url, thumbnail: result.thumbnail || null,
          errorCode: 'VIDEO_ARCHIVE_PENDING',
          errorMessage: '视频已生成，正在保存播放文件',
          nextPollAt: Date.now() + 5000, leaseOwner: null, leaseUntil: 0,
        });
      }
    }
    const completedAt = nowIso();
    const patch = {
      status: 'completed', progress: 100, resultUrl: durableResult.url, thumbnail: durableResult.thumbnail || null,
      errorCode: null, errorMessage: null,
      completedAt, updatedAt: completedAt, nextPollAt: 0, leaseOwner: null, leaseUntil: 0,
    };
    const historyRecord = durableResult.url ? {
        id: randomUUID(), userId: job.userId, projectId: job.projectId || '', nodeId: job.nodeId || null,
        type: 'video', prompt: job.prompt || '', url: durableResult.url, thumbnail: durableResult.thumbnail || null,
        createdAt: completedAt, expiresAt: new Date(Date.parse(completedAt) + historyRetentionMs()).toISOString(),
      } : null;
    if (db.finalizeGenerationJob) return db.finalizeGenerationJob(jobId, patch, historyRecord);
    return db.mutate((data) => {
      const stored = data.generationJobs.find((item) => item.id === jobId);
      if (!stored || TERMINAL_STATUSES.has(stored.status)) return null;
      Object.assign(stored, patch);
      if (historyRecord && !data.generationHistory.some((item) => item.userId === job.userId && item.url === durableResult.url)) data.generationHistory.push(historyRecord);
      return { ...stored };
    });
  };

  const apiForJob = (job) => {
    const api = db.read('systemApis').find((item) => item.id === job.apiId && item.enabled);
    if (!api) throw new Error('系统 API 已停用或不存在');
    return { ...api, baseUrl: vault.decrypt(api.baseUrl), apiKey: vault.decrypt(api.encryptedApiKey) };
  };

  const cancelUpstream = async (job) => {
    if (!job.providerTaskId) return false;
    const api = apiForJob(job);
    const adapter = createVideoProviderAdapter(api, { fetchImpl, resolveHost });
    const response = await adapter.cancel(job.providerTaskId);
    if (!response) return false;
    const body = await jsonResponse(response);
    const status = statusOf(body);
    return response.ok && !isBusinessFailure(body) && (!status || ['cancelled', 'canceled', 'success'].includes(status));
  };

  const submitJob = async (job) => {
    if (submitting.has(job.id)) return;
    submitting.add(job.id);
    const controller = new AbortController();
    controllers.set(`submit:${job.id}`, controller);
    try {
      const api = apiForJob(job);
      const adapter = createVideoProviderAdapter(api, { fetchImpl, resolveHost });
      const response = await adapter.submit(job.requestBody, job.id, controller.signal);
      const body = await jsonResponse(response);
      const status = statusOf(body);
      const result = videoResultOf(body);
      const current = db.read('generationJobs').find((item) => item.id === job.id);
      if (current?.status === 'cancel_requested') {
        const providerTaskId = taskIdOf(body);
        if (providerTaskId && await cancelUpstream({ ...current, providerTaskId })) {
          await refundJob(job.id, { code: 'USER_CANCELLED', message: '用户取消生成' }, 'cancelled');
        } else if (providerTaskId) {
          await updateJob(job.id, { status: 'processing', providerTaskId, submittedAt: job.submittedAt || nowIso(), nextPollAt: Date.now() + 5000, leaseOwner: workerId, leaseUntil: Date.now() + config.leaseDurationMs });
        } else {
          await refundJob(job.id, { code: 'USER_CANCELLED', message: '用户取消生成' }, 'cancelled');
        }
        return;
      }
      if (isProviderCapacityFailure(body)) {
        if (Date.now() - Date.parse(job.createdAt) > config.taskTimeoutMs) await refundJob(job.id, { code: 'VIDEO_JOB_TIMEOUT', message: '视频任务等待供应商容量超时，已自动退款' });
        else await updateJob(job.id, { status: 'queued', providerTaskId: null, progress: 0, attemptCount: Number(job.attemptCount || 0) + 1, nextPollAt: Date.now() + 30000, leaseOwner: null, leaseUntil: 0 });
      } else if ((response.status === 429 || response.status >= 500) && Number(job.attemptCount || 0) < 3) {
        const attemptCount = Number(job.attemptCount || 0) + 1;
        await updateJob(job.id, { status: 'queued', attemptCount, nextPollAt: Date.now() + attemptCount * 10000, leaseOwner: null, leaseUntil: 0 });
      } else if (!response.ok || isBusinessFailure(body) || failedVideoStatus(status)) {
        console.warn(JSON.stringify(upstreamFailureDiagnostic({ job, adapter, response, body })));
        await refundJob(job.id, errorOf(body, response.status));
      } else if (completedVideoResponse(status, result)) {
        await completeJob(job.id, result);
      } else {
        const providerTaskId = taskIdOf(body);
        if (!providerTaskId) await refundJob(job.id, { code: 'UPSTREAM_TASK_ID_MISSING', message: '服务商未返回视频任务 ID' });
        else await updateJob(job.id, { status: 'processing', providerTaskId, submittedAt: job.submittedAt || nowIso(), progress: Number(payloadOf(body)?.progress || 0), nextPollAt: Date.now() + 5000, leaseOwner: workerId, leaseUntil: Date.now() + config.leaseDurationMs });
      }
    } catch (error) {
      const attemptCount = Number(job.attemptCount || 0) + 1;
      if (attemptCount <= 3) await updateJob(job.id, { status: 'queued', attemptCount, nextPollAt: Date.now() + attemptCount * 10000, leaseOwner: null, leaseUntil: 0 });
      else await refundJob(job.id, { code: 'UPSTREAM_UNAVAILABLE', message: String(error?.message || '系统 AI 服务暂时不可用').slice(0, 500) });
    } finally {
      submitting.delete(job.id);
      controllers.delete(`submit:${job.id}`);
    }
  };

  const pollJob = async (job) => {
    if (polling.has(job.id)) return;
    polling.add(job.id);
    const controller = new AbortController();
    controllers.set(`poll:${job.id}`, controller);
    try {
      const api = apiForJob(job);
      const adapter = createVideoProviderAdapter(api, { fetchImpl, resolveHost });
      if (job.errorCode === 'VIDEO_ARCHIVE_PENDING' && job.resultUrl) {
        // Signed provider URLs can expire after an archive failure. Refresh the
        // provider result before retrying so we do not loop forever on a dead URL.
        let archiveResult = { url: job.resultUrl, thumbnail: job.thumbnail || '' };
        if (job.providerTaskId && adapter.refreshResult) {
          const refreshed = await adapter.refreshResult(job.providerTaskId, controller.signal);
          if (refreshed?.ok) {
            const refreshedBody = await jsonResponse(refreshed);
            const refreshedResult = videoResultOf(refreshedBody);
            if (refreshedResult.url) archiveResult = refreshedResult;
          }
        }
        await completeJob(job.id, archiveResult);
        return;
      }
      if (job.errorCode !== 'VIDEO_ARCHIVE_PENDING' && Date.now() - Date.parse(job.createdAt) > config.taskTimeoutMs) {
        await refundJob(job.id, { code: 'VIDEO_JOB_TIMEOUT', message: '视频任务处理超时，已自动退款' });
        return;
      }
      const response = await adapter.poll(job.providerTaskId, controller.signal);
      let body = await jsonResponse(response);
      let status = statusOf(body);
      let result = videoResultOf(body);
      const responseError = (!response.ok || isBusinessFailure(body) || failedVideoStatus(status))
        ? errorOf(body, response.status)
        : null;
      const progressBeforeRefresh = Number(payloadOf(body)?.progress || payloadOf(body)?.percent || job.progress || 0);
      if (response.ok && !result.url && adapter.refreshResult && (completedVideoStatus(status) || progressBeforeRefresh >= 100)) {
        const linkResponse = await adapter.refreshResult(job.providerTaskId, controller.signal);
        if (linkResponse?.ok) {
          const linkBody = await jsonResponse(linkResponse);
          const linkResult = videoResultOf(linkBody);
          body = { ...body, provider_video_link: linkBody, ...(linkResult.url ? { status: 'completed' } : {}) };
          status = statusOf(body);
          result = videoResultOf(body);
        }
      }
      if (responseError?.code === 'UPSTREAM_BALANCE_INSUFFICIENT') {
        if (failedVideoStatus(status)) {
          await refundJob(job.id, responseError);
          return;
        }
        const failures = Number(pollBalanceFailureStreaks.get(job.id) || 0) + 1;
        pollBalanceFailureStreaks.set(job.id, failures);
        if (failures >= CONFIRMED_POLL_BALANCE_FAILURES) {
          let cancelled = false;
          try { cancelled = await cancelUpstream(job); } catch { cancelled = false; }
          if (cancelled) await refundJob(job.id, responseError);
          else await updateJob(job.id, { nextPollAt: Date.now() + 30000, leaseOwner: null, leaseUntil: 0 });
        } else {
          await updateJob(job.id, { nextPollAt: Date.now() + 15000, leaseOwner: null, leaseUntil: 0 });
        }
      } else if (isProviderCapacityFailure(body)) {
        pollBalanceFailureStreaks.delete(job.id);
        if (Date.now() - Date.parse(job.createdAt) > config.taskTimeoutMs) await refundJob(job.id, { code: 'VIDEO_JOB_TIMEOUT', message: '视频任务等待供应商容量超时，已自动退款' });
        else await updateJob(job.id, { status: 'queued', providerTaskId: null, progress: 0, attemptCount: Number(job.attemptCount || 0) + 1, nextPollAt: Date.now() + 30000, leaseOwner: null, leaseUntil: 0 });
      } else if (response.status === 429 || response.status >= 500) {
        pollBalanceFailureStreaks.delete(job.id);
        await updateJob(job.id, { attemptCount: Number(job.attemptCount || 0) + 1, nextPollAt: Date.now() + 15000 });
      } else if (responseError) {
        pollBalanceFailureStreaks.delete(job.id);
        await refundJob(job.id, responseError);
      } else if (completedVideoResponse(status, result)) {
        await completeJob(job.id, result);
      } else {
        pollBalanceFailureStreaks.delete(job.id);
        const progress = Number(payloadOf(body)?.progress || payloadOf(body)?.percent || job.progress || 0);
        if (progress >= 100 && !result.url && !unparsedCompletionLogged.has(job.id)) {
          unparsedCompletionLogged.add(job.id);
          console.warn(JSON.stringify({
            event: 'video_result_unparsed', jobId: job.id, status: status || null, progress,
            responseShape: responseShape(body),
          }));
        }
        await updateJob(job.id, {
          status: 'processing', progress,
          attemptCount: Number(job.attemptCount || 0) + 1, nextPollAt: Date.now() + nextPollDelay(job),
          leaseOwner: workerId, leaseUntil: Date.now() + config.leaseDurationMs,
        });
      }
    } catch (error) {
      await updateJob(job.id, { attemptCount: Number(job.attemptCount || 0) + 1, nextPollAt: Date.now() + 15000 });
    } finally {
      polling.delete(job.id);
      controllers.delete(`poll:${job.id}`);
    }
  };

  const tick = async () => {
    if (ticking || !accepting) return;
    ticking = true;
    try {
      if (db.refreshGenerationJobs) await db.refreshGenerationJobs();
      if (Date.now() - lastCleanupAt >= 60 * 60 * 1000) {
        const cutoff = new Date(Date.now() - config.historyRetentionMs).toISOString();
        if (db.cleanupGenerationJobs) await db.cleanupGenerationJobs(cutoff, TERMINAL_STATUSES);
        else await db.mutate((data) => {
          data.generationJobs = data.generationJobs.filter((job) => !TERMINAL_STATUSES.has(job.status) || String(job.completedAt || job.updatedAt) >= cutoff);
        });
        if (generatedMedia) await generatedMedia.cleanup();
        lastCleanupAt = Date.now();
      }
      const jobs = db.read('generationJobs');
      const active = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
      const selected = selectFairQueuedJobs(jobs, active, config);
      if (selected.length) {
        const ids = new Set(selected.map((job) => job.id));
        let claimed;
        if (db.claimGenerationJobs) claimed = await db.claimGenerationJobs([...ids], nowIso(), workerId, Date.now() + config.leaseDurationMs);
        else {
          claimed = [];
          await db.mutate((data) => data.generationJobs.forEach((job) => {
            if (ids.has(job.id) && job.status === 'queued') { job.status = 'submitting'; job.submittedAt ||= nowIso(); job.updatedAt = nowIso(); claimed.push({ ...job }); }
          }));
        }
        claimed.forEach((job) => void submitJob(job));
      }
      const pollCandidates = jobs.filter((job) => job.status === 'processing' && Number(job.nextPollAt || 0) <= Date.now()).slice(0, config.pollConcurrency);
      const claimedForPolling = db.claimGenerationJobsForPolling
        ? await db.claimGenerationJobsForPolling(pollCandidates.map((job) => job.id), workerId, Date.now() + config.leaseDurationMs)
        : pollCandidates;
      claimedForPolling.forEach((job) => void pollJob({ ...job }));
    } finally {
      ticking = false;
    }
  };

  const enqueue = async ({ id = randomUUID(), userId, apiId, modelId, requestBody, chargeCents = 0, billingReference = null, client = {} }) => {
    if (!accepting) {
      const error = new Error('视频队列正在滚动发布，请稍后重试');
      error.code = 'VIDEO_QUEUE_DRAINING';
      throw error;
    }
    const existing = db.read('generationJobs').find((item) => item.id === id && item.userId === userId);
    if (existing) {
      return { job: existing, queuePosition: existing.status === 'queued' ? db.read('generationJobs').filter((item) => item.status === 'queued' && item.createdAt <= existing.createdAt).length : null, duplicate: true };
    }
    const timestamp = nowIso();
    const job = {
      id, userId, apiId, modelId, requestBody, status: 'queued', providerTaskId: null, progress: 0,
      resultUrl: null, thumbnail: null, errorCode: null, errorMessage: null, chargeCents,
      billingReference, projectId: String(client.projectId || '').slice(0, 100) || null,
      nodeId: String(client.nodeId || '').slice(0, 100) || null, prompt: String(requestBody.prompt || '').slice(0, 10000),
      attemptCount: 0, nextPollAt: 0, createdAt: timestamp, submittedAt: null, updatedAt: timestamp, completedAt: null,
      leaseOwner: null, leaseUntil: 0,
    };
    let enqueueError = null;
    if (db.enqueueGenerationJob) {
      const result = await db.enqueueGenerationJob(job, config.maxQueuePerUser, TERMINAL_STATUSES);
      enqueueError = result.error;
      if (result.job) return { job: result.job, queuePosition: result.job.status === 'queued' ? db.read('generationJobs').filter((item) => item.status === 'queued' && item.createdAt <= result.job.createdAt).length : null, duplicate: true };
    } else await db.mutate((data) => {
      const pendingForUser = data.generationJobs.filter((item) => item.userId === userId && !TERMINAL_STATUSES.has(item.status)).length;
      if (pendingForUser >= config.maxQueuePerUser) { enqueueError = 'VIDEO_QUEUE_USER_LIMIT'; return; }
      const user = data.users.find((item) => item.id === userId);
      if (!user) { enqueueError = 'USER_NOT_FOUND'; return; }
      if (Number(chargeCents || 0) > Number(user.balanceCents || 0)) { enqueueError = 'INSUFFICIENT_BALANCE'; return; }
      if (chargeCents > 0) {
        user.balanceCents = Number(user.balanceCents || 0) - Number(chargeCents);
        data.balanceTransactions.push({
          id: randomUUID(), userId, amountCents: -Number(chargeCents), type: 'model_usage',
          description: `${modelId} 视频队列调用`, referenceId: billingReference, createdBy: null, createdAt: nowIso(),
        });
      }
      data.generationJobs.push(job);
    });
    if (enqueueError) {
      const messages = {
        VIDEO_QUEUE_USER_LIMIT: `每个用户最多保留 ${config.maxQueuePerUser} 个待处理视频任务`,
        INSUFFICIENT_BALANCE: '错误：余额不足',
        USER_NOT_FOUND: '用户不存在',
      };
      const error = new Error(messages[enqueueError] || '视频队列暂时不可用');
      error.code = enqueueError;
      throw error;
    }
    void tick();
    return { job, queuePosition: db.read('generationJobs').filter((item) => item.status === 'queued' && item.createdAt <= job.createdAt).length };
  };

  // Older clients persisted the provider task ID instead of our internal job ID.
  // Resolve both identifiers so those tasks can still be resumed after a reload.
  const findOwnedJob = (jobId, userId) => db.read('generationJobs').find((item) => (
    item.userId === userId && (item.id === jobId || item.providerTaskId === jobId)
  ));

  const get = (jobId, userId) => {
    const job = findOwnedJob(jobId, userId);
    if (!job) return null;
    const queuePosition = job.status === 'queued'
      ? db.read('generationJobs').filter((item) => item.status === 'queued' && item.createdAt <= job.createdAt).length
      : null;
    return publicJob(job, queuePosition);
  };

  const cancel = async (jobId, userId) => {
    const job = findOwnedJob(jobId, userId);
    if (!job) {
      const error = new Error('视频任务不存在'); error.code = 'VIDEO_JOB_NOT_FOUND'; throw error;
    }
    if (TERMINAL_STATUSES.has(job.status)) return publicJob(job);
    if (job.status === 'queued') {
      const cancelled = await refundJob(job.id, { code: 'USER_CANCELLED', message: '用户取消生成' }, 'cancelled');
      return publicJob(cancelled || db.read('generationJobs').find((item) => item.id === job.id));
    }
    if (job.status === 'submitting' || job.status === 'cancel_requested') {
      const pending = await updateJob(job.id, { status: 'cancel_requested', nextPollAt: 0 });
      return publicJob(pending || job);
    }
    if (job.status === 'processing') {
      if (!(await cancelUpstream(job))) {
        const error = new Error('服务商未确认取消，任务仍在处理中且暂不退款');
        error.code = 'PROVIDER_CANCELLATION_UNCONFIRMED';
        throw error;
      }
      const cancelled = await refundJob(job.id, { code: 'USER_CANCELLED', message: '用户取消生成' }, 'cancelled');
      return publicJob(cancelled || db.read('generationJobs').find((item) => item.id === job.id));
    }
    return publicJob(job);
  };

  const overview = () => {
    const jobs = db.read('generationJobs');
    const counts = Object.fromEntries(['queued', 'submitting', 'processing', 'completed', 'failed'].map((status) => [status, jobs.filter((job) => job.status === status).length]));
    return { accepting, draining: !accepting, inFlight: submitting.size + polling.size + (ticking ? 1 : 0), counts, config, recent: jobs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map((job) => ({ id: job.id, userId: job.userId, apiId: job.apiId, modelId: job.modelId, status: job.status, progress: job.progress, errorCode: job.errorCode, createdAt: job.createdAt, updatedAt: job.updatedAt })) };
  };

  const isAccepting = () => accepting;
  const stop = async ({ timeoutMs = 20_000 } = {}) => {
    accepting = false;
    if (timer) clearInterval(timer);
    timer = null;
    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 20_000);
    while ((ticking || submitting.size || polling.size) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (ticking || submitting.size || polling.size) {
      controllers.forEach((controller) => controller.abort());
      const abortDeadline = Date.now() + 1000;
      while ((ticking || submitting.size || polling.size) && Date.now() < abortDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (db.releaseGenerationJobLeases) await db.releaseGenerationJobLeases(workerId);
    else await db.mutate((data) => data.generationJobs.forEach((job) => {
      if (job.leaseOwner !== workerId) return;
      if (job.status === 'submitting') job.status = 'queued';
      if (job.status === 'processing') job.nextPollAt = 0;
      job.leaseOwner = null; job.leaseUntil = 0; job.updatedAt = nowIso();
    }));
    return { drained: !ticking && submitting.size === 0 && polling.size === 0, releasedWorkerId: workerId };
  };

  if (db.recoverExpiredGenerationJobs) await db.recoverExpiredGenerationJobs();
  await db.mutate((data) => {
    const historyCutoff = Date.now() - historyRetentionMs();
    data.generationJobs.forEach((job) => {
      if (!db.recoverExpiredGenerationJobs && job.status === 'submitting') {
        job.status = 'queued';
        job.nextPollAt = 0;
        job.updatedAt = nowIso();
      }
      const completedAt = job.completedAt || job.updatedAt || job.createdAt;
      const missingHistory = job.status === 'completed' && job.resultUrl
        && Date.parse(completedAt) > historyCutoff
        && !data.generationHistory.some((item) => item.userId === job.userId && item.url === job.resultUrl);
      if (missingHistory) {
        data.generationHistory.push({
          id: randomUUID(), userId: job.userId, projectId: job.projectId || '', nodeId: job.nodeId || null,
          type: 'video', prompt: job.prompt || '', url: job.resultUrl, thumbnail: job.thumbnail || null,
          createdAt: completedAt, expiresAt: new Date(Date.parse(completedAt) + historyRetentionMs()).toISOString(),
        });
      }
    });
  });
  timer = autoStart ? setInterval(() => void tick(), 1000) : null;
  timer?.unref?.();
  return { enqueue, get, cancel, overview, tick, stop, isAccepting, config, workerId };
}
