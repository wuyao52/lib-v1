import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonDatabase } from '../store.js';
import { runMaintenance } from '../maintenance.js';

test('maintenance removes expired operational rows while retaining active and recent records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-operational-cleanup-'));
  const db = await new JsonDatabase(join(directory, 'database.json')).init();
  const now = new Date('2026-08-11T08:00:00.000Z');
  const oldAudit = new Date(now.getTime() - 181 * 24 * 60 * 60 * 1000).toISOString();
  const recentAudit = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  await db.mutate((data) => {
    data.sessions.push({ id: 'expired-session', expiresAt: now.getTime() - 1 }, { id: 'active-session', expiresAt: now.getTime() + 60_000 });
    data.emailVerifications.push({ id: 'expired-email', expiresAt: now.getTime() - 1 }, { id: 'active-email', expiresAt: now.getTime() + 60_000 });
    data.imageCaptchas.push({ id: 'expired-captcha', expiresAt: now.getTime() - 1 }, { id: 'active-captcha', expiresAt: now.getTime() + 60_000 });
    data.rateLimits.push({ id: 'expired-limit', resetAt: now.getTime() - 1 }, { id: 'active-limit', resetAt: now.getTime() + 60_000 });
    data.auditLogs.push({ id: 'old-audit', createdAt: oldAudit }, { id: 'recent-audit', createdAt: recentAudit });
  });
  const result = await runMaintenance({ db, storage: null, generatedMedia: { cleanup: async () => ({ deleted: 0 }) }, now });
  assert.deepEqual(result.operationalData.removed, { sessions: 1, emailVerifications: 1, imageCaptchas: 1, rateLimits: 1, auditLogs: 1, requestMetricBuckets: 0 });
  assert.deepEqual(db.read('sessions').map((item) => item.id), ['active-session']);
  assert.deepEqual(db.read('auditLogs').map((item) => item.id), ['recent-audit']);
  const stats = await db.storageStats();
  assert.equal(stats.provider, 'json');
  assert.ok(stats.bytes > 0);
  assert.equal(stats.rows, 5);
});
