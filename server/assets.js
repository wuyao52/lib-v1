import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { assertPublicHost } from './api-discovery.js';
import { readLimitedBody } from './resource-guard.js';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/;
const DEFAULT_USER_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const DIRECT_UPLOAD_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ASSET_RETENTION_DAYS = 30;
const SOFT_DELETE_RETENTION_DAYS = 7;
const ASSET_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNED_URL_TTL_MS = 40 * 60 * 1000;
const MAX_PROXY_RANGE_BYTES = 1024 * 1024;
const DEFAULT_DIRECT_UPLOAD_LIMIT = 300;
const DIRECT_UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const MAX_IMAGE_IMPORT_REDIRECTS = 3;
const IMAGE_IMPORT_TIMEOUT_MS = 120_000;
const IMAGE_IMPORT_JOB_TTL_MS = 10 * 60 * 1000;

export function getDirectUploadLimit(env = process.env) {
  const configured = Number(env.ASSET_DIRECT_UPLOAD_LIMIT);
  return Number.isSafeInteger(configured) && configured >= 60 && configured <= 10_000
    ? configured
    : DEFAULT_DIRECT_UPLOAD_LIMIT;
}

function parseImageDataUrl(value) {
  const match = DATA_URL_PATTERN.exec(String(value || '').trim());
  if (!match || !ALLOWED_IMAGE_TYPES.has(match[1].toLowerCase())) {
    return { error: 'INVALID_IMAGE', message: '仅支持 PNG、JPEG、WebP 或 GIF 图片' };
  }

  const encoded = match[2];
  if (encoded.length % 4 !== 0) {
    return { error: 'INVALID_IMAGE', message: '图片 Base64 数据无效' };
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) {
    return { error: 'INVALID_IMAGE', message: '图片 Base64 数据无效' };
  }
  if (bytes.length > MAX_ASSET_BYTES) {
    return { error: 'ASSET_TOO_LARGE', message: '图片大小不能超过 20 MB' };
  }
  return { bytes, mimeType: match[1].toLowerCase() };
}

function parseImageRequest(req) {
  if (Buffer.isBuffer(req.body)) {
    const mimeType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return { error: 'INVALID_IMAGE', message: '仅支持 PNG、JPEG、WebP 或 GIF 图片' };
    }
    if (!req.body.length) return { error: 'INVALID_IMAGE', message: '图片内容不能为空' };
    if (req.body.length > MAX_ASSET_BYTES) return { error: 'ASSET_TOO_LARGE', message: '图片大小不能超过 20 MB' };
    return { bytes: Buffer.from(req.body), mimeType };
  }
  return parseImageDataUrl(req.body?.dataUrl);
}

const getStableAssetUrl = (id) => `/api/assets/public/${id}`;

const directUploadMimeTypes = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
]);

function signDirectUpload(payload, signingKey) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', signingKey).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyDirectUpload(token, signingKey) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature) return null;
  const expected = createHmac('sha256', signingKey).update(encoded).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return Number(payload.expiresAt) > Date.now() ? payload : null;
  } catch { return null; }
}

function parseRange(value) {
  const match = String(value || '').match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : start + MAX_PROXY_RANGE_BYTES - 1;
  const end = Math.min(requestedEnd, start + MAX_PROXY_RANGE_BYTES - 1);
  if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start))) return null;
  return { start, header: `bytes=${start}-${end}` };
}

function signAssetAccess(id, expires, secret) {
  return createHmac('sha256', secret).update(`${id}:${expires}`).digest('base64url');
}

function validAssetSignature(id, expiresValue, signature, secret) {
  const expires = Number(expiresValue);
  if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + SIGNED_URL_TTL_MS + 60_000) return false;
  const expected = Buffer.from(signAssetAccess(id, expires, secret));
  const actual = Buffer.from(String(signature || ''));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const extensionForMimeType = (mimeType) => ({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}[mimeType] || 'bin');

const objectKeyFor = (userId, sha256, mimeType) => `assets/${userId}/${sha256}.${extensionForMimeType(mimeType)}`;

function detectImageMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function downloadImportedImage(source, { fetchImpl, resolveHost, signal }) {
  let target = new URL(source);
  for (let redirects = 0; redirects <= MAX_IMAGE_IMPORT_REDIRECTS; redirects += 1) {
    if (target.protocol !== 'https:') throw new Error(redirects ? '生成图片跳转地址必须使用 HTTPS' : '生成图片归档只允许 HTTPS 来源');
    await assertPublicHost(target.hostname, resolveHost);
    const response = await fetchImpl(target, { method: 'GET', redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('生成图片跳转响应缺少地址');
      if (redirects === MAX_IMAGE_IMPORT_REDIRECTS) throw new Error('生成图片跳转次数过多');
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) throw new Error(`下载生成图片失败 (${response.status})`);
    const bytes = await readLimitedBody(response, MAX_ASSET_BYTES);
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) throw new Error('生成结果不是支持的图片格式');
    return { bytes, mimeType };
  }
  throw new Error('生成图片跳转次数过多');
}

function storageError(res) {
  return res.status(502).json({ error: 'ASSET_STORAGE_UNAVAILABLE', message: '云端素材存储暂时不可用，请稍后重试' });
}

function assetIsReferenced(db, userId, assetId, now = Date.now()) {
  const marker = `/api/assets/public/${assetId}`;
  const projectReference = db.read('projects').some((project) => (
    project.userId === userId && JSON.stringify(project.projectData || {}).includes(marker)
  ));
  if (projectReference) return true;
  return db.read('generationHistory').some((item) => (
    item.userId === userId
    && (!item.expiresAt || Date.parse(item.expiresAt) > now)
    && (`${item.url || ''} ${item.thumbnail || ''}`).includes(marker)
  ));
}

function parseRetentionDays(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 36500 ? parsed : DEFAULT_ASSET_RETENTION_DAYS;
}

function getAssetExpiration(createdAt, retentionDays) {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) ? new Date(timestamp + retentionDays * DAY_MS).toISOString() : null;
}

export async function cleanupExpiredAssets({
  db,
  assetStorage = null,
  retentionDays = DEFAULT_ASSET_RETENTION_DAYS,
  now = Date.now(),
  onError = console.error,
} = {}) {
  const normalizedRetentionDays = parseRetentionDays(retentionDays);
  const cutoff = now - normalizedRetentionDays * DAY_MS;
  const candidates = db.read('assets').filter((asset) => {
    if (asset.deletedAt) return false;
    const createdAt = Date.parse(asset.createdAt);
    return Number.isFinite(createdAt)
      && createdAt <= cutoff
      && !assetIsReferenced(db, asset.userId, asset.id, now);
  });
  const deletedIds = [];
  const failedAssets = [];

  for (const asset of candidates) {
    try {
      deletedIds.push(asset.id);
    } catch (error) {
      failedAssets.push({ id: asset.id, error });
      onError(`Failed to automatically delete cloud asset ${asset.id}:`, error);
    }
  }

  if (deletedIds.length) {
    const deletedIdSet = new Set(deletedIds);
    await db.mutate((data) => {
      data.assets.forEach((asset) => { if (deletedIdSet.has(asset.id)) asset.deletedAt = new Date(now).toISOString(); });
    });
  }
  const purgeCutoff = now - SOFT_DELETE_RETENTION_DAYS * DAY_MS;
  const purgeCandidates = db.read('assets').filter((asset) => asset.deletedAt && Date.parse(asset.deletedAt) <= purgeCutoff);
  const purgedIds = [];
  for (const asset of purgeCandidates) {
    try {
      if (asset.objectKey) {
        if (!assetStorage) throw new Error('Object storage is not configured');
        await assetStorage.delete(asset.objectKey);
      }
      purgedIds.push(asset.id);
    } catch (error) { failedAssets.push({ id: asset.id, error }); }
  }
  if (purgedIds.length) {
    const ids = new Set(purgedIds);
    await db.mutate((data) => { data.assets = data.assets.filter((asset) => !ids.has(asset.id)); });
  }
  return { deleted: deletedIds.length, purged: purgedIds.length, failed: failedAssets.length, deletedIds, failedAssets };
}

export async function migrateLegacyAssets({ db, assetStorage, onError = console.error } = {}) {
  if (!assetStorage) return { migrated: 0, failed: 0 };
  const candidates = db.read('assets').filter((asset) => asset.dataBase64 && !asset.objectKey);
  let migrated = 0;
  let failed = 0;
  for (const asset of candidates) {
    try {
      const bytes = Buffer.from(asset.dataBase64, 'base64');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (!bytes.length || (asset.sha256 && asset.sha256 !== sha256) || !ALLOWED_IMAGE_TYPES.has(String(asset.mimeType || '').toLowerCase())) {
        throw new Error('Legacy asset integrity validation failed');
      }
      const objectKey = objectKeyFor(asset.userId, sha256, asset.mimeType);
      await assetStorage.put({ key: objectKey, bytes, mimeType: asset.mimeType });
      await db.mutate((data) => {
        const stored = data.assets.find((item) => item.id === asset.id && !item.objectKey);
        if (!stored) return;
        stored.sha256 = sha256;
        stored.objectKey = objectKey;
        stored.storageProvider = assetStorage.provider;
        stored.dataBase64 = null;
      });
      migrated += 1;
    } catch (error) {
      failed += 1;
      onError(`Failed to migrate legacy asset ${asset.id}:`, error);
    }
  }
  return { migrated, failed };
}

export function registerAssetRoutes(router, { db, requireAuth, assetStorage = null, assetSigningKey, fetchImpl = fetch, resolveHost = lookup, imageImportTimeoutMs = IMAGE_IMPORT_TIMEOUT_MS }) {
  const signingKey = String(assetSigningKey || '');
  const mutateAssets = (mutator) => db.mutateCollections ? db.mutateCollections(['assets'], mutator) : db.mutate(mutator);
  const imageImportJobs = new Map();
  if (signingKey.length < 24) throw new Error('素材签名密钥必须至少包含 24 个字符');
  const retentionDays = parseRetentionDays(process.env.ASSET_RETENTION_DAYS);
  let cleanupPromise = null;
  const runCleanup = () => {
    if (!cleanupPromise) {
      cleanupPromise = cleanupExpiredAssets({ db, assetStorage, retentionDays })
        .finally(() => { cleanupPromise = null; });
    }
    return cleanupPromise;
  };
  const cleanupTimer = setInterval(() => {
    void runCleanup().catch((error) => console.error('Cloud asset cleanup failed:', error));
  }, ASSET_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  router.get('/public/:id', async (req, res) => {
    const asset = db.read('assets').find((entry) => entry.id === req.params.id && !entry.deletedAt);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '图片不存在' });
    const ownedBySession = req.user?.id === asset.userId;
    const signedAccess = validAssetSignature(asset.id, req.query.expires, req.query.signature, signingKey);
    if (!ownedBySession && !signedAccess) return res.status(401).json({ error: 'ASSET_ACCESS_DENIED', message: '素材访问链接无效或已过期' });

    let bytes;
    try {
      if (asset.objectKey) {
        if (!assetStorage) return storageError(res);
        const range = parseRange(req.headers.range);
        if (range && assetStorage.read) {
          const object = await assetStorage.read(asset.objectKey, range.header);
          if (!object.bytes?.length) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '素材内容不存在' });
          res.status(206);
          res.setHeader('Content-Type', object.contentType || asset.mimeType);
          res.setHeader('Content-Length', String(object.bytes.length));
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Range', object.contentRange || `bytes ${range.start}-${range.start + object.bytes.length - 1}/${asset.byteSize}`);
          res.setHeader('Cache-Control', ownedBySession ? 'private, max-age=300' : 'public, max-age=300');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          return res.send(object.bytes);
        }
        bytes = await assetStorage.get(asset.objectKey);
      } else {
        bytes = Buffer.from(asset.dataBase64 || '', 'base64');
      }
    } catch (error) {
      console.error('读取云端素材失败:', error);
      return storageError(res);
    }
    if (!bytes.length) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '图片内容不存在' });
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Content-Length', String(bytes.length));
    if (asset.objectKey && assetStorage?.read) res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', ownedBySession ? 'private, max-age=300' : 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(bytes);
  });

  router.get('/', requireAuth, async (req, res, next) => {
    try {
      await runCleanup();
    } catch (error) {
      return next(error);
    }
    const quotaBytes = Number(process.env.ASSET_USER_QUOTA_BYTES) || DEFAULT_USER_QUOTA_BYTES;
    const assets = db.read('assets').filter((asset) => asset.userId === req.user.id && !asset.deletedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((asset) => {
        const referenced = assetIsReferenced(db, req.user.id, asset.id);
        return {
          id: asset.id,
          url: getStableAssetUrl(asset.id),
          mimeType: asset.mimeType,
          byteSize: Number(asset.byteSize || 0),
          storageProvider: asset.storageProvider || (asset.objectKey ? assetStorage?.provider || 'object-storage' : 'database'),
          createdAt: asset.createdAt,
          referenced,
          expiresAt: referenced ? null : getAssetExpiration(asset.createdAt, retentionDays),
        };
      });
    return res.json({
      assets,
      usedBytes: assets.reduce((sum, asset) => sum + asset.byteSize, 0),
      quotaBytes,
      storageProvider: assetStorage?.provider || 'database',
      retentionDays,
    });
  });

  router.get('/:id/signed-url', requireAuth, async (req, res) => {
    const asset = db.read('assets').find((entry) => entry.id === req.params.id && entry.userId === req.user.id);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '素材不存在' });
    const expires = Date.now() + SIGNED_URL_TTL_MS;
    if (asset.objectKey && assetStorage?.createDownloadUrl) {
      const url = await assetStorage.createDownloadUrl({ key: asset.objectKey, mimeType: asset.mimeType, expiresInSeconds: Math.floor(SIGNED_URL_TTL_MS / 1000) });
      return res.json({ url, expiresAt: new Date(expires).toISOString() });
    }
    const url = new URL(getStableAssetUrl(asset.id), 'http://same-origin.invalid');
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signAssetAccess(asset.id, expires, signingKey));
    return res.json({ url: `${url.pathname}${url.search}`, expiresAt: new Date(expires).toISOString() });
  });

  router.get('/:id/playback-url', requireAuth, async (req, res) => {
    const asset = db.read('assets').find((entry) => entry.id === req.params.id && entry.userId === req.user.id);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '素材不存在' });
    const expiresAt = Date.now() + SIGNED_URL_TTL_MS;
    if (asset.objectKey && assetStorage?.createDownloadUrl) {
      const url = await assetStorage.createDownloadUrl({ key: asset.objectKey, mimeType: asset.mimeType, expiresInSeconds: Math.floor(SIGNED_URL_TTL_MS / 1000) });
      return res.json({ url, expiresAt: new Date(expiresAt).toISOString() });
    }
    return res.json({ url: getStableAssetUrl(asset.id), expiresAt: new Date(expiresAt).toISOString() });
  });

  router.post('/direct-upload', requireAuth, async (req, res) => {
    if (!assetStorage?.createUploadUrl || !assetStorage?.stat) {
      return res.status(503).json({ error: 'DIRECT_UPLOAD_UNAVAILABLE', message: '当前对象存储不支持素材直传' });
    }
    if (db.consumeRateLimit) {
      const bucket = await db.consumeRateLimit(`asset-direct-upload:${req.user.id}`, getDirectUploadLimit(), DIRECT_UPLOAD_WINDOW_MS);
      if (!bucket.allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))));
        return res.status(429).json({ error: 'DIRECT_UPLOAD_RATE_LIMITED', message: '素材直传申请过于频繁，请稍后重试' });
      }
    }
    const mimeType = String(req.body?.mimeType || '').toLowerCase().split(';')[0];
    const extension = directUploadMimeTypes.get(mimeType);
    const byteSize = Number(req.body?.byteSize);
    const isImage = ALLOWED_IMAGE_TYPES.has(mimeType);
    const maxBytes = isImage ? MAX_ASSET_BYTES : Math.max(1, Number(process.env.ASSET_VIDEO_MAX_BYTES) || DEFAULT_VIDEO_MAX_BYTES);
    if (!extension || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > maxBytes) {
      return res.status(400).json({ error: 'INVALID_DIRECT_UPLOAD', message: `仅支持 JPG、PNG、WebP、GIF、MP4、WebM、MOV，且文件不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB` });
    }
    const quotaBytes = Number(process.env.ASSET_USER_QUOTA_BYTES) || DEFAULT_USER_QUOTA_BYTES;
    const usedBytes = db.read('assets').filter((asset) => asset.userId === req.user.id && !asset.deletedAt).reduce((sum, asset) => sum + Number(asset.byteSize || 0), 0);
    if (usedBytes + byteSize > quotaBytes) return res.status(413).json({ error: 'ASSET_QUOTA_EXCEEDED', message: '云端素材容量已满', usedBytes, quotaBytes });
    const suppliedHash = String(req.body?.sha256 || '').toLowerCase();
    const sha256 = /^[a-f0-9]{64}$/.test(suppliedHash) ? suppliedHash : randomBytes(32).toString('hex');
    const duplicate = db.read('assets').find((asset) => asset.userId === req.user.id && asset.sha256 === sha256);
    if (duplicate) {
      if (duplicate.deletedAt) await mutateAssets((data) => { const stored = data.assets.find((asset) => asset.id === duplicate.id); if (stored) stored.deletedAt = null; });
      return res.json({ duplicate: true, asset: { id: duplicate.id, url: getStableAssetUrl(duplicate.id), mimeType: duplicate.mimeType, byteSize: duplicate.byteSize } });
    }
    const id = randomUUID();
    const objectKey = `assets/${req.user.id}/${sha256}.${extension}`;
    const expiresAt = Date.now() + DIRECT_UPLOAD_TTL_MS;
    const uploadUrl = await assetStorage.createUploadUrl({ key: objectKey, mimeType, byteSize, expiresInSeconds: Math.floor(DIRECT_UPLOAD_TTL_MS / 1000) });
    const token = signDirectUpload({ id, userId: req.user.id, sha256, objectKey, mimeType, byteSize, expiresAt }, signingKey);
    return res.status(201).json({ uploadUrl, token, expiresAt: new Date(expiresAt).toISOString(), headers: { 'Content-Type': mimeType } });
  });

  router.post('/direct-upload/complete', requireAuth, async (req, res) => {
    const claim = verifyDirectUpload(req.body?.token, signingKey);
    if (!claim || claim.userId !== req.user.id || !directUploadMimeTypes.has(claim.mimeType)) {
      return res.status(400).json({ error: 'DIRECT_UPLOAD_INVALID', message: '素材上传凭证无效或已过期' });
    }
    const existing = db.read('assets').find((asset) => (asset.id === claim.id || asset.sha256 === claim.sha256) && asset.userId === req.user.id);
    if (existing?.deletedAt) await mutateAssets((data) => { const stored = data.assets.find((asset) => asset.id === existing.id); if (stored) stored.deletedAt = null; });
    if (existing) return res.json({ asset: { id: existing.id, url: getStableAssetUrl(existing.id), mimeType: existing.mimeType, byteSize: existing.byteSize } });
    let object;
    try { object = await assetStorage.stat(claim.objectKey); }
    catch { return res.status(409).json({ error: 'DIRECT_UPLOAD_NOT_FOUND', message: '尚未在对象存储中找到上传的素材' }); }
    if (object.byteSize !== claim.byteSize || object.mimeType !== claim.mimeType) {
      return res.status(409).json({ error: 'DIRECT_UPLOAD_MISMATCH', message: '对象存储中的素材大小或格式与上传申请不一致' });
    }
    const quotaBytes = Number(process.env.ASSET_USER_QUOTA_BYTES) || DEFAULT_USER_QUOTA_BYTES;
    let record; let quotaExceeded = false;
    await mutateAssets((data) => {
      const usedBytes = data.assets.filter((asset) => asset.userId === req.user.id && !asset.deletedAt).reduce((sum, asset) => sum + Number(asset.byteSize || 0), 0);
      if (usedBytes + claim.byteSize > quotaBytes) { quotaExceeded = true; return; }
      record = { id: claim.id, userId: req.user.id, sha256: claim.sha256, mimeType: claim.mimeType, dataBase64: null, objectKey: claim.objectKey, storageProvider: assetStorage.provider, byteSize: claim.byteSize, createdAt: new Date().toISOString() };
      data.assets.push(record);
    });
    if (quotaExceeded) {
      await assetStorage.delete?.(claim.objectKey).catch(() => undefined);
      return res.status(413).json({ error: 'ASSET_QUOTA_EXCEEDED', message: '云端素材容量已满' });
    }
    return res.status(201).json({ asset: { id: record.id, url: getStableAssetUrl(record.id), mimeType: record.mimeType, byteSize: record.byteSize } });
  });

  const storeImportedImage = async (userId, source, signal) => {
    let parsed;
    if (source.startsWith('data:')) parsed = parseImageDataUrl(source);
    else parsed = await downloadImportedImage(source, { fetchImpl, resolveHost, signal });
    if (parsed?.error) throw Object.assign(new Error(parsed.message), { code: parsed.error, status: parsed.error === 'ASSET_TOO_LARGE' ? 413 : 400 });
    const sha256 = createHash('sha256').update(parsed.bytes).digest('hex');
    const existing = db.read('assets').find((asset) => asset.userId === userId && asset.sha256 === sha256);
    if (existing?.deletedAt) await mutateAssets((data) => { const stored = data.assets.find((asset) => asset.id === existing.id); if (stored) stored.deletedAt = null; });
    if (existing) return { id: existing.id, url: getStableAssetUrl(existing.id), mimeType: existing.mimeType, byteSize: existing.byteSize };
    const quotaBytes = Number(process.env.ASSET_USER_QUOTA_BYTES) || DEFAULT_USER_QUOTA_BYTES;
    const objectKey = assetStorage ? objectKeyFor(userId, sha256, parsed.mimeType) : null;
    if (assetStorage) {
      try { await assetStorage.put({ key: objectKey, bytes: parsed.bytes, mimeType: parsed.mimeType }); }
      catch { throw Object.assign(new Error('云端素材存储暂时不可用，请稍后重试'), { code: 'ASSET_STORAGE_UNAVAILABLE', status: 502 }); }
    }
    let record; let duplicate = false; let quotaExceeded = false;
    await mutateAssets((data) => {
      record = data.assets.find((asset) => asset.userId === userId && asset.sha256 === sha256 && !asset.deletedAt);
      if (record) { duplicate = true; return; }
      const usedBytes = data.assets.filter((asset) => asset.userId === userId && !asset.deletedAt).reduce((sum, asset) => sum + Number(asset.byteSize || 0), 0);
      if (usedBytes + parsed.bytes.length > quotaBytes) { quotaExceeded = true; return; }
      record = { id: randomUUID(), userId, sha256, mimeType: parsed.mimeType, dataBase64: assetStorage ? null : parsed.bytes.toString('base64'), objectKey, storageProvider: assetStorage?.provider || 'database', byteSize: parsed.bytes.length, createdAt: new Date().toISOString() };
      data.assets.push(record);
    });
    if (quotaExceeded) {
      if (assetStorage) await assetStorage.delete?.(objectKey).catch(() => undefined);
      throw Object.assign(new Error('云端素材容量已满'), { code: 'ASSET_QUOTA_EXCEEDED', status: 413 });
    }
    return { id: record.id, url: getStableAssetUrl(record.id), mimeType: record.mimeType, byteSize: record.byteSize, duplicate };
  };

  router.post('/import-image', requireAuth, async (req, res) => {
    const source = String(req.body?.source || '').trim();
    if (source.startsWith('data:')) {
      try { return res.status(201).json({ asset: await storeImportedImage(req.user.id, source) }); }
      catch (error) { return res.status(error.status || 400).json({ error: error.code || 'IMAGE_IMPORT_FAILED', message: error.message }); }
    }
    try {
      const target = new URL(source);
      if (target.protocol !== 'https:') throw new Error('生成图片归档只允许 HTTPS 来源');
      await assertPublicHost(target.hostname, resolveHost);
    } catch (error) {
      return res.status(400).json({ error: 'IMAGE_IMPORT_FAILED', message: error.message });
    }
    const existingJob = [...imageImportJobs.values()].find((job) => job.userId === req.user.id && job.source === source && job.expiresAt > Date.now());
    if (existingJob) return res.status(existingJob.status === 'completed' ? 200 : 202).json({ importJob: { id: existingJob.id, status: existingJob.status }, ...(existingJob.asset ? { asset: existingJob.asset } : {}) });

    const id = randomUUID();
    const job = { id, userId: req.user.id, source, status: 'processing', asset: null, error: null, statusCode: 400, expiresAt: Date.now() + IMAGE_IMPORT_JOB_TTL_MS };
    imageImportJobs.set(id, job);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(imageImportTimeoutMs) || IMAGE_IMPORT_TIMEOUT_MS));
    timeout.unref?.();
    void storeImportedImage(job.userId, source, controller.signal)
      .then((asset) => { job.status = 'completed'; job.asset = asset; })
      .catch((error) => {
        job.status = 'failed';
        job.statusCode = error.name === 'AbortError' ? 504 : (error.status || 400);
        job.error = error.name === 'AbortError' ? '生成图片归档超时' : error.message;
      })
      .finally(() => clearTimeout(timeout));
    const cleanup = setTimeout(() => imageImportJobs.delete(id), IMAGE_IMPORT_JOB_TTL_MS);
    cleanup.unref?.();
    return res.status(202).json({ importJob: { id, status: job.status } });
  });

  router.get('/import-image/:id', requireAuth, (req, res) => {
    const job = imageImportJobs.get(req.params.id);
    if (!job || job.userId !== req.user.id || job.expiresAt <= Date.now()) return res.status(404).json({ error: 'IMAGE_IMPORT_NOT_FOUND', message: '图片归档任务不存在或已过期' });
    if (job.status === 'failed') return res.status(job.statusCode).json({ error: 'IMAGE_IMPORT_FAILED', message: job.error });
    return res.status(job.status === 'completed' ? 200 : 202).json({ importJob: { id: job.id, status: job.status }, ...(job.asset ? { asset: job.asset } : {}) });
  });

  router.delete('/:id', requireAuth, async (req, res) => {
    const asset = db.read('assets').find((entry) => entry.id === req.params.id && entry.userId === req.user.id && !entry.deletedAt);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '素材不存在' });
    if (assetIsReferenced(db, req.user.id, asset.id)) {
      return res.status(409).json({ error: 'ASSET_IN_USE', message: '该素材仍被项目或生成历史使用，不能删除' });
    }
    await mutateAssets((data) => { const stored = data.assets.find((entry) => entry.id === asset.id); if (stored) stored.deletedAt = new Date().toISOString(); });
    return res.status(202).json({ deleted: true, recoverableUntil: new Date(Date.now() + SOFT_DELETE_RETENTION_DAYS * DAY_MS).toISOString() });
  });

  router.post('/bulk-delete', requireAuth, async (req, res) => {
    const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.map((value) => String(value)) : [])].slice(0, 100);
    if (!ids.length) return res.status(400).json({ error: 'INVALID_ASSET_SELECTION', message: '请选择要删除的素材' });
    const idSet = new Set(ids);
    const owned = db.read('assets').filter((asset) => asset.userId === req.user.id && idSet.has(asset.id) && !asset.deletedAt);
    const removable = owned.filter((asset) => !assetIsReferenced(db, req.user.id, asset.id));
    const skipped = owned.filter((asset) => assetIsReferenced(db, req.user.id, asset.id)).map((asset) => asset.id);
    const deletedAt = new Date().toISOString();
    await mutateAssets((data) => data.assets.forEach((asset) => { if (removable.some((item) => item.id === asset.id)) asset.deletedAt = deletedAt; }));
    return res.json({ deleted: removable.length, skipped, recoverableUntil: new Date(Date.now() + SOFT_DELETE_RETENTION_DAYS * DAY_MS).toISOString() });
  });

  router.post('/:id/restore', requireAuth, async (req, res) => {
    const asset = db.read('assets').find((entry) => entry.id === req.params.id && entry.userId === req.user.id && entry.deletedAt);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '未找到可恢复的素材' });
    if (Date.parse(asset.deletedAt) + SOFT_DELETE_RETENTION_DAYS * DAY_MS < Date.now()) return res.status(410).json({ error: 'ASSET_RECOVERY_EXPIRED', message: '素材恢复期已结束' });
    await mutateAssets((data) => { const stored = data.assets.find((entry) => entry.id === asset.id); if (stored) stored.deletedAt = null; });
    return res.json({ asset: { id: asset.id, url: getStableAssetUrl(asset.id), mimeType: asset.mimeType, byteSize: asset.byteSize } });
  });

  router.post('/', requireAuth, async (req, res, next) => {
    try {
      const parsed = parseImageRequest(req);
      if (parsed.error) return res.status(parsed.error === 'ASSET_TOO_LARGE' ? 413 : 400).json(parsed);

      const sha256 = createHash('sha256').update(parsed.bytes).digest('hex');
      const now = new Date().toISOString();
      const existing = db.read('assets').find((asset) => asset.userId === req.user.id && asset.sha256 === sha256);
      if (existing?.deletedAt) await mutateAssets((data) => { const stored = data.assets.find((asset) => asset.id === existing.id); if (stored) stored.deletedAt = null; });
      const quotaBytes = Number(process.env.ASSET_USER_QUOTA_BYTES) || DEFAULT_USER_QUOTA_BYTES;
      const usedBytes = db.read('assets').filter((asset) => asset.userId === req.user.id && !asset.deletedAt)
        .reduce((sum, asset) => sum + Number(asset.byteSize || 0), 0);
      if (!existing && usedBytes + parsed.bytes.length > quotaBytes) {
        return res.status(413).json({
          error: 'ASSET_QUOTA_EXCEEDED',
          message: '云端素材容量已满，请删除不再使用的素材或联系系统用户提高容量',
          usedBytes,
          quotaBytes,
        });
      }

      const objectKey = assetStorage ? objectKeyFor(req.user.id, sha256, parsed.mimeType) : null;
      if (assetStorage && (!existing || !existing.objectKey)) {
        try {
          await assetStorage.put({ key: objectKey, bytes: parsed.bytes, mimeType: parsed.mimeType });
        } catch (error) {
          console.error('上传云端素材失败:', error);
          return storageError(res);
        }
      }

      const result = await mutateAssets((data) => {
        const stored = data.assets.find((asset) => asset.userId === req.user.id && asset.sha256 === sha256);
        if (stored?.deletedAt) stored.deletedAt = null;
        if (stored) {
          if (assetStorage && !stored.objectKey) {
            stored.objectKey = objectKey;
            stored.storageProvider = assetStorage.provider;
            stored.dataBase64 = null;
          }
          return { asset: stored, created: false };
        }
        const asset = {
          id: randomUUID(),
          userId: req.user.id,
          sha256,
          mimeType: parsed.mimeType,
          dataBase64: assetStorage ? null : parsed.bytes.toString('base64'),
          objectKey,
          storageProvider: assetStorage?.provider || 'database',
          byteSize: parsed.bytes.length,
          createdAt: now,
        };
        data.assets.push(asset);
        return { asset, created: true };
      });

      return res.status(result.created ? 201 : 200).json({
        asset: {
          id: result.asset.id,
          url: getStableAssetUrl(result.asset.id),
          mimeType: result.asset.mimeType,
          byteSize: result.asset.byteSize,
        },
      });
    } catch (error) {
      return next(error);
    }
  });
}
