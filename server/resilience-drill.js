import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { JsonDatabase } from './store.js';
import { runMaintenance } from './maintenance.js';

export async function runResilienceDrill({ concurrency = 50 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-drama-resilience-'));
  let server;
  try {
    const db = await new JsonDatabase(join(directory, 'database.json')).init();
    let databaseDown = false;
    let storageDown = false;
    db.ping = async () => { if (databaseDown) throw new Error('injected database outage'); return true; };
    const storage = { provider: 'drill-storage', health: async () => { if (storageDown) throw new Error('injected storage outage'); return true; }, list: async () => [] };
    const context = await createApp({ database: db, assetStorage: storage, secureCookies: false, videoQueue: false, monitoring: false, maintenance: false });
    server = context.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const health = async () => {
      const response = await fetch(`${origin}/api/health`);
      return { status: response.status, body: await response.json() };
    };

    databaseDown = true;
    const databaseFailure = await health();
    databaseDown = false; storageDown = true;
    const storageFailure = await health();
    storageDown = false;
    const recovered = await health();
    const concurrent = await Promise.all(Array.from({ length: concurrency }, () => health()));

    const now = new Date('2026-08-11T12:00:00.000Z');
    await db.mutate((data) => data.sessions.push({ id: 'drill-expired', expiresAt: now.getTime() - 1 }, { id: 'drill-active', expiresAt: now.getTime() + 60_000 }));
    const maintenance = await runMaintenance({ db, storage: null, generatedMedia: { cleanup: async () => ({ deleted: 0 }) }, now });
    const metrics = context.requestMetrics.snapshot();
    const result = {
      databaseFailure: { status: databaseFailure.status, check: databaseFailure.body.checks.database },
      storageFailure: { status: storageFailure.status, check: storageFailure.body.checks.objectStorage },
      recovered: { status: recovered.status, ok: recovered.body.ok },
      concurrent: { attempted: concurrency, succeeded: concurrent.filter((item) => item.status === 200 && item.body.ok).length },
      maintenance: { removedSessions: maintenance.operationalData.removed.sessions, remainingSessions: db.read('sessions').map((item) => item.id) },
      metrics: { total: metrics.total, p95Ms: metrics.p95Ms, serverErrorRate: metrics.serverErrorRate },
    };
    return {
      ok: result.databaseFailure.status === 503 && result.databaseFailure.check === 'error'
        && result.storageFailure.status === 503 && result.storageFailure.check === 'error'
        && result.recovered.status === 200 && result.recovered.ok
        && result.concurrent.succeeded === concurrency
        && result.maintenance.removedSessions === 1
        && result.maintenance.remainingSessions.length === 1,
      ...result,
    };
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
