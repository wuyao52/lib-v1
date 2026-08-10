import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';
import { JsonDatabase } from '../store.js';
import { createEncryptedBackup, createFreshEncryptedBackup, decodeEncryptedBackup, restoreEncryptedBackup } from '../backup.js';
import { runMaintenance } from '../maintenance.js';
import { runBackupDrill } from '../backup-drill.js';

const backupKey = 'independent-backup-encryption-key-for-tests';

test('encrypted backup restores real database rows and rejects tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-backup-'));
  const source = await new JsonDatabase(join(directory, 'source.json')).init();
  await source.mutate((data) => data.users.push({ id: 'user-1', username: 'backup-user', email: 'backup@example.com', name: 'Backup', passwordHash: 'hash', role: 'user', balanceCents: 1234, createdAt: new Date().toISOString() }));
  const document = createEncryptedBackup(source, backupKey, '2026-08-09T00:00:00.000Z');
  assert.equal(JSON.stringify(document).includes('backup@example.com'), false);
  const target = await new JsonDatabase(join(directory, 'target.json')).init();
  const restored = await restoreEncryptedBackup(target, document, backupKey);
  assert.equal(restored.backupCreatedAt, '2026-08-09T00:00:00.000Z');
  assert.equal(target.read('users')[0].email, 'backup@example.com');
  assert.throws(() => decodeEncryptedBackup({ ...document, checksum: '0'.repeat(64) }, backupKey), /Backup integrity check failed/);
  assert.throws(() => decodeEncryptedBackup(document, 'different-backup-key-that-is-long-enough'), /authenticate|加密|密钥|Unsupported state/i);
});

test('backup v2 compresses repetitive data and backup retention preserves minimum copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-backup-compression-'));
  const db = await new JsonDatabase(join(directory, 'source.json')).init();
  await db.mutate((data) => data.projects.push({ id: 'large-project', projectData: { script: 'repeated-scene '.repeat(20000) } }));
  const document = createEncryptedBackup(db, backupKey, '2026-08-10T03:00:00.000Z');
  assert.equal(document.format, 'ai-drama-studio-backup-v2');
  assert.equal(document.compression, 'gzip');
  assert.ok(JSON.stringify(document).length < JSON.stringify(db.data).length / 4);
  assert.equal(decodeEncryptedBackup(document, backupKey).collections.projects[0].id, 'large-project');

  const deleted = [];
  const storage = {
    list: async () => [
      { key: 'backups/newest.json', lastModified: '2026-08-10T00:00:00.000Z' },
      { key: 'backups/second.json', lastModified: '2026-08-09T00:00:00.000Z' },
      { key: 'backups/old.json', lastModified: '2026-06-01T00:00:00.000Z' },
    ],
    delete: async (key) => deleted.push(key),
  };
  const { cleanupStoredBackups } = await import('../backup.js');
  const result = await cleanupStoredBackups(storage, { now: new Date('2026-08-10T04:00:00.000Z'), retentionDays: 30, minimumCopies: 2 });
  assert.deepEqual(deleted, ['backups/old.json']);
  assert.deepEqual(result, { supported: true, deleted: 1, retained: 2 });
});

test('maintenance writes an encrypted backup to object storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-maintenance-'));
  const db = await new JsonDatabase(join(directory, 'database.json')).init();
  await db.mutate((data) => data.users.push({ id: 'user-maintenance', username: 'maintenance', email: 'maintenance@example.com', name: 'Maintenance', passwordHash: 'hash', role: 'user', balanceCents: 0, createdAt: new Date().toISOString() }));
  const puts = [];
  const previous = process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_ENCRYPTION_KEY = backupKey;
  try {
    const result = await runMaintenance({ db, storage: { put: async (item) => puts.push(item), delete: async () => {} }, generatedMedia: { cleanup: async () => ({ deleted: 0 }) }, now: new Date('2026-08-10T00:00:00.000Z') });
    assert.match(result.backup.objectKey, /^backups\/database-2026-08-10T00-00-00-000Z\.json$/);
    const saved = JSON.parse(puts[0].bytes.toString('utf8'));
    assert.equal(JSON.stringify(saved).includes('maintenance@example.com'), false);
    assert.equal(decodeEncryptedBackup(saved, backupKey).collections.users[0].email, 'maintenance@example.com');
  } finally { if (previous === undefined) delete process.env.BACKUP_ENCRYPTION_KEY; else process.env.BACKUP_ENCRYPTION_KEY = previous; }
});

test('fresh backups refresh every MySQL collection before encryption', async () => {
  const calls = [];
  const db = {
    data: { users: [{ id: 'stale-user' }], projects: [] },
    refreshCollections: async (names) => {
      calls.push([...names]);
      db.data.users = [{ id: 'fresh-user' }];
    },
  };
  const document = await createFreshEncryptedBackup(db, backupKey, '2026-08-10T01:00:00.000Z');
  const payload = decodeEncryptedBackup(document, backupKey);
  assert.deepEqual(calls, [['users', 'projects']]);
  assert.equal(payload.collections.users[0].id, 'fresh-user');
});

test('backup drill stores, downloads and restores every collection in isolation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-backup-drill-source-'));
  const db = await new JsonDatabase(join(directory, 'source.json')).init();
  await db.mutate((data) => {
    data.users.push({ id: 'drill-user', username: 'drill', email: 'drill@example.com' });
    data.projects.push({ id: 'drill-project', userId: 'drill-user', title: 'Drill' });
  });
  const objects = new Map();
  const phases = [];
  const result = await runBackupDrill({
    db,
    encryptionKey: backupKey,
    now: new Date('2026-08-10T02:00:00.000Z'),
    storage: {
      provider: 'test-storage',
      put: async ({ key, bytes }) => objects.set(key, Buffer.from(bytes)),
      get: async (key) => objects.get(key),
    },
    onPhase: (phase) => phases.push(phase),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verifiedCollections, Object.keys(db.data).length);
  assert.equal(result.collectionCounts.users, 1);
  assert.equal(result.collectionCounts.projects, 1);
  assert.deepEqual(phases, ['snapshot_encrypted', 'object_uploaded', 'object_downloaded', 'isolated_restore_completed']);
  assert.equal(objects.has(result.objectKey), true);
});

test('maintenance respects a shared database lock', async () => {
  let calls = 0;
  const db = { consumeRateLimit: async () => ({ allowed: ++calls === 1 }), read: () => [], mutate: async () => {} };
  const first = await runMaintenance({ db, generatedMedia: { cleanup: async () => ({ deleted: 0 }) } });
  const second = await runMaintenance({ db, generatedMedia: { cleanup: async () => ({ deleted: 0 }) } });
  assert.equal(first.skipped, undefined);
  assert.deepEqual(second, { skipped: true, reason: 'MAINTENANCE_LOCKED', ranAt: second.ranAt });
});

test('health checks report object-storage failure and admin metrics stay role protected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-operations-'));
  const codes = new Map();
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    assetStorage: { provider: 'test-r2', health: async () => { throw new Error('storage unavailable'); } },
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 503);
  assert.deepEqual((await health.json()).checks, { database: 'ok', objectStorage: 'error', queue: 'disabled' });

  const register = async (username) => {
    const email = `${username}@example.com`;
    await fetch(`${baseUrl}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
    const response = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, name: username, password: 'strong-password', verificationCode: codes.get(email) }) });
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
  };
  const normal = await register('metrics-normal');
  const admin = await register('metrics-admin');
  await db.mutate((data) => {
    data.users.find((user) => user.id === admin.user.id).role = 'system';
    data.generationJobs.push({ id: 'job-complete', userId: normal.user.id, apiId: 'api', modelId: 'video', status: 'completed', progress: 100, resultUrl: 'https://provider.example/video.mp4', createdAt: new Date(Date.now() - 2000).toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    data.balanceTransactions.push({ id: 'refund-1', userId: normal.user.id, amountCents: 250, type: 'model_refund', description: 'refund', createdAt: new Date().toISOString() });
  });
  assert.equal((await fetch(`${baseUrl}/api/admin/metrics`, { headers: { cookie: normal.cookie } })).status, 403);
  const metricsResponse = await fetch(`${baseUrl}/api/admin/metrics`, { headers: { cookie: admin.cookie } });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.recent.completed, 1);
  assert.equal(metrics.recent.refundedCents, 250);
  assert.equal(metrics.recent.archiveFallbacks, 1);
  assert.ok(metrics.recent.averageCompletionMs >= 0);
});

test('backup administration is role protected, password confirmed, locked and redacted', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-admin-backups-'));
  const codes = new Map();
  const objects = new Map();
  let releaseUpload;
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  const storage = {
    provider: 'test-oss',
    health: async () => true,
    list: async (prefix) => [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.length, lastModified: new Date().toISOString() })),
    put: async ({ key, bytes }) => { await uploadGate; objects.set(key, Buffer.from(bytes)); },
    get: async (key) => objects.get(key),
  };
  const { app, db } = await createApp({
    databasePath: join(directory, 'database.json'), secureCookies: false, videoQueue: false,
    assetStorage: storage, backupEncryptionKey: backupKey,
    sendEmailCode: async ({ email, code }) => codes.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { releaseUpload(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const register = async (username) => {
    const email = `${username}@example.com`;
    await fetch(`${baseUrl}/api/auth/email-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'register' }) });
    const response = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email, password: 'strong-password', verificationCode: codes.get(email) }) });
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
  };
  const normal = await register('backup-normal');
  const admin = await register('backup-admin');
  await db.mutate((data) => { data.users.find((user) => user.id === admin.user.id).role = 'system'; });

  assert.equal((await fetch(`${baseUrl}/api/admin/backups`, { headers: { cookie: normal.cookie } })).status, 403);
  const initial = await fetch(`${baseUrl}/api/admin/backups`, { headers: { cookie: admin.cookie } });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).provider, 'test-oss');
  const missingPassword = await fetch(`${baseUrl}/api/admin/backups/drill`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(missingPassword.status, 401);
  const started = await fetch(`${baseUrl}/api/admin/backups/drill`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'strong-password' }) });
  assert.equal(started.status, 202);
  assert.equal(typeof (await started.json()).operationId, 'string');
  const duplicate = await fetch(`${baseUrl}/api/admin/backups/drill`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'strong-password' }) });
  assert.equal(duplicate.status, 409);
  releaseUpload();
  for (let attempt = 0; attempt < 50 && !db.read('auditLogs').some((item) => item.action === 'backup_drill_completed'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(db.read('auditLogs').some((item) => item.action === 'backup_drill_completed'), true);
  const overview = await (await fetch(`${baseUrl}/api/admin/backups`, { headers: { cookie: admin.cookie } })).json();
  assert.equal(overview.backups.length, 1);
  assert.equal(overview.backups[0].verification, 'backup_drill_completed');
  assert.equal(overview.events.some((item) => item.action === 'backup_drill_completed'), true);
  const publicBody = JSON.stringify(overview);
  assert.equal(publicBody.includes('encryptedPayload'), false);
  assert.equal(publicBody.includes('backup-normal@example.com'), false);
  assert.equal(publicBody.includes('strong-password'), false);
});
