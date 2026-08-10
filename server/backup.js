import { createHash } from 'node:crypto';
import { createSecretVault } from './secrets.js';

const FORMAT = 'ai-drama-studio-backup-v1';

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createEncryptedBackup(db, encryptionKey, createdAt = new Date().toISOString()) {
  const collections = Object.fromEntries(Object.entries(db.data).map(([name, rows]) => [name, structuredClone(rows)]));
  const plaintext = JSON.stringify({ format: FORMAT, createdAt, collections });
  return {
    format: FORMAT,
    createdAt,
    checksum: checksum(plaintext),
    encryptedPayload: createSecretVault(encryptionKey).encrypt(plaintext),
  };
}

export async function createFreshEncryptedBackup(db, encryptionKey, createdAt = new Date().toISOString()) {
  if (typeof db?.refreshCollections === 'function') {
    await db.refreshCollections(Object.keys(db.data || {}));
  }
  return createEncryptedBackup(db, encryptionKey, createdAt);
}

export function decodeEncryptedBackup(document, encryptionKey) {
  if (!document || document.format !== FORMAT || typeof document.encryptedPayload !== 'string') throw new Error('备份格式无效');
  const plaintext = createSecretVault(encryptionKey).decrypt(document.encryptedPayload);
  if (checksum(plaintext) !== document.checksum) throw new Error('备份完整性校验失败');
  const payload = JSON.parse(plaintext);
  if (payload.format !== FORMAT || !payload.collections || typeof payload.collections !== 'object') throw new Error('备份内容无效');
  for (const [name, rows] of Object.entries(payload.collections)) {
    if (!Array.isArray(rows) || name === '__proto__' || name === 'constructor') throw new Error(`备份集合无效: ${name}`);
  }
  return payload;
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
