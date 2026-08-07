import mysql from 'mysql2/promise';

const EMPTY_DATABASE = {
  users: [],
  sessions: [],
  emailVerifications: [],
  imageCaptchas: [],
  skills: [],
  projects: [],
};

const TABLES = {
  users: {
    create: `CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      email VARCHAR(320) NOT NULL UNIQUE,
      name VARCHAR(80) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at VARCHAR(35) NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, username, email, name, password_hash AS passwordHash, created_at AS createdAt FROM users',
    insert: 'INSERT INTO users (id, username, email, name, password_hash, created_at) VALUES ?',
    values: (row) => [row.id, row.username, row.email, row.name, row.passwordHash, row.createdAt],
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
    for (const [collection, spec] of Object.entries(TABLES)) {
      const [rows] = await this.pool.query(spec.select);
      this.data[collection] = spec.parse ? rows.map(spec.parse) : rows;
    }
    return this;
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
