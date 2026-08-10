import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { MySqlDatabase } from '../mysql-store.js';
import { createObjectStorageFromEnv } from '../object-storage.js';
import { decodeEncryptedBackup, recordBackupEvent, restoreEncryptedBackup } from '../backup.js';
import { createApp } from '../app.js';

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const encryptionKey = String(process.env.BACKUP_ENCRYPTION_KEY || '');
const appEncryptionKey = String(process.env.APP_ENCRYPTION_KEY || '');
const storage = createObjectStorageFromEnv(process.env);
const startedAt = Date.now();
const temporaryDatabase = `restore_drill_${Date.now()}_${randomBytes(3).toString('hex')}`;

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!storage) throw new Error('Object storage is required');
if (encryptionKey.length < 24) throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 24 characters');
if (appEncryptionKey.length < 24) throw new Error('APP_ENCRYPTION_KEY must contain at least 24 characters');

const sourceUrl = new URL(databaseUrl);
const drillUrl = new URL(databaseUrl);
drillUrl.pathname = `/${temporaryDatabase}`;
const admin = await mysql.createConnection({ uri: sourceUrl.toString(), multipleStatements: false });
let source = null;
let target = null;
let server = null;
let selectedKey = null;

const canonical = (rows) => JSON.stringify([...rows]
  .map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
  .sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''))));

try {
  source = await new MySqlDatabase(databaseUrl).init();
  const backups = (await storage.list('backups/')).filter((item) => item.key.endsWith('.json')).sort((a, b) => String(b.lastModified || b.key).localeCompare(String(a.lastModified || a.key)));
  if (!backups.length) throw new Error('No stored database backup is available');
  selectedKey = String(process.env.RESTORE_DRILL_OBJECT_KEY || backups[0].key);
  const document = JSON.parse((await storage.get(selectedKey)).toString('utf8'));
  const payload = decodeEncryptedBackup(document, encryptionKey);

  await admin.query(`CREATE DATABASE \`${temporaryDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  target = await new MySqlDatabase(drillUrl.toString()).init();
  await restoreEncryptedBackup(target, document, encryptionKey);
  await target.refreshCollections(Object.keys(payload.collections));

  const mismatches = [];
  for (const [name, expected] of Object.entries(payload.collections)) {
    const actual = target.read(name);
    if (actual.length !== expected.length || canonical(actual) !== canonical(expected)) mismatches.push(name);
  }
  if (mismatches.length) throw new Error(`Temporary MySQL restore mismatch: ${mismatches.join(',')}`);

  const restored = await createApp({ database: target, assetStorage: storage, encryptionKey: appEncryptionKey, monitoring: false, maintenance: false, videoQueue: false, sendEmailCode: async () => {} });
  server = restored.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const health = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  if (health.status !== 200 || !(await health.json()).ok) throw new Error(`Restored application health check returned HTTP ${health.status}`);

  const result = { objectKey: selectedKey, verifiedCollections: Object.keys(payload.collections).length, healthStatus: health.status, elapsedMs: Date.now() - startedAt };
  await recordBackupEvent(source, 'mysql_restore_drill_completed', result);
  console.log('MySQL restore drill completed:', JSON.stringify(result));
} catch (error) {
  if (source) await recordBackupEvent(source, 'mysql_restore_drill_failed', { objectKey: selectedKey, code: String(error?.code || error?.name || 'MYSQL_RESTORE_DRILL_FAILED').slice(0, 100) });
  throw error;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (target) await target.close();
  await admin.query(`DROP DATABASE IF EXISTS \`${temporaryDatabase}\``);
  await admin.end();
  if (source) await source.close();
}
