import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MySqlDatabase } from '../server/mysql-store.js';
import { createEncryptedBackup } from '../server/backup.js';

const outputArg = process.argv.find((value) => value.startsWith('--output='));
const outputPath = resolve(outputArg?.slice('--output='.length) || `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const backupKey = String(process.env.BACKUP_ENCRYPTION_KEY || '').trim();
if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
if (backupKey.length < 24) throw new Error('BACKUP_ENCRYPTION_KEY 至少需要 24 个字符');

const db = await new MySqlDatabase(databaseUrl).init();
try {
  const document = createEncryptedBackup(db, backupKey);
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ ok: true, outputPath, createdAt: document.createdAt }));
} finally {
  await db.close();
}
