import test from 'node:test';
import assert from 'node:assert/strict';
import { MySqlDatabase } from '../mysql-store.js';

function databaseWithRecordedSql() {
  const statements = [];
  const connection = {
    beginTransaction: async () => statements.push('BEGIN'),
    commit: async () => statements.push('COMMIT'),
    rollback: async () => statements.push('ROLLBACK'),
    release() {},
    async query(sql, params) { statements.push({ sql, params }); return [{}]; },
  };
  const db = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  db.pool = { getConnection: async () => connection };
  return { db, statements };
}

test('MySQL generic mutations upsert changed rows without replacing whole tables', async () => {
  const { db, statements } = databaseWithRecordedSql();
  db.data.users.push({
    id: 'user-1', username: 'user-one', email: 'one@example.com', name: 'Before',
    passwordHash: 'salt:hash', role: 'user', balanceCents: 0, createdAt: new Date().toISOString(),
  });

  await db.mutate((data) => { data.users[0].name = 'After'; });

  const queries = statements.filter((entry) => typeof entry === 'object');
  assert.equal(queries.some(({ sql }) => /^DELETE FROM `users`\s*$/i.test(sql)), false);
  assert.equal(queries.some(({ sql }) => /INSERT INTO users/i.test(sql) && /ON DUPLICATE KEY UPDATE/i.test(sql)), true);
  assert.equal(queries.flatMap(({ params }) => params || []).flat(Infinity).includes('After'), true);
});

test('MySQL generic mutations delete only explicitly removed primary keys', async () => {
  const { db, statements } = databaseWithRecordedSql();
  db.data.sessions.push({ id: 'session-1', userId: 'user-1', tokenHash: 'a'.repeat(64), createdAt: 1, expiresAt: 2, userAgent: 'test' });

  await db.mutate((data) => { data.sessions = []; });

  const deletion = statements.find((entry) => typeof entry === 'object' && /DELETE FROM `sessions`/i.test(entry.sql));
  assert.match(deletion.sql, /WHERE id IN \(\?\)/i);
  assert.deepEqual(deletion.params, [['session-1']]);
});

test('MySQL atomic lease allows only one worker to claim the same queued job', async () => {
  const shared = { status: 'queued' };
  const pool = {
    async query(sql) {
      if (/UPDATE generation_jobs SET status/i.test(sql)) {
        if (shared.status !== 'queued') return [{ affectedRows: 0 }];
        shared.status = 'submitting';
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const job = { id: 'job-1', status: 'queued' };
  const first = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  const second = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  first.pool = pool;
  second.pool = pool;
  first.data.generationJobs = [{ ...job }];
  second.data.generationJobs = [{ ...job }];

  const claims = await Promise.all([
    first.claimGenerationJobs(['job-1'], new Date().toISOString(), 'worker-a', Date.now() + 120000),
    second.claimGenerationJobs(['job-1'], new Date().toISOString(), 'worker-b', Date.now() + 120000),
  ]);
  assert.equal(claims.flat().length, 1);
  assert.equal(new Set(claims.flat().map((item) => item.leaseOwner)).size, 1);
});

test('MySQL rate limits are shared by separate application instances', async () => {
  const row = { count: 0, resetAt: 0 };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      if (/^SELECT request_count/i.test(sql)) return [row.count ? [{ count: row.count, resetAt: row.resetAt }] : []];
      if (/^INSERT INTO rate_limits/i.test(sql)) { row.count = 1; row.resetAt = params[1]; return [{ affectedRows: 1 }]; }
      if (/SET request_count = \?/i.test(sql)) { row.count = params[0]; return [{ affectedRows: 1 }]; }
      if (/SET request_count = 1/i.test(sql)) { row.count = 1; row.resetAt = params[0]; return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const pool = { getConnection: async () => connection };
  const first = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  const second = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  first.pool = pool;
  second.pool = pool;
  assert.equal((await first.consumeRateLimit('shared-key', 3, 60000, 1000)).allowed, true);
  assert.equal((await second.consumeRateLimit('shared-key', 3, 60000, 1001)).allowed, true);
  assert.equal((await first.consumeRateLimit('shared-key', 3, 60000, 1002)).allowed, true);
  assert.equal((await second.consumeRateLimit('shared-key', 3, 60000, 1003)).allowed, false);
  assert.equal(row.count, 4);
});
