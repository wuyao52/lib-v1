import test from 'node:test';
import assert from 'node:assert/strict';
import { planGenerationTarget } from '../../src/store/generationPolicy.ts';

test('video generation overwrites its current node while other types create a result node', () => {
  const video = planGenerationTarget('video-node', 'video', () => 'unused');
  assert.deepEqual(video, { inPlace: true, targetNodeId: 'video-node', createResultNode: false, createResultEdge: false });
  const text = planGenerationTarget('text-node', 'text', () => 'result-node');
  assert.deepEqual(text, { inPlace: false, targetNodeId: 'result-node', createResultNode: true, createResultEdge: true });
});
