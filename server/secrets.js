import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function createSecretVault(secret) {
  if (!secret || String(secret).length < 24) throw new Error('APP_ENCRYPTION_KEY 必须至少包含 24 个字符');
  const key = createHash('sha256').update(String(secret)).digest();

  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
    },
    decrypt(payload) {
      const [ivValue, tagValue, encryptedValue] = String(payload).split('.');
      if (!ivValue || !tagValue || !encryptedValue) throw new Error('加密密钥数据格式无效');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
