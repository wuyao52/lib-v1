import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryboard } from '../director.js';

test('director compiler creates stateful Seedance shot contracts', () => {
  const storyboard = buildStoryboard({
    title: '雨夜归家',
    story: '女孩在雨夜回到旧屋。她发现桌上的信已经被拆开。父亲从暗处走出，她把钥匙放在桌上。两人沉默后重新坐下。',
    targetDurationSec: 24,
    clipBudgetSec: 6,
    voice: 'minimalist',
    aspectRatio: '16:9',
  });
  assert.equal(storyboard.projectMode, 'sequence_project');
  assert.equal(storyboard.shots.length, 4);
  assert.equal(storyboard.shots[0].status, 'ready');
  assert.equal(storyboard.shots[1].status, 'provisional');
  assert.ok(storyboard.shots[0].prompt.includes('本镜头只表现'));
  assert.ok(storyboard.shots[0].prompt.includes('不要提前表现'));
  assert.equal(storyboard.continuityBible.chainDepthLimit, 2);
  assert.equal(storyboard.scenes[0].anchorSource, 'canonical_references');
});

test('director clips are constrained to 5-15 seconds', () => {
  const baseInput = {
    story: '女孩走进空荡的车站。广播突然响起她的名字。她停下脚步，转身寻找声音的来源。',
    targetDurationSec: 30,
  };
  const shortPlan = buildStoryboard({ ...baseInput, clipBudgetSec: 4 });
  const longPlan = buildStoryboard({ ...baseInput, clipBudgetSec: 20 });
  assert.ok(shortPlan.shots.every((shot) => shot.targetDurationSec === 5));
  assert.ok(longPlan.shots.every((shot) => shot.targetDurationSec === 15));
});
