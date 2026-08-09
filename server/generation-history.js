import { randomUUID } from 'node:crypto';

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

const encodeCursor = (item) => Buffer.from(JSON.stringify([item.createdAt, item.id])).toString('base64url');
const decodeCursor = (value) => {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    return typeof createdAt === 'string' && typeof id === 'string' ? { createdAt, id } : null;
  } catch { return null; }
};

export function registerGenerationHistoryRoutes(router, { db, requireAuth }) {
  router.use(requireAuth);
  router.get('/', async (req, res) => {
    const now = Date.now();
    await db.mutate((data) => { data.generationHistory = data.generationHistory.filter((item) => Date.parse(item.expiresAt) > now); });
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '50'), 10) || 50));
    const cursor = decodeCursor(req.query.cursor);
    const sorted = db.read('generationHistory').filter((item) => item.userId === req.user.id)
      .filter((item) => !cursor || item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id < cursor.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const history = sorted.slice(0, limit);
    return res.json({ history, nextCursor: sorted.length > limit && history.length ? encodeCursor(history.at(-1)) : null });
  });
  router.post('/', async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url || !/^https?:|^data:/.test(url)) return res.status(400).json({ error: 'INVALID_URL', message: '生成结果地址无效' });
    const existing = db.read('generationHistory').find((item) => item.userId === req.user.id && item.url === url && Date.parse(item.expiresAt) > Date.now());
    if (existing) return res.json({ item: existing });
    const createdAt = new Date();
    const record = { id: randomUUID(), userId: req.user.id, projectId: String(req.body.projectId || '').slice(0, 100), nodeId: String(req.body.nodeId || '').slice(0, 100) || null, type: String(req.body.type || 'video').slice(0, 20), prompt: String(req.body.prompt || '').slice(0, 10000), url, thumbnail: String(req.body.thumbnail || '').trim() || null, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + THREE_DAYS).toISOString() };
    await db.mutate((data) => { data.generationHistory = data.generationHistory.filter((item) => Date.parse(item.expiresAt) > Date.now()); data.generationHistory.push(record); });
    return res.status(201).json({ item: record });
  });
}
