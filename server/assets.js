import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/;
const DEFAULT_USER_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_ASSET_RETENTION_DAYS = 30;
const ASSET_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

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
    return { error: 'ASSET_TOO_LARGE', message: '图片大小不能超过 8 MB' };
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
    if (req.body.length > MAX_ASSET_BYTES) return { error: 'ASSET_TOO_LARGE', message: '图片大小不能超过 8 MB' };
    return { bytes: Buffer.from(req.body), mimeType };
  }
  return parseImageDataUrl(req.body?.dataUrl);
}

const getStableAssetUrl = (id) => `/api/assets/public/${id}`;

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
    const createdAt = Date.parse(asset.createdAt);
    return Number.isFinite(createdAt)
      && createdAt <= cutoff
      && !assetIsReferenced(db, asset.userId, asset.id, now);
  });
  const deletedIds = [];
  const failedAssets = [];

  for (const asset of candidates) {
    try {
      if (asset.objectKey) {
        if (!assetStorage) throw new Error('Object storage is not configured');
        await assetStorage.delete(asset.objectKey);
      }
      deletedIds.push(asset.id);
    } catch (error) {
      failedAssets.push({ id: asset.id, error });
      onError(`Failed to automatically delete cloud asset ${asset.id}:`, error);
    }
  }

  if (deletedIds.length) {
    const deletedIdSet = new Set(deletedIds);
    await db.mutate((data) => {
      data.assets = data.assets.filter((asset) => !deletedIdSet.has(asset.id));
    });
  }
  return { deleted: deletedIds.length, failed: failedAssets.length, deletedIds, failedAssets };
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

export function registerAssetRoutes(router, { db, requireAuth, assetStorage = null, assetSigningKey }) {
  const signingKey = String(assetSigningKey || '');
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
    const asset = db.read('assets').find((entry) => entry.id === req.params.id);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '图片不存在' });
    const ownedBySession = req.user?.id === asset.userId;
    const signedAccess = validAssetSignature(asset.id, req.query.expires, req.query.signature, signingKey);
    if (!ownedBySession && !signedAccess) return res.status(401).json({ error: 'ASSET_ACCESS_DENIED', message: '素材访问链接无效或已过期' });

    let bytes;
    try {
      if (asset.objectKey) {
        if (!assetStorage) return storageError(res);
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
    const assets = db.read('assets').filter((asset) => asset.userId === req.user.id)
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

  router.get('/:id/signed-url', requireAuth, (req, res) => {
    const asset = db.read('assets').find((entry) => entry.id === req.params.id && entry.userId === req.user.id);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '素材不存在' });
    const expires = Date.now() + SIGNED_URL_TTL_MS;
    const url = new URL(getStableAssetUrl(asset.id), 'http://same-origin.invalid');
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signAssetAccess(asset.id, expires, signingKey));
    return res.json({ url: `${url.pathname}${url.search}`, expiresAt: new Date(expires).toISOString() });
  });

  router.delete('/:id', requireAuth, async (req, res) => {
    const asset = db.read('assets').find((entry) => entry.id === req.params.id && entry.userId === req.user.id);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '素材不存在' });
    if (assetIsReferenced(db, req.user.id, asset.id)) {
      return res.status(409).json({ error: 'ASSET_IN_USE', message: '该素材仍被项目或生成历史使用，不能删除' });
    }
    if (asset.objectKey) {
      if (!assetStorage) return storageError(res);
      try {
        await assetStorage.delete(asset.objectKey);
      } catch (error) {
        console.error('删除云端素材失败:', error);
        return storageError(res);
      }
    }
    await db.mutate((data) => { data.assets = data.assets.filter((entry) => entry.id !== asset.id); });
    return res.status(204).end();
  });

  router.post('/', requireAuth, async (req, res, next) => {
    try {
      const parsed = parseImageRequest(req);
      if (parsed.error) return res.status(parsed.error === 'ASSET_TOO_LARGE' ? 413 : 400).json(parsed);

      const sha256 = createHash('sha256').update(parsed.bytes).digest('hex');
      const now = new Date().toISOString();
      const existing = db.read('assets').find((asset) => asset.userId === req.user.id && asset.sha256 === sha256);
      const quotaBytes = Number(process.env.ASSET_USER_QUOTA_BYTES) || DEFAULT_USER_QUOTA_BYTES;
      const usedBytes = db.read('assets').filter((asset) => asset.userId === req.user.id)
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

      const result = await db.mutate((data) => {
        const stored = data.assets.find((asset) => asset.userId === req.user.id && asset.sha256 === sha256);
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
