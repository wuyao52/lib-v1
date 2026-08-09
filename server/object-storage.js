import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

const requiredR2Variables = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

export function createObjectStorageFromEnv(env = process.env) {
  const configured = requiredR2Variables.some((name) => String(env[name] || '').trim());
  if (!configured) return null;

  const missing = requiredR2Variables.filter((name) => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`R2 配置不完整，缺少：${missing.join('、')}`);

  const accountId = String(env.R2_ACCOUNT_ID).trim();
  const bucket = String(env.R2_BUCKET).trim();
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: String(env.R2_ACCESS_KEY_ID).trim(),
      secretAccessKey: String(env.R2_SECRET_ACCESS_KEY).trim(),
    },
  });

  return {
    provider: 'r2',
    async health() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    },
    async put({ key, bytes, mimeType }) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: mimeType }));
    },
    async putStream({ key, body, mimeType, contentLength }) {
      const stream = typeof Readable.fromWeb === 'function' ? Readable.fromWeb(body) : body;
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: stream, ContentType: mimeType, ContentLength: contentLength || undefined }));
    },
    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw new Error('R2 对象内容为空');
      return Buffer.from(await response.Body.transformToByteArray());
    },
    async read(key, range) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range || undefined }));
      if (!response.Body) throw new Error('R2 对象内容为空');
      return {
        bytes: Buffer.from(await response.Body.transformToByteArray()),
        contentLength: Number(response.ContentLength || 0),
        contentRange: response.ContentRange || null,
        contentType: response.ContentType || null,
      };
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
