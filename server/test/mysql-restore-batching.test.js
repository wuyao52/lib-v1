import test from 'node:test';
import assert from 'node:assert/strict';
import { MySqlDatabase } from '../mysql-store.js';

test('restoreCollections writes the observed 634-row backup collection in bounded batches', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push(['begin']),
    query: async (sql, values) => calls.push([sql, values]),
    commit: async () => calls.push(['commit']),
    rollback: async () => calls.push(['rollback']),
    release: () => calls.push(['release']),
  };
  const database = {
    data: { users: [] },
    writeQueue: Promise.resolve(),
    collectionRefreshedAt: new Map(),
    pool: { getConnection: async () => connection },
  };
  const users = Array.from({ length: 634 }, (_, index) => ({
    id: `user-${index}`, username: `user-${index}`, email: `user-${index}@example.test`, name: `User ${index}`,
    passwordHash: 'hash', role: 'user', accountType: 'special', balanceCents: 0, createdAt: '2026-09-01T00:00:00.000Z',
  }));

  await MySqlDatabase.prototype.restoreCollections.call(database, { users }, { batchSize: 10 });

  const inserts = calls.filter(([sql]) => String(sql).startsWith('INSERT INTO users'));
  assert.equal(inserts.length, 64);
  assert.equal(inserts.every(([, values]) => values[0].length <= 10), true);
  assert.equal(inserts.at(-1)[1][0].length, 4);
  assert.equal(calls.some(([sql]) => sql === 'DELETE FROM `users`'), true);
  assert.equal(calls.some(([name]) => name === 'commit'), true);
  assert.equal(calls.some(([name]) => name === 'rollback'), false);
  assert.equal(database.data.users, users);
});
