import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { assertPublicHost } from './api-discovery.js';
import { readLimitedBody } from './resource-guard.js';

const retentionMs = () => {
  const days = Number.parseInt(process.env.GENERATION_HISTORY_RETENTION_DAYS || '90', 10);
  return Math.min(3650, Math.max(3, Number.isInteger(days) ? days : 90)) * 24 * 60 * 60 * 1000;
};
const DEFAULT_MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const DEFAULT_NON_STREAM_MAX_BYTES = 32 * 1024 * 1024;
const MAX_PROXY_RANGE_BYTES = 1024 * 1024;

const maxVideoBytes = () => {
  const configured = Number(process.env.GENERATED_VIDEO_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_VIDEO_BYTES;
};
const maxNonStreamBytes = () => {
  const configured = Number(process.env.GENERATED_VIDEO_NON_STREAM_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, maxVideoBytes()) : Math.min(DEFAULT_NON_STREAM_MAX_BYTES, maxVideoBytes());
};

function limitedStream(body, maximumBytes, onProgress) {
  let total = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      total += Number(chunk?.byteLength || chunk?.length || 0);
      if (total > maximumBytes) throw Object.assign(new Error('生成视频超过平台归档大小限制'), { code: 'GENERATED_VIDEO_TOO_LARGE' });
      onProgress(total);
      controller.enqueue(chunk);
    },
  }));
}

function parseRange(value) {
  const match = String(value || '').match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : start + MAX_PROXY_RANGE_BYTES - 1;
  const end = Math.min(requestedEnd, start + MAX_PROXY_RANGE_BYTES - 1);
  if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start))) return null;
  return { start, end, header: `bytes=${start}-${end}` };
}

export function createGeneratedMediaService({ db, storage, fetchImpl = fetch, resolveHost = lookup } = {}) {
  const mutateMedia = (mutator) => db.mutateCollections ? db.mutateCollections(['generatedMedia'], mutator) : db.mutate(mutator);
  const archive = async (job, result) => {
    if (!storage || !result?.url) return result;
    const existing = db.read('generatedMedia').find((item) => item.jobId === job.id);
    if (existing) return { ...result, url: `/api/generated-media/${existing.id}` };
    const target = new URL(result.url);
    if (target.protocol !== 'https:') throw new Error('生成视频归档只允许 HTTPS 来源');
    // A provider result URL is still untrusted input. Resolve it immediately
    // before downloading so an external API cannot turn archiving into SSRF.
    await assertPublicHost(target.hostname, resolveHost);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetchImpl(target, { method: 'GET', redirect: 'error', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`下载成功视频失败 (${response.status})`);
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > maxVideoBytes()) throw new Error('生成视频超过平台归档大小限制');
      const mimeType = String(response.headers.get('content-type') || 'video/mp4').split(';')[0];
      if (!/^video\//i.test(mimeType) && mimeType !== 'application/octet-stream') throw new Error('生成结果不是可归档的视频');
      const id = randomUUID();
      const extension = mimeType.includes('webm') ? 'webm' : 'mp4';
      const objectKey = `generated-videos/${job.userId}/${job.id}/${id}.${extension}`;
      let byteSize = contentLength;
      if (storage.putStream) {
        try {
          const body = limitedStream(response.body, maxVideoBytes(), (total) => { byteSize = total; });
          await storage.putStream({ key: objectKey, body, mimeType, contentLength: contentLength || undefined });
        } catch (error) {
          await storage.delete?.(objectKey).catch(() => undefined);
          throw error;
        }
      } else {
        if (!contentLength || contentLength > maxNonStreamBytes()) throw new Error('当前存储不支持流式归档，视频过大或未声明大小，已拒绝以保护服务器内存');
        const bytes = await readLimitedBody(response, maxNonStreamBytes());
        byteSize = bytes.length;
        await storage.put({ key: objectKey, bytes, mimeType });
      }
      const createdAt = new Date().toISOString();
      const record = {
        id, userId: job.userId, jobId: job.id, objectKey, mimeType, byteSize,
        sourceUrl: result.url, createdAt, expiresAt: new Date(Date.parse(createdAt) + retentionMs()).toISOString(),
      };
      await mutateMedia((data) => data.generatedMedia.push(record));
      return { ...result, url: `/api/generated-media/${id}` };
    } finally {
      clearTimeout(timeout);
    }
  };

  const cleanup = async () => {
    if (!storage) return { deleted: 0 };
    const expired = db.read('generatedMedia').filter((item) => Date.parse(item.expiresAt) <= Date.now());
    const deleted = [];
    for (const item of expired) {
      try { await storage.delete(item.objectKey); deleted.push(item.id); } catch (error) { console.error('清理过期视频归档失败:', error); }
    }
    if (deleted.length) await mutateMedia((data) => { data.generatedMedia = data.generatedMedia.filter((item) => !deleted.includes(item.id)); });
    return { deleted: deleted.length };
  };

  return { archive, cleanup };
}

export function registerGeneratedMediaRoutes(router, { db, requireAuth, storage }) {
  router.use(requireAuth);
  router.get('/:id/playback-url', async (req, res) => {
    const media = db.read('generatedMedia').find((item) => item.id === req.params.id && item.userId === req.user.id && Date.parse(item.expiresAt) > Date.now());
    if (!media) return res.status(404).json({ error: 'GENERATED_MEDIA_NOT_FOUND', message: '视频不存在或已过期' });
    if (!storage?.createDownloadUrl) return res.json({ url: `/api/generated-media/${media.id}`, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    const url = await storage.createDownloadUrl({ key: media.objectKey, mimeType: media.mimeType, expiresInSeconds: 900 });
    return res.json({ url, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
  });
  router.get('/:id', async (req, res) => {
    const media = db.read('generatedMedia').find((item) => item.id === req.params.id && item.userId === req.user.id && Date.parse(item.expiresAt) > Date.now());
    if (!media) return res.status(404).json({ error: 'GENERATED_MEDIA_NOT_FOUND', message: '视频不存在或已过期' });
    if (!storage) return res.status(503).json({ error: 'MEDIA_STORAGE_UNAVAILABLE', message: '视频存储暂时不可用' });
    try {
      const range = parseRange(req.headers.range);
      const object = storage.read
        ? await storage.read(media.objectKey, range?.header)
        : { bytes: await storage.get(media.objectKey), contentLength: media.byteSize, contentRange: null, contentType: media.mimeType };
      res.setHeader('Content-Type', object.contentType || media.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Content-Length', String(object.bytes.length));
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', object.contentRange || `bytes ${range.start}-${range.start + object.bytes.length - 1}/${media.byteSize}`);
      }
      return res.send(object.bytes);
    } catch (error) {
      console.error('读取归档视频失败:', error);
      return res.status(502).json({ error: 'MEDIA_STORAGE_UNAVAILABLE', message: '视频读取失败' });
    }
  });
}
