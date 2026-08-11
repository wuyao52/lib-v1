import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_CLIPS = 40;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function ffmpegPath() {
  return String(process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
}

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { cwd, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(-4000); });
    child.on('error', (error) => reject(Object.assign(new Error('FFmpeg 不可用，请在服务端安装 FFmpeg 或设置 FFMPEG_PATH'), { code: 'FFMPEG_UNAVAILABLE', cause: error })));
    child.on('close', (code) => code === 0 ? resolve() : reject(Object.assign(new Error(`媒体处理失败 (${code})`), { code: 'MEDIA_PROCESSING_FAILED', detail: stderr })));
  });
}

function ownedMedia(db, userId, url) {
  const match = String(url || '').match(/\/api\/generated-media\/([^/?#]+)/i);
  if (!match) return null;
  return db.read('generatedMedia').find((item) => item.id === match[1] && item.userId === userId && Date.parse(item.expiresAt) > Date.now()) || null;
}

async function readOwnedMedia(db, storage, userId, url) {
  const record = ownedMedia(db, userId, url);
  if (!record || !storage?.get) {
    const error = new Error('只能使用当前用户已归档的视频');
    error.code = 'DIRECTOR_MEDIA_NOT_OWNED';
    throw error;
  }
  const bytes = await storage.get(record.objectKey);
  if (!bytes?.length) throw new Error('已归档视频内容为空');
  return { record, bytes };
}

async function withTempDirectory(task) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-drama-director-'));
  try { return await task(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function extractDirectorTailFrame({ db, storage, userId, url }) {
  const { bytes } = await readOwnedMedia(db, storage, userId, url);
  return withTempDirectory(async (directory) => {
    const input = join(directory, 'input.mp4');
    const output = join(directory, 'tail.png');
    await writeFile(input, bytes);
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
  const media = [];
  for (const url of clipUrls) media.push(await readOwnedMedia(db, storage, userId, url));
  return withTempDirectory(async (directory) => {
    const listPath = join(directory, 'concat.txt');
    const output = join(directory, 'short-drama.mp4');
    const lines = [];
    for (let index = 0; index < media.length; index += 1) {
      const file = join(directory, `clip-${String(index).padStart(3, '0')}.mp4`);
      await writeFile(file, media[index].bytes);
      lines.push(`file '${file.replaceAll("'", "'\\''")}'`);
    }
    await writeFile(listPath, `${lines.join('\n')}\n`, 'utf8');
    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output], directory);
    } catch {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', output], directory);
    }
    const bytes = await readFile(output);
    if (!bytes.length) throw new Error('合成结果为空');
    const id = randomUUID();
    const objectKey = `generated-videos/${userId}/director-compositions/${id}.mp4`;
    await storage.put({ key: objectKey, bytes, mimeType: 'video/mp4' });
    const now = new Date().toISOString();
    const record = { id, userId, jobId: `director-composition-${id}`, objectKey, mimeType: 'video/mp4', byteSize: bytes.length, sourceUrl: null, createdAt: now, expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() };
    await db.mutate((data) => {
      data.generatedMedia.push(record);
      data.generationHistory.push({ id: randomUUID(), userId, projectId: String(projectId).slice(0, 100), nodeId: null, type: 'video', prompt: '导演模式最终短剧合成', url: `/api/generated-media/${id}`, thumbnail: null, createdAt: now, expiresAt: record.expiresAt });
    });
    return { id, url: `/api/generated-media/${id}`, byteSize: bytes.length, clipCount: media.length, createdAt: now };
  });
}

export function createDirectorCompositionQueue({ db, storage, autoStart = true } = {}) {
  const active = new Set();
  let accepting = true;
  let timer = null;
  const tick = async () => {
    if (!accepting) return;
    const jobs = db.read('generationJobs').filter((job) => job.status === 'director_queued' && !active.has(job.id)).slice(0, 1);
    for (const job of jobs) {
      active.add(job.id);
      await db.mutate((data) => {
        const stored = data.generationJobs.find((item) => item.id === job.id && item.status === 'director_queued');
        if (stored) { stored.status = 'director_processing'; stored.progress = 10; stored.updatedAt = new Date().toISOString(); }
      });
      void composeDirectorVideos({ db, storage, userId: job.userId, projectId: job.projectId, clipUrls: job.requestBody.clipUrls })
        .then((result) => db.mutate((data) => {
          const stored = data.generationJobs.find((item) => item.id === job.id);
          if (!stored) return;
          stored.status = 'completed'; stored.progress = 100; stored.resultUrl = result.url; stored.completedAt = new Date().toISOString(); stored.updatedAt = stored.completedAt;
        }))
        .catch((error) => db.mutate((data) => {
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
    await db.mutate((data) => data.generationJobs.push(job));
    void tick();
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

export function registerDirectorMediaRoutes(router, { db, requireAuth, storage, queue = null }) {
  router.post('/tail-frame', requireAuth, async (req, res) => {
    try {
      const dataUrl = await extractDirectorTailFrame({ db, storage, userId: req.user.id, url: req.body?.url });
      return res.json({ dataUrl });
    } catch (error) {
      const status = error.code === 'DIRECTOR_MEDIA_NOT_OWNED' ? 403 : error.code === 'FFMPEG_UNAVAILABLE' ? 503 : 400;
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
      const status = error.code === 'DIRECTOR_MEDIA_NOT_OWNED' ? 403 : error.code === 'FFMPEG_UNAVAILABLE' ? 503 : 400;
      return res.status(status).json({ error: error.code || 'DIRECTOR_COMPOSITION_FAILED', message: error.message });
    }
  });
  router.get('/compose/:id', requireAuth, (req, res) => {
    const job = queue?.get(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: 'DIRECTOR_COMPOSITION_NOT_FOUND', message: '合成任务不存在' });
    return res.json({ job });
  });
}
