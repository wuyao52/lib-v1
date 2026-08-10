import mysql from 'mysql2/promise';

const databaseUrl = String(process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL || process.env.MYSQL_URL || '').trim();
if (!databaseUrl) throw new Error('A MySQL connection URL is required');

const connection = await mysql.createConnection(databaseUrl);
try {
  const [rows] = await connection.execute(
    'SELECT action, created_at AS createdAt FROM audit_logs WHERE target_type = ? ORDER BY created_at DESC LIMIT 20',
    ['monitoring'],
  );
  console.log('Monitoring audit summary:', JSON.stringify({ count: rows.length, events: rows }));
} finally {
  await connection.end();
}
