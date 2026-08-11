const HOUR = 60 * 60 * 1000;

export function createStorageCleanupPlan({ objects, referencedKeys = new Set(), now = Date.now(), retentionHours = 24, maxDeletes = 200 } = {}) {
  const cutoff = now - Math.max(1, Number(retentionHours) || 24) * HOUR;
  const candidates = [];
  const summary = { candidates: 0, candidateBytes: 0, referenced: 0, referencedBytes: 0, recentHealthchecks: 0, limited: false };
  for (const object of objects || []) {
    const key = String(object?.key || '');
    const size = Math.max(0, Number(object?.size || 0));
    if (referencedKeys.has(key)) {
      summary.referenced += 1;
      summary.referencedBytes += size;
      continue;
    }
    if (!key.startsWith('healthchecks/')) continue;
    const modifiedAt = Date.parse(object?.lastModified || '');
    if (!Number.isFinite(modifiedAt) || modifiedAt > cutoff) {
      summary.recentHealthchecks += 1;
      continue;
    }
    if (candidates.length >= Math.max(1, Number(maxDeletes) || 200)) {
      summary.limited = true;
      continue;
    }
    candidates.push({ key, size });
    summary.candidates += 1;
    summary.candidateBytes += size;
  }
  return { candidates, summary, policy: { prefix: 'healthchecks/', retentionHours: Math.max(1, Number(retentionHours) || 24), maxDeletes: Math.max(1, Number(maxDeletes) || 200) } };
}

export function referencedStorageKeys(db) {
  return new Set([
    ...(db.read('assets') || []).map((item) => item.objectKey),
    ...(db.read('generatedMedia') || []).map((item) => item.objectKey),
  ].filter(Boolean));
}
