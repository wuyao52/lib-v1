import { createHash, randomUUID } from 'node:crypto';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/;

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

export function registerAssetRoutes(router, { db, requireAuth }) {
  router.get('/public/:id', (req, res) => {
    const asset = db.read('assets').find((entry) => entry.id === req.params.id);
    if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND', message: '图片不存在' });

    const bytes = Buffer.from(asset.dataBase64, 'base64');
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
      const result = await db.mutate((data) => {
        const existing = data.assets.find((asset) => asset.userId === req.user.id && asset.sha256 === sha256);
        if (existing) return { asset: existing, created: false };
        const asset = {
          id: randomUUID(),
          userId: req.user.id,
          sha256,
          mimeType: parsed.mimeType,
          dataBase64: parsed.bytes.toString('base64'),
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

