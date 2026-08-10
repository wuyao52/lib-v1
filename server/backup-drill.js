import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshEncryptedBackup, decodeEncryptedBackup, recordBackupEvent, restoreEncryptedBackup } from './backup.js';
import { JsonDatabase } from './store.js';

async function withTransferTimeout(timeoutMs, operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Backup object transfer timed out')), timeoutMs);
  timer.unref?.();
  try { return await operation(controller.signal); } finally { clearTimeout(timer); }
}

export async function runBackupDrill({ db, storage, encryptionKey, now = new Date(), onPhase = () => {}, transferTimeoutMs = 15 * 60 * 1000 } = {}) {
  if (!db) throw new Error('Database is required');
  if (!storage) throw new Error('Object storage is required');
  if (String(encryptionKey || '').length < 24) throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 24 characters');

  const directory = await mkdtemp(join(tmpdir(), 'ai-drama-backup-drill-'));
  const createdAt = now.toISOString();
  const objectKey = `backups/drills/database-${createdAt.replace(/[:.]/g, '-')}.json`;

  try {
    const document = await createFreshEncryptedBackup(db, encryptionKey, createdAt);
    const documentBytes = Buffer.from(JSON.stringify(document));
    onPhase('snapshot_encrypted', { bytes: documentBytes.length });
    await withTransferTimeout(transferTimeoutMs, (signal) => storage.put({ key: objectKey, bytes: documentBytes, mimeType: 'application/json', signal }));
    onPhase('object_uploaded');

    const storedDocument = JSON.parse((await withTransferTimeout(transferTimeoutMs, (signal) => storage.get(objectKey, { signal }))).toString('utf8'));
    onPhase('object_downloaded');
    const payload = decodeEncryptedBackup(storedDocument, encryptionKey);
    const target = await new JsonDatabase(join(directory, 'restored.json')).init();
    await restoreEncryptedBackup(target, storedDocument, encryptionKey);
    onPhase('isolated_restore_completed');

    const collectionCounts = {};
    for (const [name, rows] of Object.entries(payload.collections)) {
      const restoredRows = target.read(name);
      if (JSON.stringify(restoredRows) !== JSON.stringify(rows)) {
        throw new Error(`Restored collection mismatch: ${name}`);
      }
      collectionCounts[name] = rows.length;
    }

    const result = {
      ok: true,
      database: db.kind,
      storage: storage.provider,
      objectKey,
      backupChecksum: storedDocument.checksum,
      restoredFingerprint: createHash('sha256').update(JSON.stringify(payload.collections)).digest('hex'),
      verifiedCollections: Object.keys(collectionCounts).length,
      collectionCounts,
    };
    await recordBackupEvent(db, 'backup_drill_completed', {
      objectKey: result.objectKey, backupChecksum: result.backupChecksum,
      restoredFingerprint: result.restoredFingerprint, verifiedCollections: result.verifiedCollections,
    });
    return result;
  } catch (error) {
    await recordBackupEvent(db, 'backup_drill_failed', { objectKey, code: String(error?.code || error?.name || 'BACKUP_DRILL_FAILED').slice(0, 100) });
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
