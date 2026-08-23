import { randomUUID } from 'node:crypto';

const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
const MAX_PROJECT_REVISIONS = 30;

function trimProjectRevisions(data, projectId) {
  const revisions = (data.projectRevisions || []).filter((item) => item.projectId === projectId);
  if (revisions.length <= MAX_PROJECT_REVISIONS) return;
  const keep = new Set(revisions
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, MAX_PROJECT_REVISIONS)
    .map((item) => item.id));
  data.projectRevisions = data.projectRevisions.filter((item) => item.projectId !== projectId || keep.has(item.id));
}

function projectInfo(record) {
  const project = record.projectData;
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sceneCount: Array.isArray(project.nodes) ? project.nodes.length : 0,
    thumbnail: project.thumbnail,
    version: Number(record.version || 1),
  };
}

function sanitizeModel(model) {
  return model && typeof model === 'object' ? { ...model, apiKey: '' } : model;
}

function normalizeProject(input, routeId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目数据格式无效');
  const id = String(input.id || '').trim();
  if (!id || id !== routeId || id.length > 100) throw new Error('项目 ID 无效');
  const title = String(input.title || '').trim().slice(0, 160);
  if (!title) throw new Error('项目标题不能为空');
  const description = String(input.description || '').trim().slice(0, 5000);
  const createdAt = String(input.createdAt || new Date().toISOString());
  const updatedAt = String(input.updatedAt || new Date().toISOString());
  const project = {
    ...input,
    id,
    title,
    description,
    createdAt,
    updatedAt,
    nodes: Array.isArray(input.nodes) ? input.nodes : [],
    edges: Array.isArray(input.edges) ? input.edges : [],
    settings: {
      ...(input.settings || {}),
      aiModel: sanitizeModel(input.settings?.aiModel),
      multiModel: input.settings?.multiModel ? {
        textModel: sanitizeModel(input.settings.multiModel.textModel),
        videoModel: sanitizeModel(input.settings.multiModel.videoModel),
        imageModel: sanitizeModel(input.settings.multiModel.imageModel),
      } : undefined,
    },
  };
  if (Buffer.byteLength(JSON.stringify(project), 'utf8') > MAX_PROJECT_BYTES) throw new Error('项目数据不能超过 20 MB');
  return project;
}

export function registerProjectRoutes(router, { db, requireAuth }) {
  router.use(requireAuth);

  router.get('/', (req, res) => {
    const projects = db.read('projects')
      .filter((record) => record.userId === req.user.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(projectInfo);
    return res.json({ projects });
  });

  router.get('/:id', (req, res) => {
    const record = db.read('projects').find((item) => item.id === req.params.id && item.userId === req.user.id);
    if (!record) return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在' });
    return res.json({ project: { ...record.projectData, version: Number(record.version || 1) } });
  });

  router.get('/:id/revisions', (req, res) => {
    const current = db.read('projects').find((item) => item.id === req.params.id && item.userId === req.user.id);
    if (!current) return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在' });
    const revisions = (db.read('projectRevisions') || []).filter((item) => item.projectId === current.id && item.userId === req.user.id)
      .sort((a, b) => Number(b.version) - Number(a.version)).slice(0, 30)
      .map((item) => ({ id: item.id, version: item.version, createdAt: item.createdAt, reason: item.reason, title: item.projectData.title, sceneCount: Array.isArray(item.projectData.nodes) ? item.projectData.nodes.length : 0 }));
    return res.json({ currentVersion: Number(current.version || 1), revisions });
  });

  router.put('/:id', async (req, res) => {
    try {
      const project = normalizeProject(req.body.project, req.params.id);
      const expectedVersion = Number(req.body.expectedVersion ?? project.version ?? 0);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return res.status(400).json({ error: 'INVALID_PROJECT_VERSION', message: '项目版本无效' });
      const existingIndex = db.read('projects').findIndex((item) => item.id === project.id);
      if (existingIndex >= 0 && db.read('projects')[existingIndex].userId !== req.user.id) {
        return res.status(409).json({ error: 'PROJECT_ID_CONFLICT', message: '项目 ID 已被占用' });
      }
      const record = {
        id: project.id,
        userId: req.user.id,
        title: project.title,
        description: project.description,
        projectData: project,
        version: expectedVersion + 1,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
      if (db.saveProject) {
        const saved = await db.saveProject(record, expectedVersion);
        if (saved.conflict) return res.status(409).json({ error: 'PROJECT_VERSION_CONFLICT', message: '项目已在其他页面或设备更新，请重新加载后再编辑' });
        return res.status(expectedVersion > 0 ? 200 : 201).json({ project: projectInfo(saved.record) });
      }
      let conflict = false;
      await db.mutate((data) => {
        const index = data.projects.findIndex((item) => item.id === project.id);
        const currentVersion = index >= 0 ? Number(data.projects[index].version || 1) : 0;
        if (currentVersion !== expectedVersion) { conflict = true; return; }
        if (index >= 0) {
          const previous = data.projects[index];
          data.projectRevisions ||= [];
          data.projectRevisions.push({ id: randomUUID(), projectId: previous.id, userId: previous.userId, version: currentVersion, projectData: previous.projectData, createdAt: new Date().toISOString(), reason: 'save' });
          trimProjectRevisions(data, project.id);
          data.projects[index] = record;
        }
        else data.projects.push(record);
      });
      if (conflict) return res.status(409).json({ error: 'PROJECT_VERSION_CONFLICT', message: '项目已在其他页面或设备更新，请重新加载后再编辑' });
      return res.status(expectedVersion > 0 ? 200 : 201).json({ project: projectInfo(record) });
    } catch (error) {
      return res.status(400).json({ error: 'PROJECT_VALIDATION_ERROR', message: error.message });
    }
  });

  router.post('/:id/revisions/:revisionId/restore', async (req, res) => {
    const current = db.read('projects').find((item) => item.id === req.params.id && item.userId === req.user.id);
    const revision = (db.read('projectRevisions') || []).find((item) => item.id === req.params.revisionId && item.projectId === req.params.id && item.userId === req.user.id);
    if (!current || !revision) return res.status(404).json({ error: 'PROJECT_REVISION_NOT_FOUND', message: '项目恢复版本不存在' });
    const expectedVersion = Number(req.body?.expectedVersion ?? current.version);
    if (expectedVersion !== Number(current.version)) return res.status(409).json({ error: 'PROJECT_VERSION_CONFLICT', message: '项目已更新，请刷新后再恢复' });
    const restored = normalizeProject({ ...revision.projectData, id: current.id, updatedAt: new Date().toISOString() }, current.id);
    const record = { ...current, title: restored.title, description: restored.description, projectData: restored, version: expectedVersion + 1, updatedAt: restored.updatedAt };
    if (db.saveProject) {
      const saved = await db.saveProject(record, expectedVersion);
      if (saved.conflict) return res.status(409).json({ error: 'PROJECT_VERSION_CONFLICT', message: '项目已更新，请刷新后再恢复' });
      return res.json({ project: projectInfo(saved.record), restoredFromVersion: revision.version });
    }
    let conflict = false;
    await db.mutate((data) => {
      const index = data.projects.findIndex((item) => item.id === current.id && item.userId === req.user.id);
      if (index < 0 || Number(data.projects[index].version) !== expectedVersion) { conflict = true; return; }
      (data.projectRevisions ||= []).push({ id: randomUUID(), projectId: current.id, userId: current.userId, version: Number(current.version), projectData: current.projectData, createdAt: new Date().toISOString(), reason: 'restore' });
      trimProjectRevisions(data, current.id);
      data.projects[index] = record;
    });
    if (conflict) return res.status(409).json({ error: 'PROJECT_VERSION_CONFLICT', message: '项目已更新，请刷新后再恢复' });
    return res.json({ project: projectInfo(record), restoredFromVersion: revision.version });
  });

  router.delete('/:id', async (req, res) => {
    const existing = db.read('projects').find((item) => item.id === req.params.id && item.userId === req.user.id);
    if (!existing) return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在' });
    await db.mutate((data) => { data.projects = data.projects.filter((item) => item.id !== existing.id); });
    return res.status(204).end();
  });
}
