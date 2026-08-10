import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createSecretVault } from './secrets.js';

const FORMAT_V1 = 'ai-drama-studio-backup-v1';
const FORMAT = 'ai-drama-studio-backup-v2';

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createEncryptedBackup(db, encryptionKey, createdAt = new Date().toISOString()) {
  const collections = Object.fromEntries(Object.entries(db.data).map(([name, rows]) => [name, structuredClone(rows)]));
  const plaintext = JSON.stringify({ format: FORMAT, createdAt, collections });
  const compressedPayload = gzipSync(Buffer.from(plaintext)).toString('base64url');
  return {
    format: FORMAT,
    createdAt,
    checksum: checksum(plaintext),
    compression: 'gzip',
    encryptedPayload: createSecretVault(encryptionKey).encrypt(compressedPayload),
  };
}

export async function createFreshEncryptedBackup(db, encryptionKey, createdAt = new Date().toISOString()) {
  if (typeof db?.refreshCollections === 'function') {
    await db.refreshCollections(Object.keys(db.data || {}));
  }
  return createEncryptedBackup(db, encryptionKey, createdAt);
}

export function decodeEncryptedBackup(document, encryptionKey) {
  if (!document || ![FORMAT, FORMAT_V1].includes(document.format) || typeof document.encryptedPayload !== 'string') {
    throw new Error('Invalid backup format');
  }
  const decrypted = createSecretVault(encryptionKey).decrypt(document.encryptedPayload);
  const plaintext = document.format === FORMAT
    ? gunzipSync(Buffer.from(decrypted, 'base64url')).toString('utf8')
    : decrypted;
  if (checksum(plaintext) !== document.checksum) throw new Error('Backup integrity check failed');
  const payload = JSON.parse(plaintext);
  if (![FORMAT, FORMAT_V1].includes(payload.format) || !payload.collections || typeof payload.collections !== 'object') {
    throw new Error('Invalid backup contents');
  }
  for (const [name, rows] of Object.entries(payload.collections)) {
    if (!Array.isArray(rows) || name === '__proto__' || name === 'constructor') throw new Error(`Invalid backup collection: ${name}`);
  }
  return payload;
}

export async function cleanupStoredBackups(storage, { now = new Date(), retentionDays = 30, minimumCopies = 7 } = {}) {
  if (typeof storage?.list !== 'function') return { supported: false, deleted: 0, retained: 0 };
  const objects = (await storage.list('backups/'))
    .filter((item) => item.key.endsWith('.json'))
    .sort((a, b) => String(b.lastModified || b.key).localeCompare(String(a.lastModified || a.key)));
  const protectedKeys = new Set(objects.slice(0, Math.max(1, minimumCopies)).map((item) => item.key));
  const cutoff = now.getTime() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  const expired = objects.filter((item) => !protectedKeys.has(item.key) && Date.parse(item.lastModified || '') < cutoff);
  for (const item of expired) await storage.delete(item.key);
  return { supported: true, deleted: expired.length, retained: objects.length - expired.length };
}

export async function recordBackupEvent(db, action, metadata = {}) {
  if (!Array.isArray(db?.data?.auditLogs) || typeof db.mutate !== 'function') return;
  await db.mutate((data) => data.auditLogs.push({
    id: randomUUID(), userId: null, action, targetType: 'backup', targetId: metadata.objectKey || null,
    ipAddress: 'system', userAgent: 'maintenance', metadata, createdAt: new Date().toISOString(),
  }));
}

export async function restoreEncryptedBackup(db, document, encryptionKey) {
  const payload = decodeEncryptedBackup(document, encryptionKey);
  const knownCollections = new Set(Object.keys(db.data));
  await db.mutate((data) => {
    for (const [name, rows] of Object.entries(payload.collections)) {
      if (knownCollections.has(name)) data[name] = structuredClone(rows);
    }
  });
  return { restoredAt: new Date().toISOString(), backupCreatedAt: payload.createdAt };
}
