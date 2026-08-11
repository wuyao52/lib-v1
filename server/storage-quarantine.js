import { randomUUID } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const objectType = (key) => key.startsWith('assets/') ? 'asset' : 'generated_video';

export function createOrphanQuarantinePlan({ objects, referencedKeys = new Set(), quarantineRecords = [], now = Date.now(), minAgeDays = 7, maxObjects = 100 } = {}) {
  const cutoff = now - Math.max(1, Number(minAgeDays) || 7) * DAY;
  const tracked = new Set(quarantineRecords.filter((item) => ['moving', 'quarantined'].includes(item.status)).map((item) => item.originalKey));
  const candidates = [];
  const summary = { candidates: 0, candidateBytes: 0, referenced: 0, tooRecent: 0, tracked: 0, limited: false };
  for (const item of objects || []) {
    const key = String(item?.key || '');
    if (!key.startsWith('assets/') && !key.startsWith('generated-videos/')) continue;
    const size = Math.max(0, Number(item?.size || 0));
    if (referencedKeys.has(key)) { summary.referenced += 1; continue; }
    if (tracked.has(key)) { summary.tracked += 1; continue; }
    const modifiedAt = Date.parse(item?.lastModified || '');
    if (!Number.isFinite(modifiedAt) || modifiedAt > cutoff) { summary.tooRecent += 1; continue; }
    if (candidates.length >= Math.max(1, Number(maxObjects) || 100)) { summary.limited = true; continue; }
    candidates.push({ key, size, objectType: objectType(key) });
    summary.candidates += 1; summary.candidateBytes += size;
  }
  return { candidates, summary, policy: { minAgeDays: Math.max(1, Number(minAgeDays) || 7), maxObjects: Math.max(1, Number(maxObjects) || 100), retentionDays: null } };
}

export async function quarantineOrphanObjects({ db, storage, candidates, actorId = null, now = new Date(), retentionDays = 7 } = {}) {
  if (!storage?.move) throw new Error('Object storage does not support quarantine moves');
  const results = [];
  for (const candidate of candidates || []) {
    const id = randomUUID();
    const record = {
      id, originalKey: candidate.key, quarantineKey: `quarantine/orphans/${id}`, objectSize: Number(candidate.size || 0), objectType: candidate.objectType,
      status: 'moving', quarantinedBy: actorId, quarantinedAt: now.toISOString(), deleteAfter: new Date(now.getTime() + Math.max(1, Number(retentionDays) || 7) * DAY).toISOString(), restoredAt: null, deletedAt: null, errorCode: null,
    };
    await db.mutate((data) => data.storageQuarantine.push(record));
    try {
      await storage.move(record.originalKey, record.quarantineKey);
      record.status = 'quarantined';
      await db.mutate((data) => Object.assign(data.storageQuarantine.find((item) => item.id === id), { status: 'quarantined' }));
      results.push({ id, status: 'quarantined', objectSize: record.objectSize, objectType: record.objectType });
    } catch (error) {
      const errorCode = String(error?.code || error?.name || 'MOVE_FAILED').slice(0, 100);
      await db.mutate((data) => Object.assign(data.storageQuarantine.find((item) => item.id === id), { status: 'move_failed', errorCode }));
      results.push({ id, status: 'move_failed', objectSize: record.objectSize, objectType: record.objectType, errorCode });
    }
  }
  return { quarantined: results.filter((item) => item.status === 'quarantined').length, failed: results.filter((item) => item.status === 'move_failed').length, bytes: results.filter((item) => item.status === 'quarantined').reduce((sum, item) => sum + item.objectSize, 0), results };
}

export async function restoreQuarantinedObject({ db, storage, id, now = new Date() } = {}) {
  const record = db.read('storageQuarantine').find((item) => item.id === id && item.status === 'quarantined');
  if (!record) return { restored: false, error: 'QUARANTINE_NOT_FOUND' };
  const collision = (await storage.list(record.originalKey)).some((item) => item.key === record.originalKey);
  if (collision) return { restored: false, error: 'ORIGINAL_OBJECT_EXISTS' };
  await storage.move(record.quarantineKey, record.originalKey);
  const restoredAt = now.toISOString();
  await db.mutate((data) => Object.assign(data.storageQuarantine.find((item) => item.id === id), { status: 'restored', restoredAt }));
  return { restored: true, id, restoredAt };
}

export async function purgeExpiredQuarantine({ db, storage, now = new Date() } = {}) {
  const due = db.read('storageQuarantine').filter((item) => item.status === 'quarantined' && Date.parse(item.deleteAfter) <= now.getTime());
  let deleted = 0; let bytes = 0;
  for (const record of due) {
    try {
      await storage.delete(record.quarantineKey);
      const deletedAt = now.toISOString();
      await db.mutate((data) => Object.assign(data.storageQuarantine.find((item) => item.id === record.id), { status: 'deleted', deletedAt }));
      deleted += 1; bytes += Number(record.objectSize || 0);
    } catch (error) {
      await db.mutate((data) => Object.assign(data.storageQuarantine.find((item) => item.id === record.id), { errorCode: String(error?.code || error?.name || 'DELETE_FAILED').slice(0, 100) }));
    }
  }
  return { deleted, bytes };
}
