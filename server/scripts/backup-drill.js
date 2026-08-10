import { runBackupDrill } from '../backup-drill.js';
import { MySqlDatabase } from '../mysql-store.js';
import { createObjectStorageFromEnv } from '../object-storage.js';

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

try {
  const result = await runBackupDrill({ db: source, storage, encryptionKey, onPhase: phase });
  console.log(JSON.stringify(result));
} finally {
  phase('cleanup_started');
  await source.close();
  phase('cleanup_completed');
}
