import { createHash, randomUUID } from 'node:crypto';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/;
const DEFAULT_USER_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

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

function getPublicAssetUrl(req, id) {
  const configuredOrigin = String(process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');
  const requestOrigin = `${req.protocol}://${req.get('host')}`;
  return `${configuredOrigin || requestOrigin}/api/assets/public/${id}`;
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

export function registerAssetRoutes(router, { db, requireAuth, assetStorage = null }) {
  router.get('/public/:id', async (req, res) => {
    const asset = db.read('assets').find((entry) => entry.id === req.params.id);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '图片不存在' });

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
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(bytes);
  });

  router.post('/', requireAuth, async (req, res, next) => {
    try {
      const parsed = parseImageDataUrl(req.body?.dataUrl);
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
          url: getPublicAssetUrl(req, result.asset.id),
          mimeType: result.asset.mimeType,
          byteSize: result.asset.byteSize,
        },
      });
    } catch (error) {
      return next(error);
    }
  });
}
