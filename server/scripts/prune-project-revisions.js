import mysql from 'mysql2/promise';

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const maxRevisions = 30;
const apply = process.argv.includes('--apply');

if (!databaseUrl) throw new Error('DATABASE_URL is required');

const connection = await mysql.createConnection(databaseUrl);
const countSql = `
  SELECT COUNT(*) AS totalRevisions,
    COALESCE(SUM(revision_rank > ${maxRevisions}), 0) AS revisionsToDelete
  FROM (
    SELECT ROW_NUMBER() OVER (
      PARTITION BY project_id ORDER BY version DESC, created_at DESC
    ) AS revision_rank
    FROM project_revisions
  ) ranked`;

try {
  const [beforeRows] = await connection.query(countSql);
  const before = beforeRows[0] || { totalRevisions: 0, revisionsToDelete: 0 };
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', before }));
  if (!apply) process.exitCode = 0;
  else {
    await connection.beginTransaction();
    try {
      const [result] = await connection.query(`
        DELETE old
        FROM project_revisions old
        JOIN (
          SELECT id
          FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY project_id ORDER BY version DESC, created_at DESC
            ) AS revision_rank
            FROM project_revisions
          ) ranked
          WHERE revision_rank > ${maxRevisions}
        ) stale ON stale.id = old.id`);
      await connection.commit();
      const [afterRows] = await connection.query(countSql);
      console.log(JSON.stringify({ deleted: result.affectedRows, after: afterRows[0] || null }));
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
} finally {
  await connection.end();
}
