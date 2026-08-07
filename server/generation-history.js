import { randomUUID } from 'node:crypto';

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

export function registerGenerationHistoryRoutes(router, { db, requireAuth }) {
  router.use(requireAuth);
  router.get('/', async (req, res) => {
    const now = Date.now();
    await db.mutate((data) => { data.generationHistory = data.generationHistory.filter((item) => Date.parse(item.expiresAt) > now); });
    const history = db.read('generationHistory').filter((item) => item.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.json({ history });
  });
  router.post('/', async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url || !/^https?:|^data:/.test(url)) return res.status(400).json({ error: 'INVALID_URL', message: '生成结果地址无效' });
    const createdAt = new Date();
    const record = { id: randomUUID(), userId: req.user.id, projectId: String(req.body.projectId || '').slice(0, 100), nodeId: String(req.body.nodeId || '').slice(0, 100) || null, type: String(req.body.type || 'video').slice(0, 20), prompt: String(req.body.prompt || '').slice(0, 10000), url, thumbnail: String(req.body.thumbnail || '').trim() || null, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + THREE_DAYS).toISOString() };
    await db.mutate((data) => { data.generationHistory = data.generationHistory.filter((item) => Date.parse(item.expiresAt) > Date.now()); data.generationHistory.push(record); });
    return res.status(201).json({ item: record });
  });
}
