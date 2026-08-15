import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const MAX_CLIPS = 40;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const configuredBytes = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const maxClipBytes = () => configuredBytes('DIRECTOR_MAX_CLIP_BYTES', 512 * 1024 * 1024);
const maxInputBytes = () => configuredBytes('DIRECTOR_MAX_INPUT_BYTES', 2 * 1024 * 1024 * 1024);
const maxOutputBytes = () => configuredBytes('DIRECTOR_MAX_OUTPUT_BYTES', 2 * 1024 * 1024 * 1024);
const ffmpegTimeoutMs = () => configuredBytes('DIRECTOR_FFMPEG_TIMEOUT_MS', 15 * 60 * 1000);
const mutateCollections = (db, collections, mutator) => db.mutateCollections ? db.mutateCollections(collections, mutator) : db.mutate(mutator);

function ffmpegPath() {
  return String(process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
}

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { cwd, windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (callback) => { if (!settled) { settled = true; clearTimeout(timer); callback(); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(Object.assign(new Error('媒体处理超时，已终止任务'), { code: 'MEDIA_PROCESSING_TIMEOUT' })));
    }, ffmpegTimeoutMs());
    timer.unref?.();
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-8000); });
    child.on('error', (error) => finish(() => reject(Object.assign(new Error('FFmpeg 不可用，请在服务端安装 FFmpeg 或设置 FFMPEG_PATH'), { code: 'FFMPEG_UNAVAILABLE', cause: error }))));
    child.on('close', (code) => finish(() => code === 0 ? resolve() : reject(Object.assign(new Error(`媒体处理失败 (${code})`), { code: 'MEDIA_PROCESSING_FAILED', detail: stderr }))));
  });
}

function ownedMedia(db, userId, url) {
  const match = String(url || '').match(/\/api\/generated-media\/([^/?#]+)/i);
  if (!match) return null;
  return db.read('generatedMedia').find((item) => item.id === match[1] && item.userId === userId && Date.parse(item.expiresAt) > Date.now()) || null;
}

function requireOwnedMedia(db, storage, userId, url) {
  const record = ownedMedia(db, userId, url);
  if (!record || (!storage?.getStream && !storage?.get)) {
    const error = new Error('只能使用当前用户已归档的视频');
    error.code = 'DIRECTOR_MEDIA_NOT_OWNED';
    throw error;
  }
  if (Number(record.byteSize || 0) > maxClipBytes()) {
    throw Object.assign(new Error('单个镜头超过导演合成大小限制'), { code: 'DIRECTOR_CLIP_TOO_LARGE' });
  }
  return record;
}

async function downloadOwnedMedia(storage, record, destination) {
  if (storage.getStream) {
    const response = await storage.getStream(record.objectKey);
    if (response.contentLength && response.contentLength > maxClipBytes()) throw Object.assign(new Error('单个镜头超过导演合成大小限制'), { code: 'DIRECTOR_CLIP_TOO_LARGE' });
    await pipeline(response.body, createWriteStream(destination));
  } else {
    const bytes = await storage.get(record.objectKey);
    if (!bytes?.length || bytes.length > maxClipBytes()) throw Object.assign(new Error('已归档视频内容为空或过大'), { code: 'DIRECTOR_CLIP_TOO_LARGE' });
    await writeFile(destination, bytes);
  }
  const file = await stat(destination);
  if (!file.size || file.size > maxClipBytes()) throw Object.assign(new Error('已归档视频内容为空或过大'), { code: 'DIRECTOR_CLIP_TOO_LARGE' });
  return file.size;
}

async function withTempDirectory(task) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-drama-director-'));
  try { return await task(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function extractDirectorTailFrame({ db, storage, userId, url }) {
  const record = requireOwnedMedia(db, storage, userId, url);
  return withTempDirectory(async (directory) => {
    const input = join(directory, 'input.mp4');
    const output = join(directory, 'tail.png');
    await downloadOwnedMedia(storage, record, input);
    await runFfmpeg(['-y', '-sseof', '-0.1', '-i', input, '-frames:v', '1', '-f', 'image2', output], directory);
    const frame = await readFile(output);
    if (!frame.length || frame.length > MAX_FRAME_BYTES) throw new Error('尾帧图片无效或过大');
    return `data:image/png;base64,${frame.toString('base64')}`;
  });
}

export async function composeDirectorVideos({ db, storage, userId, clipUrls, projectId = '' }) {
  if (!Array.isArray(clipUrls) || clipUrls.length < 1 || clipUrls.length > MAX_CLIPS) {
    const error = new Error(`合成至少需要 1 个、最多 ${MAX_CLIPS} 个已完成镜头`);
    error.code = 'DIRECTOR_COMPOSITION_INPUT_INVALID';
    throw error;
  }
  const media = clipUrls.map((url) => requireOwnedMedia(db, storage, userId, url));
  const declaredInputBytes = media.reduce((sum, item) => sum + Number(item.byteSize || 0), 0);
  if (declaredInputBytes > maxInputBytes()) throw Object.assign(new Error('镜头总大小超过导演合成限制'), { code: 'DIRECTOR_INPUT_TOO_LARGE' });
  return withTempDirectory(async (directory) => {
    const listPath = join(directory, 'concat.txt');
    const output = join(directory, 'short-drama.mp4');
    const lines = [];
    let actualInputBytes = 0;
    for (let index = 0; index < media.length; index += 1) {
      const file = join(directory, `clip-${String(index).padStart(3, '0')}.mp4`);
      actualInputBytes += await downloadOwnedMedia(storage, media[index], file);
      if (actualInputBytes > maxInputBytes()) throw Object.assign(new Error('镜头总大小超过导演合成限制'), { code: 'DIRECTOR_INPUT_TOO_LARGE' });
      lines.push(`file '${file.replaceAll("'", "'\\''")}'`);
    }
    await writeFile(listPath, `${lines.join('\n')}\n`, 'utf8');
    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output], directory);
    } catch {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', output], directory);
    }
    const outputFile = await stat(output);
    if (!outputFile.size || outputFile.size > maxOutputBytes()) throw Object.assign(new Error('合成结果为空或超过大小限制'), { code: 'DIRECTOR_OUTPUT_TOO_LARGE' });
    const id = randomUUID();
    const objectKey = `generated-videos/${userId}/director-compositions/${id}.mp4`;
    if (storage.putStream) await storage.putStream({ key: objectKey, body: createReadStream(output), mimeType: 'video/mp4', contentLength: outputFile.size });
    else await storage.put({ key: objectKey, bytes: await readFile(output), mimeType: 'video/mp4' });
    const now = new Date().toISOString();
    const record = { id, userId, jobId: `director-composition-${id}`, objectKey, mimeType: 'video/mp4', byteSize: outputFile.size, sourceUrl: null, createdAt: now, expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() };
    await mutateCollections(db, ['generatedMedia', 'generationHistory'], (data) => {
      data.generatedMedia.push(record);
      data.generationHistory.push({ id: randomUUID(), userId, projectId: String(projectId).slice(0, 100), nodeId: null, type: 'video', prompt: '导演模式最终短剧合成', url: `/api/generated-media/${id}`, thumbnail: null, createdAt: now, expiresAt: record.expiresAt });
    });
    return { id, url: `/api/generated-media/${id}`, byteSize: outputFile.size, clipCount: media.length, createdAt: now };
  });
}

export function createDirectorCompositionQueue({ db, storage, autoStart = true } = {}) {
  const active = new Set();
  let accepting = true;
  let timer = null;
  const tick = async () => {
    if (!accepting) return;
    const staleBefore = Date.now() - 120_000;
    const hasStaleJob = db.read('generationJobs').some((job) => job.status === 'director_processing' && !active.has(job.id) && Date.parse(job.updatedAt || 0) < staleBefore);
    if (hasStaleJob) await mutateCollections(db, ['generationJobs'], (data) => data.generationJobs.forEach((job) => {
      if (job.status === 'director_processing' && !active.has(job.id) && Date.parse(job.updatedAt || 0) < staleBefore) {
        job.status = 'director_queued'; job.updatedAt = new Date().toISOString();
      }
    }));
    const jobs = db.read('generationJobs').filter((job) => job.status === 'director_queued' && !active.has(job.id)).slice(0, 1);
    for (const job of jobs) {
      active.add(job.id);
      await mutateCollections(db, ['generationJobs'], (data) => {
        const stored = data.generationJobs.find((item) => item.id === job.id && item.status === 'director_queued');
        if (stored) { stored.status = 'director_processing'; stored.progress = 10; stored.updatedAt = new Date().toISOString(); }
      });
      void composeDirectorVideos({ db, storage, userId: job.userId, projectId: job.projectId, clipUrls: job.requestBody.clipUrls })
        .then((result) => mutateCollections(db, ['generationJobs'], (data) => {
          const stored = data.generationJobs.find((item) => item.id === job.id);
          if (!stored) return;
          stored.status = 'completed'; stored.progress = 100; stored.resultUrl = result.url; stored.completedAt = new Date().toISOString(); stored.updatedAt = stored.completedAt;
        }))
        .catch((error) => mutateCollections(db, ['generationJobs'], (data) => {
          const stored = data.generationJobs.find((item) => item.id === job.id);
          if (!stored) return;
          stored.status = 'failed'; stored.progress = 100; stored.errorCode = error.code || 'DIRECTOR_COMPOSITION_FAILED'; stored.errorMessage = String(error.message || '短剧合成失败').slice(0, 500); stored.completedAt = new Date().toISOString(); stored.updatedAt = stored.completedAt;
        }))
        .finally(() => active.delete(job.id));
    }
  };
  const enqueue = async ({ userId, projectId, clipUrls }) => {
    if (!accepting) throw Object.assign(new Error('导演合成队列正在停止'), { code: 'DIRECTOR_QUEUE_DRAINING' });
    if (!Array.isArray(clipUrls) || clipUrls.length < 1 || clipUrls.length > MAX_CLIPS) throw Object.assign(new Error(`合成至少需要 1 个、最多 ${MAX_CLIPS} 个镜头`), { code: 'DIRECTOR_COMPOSITION_INPUT_INVALID' });
    for (const url of clipUrls) if (!ownedMedia(db, userId, url)) throw Object.assign(new Error('只能使用当前用户已归档的视频'), { code: 'DIRECTOR_MEDIA_NOT_OWNED' });
    const now = new Date().toISOString();
    const job = { id: randomUUID(), userId, apiId: 'director-composer', modelId: 'ffmpeg', requestBody: { clipUrls }, status: 'director_queued', providerTaskId: null, progress: 0, resultUrl: null, thumbnail: null, errorCode: null, errorMessage: null, chargeCents: 0, billingReference: null, projectId: String(projectId || '').slice(0, 100) || null, nodeId: null, prompt: '导演模式最终短剧合成', attemptCount: 0, nextPollAt: 0, createdAt: now, submittedAt: null, updatedAt: now, completedAt: null, leaseOwner: null, leaseUntil: 0 };
    await mutateCollections(db, ['generationJobs'], (data) => data.generationJobs.push(job));
    if (autoStart) void tick();
    return job;
  };
  const get = (id, userId) => {
    const job = db.read('generationJobs').find((item) => item.id === id && item.userId === userId && (String(item.status).startsWith('director_') || ['completed', 'failed'].includes(item.status)));
    if (!job) return null;
    return { id: job.id, status: job.status, progress: Number(job.progress || 0), resultUrl: job.resultUrl || undefined, error: job.errorMessage || undefined };
  };
  if (autoStart) { timer = setInterval(() => void tick(), 500); timer.unref?.(); }
  return { enqueue, get, tick, stop: async () => { accepting = false; if (timer) clearInterval(timer); timer = null; } };
}

function directorErrorStatus(error) {
  if (error.code === 'DIRECTOR_MEDIA_NOT_OWNED') return 403;
  if (error.code === 'FFMPEG_UNAVAILABLE') return 503;
  if (error.code === 'MEDIA_PROCESSING_TIMEOUT') return 504;
  if (['DIRECTOR_CLIP_TOO_LARGE', 'DIRECTOR_INPUT_TOO_LARGE', 'DIRECTOR_OUTPUT_TOO_LARGE'].includes(error.code)) return 413;
  return 400;
}

export function registerDirectorMediaRoutes(router, { db, requireAuth, storage, queue = null }) {
  router.post('/tail-frame', requireAuth, async (req, res) => {
    try {
      const dataUrl = await extractDirectorTailFrame({ db, storage, userId: req.user.id, url: req.body?.url });
      return res.json({ dataUrl });
    } catch (error) {
      const status = directorErrorStatus(error);
      return res.status(status).json({ error: error.code || 'TAIL_FRAME_FAILED', message: error.message });
    }
  });

  router.post('/compose', requireAuth, async (req, res) => {
    try {
      const job = queue
        ? await queue.enqueue({ db, userId: req.user.id, projectId: req.body?.projectId, clipUrls: req.body?.clipUrls })
        : await composeDirectorVideos({ db, storage, userId: req.user.id, projectId: req.body?.projectId, clipUrls: req.body?.clipUrls });
      return res.status(queue ? 202 : 201).json(queue ? { job: { id: job.id, status: job.status, progress: 0 } } : { composition: job });
    } catch (error) {
      const status = directorErrorStatus(error);
      return res.status(status).json({ error: error.code || 'DIRECTOR_COMPOSITION_FAILED', message: error.message });
    }
  });
  router.get('/compose/:id', requireAuth, (req, res) => {
    const job = queue?.get(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: 'DIRECTOR_COMPOSITION_NOT_FOUND', message: '合成任务不存在' });
    return res.json({ job });
  });
}
