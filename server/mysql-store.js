import mysql from 'mysql2/promise';

const EMPTY_DATABASE = {
  users: [],
  sessions: [],
  emailVerifications: [],
  imageCaptchas: [],
  skills: [],
  projects: [],
  systemApis: [],
  modelPricing: [],
  balanceTransactions: [],
  rechargeRequests: [],
};

const TABLES = {
  users: {
    create: `CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      email VARCHAR(320) NOT NULL UNIQUE,
      name VARCHAR(80) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'user',
      balance_cents BIGINT NOT NULL DEFAULT 0,
      created_at VARCHAR(35) NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, username, email, name, password_hash AS passwordHash, role, balance_cents AS balanceCents, created_at AS createdAt FROM users',
    insert: 'INSERT INTO users (id, username, email, name, password_hash, role, balance_cents, created_at) VALUES ?',
    values: (row) => [row.id, row.username, row.email, row.name, row.passwordHash, row.role || 'user', row.balanceCents || 0, row.createdAt],
  },
  sessions: {
    create: `CREATE TABLE IF NOT EXISTS sessions (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      user_agent VARCHAR(300) NOT NULL,
      INDEX sessions_user_id_idx (user_id),
      INDEX sessions_expires_at_idx (expires_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, token_hash AS tokenHash, created_at AS createdAt, expires_at AS expiresAt, user_agent AS userAgent FROM sessions',
    insert: 'INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent) VALUES ?',
    values: (row) => [row.id, row.userId, row.tokenHash, row.createdAt, row.expiresAt, row.userAgent],
  },
  emailVerifications: {
    table: 'email_verifications',
    create: `CREATE TABLE IF NOT EXISTS email_verifications (
      id CHAR(36) PRIMARY KEY,
      email VARCHAR(320) NOT NULL,
      purpose VARCHAR(32) NOT NULL,
      code_hash CHAR(64) NOT NULL,
      salt CHAR(32) NOT NULL,
      attempts INT NOT NULL,
      created_at BIGINT NOT NULL,
      next_send_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at BIGINT NULL,
      INDEX email_verification_lookup_idx (email, purpose, expires_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, email, purpose, code_hash AS codeHash, salt, attempts, created_at AS createdAt, next_send_at AS nextSendAt, expires_at AS expiresAt, used_at AS usedAt FROM email_verifications',
    insert: 'INSERT INTO email_verifications (id, email, purpose, code_hash, salt, attempts, created_at, next_send_at, expires_at, used_at) VALUES ?',
    values: (row) => [row.id, row.email, row.purpose, row.codeHash, row.salt, row.attempts, row.createdAt, row.nextSendAt, row.expiresAt, row.usedAt],
  },
  imageCaptchas: {
    table: 'image_captchas',
    create: `CREATE TABLE IF NOT EXISTS image_captchas (
      id CHAR(36) PRIMARY KEY,
      code_hash CHAR(64) NOT NULL,
      salt CHAR(32) NOT NULL,
      attempts INT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at BIGINT NULL,
      INDEX image_captcha_expires_at_idx (expires_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, code_hash AS codeHash, salt, attempts, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt FROM image_captchas',
    insert: 'INSERT INTO image_captchas (id, code_hash, salt, attempts, created_at, expires_at, used_at) VALUES ?',
    values: (row) => [row.id, row.codeHash, row.salt, row.attempts, row.createdAt, row.expiresAt, row.usedAt],
  },
  skills: {
    create: `CREATE TABLE IF NOT EXISTS skills (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      name VARCHAR(80) NOT NULL,
      description VARCHAR(300) NOT NULL,
      instructions MEDIUMTEXT NOT NULL,
      tags JSON NOT NULL,
      created_at VARCHAR(35) NOT NULL,
      updated_at VARCHAR(35) NOT NULL,
      INDEX skills_user_id_idx (user_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, name, description, instructions, tags, created_at AS createdAt, updated_at AS updatedAt FROM skills',
    insert: 'INSERT INTO skills (id, user_id, name, description, instructions, tags, created_at, updated_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.name, row.description, row.instructions, JSON.stringify(row.tags || []), row.createdAt, row.updatedAt],
    parse: (row) => ({ ...row, tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags }),
  },
  projects: {
    create: `CREATE TABLE IF NOT EXISTS projects (
      id VARCHAR(100) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      title VARCHAR(160) NOT NULL,
      description TEXT NOT NULL,
      project_data JSON NOT NULL,
      created_at VARCHAR(35) NOT NULL,
      updated_at VARCHAR(35) NOT NULL,
      INDEX projects_user_id_updated_idx (user_id, updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, title, description, project_data AS projectData, created_at AS createdAt, updated_at AS updatedAt FROM projects',
    insert: 'INSERT INTO projects (id, user_id, title, description, project_data, created_at, updated_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.title, row.description, JSON.stringify(row.projectData), row.createdAt, row.updatedAt],
    parse: (row) => ({ ...row, projectData: typeof row.projectData === 'string' ? JSON.parse(row.projectData) : row.projectData }),
  },
  systemApis: {
    table: 'system_apis',
    create: `CREATE TABLE IF NOT EXISTS system_apis (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      provider VARCHAR(80) NOT NULL,
      base_url VARCHAR(500) NOT NULL,
      encrypted_api_key TEXT NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_by CHAR(36) NOT NULL,
      created_at VARCHAR(35) NOT NULL,
      updated_at VARCHAR(35) NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, name, provider, base_url AS baseUrl, encrypted_api_key AS encryptedApiKey, enabled, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM system_apis',
    insert: 'INSERT INTO system_apis (id, name, provider, base_url, encrypted_api_key, enabled, created_by, created_at, updated_at) VALUES ?',
    values: (row) => [row.id, row.name, row.provider, row.baseUrl, row.encryptedApiKey, row.enabled ? 1 : 0, row.createdBy, row.createdAt, row.updatedAt],
    parse: (row) => ({ ...row, enabled: Boolean(row.enabled) }),
  },
  modelPricing: {
    table: 'model_pricing',
    create: `CREATE TABLE IF NOT EXISTS model_pricing (
      id CHAR(36) PRIMARY KEY,
      api_id CHAR(36) NOT NULL,
      model_id VARCHAR(160) NOT NULL,
      display_name VARCHAR(160) NOT NULL,
      category VARCHAR(20) NOT NULL,
      billing_unit VARCHAR(20) NOT NULL,
      unit_price_cents INT NOT NULL,
      min_duration_sec INT NULL,
      max_duration_sec INT NULL,
      allowed_durations_sec JSON NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at VARCHAR(35) NOT NULL,
      updated_at VARCHAR(35) NOT NULL,
      UNIQUE KEY model_pricing_api_model_unique (api_id, model_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, api_id AS apiId, model_id AS modelId, display_name AS displayName, category, billing_unit AS billingUnit, unit_price_cents AS unitPriceCents, min_duration_sec AS minDurationSec, max_duration_sec AS maxDurationSec, allowed_durations_sec AS allowedDurationsSec, enabled, created_at AS createdAt, updated_at AS updatedAt FROM model_pricing',
    insert: 'INSERT INTO model_pricing (id, api_id, model_id, display_name, category, billing_unit, unit_price_cents, min_duration_sec, max_duration_sec, allowed_durations_sec, enabled, created_at, updated_at) VALUES ?',
    values: (row) => [row.id, row.apiId, row.modelId, row.displayName, row.category, row.billingUnit, row.unitPriceCents, row.minDurationSec || null, row.maxDurationSec || null, JSON.stringify(row.allowedDurationsSec || []), row.enabled ? 1 : 0, row.createdAt, row.updatedAt],
    parse: (row) => ({ ...row, enabled: Boolean(row.enabled), allowedDurationsSec: typeof row.allowedDurationsSec === 'string' ? JSON.parse(row.allowedDurationsSec || '[]') : (row.allowedDurationsSec || []) }),
  },
  balanceTransactions: {
    table: 'balance_transactions',
    create: `CREATE TABLE IF NOT EXISTS balance_transactions (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      amount_cents BIGINT NOT NULL,
      type VARCHAR(32) NOT NULL,
      description VARCHAR(300) NOT NULL,
      reference_id VARCHAR(100) NULL,
      created_by CHAR(36) NULL,
      created_at VARCHAR(35) NOT NULL,
      INDEX balance_transactions_user_idx (user_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, amount_cents AS amountCents, type, description, reference_id AS referenceId, created_by AS createdBy, created_at AS createdAt FROM balance_transactions',
    insert: 'INSERT INTO balance_transactions (id, user_id, amount_cents, type, description, reference_id, created_by, created_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.amountCents, row.type, row.description, row.referenceId || null, row.createdBy || null, row.createdAt],
  },
  rechargeRequests: {
    table: 'recharge_requests',
    create: `CREATE TABLE IF NOT EXISTS recharge_requests (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      amount_cents BIGINT NOT NULL,
      status VARCHAR(20) NOT NULL,
      note VARCHAR(300) NOT NULL,
      reviewed_by CHAR(36) NULL,
      created_at VARCHAR(35) NOT NULL,
      reviewed_at VARCHAR(35) NULL,
      INDEX recharge_requests_status_idx (status, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, amount_cents AS amountCents, status, note, reviewed_by AS reviewedBy, created_at AS createdAt, reviewed_at AS reviewedAt FROM recharge_requests',
    insert: 'INSERT INTO recharge_requests (id, user_id, amount_cents, status, note, reviewed_by, created_at, reviewed_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.amountCents, row.status, row.note, row.reviewedBy || null, row.createdAt, row.reviewedAt || null],
  },
};

export class MySqlDatabase {
  constructor(databaseUrl) {
    this.kind = 'mysql';
    this.pool = mysql.createPool({
      uri: databaseUrl,
      waitForConnections: true,
      connectionLimit: 5,
      enableKeepAlive: true,
      charset: 'utf8mb4',
    });
    this.data = structuredClone(EMPTY_DATABASE);
    this.writeQueue = Promise.resolve();
  }

  async init() {
    for (const spec of Object.values(TABLES)) await this.pool.query(spec.create);
    await this.ensureColumn('users', 'role', "VARCHAR(16) NOT NULL DEFAULT 'user'");
    await this.ensureColumn('users', 'balance_cents', 'BIGINT NOT NULL DEFAULT 0');
    await this.ensureColumn('model_pricing', 'min_duration_sec', 'INT NULL');
    await this.ensureColumn('model_pricing', 'max_duration_sec', 'INT NULL');
    await this.ensureColumn('model_pricing', 'allowed_durations_sec', 'JSON NULL');
    for (const [collection, spec] of Object.entries(TABLES)) {
      const [rows] = await this.pool.query(spec.select);
      this.data[collection] = spec.parse ? rows.map(spec.parse) : rows;
    }
    return this;
  }

  async ensureColumn(table, column, definition) {
    const [rows] = await this.pool.query(
      'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1',
      [table, column],
    );
    if (!rows.length) await this.pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }

  read(collection) {
    return this.data[collection];
  }

  async mutate(mutator) {
    let result;
    const operation = this.writeQueue.then(async () => {
      const before = structuredClone(this.data);
      result = mutator(this.data);
      const changedCollections = Object.keys(TABLES).filter((name) => JSON.stringify(before[name]) !== JSON.stringify(this.data[name]));
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const collection of changedCollections) await this.replaceCollection(connection, collection);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        this.data = before;
        throw error;
      } finally {
        connection.release();
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async replaceCollection(connection, collection) {
    const spec = TABLES[collection];
    const table = spec.table || collection;
    await connection.query(`DELETE FROM \`${table}\``);
    const rows = this.data[collection].map(spec.values);
    if (rows.length) await connection.query(spec.insert, [rows]);
  }

  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }
}
