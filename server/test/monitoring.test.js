import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createMonitoringService } from '../monitoring.js';

test('external monitoring sends a signed alert once and a recovery event when backlog clears', async () => {
  const calls = [];
  let jobs = [{ id: 'queued-1', status: 'queued', createdAt: new Date().toISOString() }];
  const now = new Date().toISOString();
  const auditLogs = [
    { id: 'backup-ok', action: 'backup_completed', targetType: 'backup', createdAt: now },
    { id: 'restore-ok', action: 'mysql_restore_drill_completed', targetType: 'backup', createdAt: now },
  ];
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
      ? [
        { id: 'backup-ok', action: 'backup_completed', targetType: 'backup', createdAt: new Date().toISOString() },
        { id: 'restore-ok', action: 'mysql_restore_drill_completed', targetType: 'backup', createdAt: new Date().toISOString() },
      ]
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

test('monitoring tracks backup and MySQL restore drill failures independently', async () => {
  const calls = [];
  const auditLogs = [
    { id: 'backup-failed', action: 'backup_failed', targetType: 'backup', createdAt: '2026-08-10T00:00:00.000Z' },
    { id: 'restore-failed', action: 'mysql_restore_drill_failed', targetType: 'backup', createdAt: '2026-08-10T00:00:01.000Z' },
  ];
  const db = { read: (collection) => collection === 'auditLogs' ? auditLogs : [] };
  const service = createMonitoringService({
    db,
    env: { ALERT_WEBHOOK_URL: 'https://alerts.example.test/hooks/backup', ALERT_WEBHOOK_SECRET: 'monitoring-webhook-secret-at-least-24', ALERT_BACKUP_MAX_AGE_HOURS: '12', ALERT_RESTORE_DRILL_MAX_AGE_HOURS: '840' },
    fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response('{}', { status: 202 }); },
  });
  const failed = await service.check();
  assert.deepEqual(failed.snapshot.alerts.map((item) => item.code), ['BACKUP_FAILED', 'BACKUP_STALE', 'RESTORE_DRILL_FAILED', 'RESTORE_DRILL_STALE']);
  const now = new Date().toISOString();
  auditLogs.push({ id: 'backup-success', action: 'backup_completed', targetType: 'backup', createdAt: now });
  assert.deepEqual((await service.check()).snapshot.alerts.map((item) => item.code), ['RESTORE_DRILL_FAILED', 'RESTORE_DRILL_STALE']);
  auditLogs.push({ id: 'restore-success', action: 'mysql_restore_drill_completed', targetType: 'backup', createdAt: new Date(Date.now() + 1).toISOString() });
  const recovered = await service.check();
  assert.equal(recovered.event, 'operations.recovered');
  assert.equal(calls.length, 3);
});

test('monitoring delivers the same redacted alert to webhook and system-user email once', async () => {
  const webhookCalls = [];
  const emails = [];
  const now = new Date().toISOString();
  const db = { read: (collection) => {
    if (collection === 'users') return [{ id: 'system-1', role: 'system', email: 'operator@example.com' }, { id: 'user-1', role: 'user', email: 'user@example.com' }];
    if (collection === 'auditLogs') return [
      { id: 'backup-ok', action: 'backup_completed', targetType: 'backup', createdAt: now },
      { id: 'restore-ok', action: 'mysql_restore_drill_completed', targetType: 'backup', createdAt: now },
    ];
    return [{ id: 'queued-1', status: 'queued', createdAt: now }];
  } };
  const service = createMonitoringService({
    db,
    env: { ALERT_WEBHOOK_URL: 'https://alerts.example.test/operations', ALERT_WEBHOOK_SECRET: 'monitoring-webhook-secret-at-least-24', ALERT_QUEUE_BACKLOG: '1' },
    fetchImpl: async (_url, options) => { webhookCalls.push(JSON.parse(options.body)); return new Response('{}', { status: 202 }); },
    emailSender: async (message) => emails.push(message),
  });
  const result = await service.check();
  assert.deepEqual(result.delivery.channels, ['webhook', 'email']);
  assert.equal(service.configured, true);
  assert.deepEqual(service.channels, { webhook: true, email: true });
  assert.deepEqual(emails.map((item) => item.to), ['operator@example.com']);
  assert.equal(emails[0].subject.includes('QUEUE_BACKLOG'), true);
  assert.equal(JSON.stringify(emails).includes('user@example.com'), false);
  assert.equal(webhookCalls.length, 1);
  assert.equal((await service.check()).changed, false);
  assert.equal(emails.length, 1);
});

test('monitoring is silent while initially healthy and sends one alert and one recovery across instances', async () => {
  const now = new Date().toISOString();
  const data = {
    users: [{ id: 'system-1', role: 'system', email: 'operator@example.com' }],
    generationJobs: [],
    auditLogs: [
      { id: 'backup-ok', action: 'backup_completed', targetType: 'backup', createdAt: now },
      { id: 'restore-ok', action: 'mysql_restore_drill_completed', targetType: 'backup', createdAt: now },
    ],
  };
  const locks = new Map();
  const db = {
    read: (collection) => data[collection] || [],
    mutate: async (mutation) => mutation(data),
    async consumeRateLimit(key, limit, windowMs) {
      const current = locks.get(key);
      if (!current || current.resetAt <= Date.now()) {
        locks.set(key, { count: 1, resetAt: Date.now() + windowMs });
        return { allowed: true, count: 1, resetAt: Date.now() + windowMs };
      }
      current.count += 1;
      return { allowed: current.count <= limit, count: current.count, resetAt: current.resetAt };
    },
  };
  const emails = [];
  const options = { db, env: { ALERT_REPEAT_HOURS: '24' }, emailSender: async (message) => emails.push(message) };
  const first = createMonitoringService(options);
  assert.equal((await first.check()).reason, 'HEALTHY');
  assert.equal(emails.length, 0);

  data.generationJobs.push({ id: 'queued-1', status: 'queued', createdAt: now });
  const alerting = createMonitoringService({ ...options, env: { ALERT_REPEAT_HOURS: '24', ALERT_QUEUE_BACKLOG: '1' } });
  assert.equal((await alerting.check()).event, 'operations.alert');
  for (let index = 0; index < 20; index += 1) await alerting.check();
  const restarted = createMonitoringService({ ...options, env: { ALERT_REPEAT_HOURS: '24', ALERT_QUEUE_BACKLOG: '1' } });
  await restarted.check();
  assert.equal(emails.length, 1);

  data.generationJobs.length = 0;
  assert.equal((await alerting.check()).event, 'operations.recovered');
  for (let index = 0; index < 20; index += 1) await restarted.check();
  assert.equal(emails.length, 2);
  assert.match(emails[0].subject, /运维告警/);
  assert.match(emails[1].subject, /运维恢复/);
});

test('monitoring test email is sent once per deployment even across service instances', async () => {
  const now = new Date().toISOString();
  const data = {
    users: [{ id: 'system-1', role: 'system', email: 'operator@example.com' }], generationJobs: [],
    auditLogs: [
      { id: 'backup-ok', action: 'backup_completed', targetType: 'backup', createdAt: now },
      { id: 'restore-ok', action: 'mysql_restore_drill_completed', targetType: 'backup', createdAt: now },
    ],
  };
  const locks = new Set();
  const db = {
    read: (collection) => data[collection] || [],
    async consumeRateLimit(key) {
      if (locks.has(key)) return { allowed: false, count: 2, resetAt: Date.now() + 1000 };
      locks.add(key);
      return { allowed: true, count: 1, resetAt: Date.now() + 1000 };
    },
  };
  const emails = [];
  const options = { db, env: { RAILWAY_DEPLOYMENT_ID: 'deployment-1' }, emailSender: async (message) => emails.push(message) };
  const first = createMonitoringService(options);
  const second = createMonitoringService(options);
  const results = await Promise.all([first.testOnce(), second.testOnce(), first.testOnce()]);
  assert.equal(results.filter((item) => item.delivered).length, 1);
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /运维测试：TEST/);
});
