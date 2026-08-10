import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjectStorageFromEnv } from '../object-storage.js';

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
