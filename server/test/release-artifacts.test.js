import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyReleaseArtifacts } from '../scripts/verify-release-artifacts.js';

test('release verification accepts a complete hashed bundle and rejects a missing asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ads-release-'));
  await mkdir(join(root, 'dist', 'assets'), { recursive: true });
  await writeFile(join(root, 'dist', 'index.html'), '<script src="/assets/app-hash.js"></script><link href="/assets/app-hash.css">');
  await writeFile(join(root, 'dist', 'assets', 'app-hash.js'), 'export {};');
  await writeFile(join(root, 'dist', 'assets', 'app-hash.css'), 'body{}');
  assert.deepEqual((await verifyReleaseArtifacts(root)).checked, ['/assets/app-hash.css', '/assets/app-hash.js']);
  await writeFile(join(root, 'dist', 'index.html'), '<script src="/assets/missing.js"></script>');
  await assert.rejects(verifyReleaseArtifacts(root), /ENOENT/);
});
