import { MySqlDatabase } from '../mysql-store.js';
import { createObjectStorageFromEnv } from '../object-storage.js';
import { createGeneratedMediaService } from '../generated-media.js';
import { runMaintenance } from '../maintenance.js';

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const storage = createObjectStorageFromEnv(process.env);

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!storage) throw new Error('Object storage is required');
if (String(process.env.BACKUP_ENCRYPTION_KEY || '').length < 24) throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 24 characters');

const startedAt = Date.now();
const db = await new MySqlDatabase(databaseUrl).init();
const generatedMedia = createGeneratedMediaService({ db, storage });

try {
  const result = await runMaintenance({ db, storage, generatedMedia });
  console.log('Maintenance completed:', JSON.stringify({
    elapsedMs: Date.now() - startedAt,
    skipped: Boolean(result.skipped),
    reason: result.reason || null,
    assetsMigrated: result.assetMigration?.migrated || 0,
    assetMigrationsFailed: result.assetMigration?.failed || 0,
    assetsDeleted: result.assets?.deleted || 0,
    assetsFailed: result.assets?.failed || 0,
    mediaDeleted: result.media?.deleted || 0,
    backup: result.backup ? { objectKey: result.backup.objectKey, bytes: result.backup.bytes, retention: result.backup.retention } : null,
  }));
} finally {
  await db.close();
}
