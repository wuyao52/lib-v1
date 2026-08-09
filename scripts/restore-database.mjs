import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MySqlDatabase } from '../server/mysql-store.js';
import { restoreEncryptedBackup } from '../server/backup.js';

const inputArg = process.argv.find((value) => value.startsWith('--input='));
if (!inputArg || !process.argv.includes('--confirm-restore')) throw new Error('必须提供 --input=备份文件 和 --confirm-restore');
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const backupKey = String(process.env.BACKUP_ENCRYPTION_KEY || '').trim();
if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
if (backupKey.length < 24) throw new Error('BACKUP_ENCRYPTION_KEY 至少需要 24 个字符');
const document = JSON.parse(await readFile(resolve(inputArg.slice('--input='.length)), 'utf8'));

const db = await new MySqlDatabase(databaseUrl).init();
try {
  const result = await restoreEncryptedBackup(db, document, backupKey);
  console.log(JSON.stringify({ ok: true, ...result }));
} finally {
  await db.close();
}
