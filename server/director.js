import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import multer from 'multer';
import { extractWordText } from './word.js';

const MAX_WORD_FILE_BYTES = 10 * 1024 * 1024;
const wordUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_WORD_FILE_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = extname(file.originalname).toLowerCase();
    callback(extension === '.doc' || extension === '.docx' ? null : new Error('仅支持 DOC 和 DOCX 文件'), true);
  },
});

const VOICES = {
  naturalist: { name: '观察式自然主义', camera: '克制的固定或轻微手持', light: '柔和的现场实用光', performance: '收敛、生活化的动作' },
  classicist: { name: '构图古典主义', camera: '平衡构图与节制的轨道移动', light: '有来源的塑形光', performance: '精确、含蓄的动作' },
  visceral: { name: '动势写实', camera: '贴近主体的跟拍与明确运动方向', light: '高反差环境光', performance: '能看见重量与恢复的动作' },
  minimalist: { name: '亲密极简', camera: '极小幅度推进', light: '单一柔和光源', performance: '一个克制的微动作' },
  formalist: { name: '图形式构成', camera: '固定或精确的几何运镜', light: '硬朗且受控的造型光', performance: '简洁、明确的动作' },
};

const ARC = ['open', 'rising', 'turn', 'climax', 'release'];
const SHOTS = ['全景', '中全景', '中景', '中近景', '特写'];
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));

function splitStory(story) {
  const cleaned = String(story || '').replace(/\r/g, '').trim();
  const sentences = cleaned.split(/(?<=[。！？!?；;\n])/u).map((item) => item.trim()).filter(Boolean);
  return sentences.length > 1 ? sentences : cleaned.split(/[，,、]/u).map((item) => item.trim()).filter(Boolean);
}

function arcAt(index, total) {
  if (total <= 1) return 'turn';
  return ARC[Math.min(ARC.length - 1, Math.floor((index / (total - 1)) * ARC.length))];
}

function sceneFunction(arcPosition) {
  return { open: '建立人物、世界和初始关系', rising: '加深阻力并推动目标', turn: '交付故事的关键转折', climax: '让主要冲突达到结果', release: '确认变化并留下余韵' }[arcPosition];
}

function visibleGesture(beat, arcPosition) {
  const compact = beat.replace(/[。！？!?；;]+$/u, '');
  const verbs = {
    open: '主体进入画面并停在决定行动的位置',
    rising: '主体执行一个受阻但清晰的动作',
    turn: '主体用一个不可撤回的动作作出选择',
    climax: '主体完成最关键的动作并承受其结果',
    release: '主体以一个小动作确认变化已经发生',
  };
  return `${compact}；${verbs[arcPosition]}`;
}

function cameraFor(arcPosition, voice) {
  const shotSize = SHOTS[Math.min(SHOTS.length - 1, ARC.indexOf(arcPosition))];
  const movement = arcPosition === 'climax' ? '固定镜头，刻意打破此前运动规律' : voice.camera;
  return `${shotSize}，${movement}，只保留一个有动机的主运镜`;
}

function compilePrompt({ gesture, camera, voice, location, timeOfDay, endpoint, reserved, continuityLocks, audio, skillRules }) {
  const reservedClause = reserved.length ? `不要提前表现：${reserved.join('、')}。` : '';
  const skillClause = skillRules.length ? `创作约束：${skillRules.map((skill) => skill.instructions.slice(0, 160).replace(/[。！？!?；;]+$/u, '')).join('；')}。` : '';
  return `${location}，${timeOfDay}。本镜头只表现：${gesture}。镜头：${camera}。表演：${voice.performance}。光线：${voice.light}，光源来自场景内可见方向。声音：${audio}，不生成配乐。保持${continuityLocks.join('、')}连续稳定。${reservedClause}${skillClause}在“${endpoint}”时停止。No generated text, no watermark.`;
}

export function buildStoryboard(input, customSkills = []) {
  const story = String(input.story || '').trim();
  if (story.length < 20 || story.length > 20_000) throw new Error('剧本长度需为 20-20000 字');
  const title = String(input.title || '未命名导演方案').trim().slice(0, 80);
  const targetDurationSec = clamp(input.targetDurationSec, 10, 600);
  const clipBudgetSec = clamp(input.clipBudgetSec, 5, 15);
  const maxShots = clamp(Math.ceil(targetDurationSec / clipBudgetSec), 1, 40);
  const sourceBeats = splitStory(story);
  const beatCount = Math.min(maxShots, Math.max(1, sourceBeats.length));
  const beats = Array.from({ length: beatCount }, (_, index) => sourceBeats[index % sourceBeats.length]);
  const voice = VOICES[input.voice] || VOICES.naturalist;
  const projectId = `director-${randomUUID()}`;
  const location = String(input.location || '与剧本一致的主要场景').trim().slice(0, 120);
  const timeOfDay = String(input.timeOfDay || '有明确来源的环境光时段').trim().slice(0, 80);
  const continuityLocks = ['角色身份与服装', '关键道具状态', '屏幕运动方向', '场景时间与主光方向'];
  const skillRules = customSkills.map((skill) => ({ id: skill.id, name: skill.name, instructions: skill.instructions.slice(0, 500) }));

  const shots = beats.map((beat, index) => {
    const arcPosition = arcAt(index, beats.length);
    const clipId = `clip-${String(index + 1).padStart(2, '0')}`;
    const sceneIndex = Math.floor(index / 4) + 1;
    const gesture = visibleGesture(beat, arcPosition);
    const endpoint = gesture.split('；').at(-1);
    const reserved = beats.slice(index + 1, index + 3).map((item) => item.replace(/[。！？!?；;]+$/u, ''));
    const camera = cameraFor(arcPosition, voice);
    const audio = arcPosition === 'climax' ? '动作同步声突出，环境声在动作落点后短暂抽空' : '与场景匹配的环境声和一个动作同步声';
    return {
      clipId,
      sceneId: `scene-${String(sceneIndex).padStart(2, '0')}`,
      sequenceIndex: index + 1,
      parentClipId: index % 4 === 0 ? null : `clip-${String(index).padStart(2, '0')}`,
      title: `镜头 ${String(index + 1).padStart(2, '0')}`,
      narrativeJob: beat,
      feltIntent: `让观众清楚感到故事正在${sceneFunction(arcPosition)}`,
      arcPosition,
      targetDurationSec: clipBudgetSec,
      generationMode: index % 4 === 0 ? 'T2V' : 'intentional_next_shot',
      shotStructure: 'compact_single_take',
      primarySpend: arcPosition === 'open' ? 'scene_density' : arcPosition === 'climax' ? 'motion_boldness' : 'identity_fidelity',
      camera,
      lighting: voice.light,
      performance: voice.performance,
      audio,
      plannedStartState: index === 0 ? '从故事初始状态和规范参考开始' : `承接 clip-${String(index).padStart(2, '0')} 的已验收结束状态`,
      plannedEndState: endpoint,
      continuityLocks,
      reservedForLater: reserved,
      status: index === 0 ? 'ready' : 'provisional',
      prompt: compilePrompt({ gesture, camera, voice, location, timeOfDay, endpoint, reserved, continuityLocks, audio, skillRules }),
    };
  });

  const sceneIds = [...new Set(shots.map((shot) => shot.sceneId))];
  const scenes = sceneIds.map((sceneId, index) => {
    const assigned = shots.filter((shot) => shot.sceneId === sceneId);
    const arcPosition = assigned[Math.floor(assigned.length / 2)].arcPosition;
    return {
      sceneId,
      sceneIndex: index + 1,
      narrativeFunction: sceneFunction(arcPosition),
      arcPosition,
      location,
      timeOfDay,
      anchorSource: 'canonical_references',
      maxChainDepth: 2,
      audioPlan: '镜头内保留环境声、同步音效和短对白；统一配乐在后期完成',
      assignedClipIds: assigned.map((shot) => shot.clipId),
      status: index === 0 ? 'current' : 'planned',
    };
  });

  return {
    schemaVersion: 1,
    projectId,
    title,
    projectMode: 'sequence_project',
    surface: String(input.surface || 'Seedance 2.0 generic'),
    aspectRatio: String(input.aspectRatio || '16:9'),
    targetDurationSec,
    clipBudgetSec,
    storySummary: sourceBeats.slice(0, 3).join(' ').slice(0, 400),
    storyPromise: `围绕“${sourceBeats[0].slice(0, 80)}”推进，并在结尾交付可见变化`,
    finalOutcome: sourceBeats.at(-1).replace(/[。！？!?；;]+$/u, ''),
    directorVoice: voice,
    continuityBible: { continuityLocks, chainDepthLimit: 2, scoreInPost: true },
    customSkills: skillRules,
    scenes,
    shots,
    currentClipId: shots[0].clipId,
    createdAt: new Date().toISOString(),
  };
}

export function registerDirectorRoutes(router, { db, requireAuth }) {
  router.post('/script-import', requireAuth, (req, res, next) => {
    wordUpload.single('file')(req, res, async (uploadError) => {
      if (uploadError) {
        const isTooLarge = uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({
          error: isTooLarge ? 'FILE_TOO_LARGE' : 'WORD_UPLOAD_ERROR',
          message: isTooLarge ? 'Word 文件不能超过 10 MB' : uploadError.message,
        });
      }
      if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED', message: '请选择 DOC 或 DOCX 文件' });
      try {
        const text = await extractWordText(req.file.buffer, extname(req.file.originalname).toLowerCase());
        return res.json({ text, fileName: req.file.originalname });
      } catch (error) {
        return res.status(400).json({ error: 'WORD_PARSE_ERROR', message: error.message || 'Word 文件解析失败' });
      }
    });
  });

  router.post('/storyboard', requireAuth, (req, res) => {
    try {
      const requestedSkillIds = Array.isArray(req.body.skillIds) ? req.body.skillIds : [];
      const skills = db.read('skills').filter((skill) => skill.userId === req.user.id && requestedSkillIds.includes(skill.id));
      return res.status(201).json({ storyboard: buildStoryboard(req.body, skills) });
    } catch (error) {
      return res.status(400).json({ error: 'DIRECTOR_INPUT_ERROR', message: error.message });
    }
  });
}
