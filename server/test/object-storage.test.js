import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjectStorageFromEnv, summarizeStoredObjects } from '../object-storage.js';

test('object storage accepts a complete Alibaba Cloud OSS S3 configuration', () => {
  let clientConfig;
  const storage = createObjectStorageFromEnv({
    OSS_REGION: 'cn-hangzhou',
    OSS_ACCESS_KEY_ID: 'test-access-key',
    OSS_ACCESS_KEY_SECRET: 'test-secret-key',
    OSS_BUCKET: 'ai-drama-assets',
  }, { clientFactory: (config) => { clientConfig = config; return { send: async () => ({}) }; } });
  assert.equal(storage.provider, 'aliyun-oss');
  assert.equal(clientConfig.endpoint, 'https://oss-cn-hangzhou.aliyuncs.com');
  assert.equal(clientConfig.forcePathStyle, false);
  assert.equal(typeof storage.put, 'function');
  assert.equal(typeof storage.get, 'function');
  assert.equal(typeof storage.delete, 'function');
});

test('object storage rejects incomplete Alibaba Cloud OSS configuration without falling back', () => {
  assert.throws(() => createObjectStorageFromEnv({
    OSS_REGION: 'cn-hangzhou',
    OSS_BUCKET: 'ai-drama-assets',
  }), /Alibaba Cloud OSS 配置不完整.*OSS_ACCESS_KEY_ID.*OSS_ACCESS_KEY_SECRET/);
});

test('object storage rejects ambiguous R2 and OSS configuration', () => {
  assert.throws(() => createObjectStorageFromEnv({
    R2_ACCOUNT_ID: 'account-id',
    R2_ACCESS_KEY_ID: 'access-key',
    R2_SECRET_ACCESS_KEY: 'secret-key',
    R2_BUCKET: 'r2-bucket',
    OSS_REGION: 'cn-hangzhou',
    OSS_ACCESS_KEY_ID: 'oss-access-key',
    OSS_ACCESS_KEY_SECRET: 'oss-secret-key',
    OSS_BUCKET: 'oss-bucket',
  }), /只能配置一个对象存储提供商/);
});

test('object storage preserves existing Cloudflare R2 selection', () => {
  const storage = createObjectStorageFromEnv({
    R2_ACCOUNT_ID: 'account-id',
    R2_ACCESS_KEY_ID: 'access-key',
    R2_SECRET_ACCESS_KEY: 'secret-key',
    R2_BUCKET: 'ai-drama-assets',
  });
  assert.equal(storage.provider, 'r2');
});

test('Alibaba Cloud OSS accepts an explicit regional endpoint override', () => {
  let clientConfig;
  createObjectStorageFromEnv({
    OSS_REGION: 'cn-beijing',
    OSS_ENDPOINT: 'https://custom-oss.example.com',
    OSS_ACCESS_KEY_ID: 'test-access-key',
    OSS_ACCESS_KEY_SECRET: 'test-secret-key',
    OSS_BUCKET: 'ai-drama-assets-ooc',
  }, { clientFactory: (config) => { clientConfig = config; return { send: async () => ({}) }; } });
  assert.equal(clientConfig.endpoint, 'https://custom-oss.example.com');
});

test('object storage health checks the object permissions used by the application', async () => {
  const commands = [];
  const storage = createObjectStorageFromEnv({
    OSS_REGION: 'cn-beijing',
    OSS_ACCESS_KEY_ID: 'test-access-key',
    OSS_ACCESS_KEY_SECRET: 'test-secret-key',
    OSS_BUCKET: 'ai-drama-assets-ooc',
  }, {
    clientFactory: () => ({
      send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'GetObjectCommand') {
          return { Body: { transformToByteArray: async () => Buffer.from('ok') } };
        }
        return {};
      },
    }),
  });

  assert.equal(await storage.health(), true);
  assert.deepEqual(commands.map((command) => command.constructor.name), [
    'PutObjectCommand',
    'GetObjectCommand',
    'DeleteObjectCommand',
  ]);
  assert.match(commands[0].input.Key, /^healthchecks\/[\w-]+\.txt$/);
  assert.equal(commands[0].input.Key, commands[1].input.Key);
  assert.equal(commands[0].input.Key, commands[2].input.Key);
});

test('object storage lists every backup page without exposing credentials', async () => {
  const commands = [];
  const storage = createObjectStorageFromEnv({
    OSS_REGION: 'cn-beijing', OSS_ACCESS_KEY_ID: 'test-access-key',
    OSS_ACCESS_KEY_SECRET: 'test-secret-key', OSS_BUCKET: 'ai-drama-assets-ooc',
  }, {
    clientFactory: () => ({ send: async (command) => {
      commands.push(command);
      if (!command.input.ContinuationToken) return { IsTruncated: true, NextContinuationToken: 'page-2', Contents: [{ Key: 'backups/a.json', Size: 10, LastModified: new Date('2026-08-10T00:00:00Z') }] };
      return { IsTruncated: false, Contents: [{ Key: 'backups/b.json', Size: 20, LastModified: new Date('2026-08-09T00:00:00Z') }] };
    } }),
  });
  const objects = await storage.list('backups/');
  assert.deepEqual(objects.map((item) => item.key), ['backups/a.json', 'backups/b.json']);
  assert.deepEqual(commands.map((command) => command.input.ContinuationToken || null), [null, 'page-2']);
});

test('object storage usage groups every object and byte without exposing keys', () => {
  const usage = summarizeStoredObjects([
    { key: 'assets/user/image.png', size: 25 },
    { key: 'generated-videos/user/video.mp4', size: 1000 },
    { key: 'backups/database.json', size: 200 },
    { key: 'unclassified/item.bin', size: 5 },
  ]);
  assert.equal(usage.objects, 4);
  assert.equal(usage.bytes, 1230);
  assert.deepEqual(usage.groups.find((item) => item.prefix === 'generated-videos/'), { prefix: 'generated-videos/', objects: 1, bytes: 1000 });
  assert.equal(JSON.stringify(usage).includes('user/image.png'), false);
});
