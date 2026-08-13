import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitoringService } from '../monitoring.js';
import { summarizeGenerationFailures } from '../generation-failure-policy.js';

const now = new Date().toISOString();
const completed = (id) => ({ id, status: 'completed', createdAt: now });
const failed = (id, errorCode) => ({ id, status: 'failed', errorCode, createdAt: now });

function monitoringFor(jobs) {
  const data = {
    generationJobs: jobs,
    users: [],
    auditLogs: [
      { action: 'backup_completed', targetType: 'backup', createdAt: now },
      { action: 'mysql_restore_drill_completed', targetType: 'backup', createdAt: now },
    ],
  };
  return createMonitoringService({
    db: { read: (collection) => data[collection] || [] },
    env: { ALERT_GENERATION_FAILURE_EMAIL_ENABLED: 'true' },
  });
}

test('generation failure email alerts are disabled by default while metrics remain available', () => {
  const jobs = Array.from({ length: 6 }, (_, index) => failed(`system-${index}`, 'UPSTREAM_VIDEO_FAILED'));
  const data = {
    generationJobs: jobs,
    users: [],
    auditLogs: [
      { action: 'backup_completed', targetType: 'backup', createdAt: now },
      { action: 'mysql_restore_drill_completed', targetType: 'backup', createdAt: now },
    ],
  };
  const snapshot = createMonitoringService({ db: { read: (collection) => data[collection] || [] } }).snapshot();
  assert.equal(snapshot.generationFailures.operationalFailed, 6);
  assert.equal(snapshot.generationFailures.emailEnabled, false);
  assert.equal(snapshot.alerts.some((alert) => alert.code === 'GENERATION_FAILURE_RATE'), false);
});

test('one operational generation failure is reported in metrics but does not alert', () => {
  const snapshot = monitoringFor([failed('system-1', 'UPSTREAM_VIDEO_FAILED')]).snapshot();
  assert.equal(snapshot.generationFailures.operationalFailed, 1);
  assert.equal(snapshot.generationFailures.operationalFailureRate, 1);
  assert.equal(snapshot.generationFailures.minimumCount, 2);
  assert.equal(snapshot.alerts.some((alert) => alert.code === 'GENERATION_FAILURE_RATE'), false);
});

test('two operational failures over the threshold trigger one aggregate alert', () => {
  const jobs = [failed('system-1', 'UPSTREAM_VIDEO_FAILED'), failed('system-2', 'VIDEO_JOB_TIMEOUT')];
  for (let index = 0; index < 8; index += 1) jobs.push(completed(`completed-${index}`));
  const snapshot = monitoringFor(jobs).snapshot();
  const alert = snapshot.alerts.find((item) => item.code === 'GENERATION_FAILURE_RATE');
  assert.deepEqual({ code: alert.code, count: alert.count, total: alert.total, rate: alert.rate, errorCodes: alert.errorCodes }, {
    code: 'GENERATION_FAILURE_RATE', count: 2, total: 10, rate: 0.2,
    errorCodes: [{ code: 'UPSTREAM_VIDEO_FAILED', count: 1 }, { code: 'VIDEO_JOB_TIMEOUT', count: 1 }],
  });
});

test('two failures in a tiny sample stay silent while five failures are considered critical', () => {
  assert.equal(monitoringFor([
    failed('small-1', 'UPSTREAM_VIDEO_FAILED'),
    failed('small-2', 'UPSTREAM_VIDEO_FAILED'),
  ]).snapshot().alerts.some((alert) => alert.code === 'GENERATION_FAILURE_RATE'), false);
  assert.equal(monitoringFor(Array.from({ length: 5 }, (_, index) => failed(`critical-${index}`, 'UPSTREAM_VIDEO_FAILED')))
    .snapshot().alerts.some((alert) => alert.code === 'GENERATION_FAILURE_RATE'), true);
});

test('prompt and image moderation failures are excluded from operational alerts', () => {
  const jobs = Array.from({ length: 6 }, (_, index) => failed(`moderation-${index}`, 'PROVIDER_MODERATION_ERROR'));
  const snapshot = monitoringFor(jobs).snapshot();
  assert.equal(snapshot.generationFailures.totalFailed, 6);
  assert.equal(snapshot.generationFailures.moderationFailed, 6);
  assert.equal(snapshot.generationFailures.operationalFailed, 0);
  assert.equal(snapshot.alerts.some((alert) => alert.code === 'GENERATION_FAILURE_RATE'), false);
});

test('moderation plus one system failure stays silent, but a second system failure alerts', () => {
  const jobs = [
    failed('moderation-1', 'CONTENT_POLICY_VIOLATION'),
    failed('system-1', 'UPSTREAM_VIDEO_FAILED'),
    completed('completed-1'),
  ];
  assert.equal(monitoringFor(jobs).snapshot().alerts.some((alert) => alert.code === 'GENERATION_FAILURE_RATE'), false);
  jobs.push(failed('system-2', 'UPSTREAM_TIMEOUT'));
  assert.equal(monitoringFor(jobs).snapshot().alerts.some((alert) => alert.code === 'GENERATION_FAILURE_RATE'), false);
  for (let index = 0; index < 7; index += 1) jobs.push(completed(`completed-${index + 2}`));
  assert.equal(monitoringFor(jobs).snapshot().alerts.some((alert) => alert.code === 'GENERATION_FAILURE_RATE'), true);
});

test('cancelled, balance and invalid-input outcomes are separated from system failures', () => {
  const summary = summarizeGenerationFailures([
    { id: 'cancelled', status: 'cancelled', errorCode: 'USER_CANCELLED' },
    failed('balance', 'INSUFFICIENT_BALANCE'),
    failed('duration', 'INVALID_DURATION'),
    failed('image', 'MISSING_IMAGES'),
    failed('unknown', 'UNRECOGNIZED_PROVIDER_FAILURE'),
  ]);
  assert.deepEqual({
    totalFailed: summary.totalFailed,
    operationalFailed: summary.operationalFailed,
    excludedFailed: summary.excludedFailed,
    businessFailed: summary.businessFailed,
    cancelled: summary.cancelled,
  }, { totalFailed: 4, operationalFailed: 1, excludedFailed: 3, businessFailed: 3, cancelled: 1 });
});
