import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshEncryptedBackup, decodeEncryptedBackup, restoreEncryptedBackup } from './backup.js';
import { JsonDatabase } from './store.js';

export async function runBackupDrill({ db, storage, encryptionKey, now = new Date(), onPhase = () => {} } = {}) {
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
    await storage.put({ key: objectKey, bytes: documentBytes, mimeType: 'application/json' });
    onPhase('object_uploaded');

    const storedDocument = JSON.parse((await storage.get(objectKey)).toString('utf8'));
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

    return {
      ok: true,
      database: db.kind,
      storage: storage.provider,
      objectKey,
      backupChecksum: storedDocument.checksum,
      restoredFingerprint: createHash('sha256').update(JSON.stringify(payload.collections)).digest('hex'),
      verifiedCollections: Object.keys(collectionCounts).length,
      collectionCounts,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
