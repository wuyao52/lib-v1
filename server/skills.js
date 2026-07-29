import { randomUUID } from 'node:crypto';

function parseFrontmatter(markdown) {
  const source = String(markdown || '').replace(/^\uFEFF/, '').trim();
  if (!source.startsWith('---')) return { metadata: {}, body: source };
  const end = source.indexOf('\n---', 3);
  if (end < 0) return { metadata: {}, body: source };
  const metadata = {};
  source.slice(3, end).split('\n').forEach((line) => {
    const separator = line.indexOf(':');
    if (separator < 1) return;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key === 'tags') value = value.replace(/^\[|\]$/g, '').split(',').map((item) => item.trim()).filter(Boolean);
    metadata[key] = value;
  });
  return { metadata, body: source.slice(end + 4).trim() };
}

function normalizeSkillInput(input) {
  const imported = input.markdown ? parseFrontmatter(input.markdown) : { metadata: {}, body: input.instructions };
  const name = String(input.name || imported.metadata.name || '').trim();
  const description = String(input.description || imported.metadata.description || '').trim();
  const instructions = String(input.instructions || imported.body || '').trim();
  const tagsValue = input.tags || imported.metadata.tags || [];
  const tags = (Array.isArray(tagsValue) ? tagsValue : String(tagsValue).split(','))
    .map((tag) => String(tag).trim().toLowerCase()).filter(Boolean).slice(0, 12);
  if (name.length < 2 || name.length > 80) throw new Error('Skill 名称长度需为 2-80 位');
  if (description.length > 300) throw new Error('Skill 描述不能超过 300 字');
  if (instructions.length < 10 || instructions.length > 50_000) throw new Error('Skill 指令长度需为 10-50000 字');
  return { name, description, instructions, tags };
}

function publicSkill(skill) {
  const { userId: _userId, ...result } = skill;
  return result;
}

export function registerSkillRoutes(router, { db, requireAuth }) {
  router.use(requireAuth);

  router.get('/', (req, res) => {
    const skills = db.read('skills').filter((skill) => skill.userId === req.user.id).map(publicSkill);
    res.json({ skills });
  });

  router.post('/', async (req, res) => {
    try {
      const now = new Date().toISOString();
      const skill = { id: randomUUID(), userId: req.user.id, ...normalizeSkillInput(req.body), createdAt: now, updatedAt: now };
      await db.mutate((data) => data.skills.push(skill));
      res.status(201).json({ skill: publicSkill(skill) });
    } catch (error) {
      res.status(400).json({ error: 'SKILL_VALIDATION_ERROR', message: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const index = db.read('skills').findIndex((skill) => skill.id === req.params.id && skill.userId === req.user.id);
      if (index < 0) return res.status(404).json({ error: 'SKILL_NOT_FOUND', message: 'Skill 不存在' });
      const updated = { ...db.read('skills')[index], ...normalizeSkillInput(req.body), updatedAt: new Date().toISOString() };
      await db.mutate((data) => { data.skills[index] = updated; });
      return res.json({ skill: publicSkill(updated) });
    } catch (error) {
      return res.status(400).json({ error: 'SKILL_VALIDATION_ERROR', message: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    const existing = db.read('skills').find((skill) => skill.id === req.params.id && skill.userId === req.user.id);
    if (!existing) return res.status(404).json({ error: 'SKILL_NOT_FOUND', message: 'Skill 不存在' });
    await db.mutate((data) => { data.skills = data.skills.filter((skill) => skill.id !== existing.id); });
    return res.status(204).end();
  });
}

export { parseFrontmatter };
