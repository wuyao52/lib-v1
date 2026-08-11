import 'dotenv/config';
import { createApp } from './app.js';
import { runBackupDrill } from './backup-drill.js';

const port = Number(process.env.PORT || 8787);
const allowedOrigins = String(process.env.APP_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const { app, db, monitoring, maintenance, assetStorage, requestMetrics, videoQueue, directorCompositionQueue } = await createApp({ allowedOrigins, serveFrontend: true });
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`AI Drama Studio server listening on http://127.0.0.1:${port}`);
});

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; draining HTTP requests`);
  monitoring.stop();
  maintenance?.stop?.();
  const shutdownTimeoutMs = Math.min(120_000, Math.max(5_000, Number(process.env.SHUTDOWN_TIMEOUT_SECONDS || 30) * 1000));
  const queueStop = videoQueue?.stop?.({ timeoutMs: Math.max(1000, shutdownTimeoutMs - 5000) }) || Promise.resolve({ drained: true });
  const directorQueueStop = directorCompositionQueue?.stop?.() || Promise.resolve();
  const deadline = setTimeout(() => process.exit(1), shutdownTimeoutMs);
  deadline.unref?.();
  server.close(async () => {
    try {
      const queueResult = await queueStop;
      await directorQueueStop;
      if (!queueResult.drained) console.warn('Video queue shutdown timed out; leases were released for another worker');
      await requestMetrics.close?.();
      await db.close?.();
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      console.error('Graceful shutdown failed:', error);
      process.exit(1);
    }
  });
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

if (String(process.env.BACKUP_DRILL_ON_START || '').toLowerCase() === 'true') {
  const startedAt = Date.now();
  const onPhase = (phase, details = {}) => console.log('Backup drill phase:', JSON.stringify({ phase, elapsedMs: Date.now() - startedAt, ...details }));
  runBackupDrill({ db, storage: assetStorage, encryptionKey: process.env.BACKUP_ENCRYPTION_KEY, onPhase })
    .then((result) => console.log('Backup drill completed:', JSON.stringify(result)))
    .catch((error) => console.error('Backup drill failed:', JSON.stringify({ name: error?.name || 'Error', code: error?.code || '', message: String(error?.message || 'Unknown error').slice(0, 300) })));
}

if (String(process.env.ALERT_TEST_ON_START || '').toLowerCase() === 'true') {
  monitoring.testOnce()
    .then((result) => console.log('Monitoring test completed:', JSON.stringify(result)))
    .catch((error) => console.error('Monitoring test failed:', JSON.stringify({ name: error?.name || 'Error', code: error?.code || '', message: String(error?.message || 'Unknown error').slice(0, 300) })));
}
