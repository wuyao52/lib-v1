import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transform } from 'esbuild';

async function loadDirectorAIService() {
  const source = await readFile(new URL('../../src/services/directorAIService.ts', import.meta.url), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
}

const project = {
  id: 'project-test',
  title: '测试短剧',
  settings: {
    aspectRatio: '16:9',
    multiModel: {
      textModel: { id: 'text', name: 'Mock Text', provider: 'Mock', apiKey: 'session-key', baseUrl: 'https://mock.example/v1', modelId: 'mock-chat', parameters: {} },
    },
  },
};

const rawPlan = {
  coveredSourceIds: ['source-001'],
  recommendedTotalDurationSec: 20,
  durationRecommendationReason: '三个明确叙事节拍',
  storySummary: '人物完成一次选择。',
  storyPromise: '选择将改变人物关系。',
  finalOutcome: '人物承担选择的结果。',
  shots: [
    { sourceSegmentIds: ['source-001'], sourceEvidence: '人物', sceneId: 'scene-01', title: '开场', narrativeJob: '人物发现信件', feltIntent: '疑惑', arcPosition: 'open', targetDurationSec: 2, camera: '中景缓慢推近', lighting: '窗边自然光', performance: '停顿后拿起信件', audio: '纸张声', plannedEndState: '信件已在手中', continuityLocks: ['蓝色外套'], reservedForLater: ['暂不拆信'], prompt: '中景缓慢推近，人物停顿后拿起桌上的信件，画面结束于信件已在手中。' },
    { sourceSegmentIds: ['source-001'], sourceEvidence: '发现一封信', sceneId: 'scene-01', title: '转折', narrativeJob: '人物读到署名', feltIntent: '震惊', arcPosition: 'turn', targetDurationSec: 18, camera: '手部特写切面部近景', lighting: '保持窗边自然光', performance: '呼吸停住', audio: '环境声降低', plannedEndState: '人物确认署名', continuityLocks: ['蓝色外套'], reservedForLater: [], prompt: '手部特写切到面部近景，人物读到署名后呼吸停住，结束于确认署名。' },
  ],
};

test('AI storyboard uses the configured text model and clamps each shot to 5-15 seconds', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  let request;
  const progressUpdates = [];
  globalThis.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body), authorization: options.headers.Authorization, apiKey: options.headers['x-api-key'] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rawPlan) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const plan = await service.generateAIStoryboard({ project, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [], onProgress: (message, progress) => progressUpdates.push({ message, progress }) });
    assert.equal(request.url, 'https://mock.example/v1/chat/completions');
    assert.equal(request.authorization, 'Bearer session-key');
    assert.equal(request.apiKey, 'session-key');
    assert.equal(request.body.model, 'mock-chat');
    assert.match(request.body.messages[1].content, /本批唯一可拍摄的剧情正文/);
    assert.equal(request.body.max_tokens, 900);
    assert.deepEqual(plan.shots.map((shot) => shot.targetDurationSec), [5, 15]);
    assert.equal(plan.targetDurationSec, 20);
    assert.equal(plan.shots[0].status, 'ready');
    assert.equal(plan.shots[1].status, 'provisional');
    assert.ok(progressUpdates.length >= 3);
    assert.equal(progressUpdates[progressUpdates.length - 1].progress, 90);
    assert.ok(progressUpdates.every((update) => update.progress >= 0 && update.progress <= 100));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('managed director text models use the same-origin system gateway', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), authorization: options.headers.Authorization, apiKey: options.headers['x-api-key'] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rawPlan) } }] }), { status: 200 });
  };
  try {
    const managedProject = {
      ...project,
      settings: {
        ...project.settings,
        multiModel: {
          textModel: {
            ...project.settings.multiModel.textModel,
            apiId: 'managed-api-123', managed: true, apiKey: '', baseUrl: 'https://provider.example/v1',
          },
        },
      },
    };
    await service.generateAIStoryboard({ project: managedProject, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] });
    assert.equal(request.url, '/api/system-ai/managed-api-123/v1/chat/completions');
    assert.equal(request.authorization, undefined);
    assert.equal(request.apiKey, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('automatic text protocol falls back from a missing Chat endpoint to OpenAI Responses', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (String(url).endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ error: { message: 'Not Found' } }), { status: 404 });
    }
    return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(rawPlan) }] }] }), { status: 200 });
  };
  try {
    const autoProject = { ...project, settings: { ...project.settings, multiModel: { textModel: { ...project.settings.multiModel.textModel, textProtocol: 'auto' } } } };
    const plan = await service.generateAIStoryboard({ project: autoProject, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] });
    assert.deepEqual(requests.map((request) => request.url), [
      'https://mock.example/v1/chat/completions',
      'https://mock.example/v1/responses',
    ]);
    assert.ok(Array.isArray(requests[1].body.input));
    assert.equal(requests[1].body.max_output_tokens, 900);
    assert.equal(plan.shots.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic Messages protocol sends the correct envelope and reads content blocks', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(rawPlan) }], stop_reason: 'end_turn' }), { status: 200 });
  };
  try {
    const anthropicProject = { ...project, settings: { ...project.settings, multiModel: { textModel: { ...project.settings.multiModel.textModel, textProtocol: 'anthropic-messages' } } } };
    const plan = await service.generateAIStoryboard({ project: anthropicProject, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] });
    assert.equal(request.url, 'https://mock.example/v1/messages');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.match(request.body.system, /短剧导演/);
    assert.equal(request.body.messages[0].role, 'user');
    assert.equal(request.body.max_tokens, 900);
    assert.equal(plan.shots.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an explicit missing text endpoint is not retried against the same URL', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'Not Found' } }), { status: 404 });
  };
  try {
    const chatProject = { ...project, settings: { ...project.settings, multiModel: { textModel: { ...project.settings.multiModel.textModel, textProtocol: 'openai-chat' } } } };
    await assert.rejects(
      service.generateAIStoryboard({ project: chatProject, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] }),
      /Not Found/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('storyboard generation can be cancelled through AbortSignal', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    if (options.signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  try {
    const pending = service.generateAIStoryboard({ project, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [], signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === 'AbortError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manual total duration is sent to the text model', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  let userMessage = '';
  globalThis.fetch = async (_url, options) => {
    userMessage = JSON.parse(options.body).messages[1].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rawPlan) } }] }), { status: 200 });
  };
  try {
    const plan = await service.generateAIStoryboard({ project, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'manual', manualDurationSec: 25, skills: [] });
    assert.match(userMessage, /用户指定全片总时长 25 秒/);
    assert.equal(plan.targetDurationSec, 25);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fixed single-shot duration is enforced in the prompt and normalized plan', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  const requests = [];
  let callCount = 0;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    callCount += 1;
    const corrected = { ...rawPlan, shots: rawPlan.shots.map((shot) => ({ ...shot, targetDurationSec: 10 })) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(callCount === 1 ? rawPlan : corrected) } }] }), { status: 200 });
  };
  try {
    const plan = await service.generateAIStoryboard({
      project,
      story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。',
      voice: 'naturalist',
      durationMode: 'fixed-shot',
      fixedShotDurationSec: 10,
      skills: [],
    });
    assert.equal(callCount, 2);
    assert.match(requests[0].messages[0].content, /每镜头必须严格为 10 秒/);
    assert.match(requests[0].messages[1].content, /每个分镜固定为 10 秒/);
    assert.match(requests[1].messages[1].content, /这些镜头返回了其他时长/);
    assert.deepEqual(plan.shots.map((shot) => shot.targetDurationSec), [10, 10]);
    assert.equal(plan.targetDurationSec, 20);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fixed single-shot duration rejects a model that ignores the constraint twice', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rawPlan) } }] }), { status: 200 });
  };
  try {
    await assert.rejects(
      service.generateAIStoryboard({
        project,
        story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。',
        voice: 'naturalist',
        durationMode: 'fixed-shot',
        fixedShotDurationSec: 10,
        skills: [],
      }),
      /未使用用户指定的固定 10 秒/,
    );
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalid JSON and missing text model fail explicitly', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  let invalidCalls = 0;
  globalThis.fetch = async () => {
    invalidCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), { status: 200 });
  };
  try {
    await assert.rejects(
      service.generateAIStoryboard({ project, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] }),
      /输出限制过低/,
    );
    assert.equal(invalidCalls, 4);
    await assert.rejects(
      service.generateAIStoryboard({ project: { ...project, settings: { ...project.settings, multiModel: undefined } }, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] }),
      /文本分析/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalid JSON is retried with a compact-output correction', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (_url, options) => {
    messages.push(JSON.parse(options.body).messages[1].content);
    const content = messages.length === 1 ? '{"shots":[' : JSON.stringify(rawPlan);
    return new Response(JSON.stringify({ choices: [{ finish_reason: messages.length === 1 ? 'length' : 'stop', message: { content } }] }), { status: 200 });
  };
  try {
    const plan = await service.generateAIStoryboard({ project, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] });
    assert.equal(messages.length, 2);
    assert.match(messages[1], /上一轮 JSON 无效或被截断/);
    assert.equal(plan.shots.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('two truncated JSON responses fall back to resumable shot-per-line NDJSON', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (!body.messages[0].content.includes('NDJSON')) {
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"shots":[' } }] }), { status: 200 });
    }
    const lines = [
      { type: 'meta', storySummary: rawPlan.storySummary, storyPromise: rawPlan.storyPromise, finalOutcome: rawPlan.finalOutcome, durationRecommendationReason: rawPlan.durationRecommendationReason },
      ...rawPlan.shots.map((shot) => ({ type: 'shot', ...shot })),
      { type: 'complete', coveredSourceIds: ['source-001'] },
    ].map((record) => JSON.stringify(record)).join('\n');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: lines } }] }), { status: 200 });
  };
  try {
    const plan = await service.generateAIStoryboard({ project, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] });
    assert.equal(calls, 3);
    assert.equal(plan.shots.length, 2);
    assert.deepEqual(plan.shots.map((shot) => shot.sourceSegmentIds), [['source-001'], ['source-001']]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a gateway 504 falls back to resumable shot-per-line NDJSON', async () => {
  const service = await loadDirectorAIService();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'Gateway Timeout' } }), { status: 504 });
    }
    assert.match(body.messages[0].content, /NDJSON/);
    const lines = [
      { type: 'meta', storySummary: rawPlan.storySummary, storyPromise: rawPlan.storyPromise, finalOutcome: rawPlan.finalOutcome, durationRecommendationReason: rawPlan.durationRecommendationReason },
      ...rawPlan.shots.map((shot) => ({ type: 'shot', ...shot })),
      { type: 'complete', coveredSourceIds: ['source-001'] },
    ].map((record) => JSON.stringify(record)).join('\n');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: lines } }] }), { status: 200 });
  };
  try {
    const plan = await service.generateAIStoryboard({ project, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] });
    assert.equal(requests.length, 2);
    assert.ok(requests.every((body) => body.max_tokens === 900));
    assert.equal(plan.shots.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('long scripts are read in multiple batches and missing source coverage is rejected', async () => {
  const service = await loadDirectorAIService();
  const longStory = Array.from({ length: 8 }, (_, index) => `第${index + 1}场：${'人物执行关键动作并产生新的可见结果。'.repeat(35)}`).join('\n');
  const segments = service.splitStoryIntoSourceSegments(longStory);
  assert.ok(segments.length > 6);

  const originalFetch = globalThis.fetch;
  const requestedSourceBatches = [];
  globalThis.fetch = async (_url, options) => {
    const userContent = JSON.parse(options.body).messages[1].content;
    const ids = [...userContent.matchAll(/\[(source-\d+)\]/g)].map((match) => match[1]);
    requestedSourceBatches.push(ids);
    const responsePlan = {
      ...rawPlan,
      coveredSourceIds: ids,
      shots: ids.map((id, index) => ({ ...rawPlan.shots[index % rawPlan.shots.length], sourceSegmentIds: [id], title: id })),
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responsePlan) } }] }), { status: 200 });
  };
  try {
    const plan = await service.generateAIStoryboard({ project, story: longStory, voice: 'naturalist', durationMode: 'ai', skills: [] });
    assert.ok(requestedSourceBatches.length > 1);
    assert.deepEqual(new Set(plan.shots.flatMap((shot) => shot.sourceSegmentIds)), new Set(segments.map((segment) => segment.id)));
  } finally {
    globalThis.fetch = originalFetch;
  }

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...rawPlan, coveredSourceIds: [], shots: [] }) } }] }), { status: 200 });
  };
  try {
    await assert.rejects(
      service.generateAIStoryboard({ project, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] }),
      /一致性校验失败/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scene headings start new source segments instead of being packed into the previous scene', async () => {
  const service = await loadDirectorAIService();
  const segments = service.splitStoryIntoSourceSegments('第1场 内景 客厅\n人物放下杯子。\n第2场 外景 街道\n人物走出门。');
  assert.equal(segments.length, 2);
  assert.match(segments[0].text, /^第1场/);
  assert.match(segments[1].text, /^第2场/);
});

test('structured script metadata is context only and never becomes storyboard source', async () => {
  const service = await loadDirectorAIService();
  const story = `# 剧本信息
剧名：回信
类型：家庭悬疑

**故事大纲**
林夏收到一封旧信，并最终发现父亲隐瞒的往事。

## 人物形象
林夏：二十八岁，短发，穿蓝色外套。
父亲：沉默寡言。

# 剧本正文
第1场 内景 客厅 夜
林夏拿起桌上的旧信，拆开信封。

第2场 内景 书房 夜
林夏把旧信放到父亲面前。`;
  const parsed = service.parseDirectorScript(story);
  assert.match(parsed.contextText, /故事大纲/);
  assert.match(parsed.contextText, /人物形象/);
  assert.doesNotMatch(parsed.shootableText, /最终发现父亲隐瞒/);
  assert.doesNotMatch(parsed.shootableText, /二十八岁/);
  assert.match(parsed.shootableText, /^第1场/);
  assert.deepEqual(parsed.excludedSectionTitles, ['剧本信息', '故事大纲', '人物形象']);

  const segments = service.splitStoryIntoSourceSegments(story);
  assert.equal(segments.length, 2);
  assert.ok(segments.every((segment) => !/剧本信息|故事大纲|人物形象/.test(segment.text)));
  assert.match(segments[0].text, /林夏拿起桌上的旧信/);
  assert.match(segments[1].text, /林夏把旧信放到父亲面前/);
});

test('shots without exact source evidence and excessive invented shots are rejected', async () => {
  const service = await loadDirectorAIService();
  const story = '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const hallucinated = { ...rawPlan, shots: rawPlan.shots.map((shot) => ({ ...shot, sourceEvidence: '原文中完全不存在的飞船爆炸' })) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(hallucinated) } }] }), { status: 200 });
  };
  try {
    await assert.rejects(
      service.generateAIStoryboard({ project, story, voice: 'naturalist', durationMode: 'ai', skills: [] }),
      /逐字证据/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const excessive = { ...rawPlan, shots: [rawPlan.shots[0], rawPlan.shots[1], { ...rawPlan.shots[0], title: '擅自增加的镜头' }] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(excessive) } }] }), { status: 200 });
  };
  try {
    await assert.rejects(
      service.generateAIStoryboard({ project, story, voice: 'naturalist', durationMode: 'ai', skills: [] }),
      /超过当前原文证据允许/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('source evidence matching ignores punctuation and full-width formatting differences', async () => {
  const service = await loadDirectorAIService();
  const story = '摄影师指着他说：“你被误认为‘男模’了！”他立刻摆手解释，现场的人都安静下来。';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const responsePlan = {
      ...rawPlan,
      shots: [{
        ...rawPlan.shots[0],
        title: '被误认为男模',
        narrativeJob: '人物被误认为男模',
        sourceEvidence: '被误认为男模',
        plannedEndState: '误会已经发生',
      }],
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responsePlan) } }] }), { status: 200 });
  };
  try {
    const plan = await service.generateAIStoryboard({ project, story, voice: 'naturalist', durationMode: 'ai', skills: [] });
    assert.equal(plan.shots.length, 1);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('one extra evidence-backed shot is accepted for a medium or long source segment', async () => {
  const service = await loadDirectorAIService();
  const evidence = ['动作一', '动作二', '动作三', '动作四', '动作五', '动作六', '动作七'];
  const story = evidence.map((label) => `${label}${'剧情内容'.repeat(20)}`).join('') + '补充内容'.repeat(18);
  assert.ok(story.length > 600 && story.length <= 700);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const responsePlan = {
      ...rawPlan,
      shots: evidence.map((sourceEvidence, index) => ({
        ...rawPlan.shots[0],
        title: `镜头${index + 1}`,
        narrativeJob: `表现${sourceEvidence}`,
        plannedEndState: `${sourceEvidence}完成`,
        sourceEvidence,
      })),
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responsePlan) } }] }), { status: 200 });
  };
  try {
    const plan = await service.generateAIStoryboard({ project, story, voice: 'naturalist', durationMode: 'ai', skills: [] });
    assert.equal(plan.shots.length, 7);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('storyboard evidence must advance in source order without reusing the same beat', async () => {
  const service = await loadDirectorAIService();
  const story = '人物先拿起桌上的信件，随后拆开信封，最后读到信中的署名。';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const reversed = {
      ...rawPlan,
      shots: [
        { ...rawPlan.shots[0], title: '先拍结尾', sourceEvidence: '读到信中的署名' },
        { ...rawPlan.shots[1], title: '再拍开头', sourceEvidence: '拿起桌上的信件' },
      ],
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reversed) } }] }), { status: 200 });
  };
  try {
    await assert.rejects(
      service.generateAIStoryboard({ project, story, voice: 'naturalist', durationMode: 'ai', skills: [] }),
      /倒序或重复的原文证据/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a single selected source is bound automatically when the model omits coverage IDs', async () => {
  const service = await loadDirectorAIService();
  const story = Array.from({ length: 4 }, (_, index) => `第${index + 1}场：${'人物完成一个明确动作。'.repeat(35)}`).join('\n');
  const batches = service.getStoryboardSourceBatches(story);
  assert.ok(batches.length > 1);
  const targetBatch = batches[batches.length - 1];
  const targetSourceId = targetBatch.segments[0].id;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...rawPlan, coveredSourceIds: [], shots: [{ ...rawPlan.shots[0], sourceSegmentIds: [] }] }) } }] }), { status: 200 });
  try {
    const plan = await service.generateAIStoryboard({ project, story, voice: 'naturalist', durationMode: 'ai', skills: [], selectedBatchIndexes: [targetBatch.index] });
    assert.ok(plan.shots.length > 0);
    assert.deepEqual(new Set(plan.shots.flatMap((shot) => shot.sourceSegmentIds)), new Set([targetSourceId]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('users can generate selected source batches only', async () => {
  const service = await loadDirectorAIService();
  const story = Array.from({ length: 6 }, (_, index) => `第${index + 1}场：${'人物执行动作并改变现场状态。'.repeat(35)}`).join('\n');
  const batches = service.getStoryboardSourceBatches(story);
  assert.ok(batches.length >= 3);
  const expectedIds = batches[1].segments.map((segment) => segment.id);
  const requestedIds = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const userContent = JSON.parse(options.body).messages[1].content;
    const ids = [...userContent.matchAll(/\[(source-\d+)\]/g)].map((match) => match[1]);
    requestedIds.push(...ids);
    const responsePlan = { ...rawPlan, coveredSourceIds: ids, shots: ids.map((id, index) => ({ ...rawPlan.shots[index % 2], sourceSegmentIds: [id], title: id })) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responsePlan) } }] }), { status: 200 });
  };
  try {
    const plan = await service.generateAIStoryboard({ project, story, voice: 'naturalist', durationMode: 'ai', skills: [], selectedBatchIndexes: [1] });
    assert.deepEqual(requestedIds, expectedIds);
    assert.deepEqual(new Set(plan.shots.flatMap((shot) => shot.sourceSegmentIds)), new Set(expectedIds));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('regenerated source sections replace overlapping shots and preserve order', async () => {
  const service = await loadDirectorAIService();
  const input = { project, story: '这是一个足够长的完整测试剧本，人物在房间里发现一封信并决定面对过去。', voice: 'naturalist', durationMode: 'ai', skills: [] };
  const makeShot = (sourceId, title) => ({ ...rawPlan.shots[0], sourceSegmentIds: [sourceId], title, narrativeJob: title, plannedEndState: `${title}结束` });
  const current = service.normalizeAIStoryboard({ ...rawPlan, coveredSourceIds: ['source-001', 'source-002', 'source-003'], shots: [makeShot('source-001', '旧一'), makeShot('source-002', '旧二A'), makeShot('source-002', '旧二B'), makeShot('source-003', '旧三')] }, input);
  const replacement = service.normalizeAIStoryboard({ ...rawPlan, coveredSourceIds: ['source-002'], shots: [makeShot('source-002', '新二A'), makeShot('source-002', '新二B')] }, input);
  const merged = service.mergeRegeneratedStoryboardShots(current, replacement, ['source-002']);
  assert.deepEqual(merged.shots.map((shot) => shot.narrativeJob), ['旧一', '新二A', '新二B', '旧三']);
  assert.deepEqual(merged.shots.map((shot) => shot.clipId), ['clip-001', 'clip-002', 'clip-003', 'clip-004']);
  assert.equal(merged.targetDurationSec, merged.shots.reduce((sum, shot) => sum + shot.targetDurationSec, 0));
});
