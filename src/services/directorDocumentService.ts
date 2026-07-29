import type { StoryboardPlan } from '@/types/director';
import { apiRequest } from '@/services/apiClient';

const MAX_SCRIPT_FILE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['txt', 'md', 'markdown', 'fountain', 'json', 'doc', 'docx'];
const SCRIPT_KEYS = ['story', 'script', 'content', 'text'] as const;

function extractJsonScript(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(extractJsonScript).filter(Boolean).join('\n\n');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of SCRIPT_KEYS) {
      const extracted = extractJsonScript(record[key]);
      if (extracted) return extracted;
    }
    if (Array.isArray(record.scenes)) return extractJsonScript(record.scenes);
  }
  return '';
}

export async function readDirectorScriptFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new Error('仅支持 TXT、Markdown、Fountain、JSON、DOC 和 DOCX 剧本文件');
  }
  if (file.size > MAX_SCRIPT_FILE_BYTES) throw new Error('剧本文件不能超过 10 MB');

  if (extension === 'doc' || extension === 'docx') {
    const formData = new FormData();
    formData.append('file', file);
    const result = await apiRequest<{ text: string }>('/api/director/script-import', { method: 'POST', body: formData });
    return result.text;
  }

  const raw = (await file.text()).replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('剧本文件内容为空');
  if (extension !== 'json') return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JSON 文件格式无效');
  }
  const script = extractJsonScript(parsed);
  if (!script) throw new Error('JSON 中未找到 story、script、content、text 或 scenes 内容');
  return script;
}

export function formatStoryboardForClipboard(plan: StoryboardPlan) {
  const lines = [
    plan.title,
    `故事梗概：${plan.storySummary}`,
    `故事承诺：${plan.storyPromise}`,
    `最终结果：${plan.finalOutcome}`,
    `导演声音：${plan.directorVoice.name}`,
    `总时长：${plan.shots.reduce((sum, shot) => sum + shot.targetDurationSec, 0)} 秒`,
    `时长依据：${plan.durationRecommendationReason}`,
    '',
  ];
  plan.shots.forEach((shot) => {
    lines.push(`${shot.title}｜${shot.sceneId}｜${shot.targetDurationSec}s`);
    lines.push(`叙事任务：${shot.narrativeJob}`);
    lines.push(`镜头：${shot.camera}`);
    lines.push(`结束状态：${shot.plannedEndState}`);
    lines.push(`提示词：${shot.prompt}`, '');
  });
  return lines.join('\n').trim();
}

export async function copyDirectorText(text: string) {
  if (!text.trim()) throw new Error('没有可复制的内容');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('浏览器未允许复制，请检查剪贴板权限');
}
