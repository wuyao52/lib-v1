import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
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
        // The AWS SDK uses virtual-host addressing on OSS's regional endpoint.
        endpoint: String(env.OSS_ENDPOINT || `https://oss-${region}.aliyuncs.com`).trim(),
        bucket: String(env.OSS_BUCKET).trim(),
        accessKeyId: String(env.OSS_ACCESS_KEY_ID).trim(),
        secretAccessKey: String(env.OSS_ACCESS_KEY_SECRET).trim(),
      };
    },
  },
];

export function summarizeStoredObjects(objects, prefixes = ['assets/', 'generated-videos/', 'backups/', 'healthchecks/']) {
  const summary = Object.fromEntries(prefixes.map((prefix) => [prefix, { objects: 0, bytes: 0 }]));
  summary.other = { objects: 0, bytes: 0 };
  for (const item of objects || []) {
    const key = String(item?.key || '');
    const bucket = prefixes.find((prefix) => key.startsWith(prefix)) || 'other';
    summary[bucket].objects += 1;
    summary[bucket].bytes += Math.max(0, Number(item?.size || 0));
  }
  const groups = Object.entries(summary).map(([prefix, usage]) => ({ prefix, ...usage }));
  return {
    objects: groups.reduce((sum, item) => sum + item.objects, 0),
    bytes: groups.reduce((sum, item) => sum + item.bytes, 0),
    groups,
  };
}

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

export function createObjectStorageFromEnv(env = process.env, { clientFactory = (config) => new S3Client(config) } = {}) {
  const provider = configuredProvider(env);
  if (!provider) return null;
  const config = provider.createConfig(env);
  const client = clientFactory({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: false,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    provider: provider.id,
    async health() {
      const key = `healthchecks/${randomUUID()}.txt`;
      const expected = Buffer.from('ok');
      let created = false;
      try {
        await client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: expected,
          ContentType: 'text/plain',
        }));
        created = true;
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        if (!response.Body) throw new Error('Object storage health check returned an empty body');
        const actual = Buffer.from(await response.Body.transformToByteArray());
        if (!actual.equals(expected)) throw new Error('Object storage health check returned unexpected content');
      } finally {
        if (created) await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      }
      return true;
    },
    async put({ key, bytes, mimeType, signal }) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes, ContentType: mimeType, ContentLength: bytes?.length }), { abortSignal: signal });
    },
    async putStream({ key, body, mimeType, contentLength }) {
      const stream = typeof Readable.fromWeb === 'function' ? Readable.fromWeb(body) : body;
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: stream, ContentType: mimeType, ContentLength: contentLength || undefined }));
    },
    async get(key, { signal } = {}) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: signal });
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
    async move(sourceKey, destinationKey) {
      const copySource = `${config.bucket}/${String(sourceKey).split('/').map(encodeURIComponent).join('/')}`;
      await client.send(new CopyObjectCommand({ Bucket: config.bucket, CopySource: copySource, Key: destinationKey }));
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: sourceKey }));
    },
    async list(prefix = '') {
      const objects = [];
      let continuationToken;
      do {
        const response = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: continuationToken }));
        for (const item of response.Contents || []) {
          if (item.Key) objects.push({ key: item.Key, size: Number(item.Size || 0), lastModified: item.LastModified?.toISOString?.() || null });
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return objects;
    },
  };
}
