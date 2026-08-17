import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PROVIDERS = [
  ['openai.com', 'OpenAI'], ['deepseek.com', 'DeepSeek'], ['anthropic.com', 'Anthropic'],
  ['googleapis.com', 'Google'], ['volcengineapi.com', '火山引擎'], ['byteplusapi.com', 'BytePlus'],
  ['aliyuncs.com', '阿里云'], ['siliconflow.cn', 'SiliconFlow'], ['openrouter.ai', 'OpenRouter'],
];

function isPrivateIp(address) {
  if (address === '::1' || address === '::' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  if (address.startsWith('::ffff:')) return isPrivateIp(address.slice(7));
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export async function assertPublicHost(hostname, resolveHost = lookup) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('不允许访问本地或内网地址');
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolveHost(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error('不允许访问本地或内网地址');
}

function modelsFromPayload(payload) {
  const candidates = payload?.data?.models ?? payload?.models ?? payload?.data ?? payload?.items ?? [];
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, 1000).map((model) => {
    if (typeof model === 'string') return { id: model, name: model, type: '' };
    const id = String(model?.id ?? model?.model ?? model?.name ?? '').trim().slice(0, 160);
    if (!id) return null;
    return {
      id,
      name: String(model?.display_name ?? model?.displayName ?? model?.name ?? id).trim().slice(0, 160),
      type: String(model?.type ?? model?.category ?? model?.task ?? '').trim().slice(0, 80),
      owner: String(model?.owned_by ?? model?.provider ?? model?.organization ?? '').trim().slice(0, 80),
    };
  }).filter(Boolean);
}

function inferProvider(url, payload, models) {
  const declared = String(payload?.provider ?? payload?.organization ?? '').trim().slice(0, 80);
  if (declared) return declared;
  const owner = models.map((model) => model.owner).find(Boolean);
  if (owner && owner !== 'system') return owner;
  const known = PROVIDERS.find(([domain]) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  if (known) return known[1];
  return url.hostname.replace(/^api\./, '').split('.')[0] || 'OpenAI Compatible';
}

export async function discoverSystemApi({ baseUrl, apiKey, fetchImpl = fetch, resolveHost = lookup }) {
  let base;
  try { base = new URL(String(baseUrl || '').trim().replace(/\/+$/, '')); } catch { throw new Error('API 地址无效'); }
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('自动识别只允许不含账号信息的 HTTPS 地址');
  if (String(apiKey || '').trim().length < 8) throw new Error('请先填写有效的 API Key');
  await assertPublicHost(base.hostname, resolveHost);
  if (base.hostname.toLowerCase() === 'api.shishikeji.com') {
    return {
      name: '时时科技视频 API', provider: '时时科技',
      models: [{ id: 'xinghe-2.0', name: '星河 2.0', type: 'video' }],
    };
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  const modelsUrl = new URL(`${base.origin}${basePath.endsWith('/v1') ? basePath : `${basePath}/v1`}/models`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(modelsUrl, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: new Headers({ accept: 'application/json', authorization: `Bearer ${String(apiKey).trim()}`, 'x-api-key': String(apiKey).trim() }),
    });
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('模型目录响应过大');
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('API 未返回有效的 JSON 模型目录'); }
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `模型目录请求失败 (${response.status})`);
    const models = modelsFromPayload(payload);
    const provider = inferProvider(base, payload, models);
    return { name: String(payload?.service_name ?? payload?.serviceName ?? `${provider} API`).slice(0, 100), provider, models: models.map(({ owner, ...model }) => model) };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('API 自动识别超时');
    throw error;
  } finally { clearTimeout(timeout); }
}
