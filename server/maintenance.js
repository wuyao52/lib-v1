import { cleanupStoredBackups, createFreshEncryptedBackup, recordBackupEvent } from './backup.js';
import { cleanupExpiredAssets, migrateLegacyAssets } from './assets.js';
import { cleanupOperationalData } from './operational-cleanup.js';
import { purgeExpiredQuarantine } from './storage-quarantine.js';

const HOUR = 60 * 60 * 1000;
const intEnv = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

export async function runMaintenance({ db, storage, generatedMedia, now = new Date() } = {}) {
  if (db?.consumeRateLimit) {
    const lockMinutes = intEnv('MAINTENANCE_LOCK_MINUTES', 30, 10, 1440);
    const lock = await db.consumeRateLimit('maintenance:global-lock', 1, lockMinutes * 60 * 1000, now.getTime());
    if (!lock.allowed) return { skipped: true, reason: 'MAINTENANCE_LOCKED', ranAt: now.toISOString() };
  }
  const results = { ranAt: now.toISOString(), operationalData: null, assetMigration: null, assets: null, media: null, quarantine: null, backup: null };
  results.operationalData = await cleanupOperationalData({ db, now, auditRetentionDays: intEnv('AUDIT_LOG_RETENTION_DAYS', 180, 30, 3650) });
  results.assetMigration = await migrateLegacyAssets({ db, assetStorage: storage });
  results.assets = await cleanupExpiredAssets({ db, assetStorage: storage, retentionDays: intEnv('ASSET_RETENTION_DAYS', 30, 1, 36500) });
  results.media = generatedMedia ? await generatedMedia.cleanup() : { deleted: 0 };
  results.quarantine = storage ? await purgeExpiredQuarantine({ db, storage, now }) : { deleted: 0, bytes: 0 };
  const key = String(process.env.BACKUP_ENCRYPTION_KEY || '');
  if (storage && key.length >= 24) {
    const objectKey = `backups/database-${results.ranAt.replace(/[:.]/g, '-')}.json`;
    try {
      const document = await createFreshEncryptedBackup(db, key, results.ranAt);
      const bytes = Buffer.from(JSON.stringify(document));
      await storage.put({ key: objectKey, bytes, mimeType: 'application/json' });
      const retention = await cleanupStoredBackups(storage, {
        now,
        retentionDays: intEnv('BACKUP_RETENTION_DAYS', 30, 1, 3650),
        minimumCopies: intEnv('BACKUP_MINIMUM_COPIES', 7, 1, 1000),
      });
      results.backup = { objectKey, checksum: document.checksum, bytes: bytes.length, retention };
      await recordBackupEvent(db, 'backup_completed', results.backup);
    } catch (error) {
      await recordBackupEvent(db, 'backup_failed', { objectKey, code: String(error?.code || error?.name || 'BACKUP_FAILED').slice(0, 100) });
      throw error;
    }
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
