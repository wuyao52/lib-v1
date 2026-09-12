import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateProjectGenerations } from '../projects.js';

const baseProject = {
  id: 'project-recovery',
  title: '恢复测试项目',
  description: '',
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
  nodes: [{
    id: 'video-node',
    type: 'sceneNode',
    position: { x: 0, y: 0 },
    data: {
      label: '视频',
      type: 'video',
      content: '',
      prompt: '一只红色陶瓷杯',
      duration: 15,
      settings: {},
      status: 'generating',
      progress: 100,
      generationMeta: { configId: 'model-config', modelName: '测试视频模型' },
    },
  }],
  edges: [],
  settings: {},
};

test('project loading hydrates a completed durable video from the queue row', () => {
  const project = hydrateProjectGenerations(baseProject, 'user-1', {
    read(collection) {
      return collection === 'generationJobs' ? [{
        id: 'idem-long-video-job-id-012345678901234567890123456789012345678901234567',
        userId: 'user-1',
        projectId: 'project-recovery',
        nodeId: 'video-node',
        apiId: 'api-1',
        modelId: 'video-model',
        status: 'completed',
        progress: 100,
        resultUrl: '/api/generated-media/media-1',
        completedAt: '2026-09-12T10:12:00.000Z',
        updatedAt: '2026-09-12T10:12:00.000Z',
      }] : [];
    },
  });

  const node = project.nodes[0];
  assert.equal(node.data.status, 'completed');
  assert.equal(node.data.progress, 100);
  assert.equal(node.data.generatedContent, '/api/generated-media/media-1');
  assert.equal(node.data.generationMeta.taskId, 'idem-long-video-job-id-012345678901234567890123456789012345678901234567');
  assert.equal(node.data.generationMeta.apiId, 'api-1');
  assert.equal(node.data.generationMeta.modelId, 'video-model');
  assert.equal(node.data.generationMeta.completedAt, '2026-09-12T10:12:00.000Z');
});

test('project loading hydrates a pending video task so the browser can resume polling', () => {
  const project = hydrateProjectGenerations(baseProject, 'user-1', {
    read(collection) {
      return collection === 'generationJobs' ? [{
        id: 'queued-video-job',
        userId: 'user-1',
        projectId: 'project-recovery',
        nodeId: 'video-node',
        apiId: 'api-1',
        modelId: 'video-model',
        status: 'processing',
        progress: 100,
        resultUrl: 'https://provider.example/video.mp4',
        errorCode: 'VIDEO_ARCHIVE_PENDING',
        errorMessage: '视频已生成，正在保存播放文件',
      }] : [];
    },
  });

  const node = project.nodes[0];
  assert.equal(node.data.status, 'generating');
  assert.equal(node.data.progress, 100);
  assert.equal(node.data.generationMessage, '视频已生成，正在保存播放文件');
  assert.equal(node.data.generationMeta.taskId, 'queued-video-job');
  assert.equal(node.data.generationMeta.apiId, 'api-1');
  assert.equal(node.data.generationMeta.modelId, 'video-model');
  // The provider URL remains server-side while the archive is pending.
  assert.equal(node.data.generatedContent, undefined);
});
