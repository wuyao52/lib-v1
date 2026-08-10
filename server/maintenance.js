import { createEncryptedBackup } from './backup.js';
import { cleanupExpiredAssets } from './assets.js';

const HOUR = 60 * 60 * 1000;
const intEnv = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

export async function runMaintenance({ db, storage, generatedMedia, now = new Date() } = {}) {
  if (db?.consumeRateLimit) {
    const lock = await db.consumeRateLimit('maintenance:global-lock', 1, 5 * 60 * 1000, now.getTime());
    if (!lock.allowed) return { skipped: true, reason: 'MAINTENANCE_LOCKED', ranAt: now.toISOString() };
  }
  const results = { ranAt: now.toISOString(), assets: null, media: null, backup: null };
  results.assets = await cleanupExpiredAssets({ db, assetStorage: storage, retentionDays: intEnv('ASSET_RETENTION_DAYS', 30, 1, 36500) });
  results.media = generatedMedia ? await generatedMedia.cleanup() : { deleted: 0 };
  const key = String(process.env.BACKUP_ENCRYPTION_KEY || '');
  if (storage && key.length >= 24) {
    const document = createEncryptedBackup(db, key, results.ranAt);
    const objectKey = `backups/database-${results.ranAt.replace(/[:.]/g, '-')}.json`;
    await storage.put({ key: objectKey, bytes: Buffer.from(JSON.stringify(document)), mimeType: 'application/json' });
    results.backup = { objectKey, checksum: document.checksum };
  }
  return results;
}

export function startMaintenanceScheduler(options) {
  const intervalMs = intEnv('MAINTENANCE_INTERVAL_HOURS', 6, 1, 168) * HOUR;
  const run = () => runMaintenance(options).catch((error) => console.error('Scheduled maintenance failed:', error));
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { run, stop: () => clearInterval(timer), intervalMs };
}
