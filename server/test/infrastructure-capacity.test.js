import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app.js';
import { latestInfrastructureCapacity, signCapacityReport, verifyCapacityReport } from '../infrastructure-capacity.js';

const secret = 'capacity-report-secret-at-least-24-characters';

test('capacity report signature expires, rejects tampering and accepts exact bytes', () => {
  const now = Date.parse('2026-08-11T10:00:00.000Z');
  const body = Buffer.from(JSON.stringify({ source: 'railway-mysql', usedBytes: 420, totalBytes: 500 }));
  const signature = signCapacityReport(secret, now, body);
  assert.equal(verifyCapacityReport({ secret, timestamp: now, signature, rawBody: body, now }).report.usagePercent, 84);
  assert.equal(verifyCapacityReport({ secret, timestamp: now, signature, rawBody: Buffer.from(body.toString().replace('420', '421')), now }).error, 'CAPACITY_REPORT_SIGNATURE_INVALID');
  assert.equal(verifyCapacityReport({ secret, timestamp: now - 6 * 60 * 1000, signature, rawBody: body, now }).error, 'CAPACITY_REPORT_EXPIRED');
});

test('signed infrastructure capacity endpoint stores one redacted report and rejects replay', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-capacity-report-'));
  const { app, db } = await createApp({ databasePath: join(directory, 'database.json'), infrastructureCapacitySecret: secret, videoQueue: false, maintenance: false, monitoring: false, assetStorage: null, sendEmailCode: async () => {} });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); t.after(() => server.close());
  const timestamp = Date.now(); const body = Buffer.from(JSON.stringify({ source: 'railway-mysql', usedBytes: 450, totalBytes: 500 }));
  const headers = { 'content-type': 'application/json', 'x-capacity-timestamp': String(timestamp), 'x-capacity-signature': signCapacityReport(secret, timestamp, body) };
  const url = `http://127.0.0.1:${server.address().port}/api/monitoring/capacity`;
  const accepted = await fetch(url, { method: 'POST', headers, body });
  assert.equal(accepted.status, 202);
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 409);
  const report = latestInfrastructureCapacity(db, { INFRA_CAPACITY_STALE_MINUTES: '30' }, timestamp);
  assert.deepEqual({ source: report.source, usedBytes: report.usedBytes, totalBytes: report.totalBytes, usagePercent: report.usagePercent, stale: report.stale }, { source: 'railway-mysql', usedBytes: 450, totalBytes: 500, usagePercent: 90, stale: false });
  assert.equal(JSON.stringify(db.read('auditLogs')).includes(secret), false);
});
