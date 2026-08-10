import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { assertPublicHost, discoverSystemApi } from './api-discovery.js';
import { fetchWithTimeout, readLimitedBody, resourceGuardConfig } from './resource-guard.js';

const nowIso = () => new Date().toISOString();

function publicConfig(config) {
  return {
    id: config.id,
    name: config.name,
    provider: config.provider,
    baseUrl: `/api/user-ai/${config.id}`,
    hasApiKey: Boolean(config.encryptedApiKey),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    enabled: config.enabled !== false,
    disabledAt: config.disabledAt || null,
  };
}

function parseBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim().replace(/\/+$/, '')); } catch { throw new Error('API 地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('自定义 API 必须使用不含账号信息的 HTTPS 地址');
  return url;
}

function targetFrom(baseUrl, relativeUrl) {
  const base = new URL(`${baseUrl.replace(/\/+$/, '')}/`);
  const target = new URL(String(relativeUrl || '/').replace(/^\/+/, ''), base);
  const expectedPath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if (target.protocol !== 'https:' || target.origin !== base.origin || !target.pathname.startsWith(expectedPath)) {
    const error = new Error('请求路径不被允许'); error.code = 'INVALID_UPSTREAM_PATH'; throw error;
  }
  return target;
}

export function registerUserApiConfigRoutes(router, { db, requireAuth, vault, fetchImpl = fetch, resolveHost = lookup }) {
  router.use(requireAuth);

  router.get('/', (req, res) => {
    const configs = db.read('userApiConfigs').filter((item) => item.userId === req.user.id).map(publicConfig);
    return res.json({ configs });
  });

  router.post('/discover', async (req, res) => {
    try {
      const result = await discoverSystemApi({ baseUrl: req.body?.baseUrl, apiKey: req.body?.apiKey, fetchImpl, resolveHost });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: 'API_DISCOVERY_FAILED', message: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const baseUrl = parseBaseUrl(req.body?.baseUrl);
      const apiKey = String(req.body?.apiKey || '').trim();
      const name = String(req.body?.name || '').trim().slice(0, 100);
      const provider = String(req.body?.provider || 'Custom').trim().slice(0, 80);
      if (!name || apiKey.length < 8) return res.status(400).json({ error: 'INVALID_API_CONFIG', message: '名称不能为空，API Key 至少需要 8 个字符' });
      await assertPublicHost(baseUrl.hostname, resolveHost);
      const record = { id: randomUUID(), userId: req.user.id, name, provider, encryptedBaseUrl: vault.encrypt(baseUrl.toString().replace(/\/$/, '')), encryptedApiKey: vault.encrypt(apiKey), enabled: true, disabledAt: null, createdAt: nowIso(), updatedAt: nowIso() };
      await db.mutate((data) => data.userApiConfigs.push(record));
      return res.status(201).json({ config: publicConfig(record) });
    } catch (error) {
      return res.status(400).json({ error: 'INVALID_API_CONFIG', message: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    let updated; let missing = false;
    try {
      const suppliedUrl = req.body?.baseUrl ? parseBaseUrl(req.body.baseUrl) : null;
      if (suppliedUrl) await assertPublicHost(suppliedUrl.hostname, resolveHost);
      await db.mutate((data) => {
        const config = data.userApiConfigs.find((item) => item.id === req.params.id && item.userId === req.user.id);
        if (!config) { missing = true; return; }
        const name = String(req.body?.name ?? config.name).trim().slice(0, 100);
        const provider = String(req.body?.provider ?? config.provider).trim().slice(0, 80);
        if (!name || !provider) throw new Error('名称和服务商不能为空');
        config.name = name; config.provider = provider;
        if (req.body?.enabled !== undefined) {
          config.enabled = Boolean(req.body.enabled);
          config.disabledAt = config.enabled ? null : nowIso();
        }
        if (suppliedUrl) config.encryptedBaseUrl = vault.encrypt(suppliedUrl.toString().replace(/\/$/, ''));
        const apiKey = String(req.body?.apiKey || '').trim();
        if (apiKey) {
          if (apiKey.length < 8) throw new Error('API Key 至少需要 8 个字符');
          config.encryptedApiKey = vault.encrypt(apiKey);
        }
        config.updatedAt = nowIso(); updated = publicConfig(config);
      });
      if (missing) return res.status(404).json({ error: 'API_CONFIG_NOT_FOUND', message: 'API 配置不存在' });
      return res.json({ config: updated });
    } catch (error) {
      return res.status(400).json({ error: 'INVALID_API_CONFIG', message: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    let removed = false; let affectedProjects = 0;
    await db.mutate((data) => {
      const config = data.userApiConfigs.find((item) => item.id === req.params.id && item.userId === req.user.id);
      if (config) {
        affectedProjects = data.projects.filter((project) => JSON.stringify(project.projectData || {}).includes(config.id)).length;
        config.enabled = false; config.disabledAt = nowIso(); config.updatedAt = nowIso(); removed = true;
      }
    });
    if (!removed) return res.status(404).json({ error: 'API_CONFIG_NOT_FOUND', message: 'API 配置不存在' });
    return res.json({ disabled: true, affectedProjects });
  });
}

export function registerUserAiRoutes(router, { db, requireAuth, vault, fetchImpl = fetch, resolveHost = lookup }) {
  router.use(requireAuth);
  router.use('/:configId', async (req, res) => {
    const config = db.read('userApiConfigs').find((item) => item.id === req.params.configId && item.userId === req.user.id);
    if (!config) return res.status(404).json({ error: 'API_CONFIG_NOT_FOUND', message: 'API 配置不存在' });
    if (config.enabled === false) return res.status(410).json({ error: 'API_CONFIG_DISABLED', message: '此 API 配置已停用' });
    try {
      const baseUrl = vault.decrypt(config.encryptedBaseUrl);
      const base = parseBaseUrl(baseUrl);
      await assertPublicHost(base.hostname, resolveHost);
      const marker = `/api/user-ai/${config.id}`;
      const relativeUrl = req.originalUrl.slice(req.originalUrl.indexOf(marker) + marker.length) || '/';
      const target = targetFrom(baseUrl, relativeUrl);
      // Resolve immediately before outbound I/O as a defense against DNS rebinding after configuration validation.
      await assertPublicHost(target.hostname, resolveHost);
      const apiKey = vault.decrypt(config.encryptedApiKey);
      const contentType = String(req.headers['content-type'] || 'application/json');
      if (!/^application\/json|^multipart\/form-data|^application\/x-www-form-urlencoded/i.test(contentType)) return res.status(415).json({ error: 'UNSUPPORTED_CONTENT_TYPE', message: '不支持的请求内容类型' });
      const headers = new Headers({ accept: req.headers.accept || 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'content-type': contentType });
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : (req.rawBody || (Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body || {})));
      const limits = resourceGuardConfig();
      const upstream = await fetchWithTimeout(fetchImpl, target, { method: req.method, headers, body, redirect: 'manual' }, limits.timeoutMs);
      const responseBody = await readLimitedBody(upstream, limits.maxResponseBytes);
      res.status(upstream.status);
      res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      return res.send(responseBody);
    } catch (error) {
      if (error.code === 'INVALID_UPSTREAM_PATH') return res.status(400).json({ error: error.code, message: error.message });
      if (error.code === 'UPSTREAM_RESPONSE_TOO_LARGE') return res.status(502).json({ error: error.code, message: error.message });
      if (error.name === 'AbortError') return res.status(504).json({ error: 'UPSTREAM_TIMEOUT', message: '自定义 AI 服务响应超时，请稍后重试' });
      return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE', message: '自定义 AI 服务暂时不可用' });
    }
  });
}
