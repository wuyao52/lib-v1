import type { AIModelConfig, DramaProject, TextModelProtocol } from '@/types';
import type { DirectorShot, StoryboardPlan } from '@/types/director';
import type { UserSkill } from '@/types/skill';

export type DirectorDurationMode = 'ai' | 'manual' | 'fixed-shot';

export interface GenerateAIStoryboardInput {
  project: DramaProject;
  story: string;
  voice: string;
  durationMode: DirectorDurationMode;
  manualDurationSec?: number;
  fixedShotDurationSec?: number;
  skills: UserSkill[];
  selectedBatchIndexes?: number[];
  selectedSourceSegmentIds?: string[];
  signal?: AbortSignal;
  onProgress?: (message: string, progress: number) => void;
  onBatchComplete?: (plan: StoryboardPlan, completedBatchCount: number, totalBatchCount: number) => void;
}

export interface StorySourceSegment {
  id: string;
  text: string;
}

export interface StorySourceBatch {
  index: number;
  segments: StorySourceSegment[];
}

export interface ParsedDirectorScript {
  shootableText: string;
  contextText: string;
  excludedSectionTitles: string[];
  hasStructuredSections: boolean;
}

const MAX_SOURCE_SEGMENT_CHARS = 700;
const SOURCE_SEGMENTS_PER_BATCH = 1;
const MAX_STORYBOARD_SHOTS = 1200;
// Director analysis runs through the Netlify API proxy, whose synchronous
// response window is much shorter than Railway's upstream text timeout.
// Keep each response small and use the existing continuation path as needed.
const DIRECTOR_MAX_COMPLETION_TOKENS = 900;

const DIRECTOR_VOICES: Record<string, StoryboardPlan['directorVoice']> = {
  naturalist: { name: '观察式自然主义', camera: '克制观察，动作驱动构图', light: '遵循场景中的自然光源', performance: '细小反应优先，避免夸张表演' },
  classicist: { name: '构图古典主义', camera: '稳定调度，清楚交代空间关系', light: '层次明确的经典布光', performance: '动作清晰，节奏严谨' },
  visceral: { name: '动势写实', camera: '贴近行动，保留可感知的惯性', light: '真实环境光与运动变化', performance: '身体动作和即时反应优先' },
  minimalist: { name: '亲密极简', camera: '少切换，靠近人物与关键物件', light: '简洁柔和，压低视觉噪声', performance: '留白、停顿和微表情优先' },
  formalist: { name: '图形式构成', camera: '几何构图与精确运动', light: '形状、色块和明暗关系明确', performance: '走位服从画面结构' },
};

const asText = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`文本模型返回缺少 ${field}`);
  return value.trim();
};

const asTextArray = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()).slice(0, 12)
  : [];

const clampDuration = (value: unknown) => Math.min(15, Math.max(5, Math.round(Number(value) || 5)));
export const normalizeFixedShotDuration = (value: unknown) => clampDuration(value);

export function findFixedDurationViolations(raw: any, input: Pick<GenerateAIStoryboardInput, 'durationMode' | 'fixedShotDurationSec'>): string[] {
  if (input.durationMode !== 'fixed-shot' || !Array.isArray(raw?.shots)) return [];
  const fixedDuration = normalizeFixedShotDuration(input.fixedShotDurationSec);
  return raw.shots.flatMap((shot: any, index: number) => (
    Number(shot?.targetDurationSec) === fixedDuration ? [] : [String(shot?.title || `镜头 ${index + 1}`)]
  ));
}

const METADATA_SECTION_PATTERN = /^(?:剧本信息|基本信息|项目信息|项目说明|创作说明|故事信息|故事大纲|剧情大纲|故事梗概|剧情梗概|内容梗概|人物形象|人物设定|角色设定|人物小传|角色小传|人物介绍|角色介绍|人物关系|角色关系|世界观|背景设定|美术设定|视觉设定|风格设定|创作背景|主题|核心主题|受众定位|制作信息|备注|附录)(?:\s*[:：].*)?$/i;
const BODY_SECTION_PATTERN = /^(?:剧本正文|剧情正文|故事正文|正文内容|分场剧本|分场正文|分集正文|场次正文|正文)(?:\s*[:：]\s*(.*))?$/i;

const unwrapHeading = (text: string) => text.trim()
  .replace(/^#{1,6}\s*/, '')
  .replace(/^(?:\*\*|__)(.*)(?:\*\*|__)$/, '$1')
  .replace(/^【(.*)】$/, '$1')
  .trim();

const isSceneHeading = (text: string) => /^(?:第.{1,10}[场幕集]|场景\s*[:：]?|(?:INT|EXT)\.|内景|外景|\d+[.、]\s*(?:内景|外景|INT|EXT)|【(?:第.{1,10}[场幕集]|场景|内景|外景|INT|EXT|SCENE|\d+)[^】]*】)/i.test(text.trim());

export function parseDirectorScript(story: string): ParsedDirectorScript {
  const lines = story.replace(/\r\n?/g, '\n').split('\n');
  const shootableLines: string[] = [];
  const contextLines: string[] = [];
  const pendingLines: string[] = [];
  const excludedSectionTitles: string[] = [];
  let mode: 'unknown' | 'metadata' | 'body' = 'unknown';
  let hasStructuredSections = false;

  const movePendingToContext = () => {
    if (pendingLines.length) contextLines.push(...pendingLines.splice(0));
  };

  for (const originalLine of lines) {
    const trimmed = originalLine.trim();
    const heading = unwrapHeading(trimmed);
    if (trimmed && METADATA_SECTION_PATTERN.test(heading)) {
      hasStructuredSections = true;
      movePendingToContext();
      mode = 'metadata';
      contextLines.push(originalLine);
      const title = heading.split(/[:：]/, 1)[0].trim();
      if (title && !excludedSectionTitles.includes(title)) excludedSectionTitles.push(title);
      continue;
    }

    const bodyMatch = trimmed ? heading.match(BODY_SECTION_PATTERN) : null;
    if (bodyMatch) {
      hasStructuredSections = true;
      movePendingToContext();
      mode = 'body';
      const inlineBody = bodyMatch[1]?.trim();
      if (inlineBody) shootableLines.push(inlineBody);
      continue;
    }

    if (trimmed && isSceneHeading(trimmed)) {
      hasStructuredSections = true;
      movePendingToContext();
      mode = 'body';
      shootableLines.push(originalLine);
      continue;
    }

    if (mode === 'metadata') contextLines.push(originalLine);
    else if (mode === 'body') shootableLines.push(originalLine);
    else pendingLines.push(originalLine);
  }

  if (!hasStructuredSections) {
    return { shootableText: story.trim(), contextText: '', excludedSectionTitles: [], hasStructuredSections: false };
  }
  movePendingToContext();
  return {
    shootableText: shootableLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    contextText: contextLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    excludedSectionTitles,
    hasStructuredSections: true,
  };
}

const recommendedMaxShots = (segments: StorySourceSegment[]) => Math.min(8, Math.max(2, Math.ceil(segments.reduce((sum, segment) => sum + segment.text.length, 0) / 120)));

const validatedMaxShots = (segments: StorySourceSegment[]) => {
  const recommended = recommendedMaxShots(segments);
  return recommended + (recommended >= 4 ? 1 : 0);
};

export function splitStoryIntoSourceSegments(story: string): StorySourceSegment[] {
  const shootableText = parseDirectorScript(story).shootableText;
  const units = shootableText.replace(/\r\n?/g, '\n').split(/\n+/).map((item) => item.trim()).filter(Boolean);
  const pieces: Array<{ text: string; startsScene: boolean }> = [];
  for (const unit of units) {
    const startsScene = isSceneHeading(unit);
    if (unit.length <= MAX_SOURCE_SEGMENT_CHARS) {
      pieces.push({ text: unit, startsScene });
      continue;
    }
    const sentences = unit.split(/(?<=[。！？!?；;])/u).map((item) => item.trim()).filter(Boolean);
    const sentenceParts = sentences.length ? sentences : [unit];
    for (let sentenceIndex = 0; sentenceIndex < sentenceParts.length; sentenceIndex += 1) {
      const sentence = sentenceParts[sentenceIndex];
      for (let offset = 0; offset < sentence.length; offset += MAX_SOURCE_SEGMENT_CHARS) {
        pieces.push({ text: sentence.slice(offset, offset + MAX_SOURCE_SEGMENT_CHARS), startsScene: startsScene && sentenceIndex === 0 && offset === 0 });
      }
    }
  }

  const packed: string[] = [];
  for (const piece of pieces) {
    const last = packed[packed.length - 1];
    if (!piece.startsScene && last && last.length + piece.text.length + 1 <= MAX_SOURCE_SEGMENT_CHARS) packed[packed.length - 1] = `${last}\n${piece.text}`;
    else packed.push(piece.text);
  }
  return packed.map((text, index) => ({ id: `source-${String(index + 1).padStart(3, '0')}`, text }));
}

export function getStoryboardSourceBatches(story: string): StorySourceBatch[] {
  const segments = splitStoryIntoSourceSegments(story);
  return Array.from({ length: Math.ceil(segments.length / SOURCE_SEGMENTS_PER_BATCH) }, (_, index) => ({
    index,
    segments: segments.slice(index * SOURCE_SEGMENTS_PER_BATCH, (index + 1) * SOURCE_SEGMENTS_PER_BATCH),
  }));
}

function fitManualTotal(shots: DirectorShot[], requestedDuration: number) {
  const target = Math.min(600, Math.max(10, Math.round(requestedDuration)));
  if (target < shots.length * 5 || target > shots.length * 15) {
    throw new Error(`AI 规划的 ${shots.length} 个镜头无法满足 ${target} 秒总时长，请重新生成`);
  }
  let difference = target - shots.reduce((sum, shot) => sum + shot.targetDurationSec, 0);
  const adjusted = shots.map((shot) => ({ ...shot }));
  while (difference !== 0) {
    let changed = false;
    for (const shot of adjusted) {
      if (difference > 0 && shot.targetDurationSec < 15) {
        shot.targetDurationSec += 1;
        difference -= 1;
        changed = true;
      } else if (difference < 0 && shot.targetDurationSec > 5) {
        shot.targetDurationSec -= 1;
        difference += 1;
        changed = true;
      }
      if (difference === 0) break;
    }
    if (!changed) break;
  }
  return adjusted;
}

function textCompletionUrl(baseUrl: string, protocol: Exclude<TextModelProtocol, 'auto'>) {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  const suffix = protocol === 'openai-chat' ? 'chat/completions' : protocol === 'openai-responses' ? 'responses' : 'messages';
  if (normalized.toLowerCase().endsWith(`/${suffix}`)) return normalized;
  return `${normalized}${/\/v1$/i.test(normalized) ? '' : '/v1'}/${suffix}`;
}

function directorCompletionUrl(model: AIModelConfig, protocol: Exclude<TextModelProtocol, 'auto'>) {
  const suffix = protocol === 'openai-chat' ? 'chat/completions' : protocol === 'openai-responses' ? 'responses' : 'messages';
  // Managed credentials must stay on the server. Routing through the managed
  // gateway also applies provider-specific headers, timeouts and billing.
  if (model.managed && model.apiId) {
    return `/api/system-ai/${encodeURIComponent(model.apiId)}/v1/${suffix}`;
  }
  return textCompletionUrl(model.baseUrl, protocol);
}

export function resolveDirectorTextModel(project: DramaProject): AIModelConfig | null {
  const model = project.settings.multiModel?.textModel;
  return (model?.managed || model?.credentialManaged || model?.apiKey?.trim()) && model?.baseUrl?.trim() && model?.modelId?.trim() ? model : null;
}

function extractMessageContent(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  }
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (Array.isArray(payload?.output)) {
    const output = payload.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
      .map((part: any) => typeof part === 'string' ? part : part?.text || part?.output_text || '')
      .join('');
    if (output) return output;
  }
  if (Array.isArray(payload?.content)) {
    const anthropic = payload.content.map((part: any) => typeof part === 'string' ? part : part?.text || '').join('');
    if (anthropic) return anthropic;
  }
  throw new Error(payload?.error?.message || payload?.message || '文本模型没有返回可读取的分镜内容');
}

function parseJsonContent(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  try {
    return JSON.parse(fenced || trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* handled below */ }
    }
    throw new Error('文本模型返回的分镜不是有效 JSON，请更换支持结构化输出的文本模型后重试');
  }
}

function bindSingleSourceCoverage(raw: any, expectedIds: string[]) {
  if (expectedIds.length !== 1 || !raw || !Array.isArray(raw.shots) || raw.shots.length === 0) return raw;
  const sourceId = expectedIds[0];
  return {
    ...raw,
    coveredSourceIds: [sourceId],
    shots: raw.shots.map((shot: any) => ({ ...shot, sourceSegmentIds: [sourceId] })),
  };
}

const normalizeEvidenceText = (value: string) => value
  .normalize('NFKC')
  .replace(/[\p{P}\p{S}\s]/gu, '');

function findUngroundedShotTitles(raw: any, segments: StorySourceSegment[]) {
  if (!Array.isArray(raw?.shots)) return [];
  const sourceById = new Map(segments.map((segment) => [segment.id, normalizeEvidenceText(segment.text)]));
  return raw.shots.filter((shot: any) => {
    const evidence = typeof shot?.sourceEvidence === 'string' ? normalizeEvidenceText(shot.sourceEvidence) : '';
    if (evidence.length < 2) return true;
    const sourceIds = asTextArray(shot?.sourceSegmentIds);
    return !sourceIds.some((id) => sourceById.get(id)?.includes(evidence));
  }).map((shot: any, index: number) => typeof shot?.title === 'string' && shot.title.trim() ? shot.title.trim() : `镜头${index + 1}`);
}

function findOutOfOrderEvidenceTitles(raw: any, segments: StorySourceSegment[]) {
  if (!Array.isArray(raw?.shots)) return [];
  const sourceOrder = new Map(segments.map((segment, index) => [segment.id, index]));
  const sourceText = new Map(segments.map((segment) => [segment.id, normalizeEvidenceText(segment.text)]));
  let lastSourceIndex = -1;
  let lastEvidenceStart = -1;

  return raw.shots.flatMap((shot: any, index: number) => {
    const title = typeof shot?.title === 'string' && shot.title.trim() ? shot.title.trim() : `镜头${index + 1}`;
    const evidence = typeof shot?.sourceEvidence === 'string' ? normalizeEvidenceText(shot.sourceEvidence) : '';
    const sourceIds = asTextArray(shot?.sourceSegmentIds)
      .filter((id) => sourceOrder.has(id))
      .sort((left, right) => sourceOrder.get(left)! - sourceOrder.get(right)!);
    const sourceId = sourceIds.find((id) => sourceText.get(id)?.includes(evidence));
    if (!sourceId || !evidence) return [];

    const sourceIndex = sourceOrder.get(sourceId)!;
    const searchFrom = sourceIndex === lastSourceIndex ? lastEvidenceStart + 1 : 0;
    const evidenceStart = sourceText.get(sourceId)!.indexOf(evidence, searchFrom);
    if (sourceIndex < lastSourceIndex || evidenceStart < 0) return [title];

    lastSourceIndex = sourceIndex;
    lastEvidenceStart = evidenceStart;
    return [];
  });
}

export function normalizeAIStoryboard(raw: any, input: Omit<GenerateAIStoryboardInput, 'signal' | 'onProgress'>): StoryboardPlan {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.shots)) throw new Error('文本模型返回缺少 shots 分镜数组');
  if (raw.shots.length < 1 || raw.shots.length > MAX_STORYBOARD_SHOTS) throw new Error(`文本模型返回的镜头数必须在 1–${MAX_STORYBOARD_SHOTS} 个之间`);

  let shots: DirectorShot[] = raw.shots.map((shot: any, index: number) => {
    if (!shot || typeof shot !== 'object') throw new Error(`第 ${index + 1} 个镜头格式无效`);
    const clipNumber = String(index + 1).padStart(2, '0');
    return {
      clipId: `clip-${clipNumber}`,
      sceneId: typeof shot.sceneId === 'string' && shot.sceneId.trim() ? shot.sceneId.trim() : 'scene-01',
      sequenceIndex: index,
      sourceSegmentIds: asTextArray(shot.sourceSegmentIds),
      sourceEvidence: asText(shot.sourceEvidence, `shots[${index}].sourceEvidence`),
      title: typeof shot.title === 'string' && shot.title.trim() ? shot.title.trim() : `镜头 ${clipNumber}`,
      narrativeJob: asText(shot.narrativeJob, `shots[${index}].narrativeJob`),
      feltIntent: asText(shot.feltIntent, `shots[${index}].feltIntent`),
      arcPosition: asText(shot.arcPosition, `shots[${index}].arcPosition`),
      targetDurationSec: clampDuration(shot.targetDurationSec),
      generationMode: typeof shot.generationMode === 'string' && shot.generationMode.trim() ? shot.generationMode.trim() : (index === 0 ? 'text-to-video' : 'continuation-ready'),
      camera: asText(shot.camera, `shots[${index}].camera`),
      lighting: asText(shot.lighting, `shots[${index}].lighting`),
      performance: asText(shot.performance, `shots[${index}].performance`),
      audio: asText(shot.audio, `shots[${index}].audio`),
      plannedEndState: asText(shot.plannedEndState, `shots[${index}].plannedEndState`),
      continuityLocks: asTextArray(shot.continuityLocks),
      reservedForLater: asTextArray(shot.reservedForLater),
      status: index === 0 ? 'ready' : 'provisional',
      prompt: asText(shot.prompt, `shots[${index}].prompt`),
    };
  });

  if (input.durationMode === 'fixed-shot') {
    const fixedDuration = normalizeFixedShotDuration(input.fixedShotDurationSec);
    shots = shots.map((shot) => ({ ...shot, targetDurationSec: fixedDuration }));
  } else if (input.durationMode === 'manual') shots = fitManualTotal(shots, input.manualDurationSec || 30);

  const totalDuration = shots.reduce((sum, shot) => sum + shot.targetDurationSec, 0);
  const sceneIds = [...new Set(shots.map((shot) => shot.sceneId))];
  return {
    projectId: `director-${input.project.id}-${Date.now()}`,
    title: input.project.title,
    source: 'ai',
    targetDurationSec: totalDuration,
    durationRecommendationReason: asText(raw.durationRecommendationReason, 'durationRecommendationReason'),
    storySummary: asText(raw.storySummary, 'storySummary'),
    storyPromise: asText(raw.storyPromise, 'storyPromise'),
    finalOutcome: asText(raw.finalOutcome, 'finalOutcome'),
    directorVoice: DIRECTOR_VOICES[input.voice] || DIRECTOR_VOICES.naturalist,
    scenes: sceneIds.map((sceneId) => ({
      sceneId,
      narrativeFunction: shots.filter((shot) => shot.sceneId === sceneId).map((shot) => shot.narrativeJob).join('；'),
      arcPosition: shots.find((shot) => shot.sceneId === sceneId)?.arcPosition || 'develop',
      assignedClipIds: shots.filter((shot) => shot.sceneId === sceneId).map((shot) => shot.clipId),
    })),
    shots,
    customSkills: input.skills.map(({ id, name, instructions }) => ({ id, name, instructions })),
  };
}

export function mergeRegeneratedStoryboardShots(current: StoryboardPlan, replacement: StoryboardPlan, sourceIds: string[]): StoryboardPlan {
  const affectedSourceIds = new Set(sourceIds);
  const overlaps = (shot: DirectorShot) => shot.sourceSegmentIds.some((id) => affectedSourceIds.has(id));
  const firstAffectedIndex = current.shots.findIndex(overlaps);
  if (firstAffectedIndex < 0) throw new Error('所选原文段在当前分镜中不存在');
  const shots = current.shots.flatMap((shot, index) => {
    if (index === firstAffectedIndex) return replacement.shots;
    return overlaps(shot) ? [] : [shot];
  }).map((shot, index) => ({
    ...shot,
    clipId: `clip-${String(index + 1).padStart(3, '0')}`,
    sequenceIndex: index,
    status: index === 0 ? 'ready' as const : 'provisional' as const,
  }));
  const scenes = [...new Set(shots.map((shot) => shot.sceneId))].map((sceneId) => ({
    sceneId,
    narrativeFunction: shots.filter((shot) => shot.sceneId === sceneId).map((shot) => shot.narrativeJob).join('；'),
    arcPosition: shots.find((shot) => shot.sceneId === sceneId)?.arcPosition || 'develop',
    assignedClipIds: shots.filter((shot) => shot.sceneId === sceneId).map((shot) => shot.clipId),
  }));
  return {
    ...current,
    shots,
    scenes,
    targetDurationSec: shots.reduce((sum, shot) => sum + shot.targetDurationSec, 0),
    durationRecommendationReason: `已重新导演所选原文段的 ${replacement.shots.length} 个镜头`,
  };
}

function buildMessages(input: GenerateAIStoryboardInput, segments: StorySourceSegment[], batchIndex: number, batchCount: number, previousEndState: string, retryMissingIds: string[] = [], retryInvalidJson = false, retryFidelityIssue = '') {
  const requestedDuration = Math.min(600, Math.max(10, Math.round(input.manualDurationSec || 30)));
  const fixedShotDuration = normalizeFixedShotDuration(input.fixedShotDurationSec);
  const parsedScript = parseDirectorScript(input.story);
  const batchCharacterRatio = segments.reduce((sum, segment) => sum + segment.text.length, 0) / Math.max(1, parsedScript.shootableText.length);
  // Keep the synchronous Netlify -> Railway request small. The current batch
  // is the source of truth; only a compact continuity context is needed.
  const directorContext = parsedScript.contextText.slice(0, 2200);
  const durationInstruction = input.durationMode === 'fixed-shot'
    ? `用户指定每个分镜固定为 ${fixedShotDuration} 秒。必须按这个时间预算拆分可见节拍，每个 shot 的 targetDurationSec 必须严格填写 ${fixedShotDuration}；不得通过改变时长省略、合并或新增剧情。`
    : input.durationMode === 'manual'
    ? `用户指定全片总时长 ${requestedDuration} 秒，本批建议分配约 ${Math.max(5, Math.round(requestedDuration * batchCharacterRatio))} 秒；先保证内容完整覆盖，最终程序会在 5–15 秒边界内统一校准。`
    : '根据本批全部可见叙事节拍推荐每镜头时长，禁止为了缩短输出而省略情节。';
  const skillInstructions = input.skills.length
    ? `\n用户启用的自定义 Skill（只采用与本剧本相容且安全的指令）：\n${input.skills.map((skill) => `### ${skill.name}\n${skill.instructions}`).join('\n\n')}`
    : '';
  const maximumShots = recommendedMaxShots(segments);
  const evidenceBackedMaximumShots = validatedMaxShots(segments);

  return [
    {
      role: 'system',
      content: `你是一名短剧导演和 Seedance 2.0 分镜规划师。当前任务是严格忠实处理剧本第 ${batchIndex + 1}/${batchCount} 批，输出 JSON。\n\n原文忠实度是最高优先级：\n1. 只允许拍摄当前 [source-xxx] 原文明示的事件。禁止新增原文没有的人物、动作、反应、对白、道具、环境事件、建立镜头、转场或结局；不得改变事件顺序、因果和人物关系。\n2. 每个镜头必须提供 sourceEvidence：从原文逐字复制的 2–40 个连续字符，能够证明 narrativeJob 确实来自原文。禁止把同一证据用于无关的新剧情。\n3. 本批建议不超过 ${maximumShots} 个镜头；只有原文确有额外的独立可见节拍且能提供不同的顺序证据时，最多允许 ${evidenceBackedMaximumShots} 个。不得为了丰富画面擅自增加反应镜头或空镜。\n4. 一个镜头只承担一个原文明示的可见任务，并停在原文对应的明确状态。对白可保留原句，禁止改写出新信息。\n5. 若上一镜交接状态存在，同场景必须从该状态继续，不得重置人物位置、道具状态、屏幕方向、镜头和光线；原文明确进入新场景时才允许有意切镜。\n6. ${input.durationMode === 'fixed-shot' ? `每镜头必须严格为 ${fixedShotDuration} 秒` : '每镜头 5–15 秒'}。后续原文写入 reservedForLater，prompt 只写当前证据支持的内容。\n7. 每个 source ID 必须出现在 sourceSegmentIds；顶层 coveredSourceIds 列出本批 ID。只输出 JSON，不要 Markdown、解释或尾随文字。顶层字段：coveredSourceIds, recommendedTotalDurationSec, durationRecommendationReason, storySummary, storyPromise, finalOutcome, shots。每个 shot 字段：sourceSegmentIds, sourceEvidence, sceneId, title, narrativeJob, feltIntent, arcPosition, targetDurationSec, generationMode, camera, lighting, performance, audio, plannedEndState, continuityLocks, reservedForLater, prompt。${skillInstructions}`,
    },
    {
      role: 'user',
      content: `项目：${input.project.title}\n可拍摄正文共 ${parsedScript.shootableText.length} 字，本次为第 ${batchIndex + 1}/${batchCount} 批。\n画幅：${input.project.settings.aspectRatio}\n导演风格：${DIRECTOR_VOICES[input.voice]?.name || DIRECTOR_VOICES.naturalist.name}\n${durationInstruction}\n${directorContext ? `剧本资料（只用于人物、世界观和连续性约束，绝对不得生成镜头，也不得作为 sourceEvidence）：\n${directorContext}\n\n` : ''}${previousEndState ? `上一镜完整交接：${previousEndState}\n` : ''}${retryInvalidJson ? '上一轮 JSON 无效或被截断。请缩短措辞并完整闭合 JSON。\n' : ''}${retryFidelityIssue ? `上一轮忠实度校验失败：${retryFidelityIssue}。必须删除无原文证据或多余的镜头。\n` : ''}${retryMissingIds.length && !retryInvalidJson && !retryFidelityIssue ? `上一轮覆盖校验失败，遗漏了 ${retryMissingIds.join('、')}。\n` : ''}\n本批唯一可拍摄的剧情正文：\n${segments.map((segment) => `[${segment.id}]\n${segment.text}`).join('\n\n')}`,
    },
  ];
}

type ChatMessage = { role: string; content: string };

const protocolCandidates = (protocol: TextModelProtocol | undefined): Array<Exclude<TextModelProtocol, 'auto'>> => (
  !protocol || protocol === 'auto'
    ? ['openai-chat', 'openai-responses', 'anthropic-messages']
    : [protocol]
);

function completionRequestBody(protocol: Exclude<TextModelProtocol, 'auto'>, model: AIModelConfig, messages: ChatMessage[], structured: boolean) {
  const temperature = model.parameters?.temperature ?? 0.4;
  // One source segment is processed per batch. The response must fit inside
  // Netlify's synchronous proxy window; the NDJSON continuation handles
  // longer plans without asking one request to produce all shots at once.
  const configuredMaxTokens = Number(model.parameters?.maxTokens ?? model.parameters?.max_tokens ?? 4000);
  const maxTokens = Math.min(DIRECTOR_MAX_COMPLETION_TOKENS, Math.max(256, Number.isFinite(configuredMaxTokens) ? configuredMaxTokens : 4000));
  if (protocol === 'openai-responses') {
    return { model: model.modelId, input: messages, temperature, max_output_tokens: maxTokens };
  }
  if (protocol === 'anthropic-messages') {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const conversation = messages.filter((message) => message.role !== 'system').map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content,
    }));
    return { model: model.modelId, system, messages: conversation, temperature, max_tokens: maxTokens };
  }
  return {
    model: model.modelId, messages, temperature, max_tokens: maxTokens,
    ...(structured ? { response_format: { type: 'json_object' } } : {}),
  };
}

async function requestCompletion(model: AIModelConfig, input: GenerateAIStoryboardInput, messages: ChatMessage[], structured: boolean) {
  const apiKey = String(model.apiKey || '').trim();
  const candidates = protocolCandidates(model.textProtocol);
  let lastError: any;
  for (let index = 0; index < candidates.length; index += 1) {
    const protocol = candidates[index];
    const response = await fetch(directorCompletionUrl(model, protocol), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {}),
        // Managed models are authenticated by the same-origin proxy session.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify(completionRequestBody(protocol, model, messages, structured)),
      signal: input.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    const error = Object.assign(new Error(payload?.error?.message || payload?.message || `文本模型请求失败 (${response.status})`), { status: response.status, protocol });
    lastError = error;
    const canTryNextProtocol = (!model.textProtocol || model.textProtocol === 'auto') && [404, 405].includes(response.status) && index < candidates.length - 1;
    if (!canTryNextProtocol) throw error;
  }
  throw lastError || new Error('文本模型请求失败');
}

function completionWasTruncated(payload: any) {
  return payload?.choices?.[0]?.finish_reason === 'length'
    || payload?.stop_reason === 'max_tokens'
    || payload?.status === 'incomplete'
    || payload?.incomplete_details?.reason === 'max_output_tokens';
}

function buildNdjsonMessages(
  input: GenerateAIStoryboardInput,
  segments: StorySourceSegment[],
  batchIndex: number,
  batchCount: number,
  previousEndState: string,
  completedShots: any[],
): ChatMessage[] {
  const parsedScript = parseDirectorScript(input.story);
  const directorContext = parsedScript.contextText.slice(0, 2200);
  const durationInstruction = input.durationMode === 'fixed-shot'
    ? `每个镜头的 targetDurationSec 必须严格为 ${normalizeFixedShotDuration(input.fixedShotDurationSec)} 秒。`
    : '每个镜头时长必须在 5–15 秒。';
  const completedJobs = completedShots.map((shot, index) => `${index + 1}. ${shot.narrativeJob} -> ${shot.plannedEndState}`).join('\n');
  const hasCompletedShots = completedShots.length > 0;
  return [
    {
      role: 'system',
      content: `你是严格忠实原文的短剧导演。服务商输出长度很小，因此必须使用 NDJSON：每行一个完整 JSON 对象，不要 Markdown 或数组外壳。\n本次请求${hasCompletedShots ? '已经有已完成镜头：不得重复它们；只输出至多一个新的、不同的镜头。若所有原文节拍已被已完成镜头覆盖，则不要输出镜头，直接输出 complete。若本次新增的一个镜头已覆盖最后一个剩余节拍，紧接着输出 complete。' : '必须先输出一行 meta，再输出至多一个镜头；若该镜头已覆盖本批全部原文节拍，紧接着输出 complete。'} 绝对不要在一轮中输出两个以上镜头。\nmeta 格式：{"type":"meta","storySummary":"...","storyPromise":"...","finalOutcome":"...","durationRecommendationReason":"..."}。\nshot 格式：{"type":"shot","sourceSegmentIds":["source-001"],"sourceEvidence":"从原文逐字复制2-40字","sceneId":"scene-01","title":"...","narrativeJob":"...","feltIntent":"...","arcPosition":"open","targetDurationSec":7,"generationMode":"text-to-video","camera":"...","lighting":"...","performance":"...","audio":"...","plannedEndState":"...","continuityLocks":["..."],"reservedForLater":["..."],"prompt":"..."}。\ncomplete 格式：{"type":"complete","coveredSourceIds":["..."]}。\n只允许原文明示的事件，禁止新增人物、动作、反应、对白、道具、空镜、转场或结局；不得改变顺序和因果。本批建议不超过 ${recommendedMaxShots(segments)} 个镜头，仅在每镜都有不同的顺序原文证据时最多允许 ${validatedMaxShots(segments)} 个；一个镜头一个原文节拍，${durationInstruction} 若有上一镜交接，同场景必须连续。每一行必须完整闭合，再停止输出。`,
    },
    {
      role: 'user',
      content: `项目：${input.project.title}；第 ${batchIndex + 1}/${batchCount} 批；画幅：${input.project.settings.aspectRatio}；导演风格：${DIRECTOR_VOICES[input.voice]?.name || DIRECTOR_VOICES.naturalist.name}。\n${directorContext ? `剧本资料只用于连续性，禁止生成镜头或作为证据：\n${directorContext}\n` : ''}${previousEndState ? `前批结束状态：${previousEndState}\n` : ''}${completedJobs ? `本批已完成的镜头如下，禁止重复，从其结束状态继续：\n${completedJobs}\n` : ''}唯一可拍摄正文：\n${segments.map((segment) => `[${segment.id}]\n${segment.text}`).join('\n\n')}`,
    },
  ];
}

function parseNdjsonContent(content: string) {
  const records: any[] = [];
  for (const rawLine of content.replace(/^```(?:json|ndjson)?\s*/i, '').replace(/```\s*$/i, '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^data:\s*/, '');
    if (!line || line === '[DONE]') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      // A length-limited provider may cut the final line; prior complete lines remain usable.
    }
  }
  return records;
}

async function requestBatchAsNdjson(
  model: AIModelConfig,
  input: GenerateAIStoryboardInput,
  segments: StorySourceSegment[],
  batchIndex: number,
  batchCount: number,
  previousEndState: string,
) {
  const shots: any[] = [];
  const seenShots = new Set<string>();
  let metadata: any = null;
  let completedIds: string[] = [];

  const maxContinuations = validatedMaxShots(segments) + 1;
  for (let continuation = 0; continuation < maxContinuations; continuation += 1) {
    if (input.signal?.aborted) throw new DOMException('已取消导演分镜', 'AbortError');
    const batchStart = 5 + (batchIndex / batchCount) * 80;
    const batchShare = 80 / batchCount;
    input.onProgress?.(`JSON 受限，正在逐镜头恢复第 ${batchIndex + 1}/${batchCount} 批（续传 ${continuation + 1}）…`, Math.round(batchStart + Math.min(0.8, continuation / 10) * batchShare));
    const payload = await requestCompletion(model, input, buildNdjsonMessages(input, segments, batchIndex, batchCount, previousEndState, shots), false);
    const records = parseNdjsonContent(extractMessageContent(payload));
    for (const record of records) {
      if (record.type === 'meta') metadata ||= record;
      if (record.type === 'complete') completedIds = asTextArray(record.coveredSourceIds);
      if (record.type === 'shot') {
        const key = `${record.narrativeJob || ''}|${record.plannedEndState || ''}`;
        if (key !== '|' && !seenShots.has(key)) {
          seenShots.add(key);
          const { type: _type, ...shot } = record;
          shots.push(shot);
        }
      }
    }
    if (completedIds.length) break;
    if (!records.length && continuation >= 1) break;
  }

  if (!completedIds.length) {
    // Some OpenAI-compatible text services return valid NDJSON shot rows but
    // omit the final control row. Keep those rows and let the existing source
    // evidence, ordering, and shot-count validation decide whether they are usable.
    if (!shots.length) throw new Error('文本模型未返回可校验的镜头内容；请检查文本模型、API 地址和模型输出格式');
    completedIds = segments.map((segment) => segment.id);
    input.onProgress?.(`未收到续传完成标记，正在校验已返回的 ${shots.length} 个镜头…`, 85);
  }
  return {
    coveredSourceIds: completedIds,
    storySummary: metadata?.storySummary || `第 ${batchIndex + 1} 批剧本分镜`,
    storyPromise: metadata?.storyPromise || '完整呈现原剧本的叙事变化',
    finalOutcome: metadata?.finalOutcome || shots[shots.length - 1]?.plannedEndState || '完成本批剧情',
    durationRecommendationReason: metadata?.durationRecommendationReason || '按逐镜头事件密度推荐',
    shots,
  };
}

export async function generateAIStoryboard(input: GenerateAIStoryboardInput): Promise<StoryboardPlan> {
  const parsedScript = parseDirectorScript(input.story);
  if (parsedScript.shootableText.length < 20) throw new Error('未识别到至少 20 个字符的剧本正文；请使用“剧本正文/正文”标题或明确的场次标题');
  const model = resolveDirectorTextModel(input.project);
  if (!model) throw new Error('请先在模型设置的“文本分析”中配置 OpenAI-compatible 文本模型、API 地址、模型 ID 和 API Key');
  input.onProgress?.('正在分析剧本长度并建立原文覆盖索引…', 3);

  const segments = splitStoryIntoSourceSegments(input.story);
  const allBatches = getStoryboardSourceBatches(input.story);
  let batchEntries: StorySourceBatch[];
  if (input.selectedSourceSegmentIds?.length) {
    const selectedIds = new Set(input.selectedSourceSegmentIds);
    const selectedSegments = segments.filter((segment) => selectedIds.has(segment.id));
    batchEntries = Array.from({ length: Math.ceil(selectedSegments.length / SOURCE_SEGMENTS_PER_BATCH) }, (_, index) => ({
      index,
      segments: selectedSegments.slice(index * SOURCE_SEGMENTS_PER_BATCH, (index + 1) * SOURCE_SEGMENTS_PER_BATCH),
    }));
  } else if (input.selectedBatchIndexes) {
    const selectedIndexes = new Set(input.selectedBatchIndexes);
    batchEntries = allBatches.filter((batch) => selectedIndexes.has(batch.index));
  } else {
    batchEntries = allBatches;
  }
  if (!batchEntries.length) throw new Error('请至少选择一个需要生成的剧本批次');
  const rawShots: any[] = [];
  const summaries: string[] = [];
  let storyPromise = '';
  let finalOutcome = '';
  let previousEndState = '';
  let previousSourceOrdinal: number | null = null;

  for (let selectionIndex = 0; selectionIndex < batchEntries.length; selectionIndex += 1) {
    if (input.signal?.aborted) throw new DOMException('已取消导演分镜', 'AbortError');
    const batchEntry = batchEntries[selectionIndex];
    const batch = batchEntry.segments;
    const batchIndex = input.selectedSourceSegmentIds?.length ? selectionIndex : batchEntry.index;
    const displayBatchCount = input.selectedSourceSegmentIds?.length ? batchEntries.length : allBatches.length;
    const expectedIds = batch.map((segment) => segment.id);
    const currentSourceOrdinal = Number(expectedIds[0]?.replace('source-', ''));
    if (previousSourceOrdinal !== null && currentSourceOrdinal !== previousSourceOrdinal + 1) previousEndState = '';
    const batchCharacterRatio = batch.reduce((sum, segment) => sum + segment.text.length, 0) / parsedScript.shootableText.length;
    const minimumShotCount = Math.max(1, Math.min(batch.length, input.durationMode === 'manual' ? Math.floor((input.manualDurationSec || 30) * batchCharacterRatio / 5) : batch.length));
    let raw: any;
    let missingIds = expectedIds;
    let tooFewShots = true;
    let invalidJson = false;
    let responseWasTruncated = false;
    let tooManyShots = false;
    let ungroundedShotTitles: string[] = [];
    let outOfOrderEvidenceTitles: string[] = [];
    let fixedDurationViolationTitles: string[] = [];
    for (let attempt = 0; attempt < 2 && (missingIds.length || tooFewShots || tooManyShots || ungroundedShotTitles.length || outOfOrderEvidenceTitles.length || fixedDurationViolationTitles.length); attempt += 1) {
      input.onProgress?.(`AI 正在读取原剧本第 ${batchIndex + 1}/${displayBatchCount} 批（${expectedIds[0]}–${expectedIds[expectedIds.length - 1]}）…`, Math.round(5 + (selectionIndex / batchEntries.length) * 80));
      const fidelityIssue = attempt > 0
        ? fixedDurationViolationTitles.length ? `用户要求每个分镜固定为 ${normalizeFixedShotDuration(input.fixedShotDurationSec)} 秒，但这些镜头返回了其他时长：${fixedDurationViolationTitles.join('、')}`
          : ungroundedShotTitles.length ? `这些镜头没有可核验的原文证据：${ungroundedShotTitles.join('、')}`
          : outOfOrderEvidenceTitles.length ? `这些镜头引用了倒序或重复的原文证据：${outOfOrderEvidenceTitles.join('、')}`
          : tooManyShots ? `镜头数超过证据校验上限 ${validatedMaxShots(batch)}` : ''
        : '';
      const messages = buildMessages(input, batch, batchIndex, displayBatchCount, previousEndState, attempt ? missingIds : [], attempt > 0 && invalidJson, fidelityIssue);
      let payload;
      try {
        payload = await requestCompletion(model, input, messages, true);
      } catch (error: any) {
        if (input.signal?.aborted) throw error;
        // A 504 can be emitted by the Netlify proxy before Railway's text
        // timeout. Switch to the compact resumable protocol instead of
        // discarding the whole storyboard operation.
        if (error?.status === 504) {
          invalidJson = true;
          responseWasTruncated = true;
          break;
        }
        if (![400, 422].includes(error?.status)) throw error;
        payload = await requestCompletion(model, input, messages, false);
      }
      responseWasTruncated = completionWasTruncated(payload);
      try {
        raw = bindSingleSourceCoverage(parseJsonContent(extractMessageContent(payload)), expectedIds);
        invalidJson = false;
      } catch {
        raw = null;
        invalidJson = true;
        missingIds = expectedIds;
        tooFewShots = true;
        tooManyShots = false;
        ungroundedShotTitles = [];
        outOfOrderEvidenceTitles = [];
        fixedDurationViolationTitles = [];
        continue;
      }
      const declaredIds = new Set(asTextArray(raw?.coveredSourceIds));
      const mappedIds = new Set(Array.isArray(raw?.shots) ? raw.shots.flatMap((shot: any) => asTextArray(shot?.sourceSegmentIds)) : []);
      missingIds = expectedIds.filter((id) => !declaredIds.has(id) || !mappedIds.has(id));
      tooFewShots = !Array.isArray(raw?.shots) || raw.shots.length < minimumShotCount;
      tooManyShots = Array.isArray(raw?.shots) && raw.shots.length > validatedMaxShots(batch);
      ungroundedShotTitles = findUngroundedShotTitles(raw, batch);
      outOfOrderEvidenceTitles = findOutOfOrderEvidenceTitles(raw, batch);
      fixedDurationViolationTitles = findFixedDurationViolations(raw, input);
    }
    if (invalidJson) {
      input.onProgress?.(responseWasTruncated ? '完整 JSON 被截断，正在切换逐镜头续传…' : 'JSON 格式不稳定，正在切换逐镜头续传…', Math.round(5 + (selectionIndex / batchEntries.length) * 80));
      raw = bindSingleSourceCoverage(await requestBatchAsNdjson(model, input, batch, batchIndex, displayBatchCount, previousEndState), expectedIds);
      invalidJson = false;
      const declaredIds = new Set(asTextArray(raw?.coveredSourceIds));
      const mappedIds = new Set(Array.isArray(raw?.shots) ? raw.shots.flatMap((shot: any) => asTextArray(shot?.sourceSegmentIds)) : []);
      missingIds = expectedIds.filter((id) => !declaredIds.has(id) || !mappedIds.has(id));
      tooFewShots = !Array.isArray(raw?.shots) || raw.shots.length < minimumShotCount;
      tooManyShots = Array.isArray(raw?.shots) && raw.shots.length > validatedMaxShots(batch);
      ungroundedShotTitles = findUngroundedShotTitles(raw, batch);
      outOfOrderEvidenceTitles = findOutOfOrderEvidenceTitles(raw, batch);
      fixedDurationViolationTitles = findFixedDurationViolations(raw, input);
    }
    if (missingIds.length || tooFewShots || tooManyShots || ungroundedShotTitles.length || outOfOrderEvidenceTitles.length || fixedDurationViolationTitles.length) {
      const detail = missingIds.length
        ? `遗漏 ${missingIds.join('、')}`
        : tooFewShots ? `仅生成 ${raw?.shots?.length || 0} 个镜头，低于最低 ${minimumShotCount} 个`
        : tooManyShots ? `生成 ${raw.shots.length} 个镜头，超过当前原文证据允许的 ${validatedMaxShots(batch)} 个`
        : ungroundedShotTitles.length ? `镜头 ${ungroundedShotTitles.join('、')} 没有当前原文中的逐字证据`
        : outOfOrderEvidenceTitles.length ? `镜头 ${outOfOrderEvidenceTitles.join('、')} 引用了倒序或重复的原文证据`
        : `镜头 ${fixedDurationViolationTitles.join('、')} 未使用用户指定的固定 ${normalizeFixedShotDuration(input.fixedShotDurationSec)} 秒`;
      throw new Error(`AI 分镜与原剧情一致性校验失败：${detail}。本次结果已拒绝`);
    }

    const batchPlan = normalizeAIStoryboard(raw, { ...input, durationMode: 'ai' });
    rawShots.push(...batchPlan.shots);
    summaries.push(batchPlan.storySummary);
    storyPromise ||= batchPlan.storyPromise;
    finalOutcome = batchPlan.finalOutcome;
    const lastShot = batchPlan.shots[batchPlan.shots.length - 1];
    previousEndState = lastShot
      ? `场景 ${lastShot.sceneId}；上一镜任务：${lastShot.narrativeJob}；结束状态：${lastShot.plannedEndState}；镜头：${lastShot.camera}；光线：${lastShot.lighting}；连续性锁：${lastShot.continuityLocks.join('、')}`
      : previousEndState;
    previousSourceOrdinal = currentSourceOrdinal;
    const checkpoint = normalizeAIStoryboard({
      durationRecommendationReason: `已完成 ${selectionIndex + 1}/${batchEntries.length} 个原文批次，可从剩余批次继续`,
      storySummary: summaries.join('；'),
      storyPromise,
      finalOutcome,
      shots: rawShots.map((shot) => ({ ...shot })),
    }, input);
    checkpoint.shots = checkpoint.shots.map((shot, index) => ({ ...shot, clipId: `clip-${String(index + 1).padStart(3, '0')}`, sequenceIndex: index, status: index === 0 ? 'ready' : 'provisional' }));
    input.onBatchComplete?.(checkpoint, selectionIndex + 1, batchEntries.length);
    input.onProgress?.(`已完成原剧本第 ${batchIndex + 1}/${displayBatchCount} 批`, Math.round(5 + ((selectionIndex + 1) / batchEntries.length) * 80));
  }

  const combinedRaw = {
    durationRecommendationReason: `已读取并覆盖所选的 ${batchEntries.reduce((sum, batch) => sum + batch.segments.length, 0)} 个原文段，按可见叙事节拍规划镜头`,
    storySummary: summaries.join('；'),
    storyPromise,
    finalOutcome,
    shots: rawShots.map((shot) => ({ ...shot })),
  };
  input.onProgress?.('全部原文已覆盖，正在合并导演分镜…', 90);
  const plan = normalizeAIStoryboard(combinedRaw, input);
  plan.shots = plan.shots.map((shot, index) => ({ ...shot, clipId: `clip-${String(index + 1).padStart(3, '0')}`, sequenceIndex: index, status: index === 0 ? 'ready' : 'provisional' }));
  plan.scenes = [...new Set(plan.shots.map((shot) => shot.sceneId))].map((sceneId) => ({
    sceneId,
    narrativeFunction: plan.shots.filter((shot) => shot.sceneId === sceneId).map((shot) => shot.narrativeJob).join('；'),
    arcPosition: plan.shots.find((shot) => shot.sceneId === sceneId)?.arcPosition || 'develop',
    assignedClipIds: plan.shots.filter((shot) => shot.sceneId === sceneId).map((shot) => shot.clipId),
  }));
  return plan;
}
