export function validateExpectedCommit(actualCommit, expectedCommit) {
  const expected = String(expectedCommit || '').trim().toLowerCase();
  if (!expected) return null;
  const actual = String(actualCommit || '').trim().toLowerCase();
  if (!actual) throw new Error(`Deployment did not report a commit; expected ${expected}`);
  if (actual !== expected && !actual.startsWith(expected) && !expected.startsWith(actual)) {
    throw new Error(`Deployment commit mismatch: expected ${expected}, received ${actual}`);
  }
  return actual;
}
