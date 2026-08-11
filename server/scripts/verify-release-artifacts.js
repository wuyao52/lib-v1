import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyReleaseArtifacts(root = resolve('.')) {
  const dist = resolve(root, 'dist');
  const html = await readFile(resolve(dist, 'index.html'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith('/'));
  if (!references.length) throw new Error('dist/index.html does not reference any local release assets');
  const checked = [];
  for (const reference of new Set(references)) {
    const pathname = new URL(reference, 'https://release.invalid').pathname;
    const target = resolve(dist, `.${pathname}`);
    if (!target.startsWith(`${dist}\\`) && !target.startsWith(`${dist}/`)) throw new Error(`Release asset escapes dist: ${reference}`);
    await access(target);
    checked.push(pathname);
  }
  return { ok: true, checked: checked.sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyReleaseArtifacts();
  console.log('Release artifact verification completed:', JSON.stringify(result));
}
