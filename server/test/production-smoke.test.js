import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExpectedCommit } from '../scripts/production-smoke-lib.js';

test('production smoke accepts exact and abbreviated deployment commits', () => {
  const commit = '579483b4823ed8a23f3a74eb22efe807473307b2';
  assert.equal(validateExpectedCommit(commit, commit), commit);
  assert.equal(validateExpectedCommit(commit, '579483b'), commit);
  assert.equal(validateExpectedCommit(commit, ''), null);
});

test('production smoke rejects stale or unidentified deployments', () => {
  assert.throws(() => validateExpectedCommit('1111111', '2222222'), /commit mismatch/);
  assert.throws(() => validateExpectedCommit(null, '2222222'), /did not report a commit/);
});
