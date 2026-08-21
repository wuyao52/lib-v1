const migrations = [
  {
    version: 1,
    name: 'legacy_schema_alignment',
    async up({ query, ensureColumn }) {
      await ensureColumn('users', 'role', "VARCHAR(16) NOT NULL DEFAULT 'user'");
      await ensureColumn('users', 'balance_cents', 'BIGINT NOT NULL DEFAULT 0');
      await ensureColumn('model_pricing', 'min_duration_sec', 'INT NULL');
      await ensureColumn('model_pricing', 'max_duration_sec', 'INT NULL');
      await ensureColumn('model_pricing', 'allowed_durations_sec', 'JSON NULL');
      await ensureColumn('projects', 'version', 'INT NOT NULL DEFAULT 1');
      await ensureColumn('assets', 'object_key', 'VARCHAR(1024) NULL');
      await ensureColumn('assets', 'storage_provider', "VARCHAR(20) NOT NULL DEFAULT 'database'");
      await ensureColumn('generation_jobs', 'lease_owner', 'VARCHAR(64) NULL');
      await ensureColumn('generation_jobs', 'lease_until', 'BIGINT NOT NULL DEFAULT 0');
      await ensureColumn('generation_jobs', 'submitted_at', 'VARCHAR(35) NULL');
      await ensureColumn('user_api_configs', 'enabled', 'TINYINT(1) NOT NULL DEFAULT 1');
      await ensureColumn('user_api_configs', 'disabled_at', 'VARCHAR(35) NULL');
      await query('ALTER TABLE `assets` MODIFY COLUMN `data_base64` MEDIUMTEXT NULL');
      await query('ALTER TABLE `audit_logs` MODIFY COLUMN `user_id` CHAR(36) NULL');
    },
  },
  {
    version: 2,
    name: 'persistent_request_metric_buckets',
    async up({ query }) {
      await query(`CREATE TABLE IF NOT EXISTS request_metric_buckets (
        bucket_start BIGINT NOT NULL,
        scope VARCHAR(20) NOT NULL,
        status_class VARCHAR(8) NOT NULL,
        latency_bucket_ms INT NOT NULL,
        request_count BIGINT NOT NULL,
        duration_total_ms BIGINT NOT NULL,
        PRIMARY KEY (bucket_start, scope, status_class, latency_bucket_ms),
        INDEX request_metric_bucket_time_idx (bucket_start)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    },
  },
  {
    version: 3,
    name: 'storage_orphan_quarantine',
    async up({ query }) {
      await query(`CREATE TABLE IF NOT EXISTS storage_quarantine (
        id CHAR(36) PRIMARY KEY,
        original_key VARCHAR(1024) NOT NULL,
        quarantine_key VARCHAR(255) NOT NULL UNIQUE,
        object_size BIGINT NOT NULL,
        object_type VARCHAR(32) NOT NULL,
        status VARCHAR(24) NOT NULL,
        quarantined_by CHAR(36) NULL,
        quarantined_at VARCHAR(35) NOT NULL,
        delete_after VARCHAR(35) NOT NULL,
        restored_at VARCHAR(35) NULL,
        deleted_at VARCHAR(35) NULL,
        error_code VARCHAR(100) NULL,
        INDEX storage_quarantine_status_delete_idx (status, delete_after)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    },
  },
  {
    version: 4,
    name: 'model_pricing_resolutions',
    async up({ ensureColumn }) {
      await ensureColumn('model_pricing', 'allowed_resolutions', 'JSON NULL');
    },
  },
  {
    version: 5,
    name: 'model_pricing_reference_images',
    async up({ ensureColumn }) {
      await ensureColumn('model_pricing', 'max_reference_images', 'INT NULL');
    },
  },
  {
    version: 6,
    name: 'project_revisions',
    async up({ query }) {
      await query(`CREATE TABLE IF NOT EXISTS project_revisions (
        id CHAR(36) PRIMARY KEY, project_id VARCHAR(100) NOT NULL, user_id CHAR(36) NOT NULL,
        version INT NOT NULL, project_data JSON NOT NULL, created_at VARCHAR(35) NOT NULL, reason VARCHAR(32) NOT NULL,
        INDEX project_revisions_lookup_idx (project_id, user_id, version)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    },
  },
  {
    version: 7,
    name: 'asset_soft_delete',
    async up({ ensureColumn }) {
      await ensureColumn('assets', 'deleted_at', 'VARCHAR(35) NULL');
    },
  },
  {
    version: 8,
    name: 'model_reference_audio_video_limits',
    async up({ ensureColumn }) {
      await ensureColumn('model_pricing', 'max_reference_audios', 'INT NULL');
      await ensureColumn('model_pricing', 'max_reference_videos', 'INT NULL');
    },
  },
  {
    version: 9,
    name: 'system_api_text_protocol',
    async up({ ensureColumn }) {
      await ensureColumn('system_apis', 'text_protocol', "VARCHAR(32) NOT NULL DEFAULT 'auto'");
    },
  },
];

export async function runSchemaMigrations(pool) {
  const connection = typeof pool.getConnection === 'function' ? await pool.getConnection() : pool;
  const query = (sql, params) => connection.query(sql, params);
  let lockHeld = false;
  try {
    await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      applied_at VARCHAR(35) NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const [lockRows] = await query("SELECT GET_LOCK('ai_drama_schema_migrations', 30) AS acquired");
    if (Array.isArray(lockRows) && lockRows.length && Number(lockRows[0].acquired) !== 1) {
      throw new Error('Timed out waiting for the database migration lock');
    }
    lockHeld = true;
    const [appliedRows] = await query('SELECT version FROM schema_migrations');
    const applied = new Set((appliedRows || []).map((row) => Number(row.version)));
    const ensureColumn = async (table, column, definition) => {
      const [rows] = await query(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1',
        [table, column],
      );
      if (!rows.length) await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    };
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await migration.up({ query, ensureColumn });
      await query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [migration.version, migration.name, new Date().toISOString()]);
      applied.add(migration.version);
    }
    const expectedVersion = migrations.at(-1)?.version || 0;
    return { ready: applied.has(expectedVersion), currentVersion: Math.max(0, ...applied), expectedVersion };
  } finally {
    if (lockHeld) await query("SELECT RELEASE_LOCK('ai_drama_schema_migrations')").catch(() => undefined);
    if (connection !== pool) connection.release();
  }
}

export const schemaMigrationVersions = migrations.map(({ version, name }) => ({ version, name }));
