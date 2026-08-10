import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

const providers = [
  {
    id: 'r2',
    label: 'Cloudflare R2',
    required: ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'],
    createConfig(env) {
      return {
        region: 'auto',
        endpoint: `https://${String(env.R2_ACCOUNT_ID).trim()}.r2.cloudflarestorage.com`,
        bucket: String(env.R2_BUCKET).trim(),
        accessKeyId: String(env.R2_ACCESS_KEY_ID).trim(),
        secretAccessKey: String(env.R2_SECRET_ACCESS_KEY).trim(),
      };
    },
  },
  {
    id: 'aliyun-oss',
    label: 'Alibaba Cloud OSS',
    required: ['OSS_REGION', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET'],
    createConfig(env) {
      const region = String(env.OSS_REGION).trim();
      return {
        region,
        // OSS exposes an S3-compatible endpoint. Keep the bucket private; the app serves signed access itself.
        endpoint: String(env.OSS_ENDPOINT || `https://s3.${region}.aliyuncs.com`).trim(),
        bucket: String(env.OSS_BUCKET).trim(),
        accessKeyId: String(env.OSS_ACCESS_KEY_ID).trim(),
        secretAccessKey: String(env.OSS_ACCESS_KEY_SECRET).trim(),
      };
    },
  },
];

function configuredProvider(env) {
  const configuredProviders = providers.filter((provider) => provider.required.some((name) => String(env[name] || '').trim()));
  if (configuredProviders.length > 1) {
    throw new Error(`只能配置一个对象存储提供商，当前同时检测到：${configuredProviders.map((provider) => provider.label).join('、')}`);
  }
  for (const provider of configuredProviders) {
    const missing = provider.required.filter((name) => !String(env[name] || '').trim());
    if (missing.length) throw new Error(`${provider.label} 配置不完整，缺少：${missing.join('、')}`);
    return provider;
  }
  return null;
}

export function createObjectStorageFromEnv(env = process.env) {
  const provider = configuredProvider(env);
  if (!provider) return null;
  const config = provider.createConfig(env);
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    provider: provider.id,
    async health() {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      return true;
    },
    async put({ key, bytes, mimeType }) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes, ContentType: mimeType }));
    },
    async putStream({ key, body, mimeType, contentLength }) {
      const stream = typeof Readable.fromWeb === 'function' ? Readable.fromWeb(body) : body;
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: stream, ContentType: mimeType, ContentLength: contentLength || undefined }));
    },
    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      if (!response.Body) throw new Error('对象存储内容为空');
      return Buffer.from(await response.Body.transformToByteArray());
    },
    async read(key, range) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key, Range: range || undefined }));
      if (!response.Body) throw new Error('对象存储内容为空');
      return {
        bytes: Buffer.from(await response.Body.transformToByteArray()),
        contentLength: Number(response.ContentLength || 0),
        contentRange: response.ContentRange || null,
        contentType: response.ContentType || null,
      };
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
