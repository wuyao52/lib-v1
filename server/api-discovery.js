import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PROVIDERS = [
  ['openai.com', 'OpenAI'], ['deepseek.com', 'DeepSeek'], ['anthropic.com', 'Anthropic'],
  ['googleapis.com', 'Google'], ['volcengineapi.com', '火山引擎'], ['byteplusapi.com', 'BytePlus'],
  ['aliyuncs.com', '阿里云'], ['siliconflow.cn', 'SiliconFlow'], ['openrouter.ai', 'OpenRouter'], ['weijinapi.top', 'WeijinAPI'],
];

const SHISHIKEJI_VIDEO_MODELS = [
  ['transit9-fast', '9图 Fast', ['720p']],
  ['transit9-2.0', '9图 2.0', ['720p', '1080p']],
  ['xinghe-mini', '星核 MINI', ['720p']],
  ['xinghe-fast', '星核 FAST', ['720p']],
  ['xinghe-2.0', '星核 2.0', ['480p', '720p', '1080p', '4k']],
  ['xinghe-2.0-12s', '星核 2.0 12秒', ['720p']],
  ['xinghe-2.5-12s', '星核 2.5 12秒', ['720p']],
  ['xingmiao-2.0', '星妙 2.0', ['480p', '720p', '1080p', '4k']],
  ['xingmiao-2.5', '星妙 2.5', ['720p']],
  ['canfei-fast', '残废 FAST', ['720p']],
  ['canfei-2.0', '残废 2.0', ['480p', '720p', '1080p', '4k']],
  ['jiaban-2.0', '错峰加班-2.0', ['720p']],
].map(([id, name, supportedResolutions]) => ({ id, name, type: 'video', supportedResolutions }));

const BOYESIR_VIDEO_MODELS = [
  ['nd-seedance-2.0-720p', 'Seedance 2.0 720p', ['720p'], null],
  ['nd-seedance-2.0-480p', 'Seedance 2.0 480p', ['480p'], [5, 10, 15]],
  ['seedance2.0-480p-100%', 'Seedance 2.0 480p', ['480p'], [4, 5, 6, 8, 10, 12, 15]],
  ['seedance2.0-720p-100%', 'Seedance 2.0 720p', ['720p'], [4, 5, 6, 8, 10, 12, 15]],
  ['seedance2.0-1080p-100%', 'Seedance 2.0 1080p', ['1080p'], [4, 5, 6, 8, 10, 12, 15]],
  ['seedance-fast-2.0', 'Seedance Fast 2.0', ['480p', '720p', '1080p'], [4, 5, 6, 8, 10, 12]],
  ['seedance-2.0-mini', 'Seedance 2.0 Mini', ['480p', '720p'], [4, 5, 6, 8, 10, 12]],
  ['kling-3.0-turbo', 'Kling 3.0 Turbo', ['720p', '1080p', '2k', '4k'], [4, 5, 6, 8, 10, 12]],
].map(([id, name, supportedResolutions, allowedDurationsSec]) => ({
  id, name, type: 'video', supportedResolutions,
  ...(allowedDurationsSec ? { allowedDurationsSec } : {}),
}));

export function knownVideoResolutions(provider, modelId) {
  const models = /时时科技/i.test(String(provider || '')) ? SHISHIKEJI_VIDEO_MODELS
    : /BYS|boyesir/i.test(String(provider || '')) ? BOYESIR_VIDEO_MODELS : [];
  return models.find((model) => model.id === modelId)?.supportedResolutions || [];
}

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
    const durations = model?.durations_seconds ?? model?.durationsSeconds ?? model?.allowed_durations_sec;
    const ratios = model?.ratios ?? model?.aspect_ratios ?? model?.aspectRatios;
    const maxImages = model?.max_images ?? model?.maxReferenceImages;
    const maxVideos = model?.max_videos ?? model?.maxReferenceVideos;
    const maxAudios = model?.max_audios ?? model?.maxReferenceAudios;
    const type = String(model?.type ?? model?.category ?? model?.task ?? '').trim().slice(0, 80)
      || (durations || ratios || maxImages !== undefined || maxVideos !== undefined || maxAudios !== undefined ? 'video' : '');
    return {
      id,
      name: String(model?.display_name ?? model?.displayName ?? model?.name ?? id).trim().slice(0, 160),
      type,
      owner: String(model?.owned_by ?? model?.provider ?? model?.organization ?? '').trim().slice(0, 80),
      ...(Array.isArray(durations) ? { allowedDurationsSec: durations.map(Number).filter(Number.isFinite) } : {}),
      ...(Array.isArray(ratios) ? { supportedRatios: ratios.map((value) => String(value).trim()).filter(Boolean) } : {}),
      ...(model?.resolution ? { supportedResolutions: [String(model.resolution).trim().toLowerCase()] } : {}),
      ...(Number.isFinite(Number(maxImages)) ? { maxReferenceImages: Number(maxImages) } : {}),
      ...(Number.isFinite(Number(maxVideos)) ? { maxReferenceVideos: Number(maxVideos) } : {}),
      ...(Number.isFinite(Number(maxAudios)) ? { maxReferenceAudios: Number(maxAudios) } : {}),
      ...(model?.audio_requires_image !== undefined ? { audioRequiresImage: Boolean(model.audio_requires_image) } : {}),
      ...(model?.pricing && typeof model.pricing === 'object' ? { pricing: model.pricing } : {}),
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
      models: SHISHIKEJI_VIDEO_MODELS.map((model) => ({ ...model })),
    };
  }
  if (['boyesir.icu', 'www.boyesir.icu'].includes(base.hostname.toLowerCase())) {
    return { name: 'BYS api 视频 API', provider: 'BYS api', models: BOYESIR_VIDEO_MODELS.map((model) => ({ ...model })) };
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
