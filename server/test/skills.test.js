import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../skills.js';
import { buildStoryboard } from '../director.js';

test('imports SKILL.md frontmatter and applies instructions to director prompts', () => {
  const parsed = parseFrontmatter(`---\nname: 雨夜声音设计\ndescription: 控制雨夜声音\ntags: [audio, rain]\n---\n每个镜头只保留一种主要环境声，动作落点必须有同步音效。`);
  assert.equal(parsed.metadata.name, '雨夜声音设计');
  assert.deepEqual(parsed.metadata.tags, ['audio', 'rain']);

  const storyboard = buildStoryboard({
    story: '女孩走进雨夜车站。她看见空椅上的红色围巾。她拿起围巾并望向远处驶来的列车。',
    targetDurationSec: 18,
    clipBudgetSec: 6,
  }, [{ id: 'skill-1', name: parsed.metadata.name, instructions: parsed.body }]);
  assert.equal(storyboard.customSkills[0].name, '雨夜声音设计');
  assert.ok(storyboard.shots[0].prompt.includes('动作落点必须有同步音效'));
});
