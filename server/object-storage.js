import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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
    async put({ key, bytes, mimeType }) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: mimeType }));
    },
    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw new Error('R2 对象内容为空');
      return Buffer.from(await response.Body.transformToByteArray());
    },
  };
}
