const MAX_PROJECT_BYTES = 20 * 1024 * 1024;

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
  if (Buffer.byteLength(JSON.stringify(project), 'utf8') > MAX_PROJECT_BYTES) throw new Error('项目数据不能超过 2 MB');
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
    return res.json({ project: record.projectData });
  });

  router.put('/:id', async (req, res) => {
    try {
      const project = normalizeProject(req.body.project, req.params.id);
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
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
      await db.mutate((data) => {
        if (existingIndex >= 0) data.projects[existingIndex] = record;
        else data.projects.push(record);
      });
      return res.status(existingIndex >= 0 ? 200 : 201).json({ project: projectInfo(record) });
    } catch (error) {
      return res.status(400).json({ error: 'PROJECT_VALIDATION_ERROR', message: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    const existing = db.read('projects').find((item) => item.id === req.params.id && item.userId === req.user.id);
    if (!existing) return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在' });
    await db.mutate((data) => { data.projects = data.projects.filter((item) => item.id !== existing.id); });
    return res.status(204).end();
  });
}
