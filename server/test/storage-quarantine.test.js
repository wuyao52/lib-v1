import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrphanQuarantinePlan, purgeExpiredQuarantine, quarantineOrphanObjects } from '../storage-quarantine.js';

const fakeDb = () => {
  const data = { storageQuarantine: [] };
  return { read: (name) => data[name], mutate: async (operation) => operation(data), data };
};

test('orphan quarantine excludes referenced and recent objects, then permanently deletes only expired records', async () => {
  const now = new Date('2026-08-11T12:00:00.000Z');
  const plan = createOrphanQuarantinePlan({
    now: now.getTime(), referencedKeys: new Set(['assets/kept.png']),
    objects: [
      { key: 'assets/kept.png', size: 10, lastModified: '2026-01-01T00:00:00.000Z' },
      { key: 'assets/recent.png', size: 20, lastModified: '2026-08-10T12:00:01.000Z' },
      { key: 'generated-videos/orphan.mp4', size: 30, lastModified: '2026-01-01T00:00:00.000Z' },
      { key: 'backups/never.json', size: 40, lastModified: '2026-01-01T00:00:00.000Z' },
    ], minAgeDays: 1,
  });
  assert.deepEqual(plan.candidates, [{ key: 'generated-videos/orphan.mp4', size: 30, objectType: 'generated_video' }]);
  const objects = new Map([['generated-videos/orphan.mp4', Buffer.alloc(30)]]);
  const db = fakeDb();
  const storage = {
    move: async (source, destination) => { objects.set(destination, objects.get(source)); objects.delete(source); },
    delete: async (key) => objects.delete(key),
  };
  const result = await quarantineOrphanObjects({ db, storage, candidates: plan.candidates, now, retentionDays: 2 });
  assert.deepEqual({ quarantined: result.quarantined, failed: result.failed, bytes: result.bytes }, { quarantined: 1, failed: 0, bytes: 30 });
  const record = db.data.storageQuarantine[0];
  assert.equal(record.status, 'quarantined');
  assert.equal(objects.has(record.quarantineKey), true);
  assert.equal((await purgeExpiredQuarantine({ db, storage, now: new Date('2026-08-12T12:00:00.000Z') })).deleted, 0);
  assert.equal((await purgeExpiredQuarantine({ db, storage, now: new Date('2026-08-14T12:00:00.000Z') })).deleted, 1);
  assert.equal(db.data.storageQuarantine[0].status, 'deleted');
  assert.equal(objects.has(record.quarantineKey), false);
});
