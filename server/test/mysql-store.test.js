import test from 'node:test';
import assert from 'node:assert/strict';
import { MySqlDatabase } from '../mysql-store.js';
import { runSchemaMigrations, schemaMigrationVersions } from '../schema-migrations.js';

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

test('MySQL multi-instance enqueue locks authoritative balance and pending count', async () => {
  const shared = { balance: 100, jobs: [], charges: 0, lock: Promise.resolve() };
  const makeConnection = () => {
    let unlock;
    return {
      async beginTransaction() {
        const previous = shared.lock;
        shared.lock = new Promise((resolve) => { unlock = resolve; });
        await previous;
      },
      async commit() { unlock?.(); unlock = null; },
      async rollback() { unlock?.(); unlock = null; },
      release() {},
      async query(sql, params) {
        if (/SELECT balance_cents AS balanceCents FROM users/i.test(sql)) return [[{ balanceCents: shared.balance }]];
        if (/FROM generation_jobs WHERE id = \? AND user_id = \?/i.test(sql)) return [[...shared.jobs.filter((job) => job.id === params[0] && job.userId === params[1])]];
        if (/SELECT COUNT\(\*\) AS pending/i.test(sql)) return [[{ pending: shared.jobs.filter((job) => !['completed', 'failed', 'cancelled'].includes(job.status)).length }]];
        if (/UPDATE users SET balance_cents = \?/i.test(sql)) { shared.balance = Number(params[0]); return [{ affectedRows: 1 }]; }
        if (/INSERT INTO balance_transactions/i.test(sql)) { shared.charges += 1; return [{ affectedRows: 1 }]; }
        if (/INSERT INTO generation_jobs/i.test(sql)) {
          const row = params[0][0];
          shared.jobs.push({ id: row[0], userId: row[1], apiId: row[2], modelId: row[3], requestBody: row[4], status: row[5], createdAt: row[19], updatedAt: row[21] });
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
  };
  const instances = [new MySqlDatabase('mysql://user:pass@127.0.0.1/test'), new MySqlDatabase('mysql://user:pass@127.0.0.1/test')];
  instances.forEach((db) => {
    db.pool = { getConnection: async () => makeConnection() };
    db.data.users = [{ id: 'shared-user', balanceCents: 100 }];
  });
  const jobs = Array.from({ length: 50 }, (_, index) => ({ id: `multi-${index}`, userId: 'shared-user', apiId: 'api-1', modelId: 'video', requestBody: {}, status: 'queued', chargeCents: 1, billingReference: `multi-${index}`, prompt: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const results = await Promise.all(jobs.map((job, index) => instances[index % 2].enqueueGenerationJob(job, 20, new Set(['completed', 'failed', 'cancelled']))));
  assert.equal(results.filter((item) => item.inserted).length, 20);
  assert.equal(results.filter((item) => item.error === 'VIDEO_QUEUE_USER_LIMIT').length, 30);
  assert.equal(shared.jobs.length, 20);
  assert.equal(shared.charges, 20);
  assert.equal(shared.balance, 80);
});

test('MySQL reports database bytes and estimated rows from information_schema', async () => {
  const db = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  db.pool = { query: async () => [[{ bytes: '314572800', rows: '12000' }]] };
  assert.deepEqual(await db.storageStats(), { provider: 'mysql', bytes: 314572800, rows: 12000 });
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

test('MySQL instances refresh route data instead of keeping startup snapshots', async () => {
  const sharedUsers = [];
  const pool = { async query(sql) {
    if (/^SELECT id, username, email/i.test(sql)) return [sharedUsers.map((user) => ({ ...user }))];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const first = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  const second = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  first.pool = pool; second.pool = pool;
  assert.equal(second.read('users').length, 0);
  sharedUsers.push({ id: 'shared-user', username: 'shared', email: 'shared@example.com', name: 'shared', passwordHash: 'salt:hash', role: 'user', balanceCents: 0, createdAt: new Date().toISOString() });
  await Promise.all([first.refreshCollections(['users']), second.refreshCollections(['users'])]);
  assert.equal(first.read('users')[0].id, 'shared-user');
  assert.equal(second.read('users')[0].id, 'shared-user');
});

test('MySQL unique index resolves concurrent case-insensitive usernames to one account', async () => {
  const users = [];
  const pool = { async query(sql, params) {
    if (/^INSERT INTO users/i.test(sql)) {
      const row = params[0][0];
      if (users.some((user) => user.username.toLowerCase() === String(row[1]).toLowerCase())) {
        const error = new Error('duplicate'); error.code = 'ER_DUP_ENTRY'; throw error;
      }
      users.push({ email: row[2], username: row[1] }); return [{ affectedRows: 1 }];
    }
    if (/^SELECT email, username FROM users/i.test(sql)) return [users.filter((user) => user.email === params[0] || user.username.toLowerCase() === String(params[1]).toLowerCase())];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const first = new MySqlDatabase('mysql://user:pass@127.0.0.1/test'); const second = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  first.pool = pool; second.pool = pool;
  const base = { name: 'same', passwordHash: 'salt:hash', role: 'user', balanceCents: 0, createdAt: new Date().toISOString() };
  const results = await Promise.all([
    first.createUser({ ...base, id: 'user-a', username: 'SameUser', email: 'a@example.com' }),
    second.createUser({ ...base, id: 'user-b', username: 'sameuser', email: 'b@example.com' }),
  ]);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results.find((result) => !result.created).error, 'USERNAME_EXISTS');
  assert.equal(users.length, 1);
});

test('MySQL startup applies versioned legacy alignment for system audit events', async () => {
  const statements = [];
  const db = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  db.pool = { async query(sql) {
    statements.push(sql);
    if (/^SELECT /i.test(sql)) return [[]];
    return [{ affectedRows: 0 }];
  } };
  await db.init();
  assert.equal(statements.some((sql) => /ALTER TABLE `audit_logs` MODIFY COLUMN `user_id` CHAR\(36\) NULL/i.test(sql)), true);
  assert.equal(statements.some((sql) => /CREATE TABLE IF NOT EXISTS audit_logs[\s\S]*user_id CHAR\(36\) NULL/i.test(sql)), true);
});

test('schema migrations execute once and skip all ALTER statements on later startup', async () => {
  const applied = new Set();
  const statements = [];
  const connection = {
    release() {},
    async query(sql, params) {
      statements.push(sql);
      if (/GET_LOCK/i.test(sql)) return [[{ acquired: 1 }]];
      if (/RELEASE_LOCK/i.test(sql)) return [[{ released: 1 }]];
      if (/SELECT version FROM schema_migrations/i.test(sql)) return [[...applied].map((version) => ({ version }))];
      if (/information_schema\.columns/i.test(sql)) return [[{ exists: 1 }]];
      if (/INSERT INTO schema_migrations/i.test(sql)) { applied.add(Number(params[0])); return [{ affectedRows: 1 }]; }
      return [{ affectedRows: 0 }];
    },
  };
  const pool = { getConnection: async () => connection };
  await runSchemaMigrations(pool);
  const firstAlterCount = statements.filter((sql) => /^ALTER TABLE/i.test(sql)).length;
  assert.equal(firstAlterCount, 2);
  assert.deepEqual([...applied], schemaMigrationVersions.map((item) => item.version));
  statements.length = 0;
  await runSchemaMigrations(pool);
  assert.equal(statements.some((sql) => /^ALTER TABLE/i.test(sql)), false);
  assert.equal(statements.some((sql) => /CREATE TABLE IF NOT EXISTS request_metric_buckets/i.test(sql)), false);
});

test('MySQL queue shutdown releases only the current worker leases', async () => {
  const statements = [];
  const db = new MySqlDatabase('mysql://user:pass@127.0.0.1/test');
  db.pool = { async query(sql, params) {
    statements.push({ sql, params });
    if (/^SELECT id, user_id AS userId/i.test(sql)) return [[]];
    return [{ affectedRows: 2 }];
  } };
  await db.releaseGenerationJobLeases('worker-current');
  const update = statements.find((item) => /WHERE lease_owner = \?/i.test(item.sql));
  assert.equal(update.params[1], 'worker-current');
  assert.match(update.sql, /status = CASE WHEN status = 'submitting' THEN 'queued'/i);
  assert.match(update.sql, /lease_owner = NULL, lease_until = 0/i);
});
