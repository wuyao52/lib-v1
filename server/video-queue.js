import { randomUUID } from 'node:crypto';

const ACTIVE_STATUSES = new Set(['submitting', 'processing']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const intFromEnv = (name, fallback, minimum, maximum) => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

const queueConfig = () => ({
  globalConcurrency: intFromEnv('VIDEO_QUEUE_GLOBAL_CONCURRENCY', 20, 1, 200),
  userConcurrency: intFromEnv('VIDEO_QUEUE_USER_CONCURRENCY', 20, 1, 50),
  apiConcurrency: intFromEnv('VIDEO_QUEUE_API_CONCURRENCY', 20, 1, 100),
  pollConcurrency: intFromEnv('VIDEO_QUEUE_POLL_CONCURRENCY', 20, 1, 200),
  maxQueuePerUser: intFromEnv('VIDEO_QUEUE_MAX_PENDING_PER_USER', 50, 1, 500),
  taskTimeoutMs: intFromEnv('VIDEO_QUEUE_TASK_TIMEOUT_MINUTES', 60, 5, 1440) * 60 * 1000,
  historyRetentionMs: intFromEnv('VIDEO_QUEUE_HISTORY_DAYS', 7, 1, 90) * 24 * 60 * 60 * 1000,
});

const nowIso = () => new Date().toISOString();

function buildTarget(api, suffix) {
  const base = new URL(`${api.baseUrl.replace(/\/+$/, '')}/`);
  const target = new URL(String(suffix || '').replace(/^\/+/, ''), base);
  const expectedPath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if (target.protocol !== 'https:' || target.origin !== base.origin || !target.pathname.startsWith(expectedPath)) {
    throw new Error('队列上游请求路径无效');
  }
  return target;
}

async function jsonResponse(response) {
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

function payloadOf(body) {
  return body?.data && typeof body.data === 'object' ? body.data : body;
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
  return String(payload?.id || payload?.task_id || payload?.taskId || body?.id || '').trim();
}

function videoResultOf(body) {
  const payload = payloadOf(body);
  return {
    url: payload?.video_url || payload?.url || body?.result?.video_url || body?.output?.video_url
      || body?.data?.video_url || body?.data?.url || body?.url || body?.result?.url || body?.output?.url || '',
    thumbnail: payload?.thumbnail_url || body?.thumbnail_url || body?.result?.thumbnail_url || '',
  };
}

function errorOf(body, statusCode) {
  const payload = payloadOf(body);
  const raw = String(payload?.error?.message || payload?.error?.code || payload?.error
    || body?.error?.message || body?.error?.code || body?.message || body?.msg || body?.error || `上游请求失败 (${statusCode})`);
  if (/moderation|content[_ -]?policy|safety|sensitive|审核|敏感/i.test(raw)) {
    return { code: 'PROVIDER_MODERATION_ERROR', message: '内容审核未通过，请检查提示词和参考图片后重试' };
  }
  if (/余额不足|insufficient[_ -]?(?:balance|credit)|当前余额.*(?:需要|需支付)|需要\s*[¥￥]/i.test(raw)) {
    return { code: 'UPSTREAM_BALANCE_INSUFFICIENT', message: '错误：99' };
  }
  return { code: 'UPSTREAM_VIDEO_FAILED', message: raw.slice(0, 500) };
}

function nextPollDelay(job) {
  const age = Date.now() - Date.parse(job.createdAt);
  if (age < 5 * 60 * 1000) return 5000;
  if (age < 15 * 60 * 1000) return 10000;
  return 30000;
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

export async function createVideoQueue({ db, vault, fetchImpl = fetch, autoStart = true } = {}) {
  const config = queueConfig();
  const submitting = new Set();
  const polling = new Set();
  let ticking = false;
  let lastCleanupAt = 0;

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

  const refundJob = async (jobId, error) => {
    const patch = {
      status: 'failed', progress: 100, errorCode: error.code, errorMessage: error.message,
      completedAt: nowIso(), updatedAt: nowIso(), nextPollAt: 0,
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
            description: '视频队列任务失败退款', referenceId: job.billingReference, createdBy: null, createdAt: nowIso(),
          });
        }
      }
      Object.assign(job, patch);
      return { ...job };
    });
  };

  const completeJob = async (jobId, result) => {
    const job = db.read('generationJobs').find((item) => item.id === jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return null;
    const completedAt = nowIso();
    const patch = {
      status: 'completed', progress: 100, resultUrl: result.url, thumbnail: result.thumbnail || null,
      completedAt, updatedAt: completedAt, nextPollAt: 0,
    };
    const historyRecord = result.url && job.projectId ? {
        id: randomUUID(), userId: job.userId, projectId: job.projectId, nodeId: job.nodeId || null,
        type: 'video', prompt: job.prompt || '', url: result.url, thumbnail: result.thumbnail || null,
        createdAt: completedAt, expiresAt: new Date(Date.parse(completedAt) + THREE_DAYS_MS).toISOString(),
      } : null;
    if (db.finalizeGenerationJob) return db.finalizeGenerationJob(jobId, patch, historyRecord);
    return db.mutate((data) => {
      const stored = data.generationJobs.find((item) => item.id === jobId);
      if (!stored || TERMINAL_STATUSES.has(stored.status)) return null;
      Object.assign(stored, patch);
      if (historyRecord && !data.generationHistory.some((item) => item.userId === job.userId && item.url === result.url)) data.generationHistory.push(historyRecord);
      return { ...stored };
    });
  };

  const apiForJob = (job) => {
    const api = db.read('systemApis').find((item) => item.id === job.apiId && item.enabled);
    if (!api) throw new Error('系统 API 已停用或不存在');
    return { ...api, baseUrl: vault.decrypt(api.baseUrl), apiKey: vault.decrypt(api.encryptedApiKey) };
  };

  const submitJob = async (job) => {
    if (submitting.has(job.id)) return;
    submitting.add(job.id);
    try {
      const api = apiForJob(job);
      const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${api.apiKey}`, 'x-api-key': api.apiKey });
      const response = await fetchImpl(buildTarget(api, '/v1/videos'), {
        method: 'POST', redirect: 'manual',
        headers,
        body: JSON.stringify(job.requestBody),
      });
      const body = await jsonResponse(response);
      const status = statusOf(body);
      const result = videoResultOf(body);
      if ((response.status === 429 || response.status >= 500) && Number(job.attemptCount || 0) < 3) {
        const attemptCount = Number(job.attemptCount || 0) + 1;
        await updateJob(job.id, { status: 'queued', attemptCount, nextPollAt: Date.now() + attemptCount * 10000 });
      } else if (!response.ok || isBusinessFailure(body) || ['failed', 'error', 'rejected', 'cancelled', 'canceled'].includes(status)) {
        await refundJob(job.id, errorOf(body, response.status));
      } else if (result.url && ['completed', 'success'].includes(status)) {
        await completeJob(job.id, result);
      } else {
        const providerTaskId = taskIdOf(body);
        if (!providerTaskId) await refundJob(job.id, { code: 'UPSTREAM_TASK_ID_MISSING', message: '服务商未返回视频任务 ID' });
        else await updateJob(job.id, { status: 'processing', providerTaskId, progress: Number(payloadOf(body)?.progress || 0), nextPollAt: Date.now() + 5000 });
      }
    } catch (error) {
      const attemptCount = Number(job.attemptCount || 0) + 1;
      if (attemptCount <= 3) await updateJob(job.id, { status: 'queued', attemptCount, nextPollAt: Date.now() + attemptCount * 10000 });
      else await refundJob(job.id, { code: 'UPSTREAM_UNAVAILABLE', message: String(error?.message || '系统 AI 服务暂时不可用').slice(0, 500) });
    } finally {
      submitting.delete(job.id);
    }
  };

  const pollJob = async (job) => {
    if (polling.has(job.id)) return;
    polling.add(job.id);
    try {
      if (Date.now() - Date.parse(job.createdAt) > config.taskTimeoutMs) {
        await refundJob(job.id, { code: 'VIDEO_JOB_TIMEOUT', message: '视频任务处理超时，已自动退款' });
        return;
      }
      const api = apiForJob(job);
      const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${api.apiKey}`, 'x-api-key': api.apiKey });
      const response = await fetchImpl(buildTarget(api, `/v1/videos/${encodeURIComponent(job.providerTaskId)}`), {
        method: 'GET', redirect: 'manual', headers,
      });
      const body = await jsonResponse(response);
      const status = statusOf(body);
      const result = videoResultOf(body);
      if (response.status === 429 || response.status >= 500) {
        await updateJob(job.id, { attemptCount: Number(job.attemptCount || 0) + 1, nextPollAt: Date.now() + 15000 });
      } else if (!response.ok || isBusinessFailure(body) || ['failed', 'error', 'rejected', 'cancelled', 'canceled'].includes(status)) {
        await refundJob(job.id, errorOf(body, response.status));
      } else if (['completed', 'success'].includes(status) && result.url) {
        await completeJob(job.id, result);
      } else {
        await updateJob(job.id, {
          status: 'processing', progress: Number(payloadOf(body)?.progress || payloadOf(body)?.percent || job.progress || 0),
          attemptCount: Number(job.attemptCount || 0) + 1, nextPollAt: Date.now() + nextPollDelay(job),
        });
      }
    } catch (error) {
      await updateJob(job.id, { attemptCount: Number(job.attemptCount || 0) + 1, nextPollAt: Date.now() + 15000 });
    } finally {
      polling.delete(job.id);
    }
  };

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      if (Date.now() - lastCleanupAt >= 60 * 60 * 1000) {
        const cutoff = new Date(Date.now() - config.historyRetentionMs).toISOString();
        if (db.cleanupGenerationJobs) await db.cleanupGenerationJobs(cutoff, TERMINAL_STATUSES);
        else await db.mutate((data) => {
          data.generationJobs = data.generationJobs.filter((job) => !TERMINAL_STATUSES.has(job.status) || String(job.completedAt || job.updatedAt) >= cutoff);
        });
        lastCleanupAt = Date.now();
      }
      const jobs = db.read('generationJobs');
      const active = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
      const userCounts = new Map();
      const apiCounts = new Map();
      active.forEach((job) => {
        userCounts.set(job.userId, (userCounts.get(job.userId) || 0) + 1);
        apiCounts.set(job.apiId, (apiCounts.get(job.apiId) || 0) + 1);
      });
      let available = Math.max(0, config.globalConcurrency - active.length);
      const selected = [];
      for (const job of jobs.filter((item) => item.status === 'queued' && Number(item.nextPollAt || 0) <= Date.now()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (!available) break;
        if ((userCounts.get(job.userId) || 0) >= config.userConcurrency) continue;
        if ((apiCounts.get(job.apiId) || 0) >= config.apiConcurrency) continue;
        selected.push(job);
        userCounts.set(job.userId, (userCounts.get(job.userId) || 0) + 1);
        apiCounts.set(job.apiId, (apiCounts.get(job.apiId) || 0) + 1);
        available -= 1;
      }
      if (selected.length) {
        const ids = new Set(selected.map((job) => job.id));
        let claimed;
        if (db.claimGenerationJobs) claimed = await db.claimGenerationJobs([...ids], nowIso());
        else {
          claimed = [];
          await db.mutate((data) => data.generationJobs.forEach((job) => {
            if (ids.has(job.id) && job.status === 'queued') { job.status = 'submitting'; job.updatedAt = nowIso(); claimed.push({ ...job }); }
          }));
        }
        claimed.forEach((job) => void submitJob(job));
      }
      jobs.filter((job) => job.status === 'processing' && Number(job.nextPollAt || 0) <= Date.now())
        .slice(0, config.pollConcurrency).forEach((job) => void pollJob({ ...job }));
    } finally {
      ticking = false;
    }
  };

  const enqueue = async ({ id = randomUUID(), userId, apiId, modelId, requestBody, chargeCents = 0, billingReference = null, client = {} }) => {
    const timestamp = nowIso();
    const job = {
      id, userId, apiId, modelId, requestBody, status: 'queued', providerTaskId: null, progress: 0,
      resultUrl: null, thumbnail: null, errorCode: null, errorMessage: null, chargeCents,
      billingReference, projectId: String(client.projectId || '').slice(0, 100) || null,
      nodeId: String(client.nodeId || '').slice(0, 100) || null, prompt: String(requestBody.prompt || '').slice(0, 10000),
      attemptCount: 0, nextPollAt: 0, createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    };
    let enqueueError = null;
    if (db.enqueueGenerationJob) {
      const result = await db.enqueueGenerationJob(job, config.maxQueuePerUser, TERMINAL_STATUSES);
      enqueueError = result.error;
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

  const get = (jobId, userId) => {
    const job = db.read('generationJobs').find((item) => item.id === jobId && item.userId === userId);
    if (!job) return null;
    const queuePosition = job.status === 'queued'
      ? db.read('generationJobs').filter((item) => item.status === 'queued' && item.createdAt <= job.createdAt).length
      : null;
    return publicJob(job, queuePosition);
  };

  const overview = () => {
    const jobs = db.read('generationJobs');
    const counts = Object.fromEntries(['queued', 'submitting', 'processing', 'completed', 'failed'].map((status) => [status, jobs.filter((job) => job.status === status).length]));
    return { counts, config, recent: jobs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map((job) => ({ id: job.id, userId: job.userId, apiId: job.apiId, modelId: job.modelId, status: job.status, progress: job.progress, errorCode: job.errorCode, createdAt: job.createdAt, updatedAt: job.updatedAt })) };
  };

  await db.mutate((data) => data.generationJobs.forEach((job) => {
    if (job.status === 'submitting') { job.status = 'queued'; job.nextPollAt = 0; job.updatedAt = nowIso(); }
  }));
  const timer = autoStart ? setInterval(() => void tick(), 1000) : null;
  timer?.unref?.();
  return { enqueue, get, overview, tick, config };
}
