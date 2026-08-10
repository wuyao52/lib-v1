import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createMonitoringService } from '../monitoring.js';

test('external monitoring sends a signed alert once and a recovery event when backlog clears', async () => {
  const calls = [];
  let jobs = [{ id: 'queued-1', status: 'queued', createdAt: new Date().toISOString() }];
  const auditLogs = [{ id: 'backup-ok', action: 'backup_completed', targetType: 'backup', createdAt: new Date().toISOString() }];
  const db = { read: (collection) => collection === 'auditLogs' ? auditLogs : jobs };
  const secret = 'monitoring-webhook-secret-at-least-24';
  const service = createMonitoringService({
    db,
    env: { ALERT_WEBHOOK_URL: 'https://alerts.example.test/hooks/ai-drama', ALERT_WEBHOOK_SECRET: secret, ALERT_QUEUE_BACKLOG: '1' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{}', { status: 202 }); },
  });
  const first = await service.check();
  assert.equal(first.event, 'operations.alert');
  assert.equal(calls.length, 1);
  const body = calls[0].options.body;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(calls[0].options.headers['x-ai-drama-signature'], expected);
  assert.equal(JSON.parse(body).operations.alerts[0].code, 'QUEUE_BACKLOG');
  assert.equal((await service.check()).changed, false);
  jobs = [];
  const recovered = await service.check();
  assert.equal(recovered.event, 'operations.recovered');
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls).includes('prompt'), false);
  assert.equal(createHash('sha256').update(body).digest('hex').length, 64);
});

test('two service instances share an alert lock and send one notification', async () => {
  const locks = new Map();
  const calls = [];
  const db = {
    read: (collection) => collection === 'auditLogs'
      ? [{ id: 'backup-ok', action: 'backup_completed', targetType: 'backup', createdAt: new Date().toISOString() }]
      : [{ id: 'queued-1', status: 'queued', createdAt: new Date().toISOString() }],
    async consumeRateLimit(key, limit, windowMs) {
      const existing = locks.get(key) || 0;
      locks.set(key, existing + 1);
      return { allowed: existing < limit, count: existing + 1, resetAt: Date.now() + windowMs };
    },
  };
  const env = {
    ALERT_WEBHOOK_URL: 'https://alerts.example.test/hooks/ai-drama',
    ALERT_WEBHOOK_SECRET: 'monitoring-webhook-secret-at-least-24',
    ALERT_QUEUE_BACKLOG: '1',
  };
  const fetchImpl = async () => { calls.push(true); return new Response('{}', { status: 202 }); };
  const first = createMonitoringService({ db, env, fetchImpl });
  const second = createMonitoringService({ db, env, fetchImpl });

  const results = await Promise.all([first.check(), second.check()]);
  assert.equal(results.filter((result) => result.changed).length, 1);
  assert.equal(calls.length, 1);
  assert.ok([...locks.keys()].every((key) => key.length === 64));
});

test('monitoring alerts on a failed backup and recovers after a successful drill', async () => {
  const calls = [];
  const auditLogs = [{ id: 'failed', action: 'backup_failed', targetType: 'backup', createdAt: '2026-08-10T00:00:00.000Z' }];
  const db = { read: (collection) => collection === 'auditLogs' ? auditLogs : [] };
  const service = createMonitoringService({
    db,
    env: { ALERT_WEBHOOK_URL: 'https://alerts.example.test/hooks/backup', ALERT_WEBHOOK_SECRET: 'monitoring-webhook-secret-at-least-24', ALERT_BACKUP_MAX_AGE_HOURS: '12' },
    fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response('{}', { status: 202 }); },
  });
  const failed = await service.check();
  assert.deepEqual(failed.snapshot.alerts.map((item) => item.code), ['BACKUP_FAILED', 'BACKUP_STALE']);
  auditLogs.push({ id: 'success', action: 'backup_drill_completed', targetType: 'backup', createdAt: new Date().toISOString() });
  const recovered = await service.check();
  assert.equal(recovered.event, 'operations.recovered');
  assert.equal(calls.length, 2);
});
