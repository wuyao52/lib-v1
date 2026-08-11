import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { composeDirectorVideos, extractDirectorTailFrame } from '../director-media.js';

const userId = 'user-director-media';

test('director media extracts a real tail frame and composes owned clips into MP4 history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ads-director-media-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clips = [];
  for (const [index, color] of [['01', 'red'], ['02', 'blue']]) {
    const path = join(root, `clip-${index}.mp4`);
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=0.25`, '-pix_fmt', 'yuv420p', path], { stdio: 'ignore' });
    clips.push(await readFile(path));
  }
  const storageObjects = new Map([['source-01.mp4', clips[0]], ['source-02.mp4', clips[1]]]);
  const storage = {
    provider: 'test-storage',
    get: async (key) => storageObjects.get(key),
    put: async ({ key, bytes }) => { storageObjects.set(key, bytes); },
  };
  const data = {
    generatedMedia: [
      { id: 'media-01', userId, objectKey: 'source-01.mp4', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { id: 'media-02', userId, objectKey: 'source-02.mp4', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    ],
    generationHistory: [],
  };
  const db = { read: (collection) => data[collection], mutate: async (mutator) => mutator(data) };
  const tailFrame = await extractDirectorTailFrame({ db, storage, userId, url: '/api/generated-media/media-01' });
  assert.match(tailFrame, /^data:image\/png;base64,/);
  const result = await composeDirectorVideos({ db, storage, userId, projectId: 'project-01', clipUrls: ['/api/generated-media/media-01', '/api/generated-media/media-02'] });
  assert.equal(result.clipCount, 2);
  assert.match(result.url, /^\/api\/generated-media\//);
  assert.ok(storageObjects.get(result.url.split('/').at(-1)) || [...storageObjects.keys()].some((key) => key.includes('director-compositions')));
  assert.equal(data.generationHistory.length, 1);
  assert.equal(data.generationHistory[0].projectId, 'project-01');
});

test('director media rejects a URL that is not an owned archived video', async () => {
  const db = { read: (collection) => collection === 'generatedMedia' ? [] : [], mutate: async () => undefined };
  await assert.rejects(
    composeDirectorVideos({ db, storage: { get: async () => Buffer.from('x') }, userId, clipUrls: ['https://provider.example/video.mp4'] }),
    (error) => error?.code === 'DIRECTOR_MEDIA_NOT_OWNED',
  );
});
