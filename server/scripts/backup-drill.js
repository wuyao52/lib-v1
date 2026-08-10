import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshEncryptedBackup, decodeEncryptedBackup, restoreEncryptedBackup } from '../backup.js';
import { MySqlDatabase } from '../mysql-store.js';
import { createObjectStorageFromEnv } from '../object-storage.js';
import { JsonDatabase } from '../store.js';

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const encryptionKey = String(process.env.BACKUP_ENCRYPTION_KEY || '');
const storage = createObjectStorageFromEnv(process.env);
const startedAt = Date.now();
const phase = (name, details = {}) => console.log(JSON.stringify({ phase: name, elapsedMs: Date.now() - startedAt, ...details }));

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!storage) throw new Error('Object storage is required');
if (encryptionKey.length < 24) throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 24 characters');

phase('database_connecting');
const source = await new MySqlDatabase(databaseUrl).init();
phase('database_connected', { collections: Object.keys(source.data).length });
const directory = await mkdtemp(join(tmpdir(), 'ai-drama-backup-drill-'));
const createdAt = new Date().toISOString();
const objectKey = `backups/drills/database-${createdAt.replace(/[:.]/g, '-')}.json`;

try {
  const document = await createFreshEncryptedBackup(source, encryptionKey, createdAt);
  const documentBytes = Buffer.from(JSON.stringify(document));
  phase('snapshot_encrypted', { bytes: documentBytes.length });
  await storage.put({
    key: objectKey,
    bytes: documentBytes,
    mimeType: 'application/json',
  });
  phase('object_uploaded');

  const storedDocument = JSON.parse((await storage.get(objectKey)).toString('utf8'));
  phase('object_downloaded');
  const payload = decodeEncryptedBackup(storedDocument, encryptionKey);
  const target = await new JsonDatabase(join(directory, 'restored.json')).init();
  await restoreEncryptedBackup(target, storedDocument, encryptionKey);
  phase('isolated_restore_completed');

  const collectionCounts = {};
  for (const [name, rows] of Object.entries(payload.collections)) {
    const restoredRows = target.read(name);
    if (JSON.stringify(restoredRows) !== JSON.stringify(rows)) {
      throw new Error(`Restored collection mismatch: ${name}`);
    }
    collectionCounts[name] = rows.length;
  }

  const fingerprint = createHash('sha256')
    .update(JSON.stringify(payload.collections))
    .digest('hex');
  console.log(JSON.stringify({
    ok: true,
    database: source.kind,
    storage: storage.provider,
    objectKey,
    backupChecksum: storedDocument.checksum,
    restoredFingerprint: fingerprint,
    verifiedCollections: Object.keys(collectionCounts).length,
    collectionCounts,
  }));
} finally {
  phase('cleanup_started');
  await source.close();
  await rm(directory, { recursive: true, force: true });
  phase('cleanup_completed');
}
