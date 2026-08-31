import mysql from 'mysql2/promise';
import { createHash, randomUUID } from 'node:crypto';
import { runSchemaMigrations } from './schema-migrations.js';

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
  generationHistory: [],
  generationJobs: [],
  assets: [],
  generatedMedia: [],
  rateLimits: [],
  auditLogs: [],
  userApiConfigs: [],
  paymentOrders: [],
  paymentEvents: [],
  storageQuarantine: [],
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
      account_type VARCHAR(16) NOT NULL DEFAULT 'special',
      balance_cents BIGINT NOT NULL DEFAULT 0,
      created_at VARCHAR(35) NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, username, email, name, password_hash AS passwordHash, role, account_type AS accountType, balance_cents AS balanceCents, created_at AS createdAt FROM users',
    insert: 'INSERT INTO users (id, username, email, name, password_hash, role, account_type, balance_cents, created_at) VALUES ?',
    values: (row) => [row.id, row.username, row.email, row.name, row.passwordHash, row.role || 'user', row.accountType || 'special', row.balanceCents || 0, row.createdAt],
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
      version INT NOT NULL DEFAULT 1,
      created_at VARCHAR(35) NOT NULL,
      updated_at VARCHAR(35) NOT NULL,
      INDEX projects_user_id_updated_idx (user_id, updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, title, description, project_data AS projectData, version, created_at AS createdAt, updated_at AS updatedAt FROM projects',
    insert: 'INSERT INTO projects (id, user_id, title, description, project_data, version, created_at, updated_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.title, row.description, JSON.stringify(row.projectData), Number(row.version || 1), row.createdAt, row.updatedAt],
    parse: (row) => ({ ...row, projectData: typeof row.projectData === 'string' ? JSON.parse(row.projectData) : row.projectData }),
  },
  projectRevisions: {
    table: 'project_revisions',
    create: `CREATE TABLE IF NOT EXISTS project_revisions (
      id CHAR(36) PRIMARY KEY, project_id VARCHAR(100) NOT NULL, user_id CHAR(36) NOT NULL,
      version INT NOT NULL, project_data JSON NOT NULL, created_at VARCHAR(35) NOT NULL, reason VARCHAR(32) NOT NULL,
      INDEX project_revisions_lookup_idx (project_id, user_id, version),
      INDEX project_revisions_rank_idx (project_id, version DESC, created_at DESC, id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, project_id AS projectId, user_id AS userId, version, project_data AS projectData, created_at AS createdAt, reason FROM project_revisions',
    insert: 'INSERT INTO project_revisions (id, project_id, user_id, version, project_data, created_at, reason) VALUES ?',
    values: (row) => [row.id, row.projectId, row.userId, Number(row.version), JSON.stringify(row.projectData), row.createdAt, row.reason],
    parse: (row) => ({ ...row, projectData: typeof row.projectData === 'string' ? JSON.parse(row.projectData) : row.projectData }),
  },
  systemApis: {
    table: 'system_apis',
    create: `CREATE TABLE IF NOT EXISTS system_apis (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      provider VARCHAR(80) NOT NULL,
      text_protocol VARCHAR(32) NOT NULL DEFAULT 'auto',
      base_url VARCHAR(500) NOT NULL,
      encrypted_api_key TEXT NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_by CHAR(36) NOT NULL,
      created_at VARCHAR(35) NOT NULL,
      updated_at VARCHAR(35) NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, name, provider, text_protocol AS textProtocol, base_url AS baseUrl, encrypted_api_key AS encryptedApiKey, enabled, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM system_apis',
    insert: 'INSERT INTO system_apis (id, name, provider, text_protocol, base_url, encrypted_api_key, enabled, created_by, created_at, updated_at) VALUES ?',
    values: (row) => [row.id, row.name, row.provider, row.textProtocol || 'auto', row.baseUrl, row.encryptedApiKey, row.enabled ? 1 : 0, row.createdBy, row.createdAt, row.updatedAt],
    parse: (row) => ({ ...row, enabled: Boolean(row.enabled) }),
  },
  userApiConfigs: {
    table: 'user_api_configs',
    create: `CREATE TABLE IF NOT EXISTS user_api_configs (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      name VARCHAR(100) NOT NULL,
      provider VARCHAR(80) NOT NULL,
      encrypted_base_url TEXT NOT NULL,
      encrypted_api_key TEXT NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      disabled_at VARCHAR(35) NULL,
      created_at VARCHAR(35) NOT NULL,
      updated_at VARCHAR(35) NOT NULL,
      INDEX user_api_configs_user_idx (user_id, updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, name, provider, encrypted_base_url AS encryptedBaseUrl, encrypted_api_key AS encryptedApiKey, enabled, disabled_at AS disabledAt, created_at AS createdAt, updated_at AS updatedAt FROM user_api_configs',
    insert: 'INSERT INTO user_api_configs (id, user_id, name, provider, encrypted_base_url, encrypted_api_key, enabled, disabled_at, created_at, updated_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.name, row.provider, row.encryptedBaseUrl, row.encryptedApiKey, row.enabled === false ? 0 : 1, row.disabledAt || null, row.createdAt, row.updatedAt],
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
      allowed_resolutions JSON NULL,
      max_reference_images INT NULL,
      max_reference_audios INT NULL,
      max_reference_videos INT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at VARCHAR(35) NOT NULL,
      updated_at VARCHAR(35) NOT NULL,
      UNIQUE KEY model_pricing_api_model_unique (api_id, model_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, api_id AS apiId, model_id AS modelId, display_name AS displayName, category, billing_unit AS billingUnit, unit_price_cents AS unitPriceCents, min_duration_sec AS minDurationSec, max_duration_sec AS maxDurationSec, allowed_durations_sec AS allowedDurationsSec, allowed_resolutions AS allowedResolutions, max_reference_images AS maxReferenceImages, max_reference_audios AS maxReferenceAudios, max_reference_videos AS maxReferenceVideos, enabled, created_at AS createdAt, updated_at AS updatedAt FROM model_pricing',
    insert: 'INSERT INTO model_pricing (id, api_id, model_id, display_name, category, billing_unit, unit_price_cents, min_duration_sec, max_duration_sec, allowed_durations_sec, allowed_resolutions, max_reference_images, max_reference_audios, max_reference_videos, enabled, created_at, updated_at) VALUES ?',
    values: (row) => [row.id, row.apiId, row.modelId, row.displayName, row.category, row.billingUnit, row.unitPriceCents, row.minDurationSec || null, row.maxDurationSec || null, JSON.stringify(row.allowedDurationsSec || []), JSON.stringify(row.allowedResolutions || []), Number.isInteger(Number(row.maxReferenceImages)) ? Number(row.maxReferenceImages) : 4, Number.isInteger(Number(row.maxReferenceAudios)) ? Number(row.maxReferenceAudios) : 0, Number.isInteger(Number(row.maxReferenceVideos)) ? Number(row.maxReferenceVideos) : 0, row.enabled ? 1 : 0, row.createdAt, row.updatedAt],
    parse: (row) => ({ ...row, enabled: Boolean(row.enabled), allowedDurationsSec: typeof row.allowedDurationsSec === 'string' ? JSON.parse(row.allowedDurationsSec || '[]') : (row.allowedDurationsSec || []), allowedResolutions: typeof row.allowedResolutions === 'string' ? JSON.parse(row.allowedResolutions || '[]') : (row.allowedResolutions || []) }),
  },
  userModelAccess: {
    table: 'user_model_access',
    create: `CREATE TABLE IF NOT EXISTS user_model_access (id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, pricing_id CHAR(36) NOT NULL, unit_price_cents INT NOT NULL DEFAULT 0, enabled TINYINT(1) NOT NULL DEFAULT 1, created_at VARCHAR(35) NOT NULL, updated_at VARCHAR(35) NOT NULL, UNIQUE KEY user_model_access_unique (user_id, pricing_id), INDEX user_model_access_user_idx (user_id)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, pricing_id AS pricingId, unit_price_cents AS unitPriceCents, enabled, created_at AS createdAt, updated_at AS updatedAt FROM user_model_access',
    insert: 'INSERT INTO user_model_access (id, user_id, pricing_id, unit_price_cents, enabled, created_at, updated_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.pricingId, Number(row.unitPriceCents || 0), row.enabled === false ? 0 : 1, row.createdAt, row.updatedAt],
    parse: (row) => ({ ...row, enabled: Boolean(row.enabled) }),
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
  paymentOrders: {
    table: 'payment_orders',
    create: `CREATE TABLE IF NOT EXISTS payment_orders (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      merchant_order_no VARCHAR(64) NOT NULL UNIQUE,
      provider VARCHAR(20) NOT NULL,
      amount_cents BIGINT NOT NULL,
      status VARCHAR(24) NOT NULL,
      provider_trade_no VARCHAR(100) NULL,
      pay_url TEXT NOT NULL,
      created_at VARCHAR(35) NOT NULL,
      expires_at VARCHAR(35) NOT NULL,
      paid_at VARCHAR(35) NULL,
      refunded_at VARCHAR(35) NULL,
      INDEX payment_orders_user_created_idx (user_id, created_at),
      INDEX payment_orders_status_created_idx (status, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, merchant_order_no AS merchantOrderNo, provider, amount_cents AS amountCents, status, provider_trade_no AS providerTradeNo, pay_url AS payUrl, created_at AS createdAt, expires_at AS expiresAt, paid_at AS paidAt, refunded_at AS refundedAt FROM payment_orders',
    insert: 'INSERT INTO payment_orders (id, user_id, merchant_order_no, provider, amount_cents, status, provider_trade_no, pay_url, created_at, expires_at, paid_at, refunded_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.merchantOrderNo, row.provider, row.amountCents, row.status, row.providerTradeNo || null, row.payUrl || '', row.createdAt, row.expiresAt, row.paidAt || null, row.refundedAt || null],
  },
  paymentEvents: {
    table: 'payment_events',
    create: `CREATE TABLE IF NOT EXISTS payment_events (
      id CHAR(64) PRIMARY KEY,
      provider VARCHAR(20) NOT NULL,
      provider_event_id VARCHAR(160) NOT NULL,
      order_id CHAR(36) NOT NULL,
      event_type VARCHAR(40) NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      created_at VARCHAR(35) NOT NULL,
      UNIQUE KEY payment_events_provider_event_unique (provider, provider_event_id),
      INDEX payment_events_order_idx (order_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, provider, provider_event_id AS providerEventId, order_id AS orderId, event_type AS eventType, payload_hash AS payloadHash, created_at AS createdAt FROM payment_events',
    insert: 'INSERT INTO payment_events (id, provider, provider_event_id, order_id, event_type, payload_hash, created_at) VALUES ?',
    values: (row) => [row.id, row.provider, row.providerEventId, row.orderId, row.eventType, row.payloadHash, row.createdAt],
  },
  generationHistory: {
    table: 'generation_history',
    create: `CREATE TABLE IF NOT EXISTS generation_history (
      id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, project_id VARCHAR(100) NOT NULL, node_id VARCHAR(100) NULL,
      type VARCHAR(20) NOT NULL, prompt TEXT NOT NULL, url TEXT NOT NULL, thumbnail TEXT NULL,
      created_at VARCHAR(35) NOT NULL, expires_at VARCHAR(35) NOT NULL,
      INDEX generation_history_user_expiry_idx (user_id, expires_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, project_id AS projectId, node_id AS nodeId, type, prompt, url, thumbnail, created_at AS createdAt, expires_at AS expiresAt FROM generation_history',
    insert: 'INSERT INTO generation_history (id, user_id, project_id, node_id, type, prompt, url, thumbnail, created_at, expires_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.projectId, row.nodeId || null, row.type, row.prompt, row.url, row.thumbnail || null, row.createdAt, row.expiresAt],
  },
  generationJobs: {
    table: 'generation_jobs',
    create: `CREATE TABLE IF NOT EXISTS generation_jobs (
      id VARCHAR(64) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      api_id CHAR(36) NOT NULL,
      model_id VARCHAR(191) NOT NULL,
      request_body MEDIUMTEXT NOT NULL,
      status VARCHAR(24) NOT NULL,
      provider_task_id VARCHAR(255) NULL,
      progress INT NOT NULL DEFAULT 0,
      result_url TEXT NULL,
      thumbnail TEXT NULL,
      error_code VARCHAR(100) NULL,
      error_message VARCHAR(500) NULL,
      charge_cents BIGINT NOT NULL DEFAULT 0,
      billing_reference VARCHAR(100) NULL,
      project_id VARCHAR(100) NULL,
      node_id VARCHAR(100) NULL,
      prompt TEXT NOT NULL,
      attempt_count INT NOT NULL DEFAULT 0,
      next_poll_at BIGINT NOT NULL DEFAULT 0,
      created_at VARCHAR(35) NOT NULL,
      submitted_at VARCHAR(35) NULL,
      updated_at VARCHAR(35) NOT NULL,
      completed_at VARCHAR(35) NULL,
      lease_owner VARCHAR(64) NULL,
      lease_until BIGINT NOT NULL DEFAULT 0,
      INDEX generation_jobs_status_poll_idx (status, next_poll_at),
      INDEX generation_jobs_user_created_idx (user_id, created_at),
      INDEX generation_jobs_api_status_idx (api_id, status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: `SELECT id, user_id AS userId, api_id AS apiId, model_id AS modelId, request_body AS requestBody,
      status, provider_task_id AS providerTaskId, progress, result_url AS resultUrl, thumbnail,
      error_code AS errorCode, error_message AS errorMessage, charge_cents AS chargeCents,
      billing_reference AS billingReference, project_id AS projectId, node_id AS nodeId, prompt,
      attempt_count AS attemptCount, next_poll_at AS nextPollAt, created_at AS createdAt,
      submitted_at AS submittedAt, updated_at AS updatedAt, completed_at AS completedAt, lease_owner AS leaseOwner, lease_until AS leaseUntil FROM generation_jobs`,
    insert: `INSERT INTO generation_jobs (id, user_id, api_id, model_id, request_body, status, provider_task_id,
      progress, result_url, thumbnail, error_code, error_message, charge_cents, billing_reference, project_id,
      node_id, prompt, attempt_count, next_poll_at, created_at, submitted_at, updated_at, completed_at, lease_owner, lease_until) VALUES ?`,
    values: (row) => [
      row.id, row.userId, row.apiId, row.modelId, typeof row.requestBody === 'string' ? row.requestBody : JSON.stringify(row.requestBody || {}),
      row.status, row.providerTaskId || null, Number(row.progress || 0), row.resultUrl || null, row.thumbnail || null,
      row.errorCode || null, row.errorMessage || null, Number(row.chargeCents || 0), row.billingReference || null,
      row.projectId || null, row.nodeId || null, row.prompt || '', Number(row.attemptCount || 0), Number(row.nextPollAt || 0),
      row.createdAt, row.submittedAt || null, row.updatedAt, row.completedAt || null, row.leaseOwner || null, Number(row.leaseUntil || 0),
    ],
    parse: (row) => ({ ...row, requestBody: typeof row.requestBody === 'string' ? JSON.parse(row.requestBody || '{}') : (row.requestBody || {}) }),
  },
  assets: {
    create: `CREATE TABLE IF NOT EXISTS assets (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      sha256 CHAR(64) NOT NULL,
      mime_type VARCHAR(40) NOT NULL,
      data_base64 MEDIUMTEXT NULL,
      object_key VARCHAR(1024) NULL,
      storage_provider VARCHAR(20) NOT NULL DEFAULT 'database',
      byte_size INT NOT NULL,
      created_at VARCHAR(35) NOT NULL,
      deleted_at VARCHAR(35) NULL,
      UNIQUE KEY assets_user_hash_unique (user_id, sha256)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, sha256, mime_type AS mimeType, data_base64 AS dataBase64, object_key AS objectKey, storage_provider AS storageProvider, byte_size AS byteSize, created_at AS createdAt, deleted_at AS deletedAt FROM assets',
    insert: 'INSERT INTO assets (id, user_id, sha256, mime_type, data_base64, object_key, storage_provider, byte_size, created_at, deleted_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.sha256, row.mimeType, row.dataBase64 || null, row.objectKey || null, row.storageProvider || 'database', row.byteSize, row.createdAt, row.deletedAt || null],
  },
  generatedMedia: {
    table: 'generated_media',
    create: `CREATE TABLE IF NOT EXISTS generated_media (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      job_id CHAR(36) NOT NULL,
      object_key VARCHAR(1024) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      byte_size BIGINT NOT NULL,
      source_url TEXT NULL,
      created_at VARCHAR(35) NOT NULL,
      expires_at VARCHAR(35) NOT NULL,
      UNIQUE KEY generated_media_job_unique (job_id),
      INDEX generated_media_user_expiry_idx (user_id, expires_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, job_id AS jobId, object_key AS objectKey, mime_type AS mimeType, byte_size AS byteSize, source_url AS sourceUrl, created_at AS createdAt, expires_at AS expiresAt FROM generated_media',
    insert: 'INSERT INTO generated_media (id, user_id, job_id, object_key, mime_type, byte_size, source_url, created_at, expires_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.jobId, row.objectKey, row.mimeType, row.byteSize, row.sourceUrl || null, row.createdAt, row.expiresAt],
  },
  storageQuarantine: {
    table: 'storage_quarantine',
    create: `CREATE TABLE IF NOT EXISTS storage_quarantine (
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
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, original_key AS originalKey, quarantine_key AS quarantineKey, object_size AS objectSize, object_type AS objectType, status, quarantined_by AS quarantinedBy, quarantined_at AS quarantinedAt, delete_after AS deleteAfter, restored_at AS restoredAt, deleted_at AS deletedAt, error_code AS errorCode FROM storage_quarantine',
    insert: 'INSERT INTO storage_quarantine (id, original_key, quarantine_key, object_size, object_type, status, quarantined_by, quarantined_at, delete_after, restored_at, deleted_at, error_code) VALUES ?',
    values: (row) => [row.id, row.originalKey, row.quarantineKey, row.objectSize, row.objectType, row.status, row.quarantinedBy || null, row.quarantinedAt, row.deleteAfter, row.restoredAt || null, row.deletedAt || null, row.errorCode || null],
  },
  auditLogs: {
    table: 'audit_logs',
    create: `CREATE TABLE IF NOT EXISTS audit_logs (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NULL,
      action VARCHAR(80) NOT NULL,
      target_type VARCHAR(40) NOT NULL,
      target_id VARCHAR(100) NULL,
      ip_address VARCHAR(100) NOT NULL,
      user_agent VARCHAR(300) NOT NULL,
      metadata JSON NOT NULL,
      created_at VARCHAR(35) NOT NULL,
      INDEX audit_logs_user_created_idx (user_id, created_at),
      INDEX audit_logs_target_idx (target_type, target_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    select: 'SELECT id, user_id AS userId, action, target_type AS targetType, target_id AS targetId, ip_address AS ipAddress, user_agent AS userAgent, metadata, created_at AS createdAt FROM audit_logs',
    insert: 'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, ip_address, user_agent, metadata, created_at) VALUES ?',
    values: (row) => [row.id, row.userId, row.action, row.targetType, row.targetId || null, row.ipAddress, row.userAgent, JSON.stringify(row.metadata || {}), row.createdAt],
    parse: (row) => ({ ...row, metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {}) }),
  },
};

const MAX_PROJECT_REVISIONS = 30;
export const selectForCollection = (name, spec) => name === 'projectRevisions'
  ? `SELECT revisions.id, revisions.project_id AS projectId, revisions.user_id AS userId,
        revisions.version, revisions.project_data AS projectData, revisions.created_at AS createdAt, revisions.reason
      FROM project_revisions revisions
      INNER JOIN (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY project_id ORDER BY version DESC, created_at DESC, id DESC
        ) AS revision_rank
        FROM project_revisions
      ) ranked ON ranked.id = revisions.id
      WHERE ranked.revision_rank <= ${MAX_PROJECT_REVISIONS}`
  : spec.select;

// Avoid cloning/stringifying multi-megabyte project payloads during unrelated
// writes. Project updates use saveProject(), so version/updatedAt are the
// authoritative change markers for those rows.
function rowRevision(row) {
  if (!row || typeof row !== 'object') return String(row);
  return [row.id, row.version, row.updatedAt, row.createdAt, row.status, row.progress, row.deletedAt].map((value) => String(value ?? '')).join('|');
}

function sameRow(previous, current) {
  if (!previous || !current) return previous === current;
  if (rowRevision(previous) !== rowRevision(current)) return false;
  // Small mutable records without a revision marker still need exact checks.
  const largeFields = new Set(['projectData', 'requestBody', 'payload', 'metadata', 'instructions']);
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of keys) {
    if (largeFields.has(key)) continue;
    if (previous[key] !== current[key]) return false;
  }
  return true;
}

const GENERATION_JOB_PATCH_COLUMNS = {
  status: 'status', providerTaskId: 'provider_task_id', progress: 'progress', resultUrl: 'result_url',
  thumbnail: 'thumbnail', errorCode: 'error_code', errorMessage: 'error_message', attemptCount: 'attempt_count',
  nextPollAt: 'next_poll_at', submittedAt: 'submitted_at', updatedAt: 'updated_at', completedAt: 'completed_at',
  leaseOwner: 'lease_owner', leaseUntil: 'lease_until',
};

export class MySqlDatabase {
  constructor(databaseUrl, { refreshTtlMs } = {}) {
    this.kind = 'mysql';
    this.pool = mysql.createPool({
      uri: databaseUrl,
      waitForConnections: true,
      connectionLimit: Math.min(30, Math.max(5, Number.parseInt(process.env.DATABASE_POOL_SIZE || '10', 10) || 10)),
      enableKeepAlive: true,
      charset: 'utf8mb4',
      ...(String(process.env.DATABASE_SSL || '').toLowerCase() === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
    });
    this.data = structuredClone(EMPTY_DATABASE);
    this.writeQueue = Promise.resolve();
    this.collectionRefreshedAt = new Map();
    this.refreshTtlMs = Math.max(0, Number(refreshTtlMs ?? process.env.DATABASE_REFRESH_TTL_MS ?? 1000) || 0);
    this.schemaState = { ready: false, currentVersion: 0, expectedVersion: 0 };
  }

  async init() {
    for (const spec of Object.values(TABLES)) await this.pool.query(spec.create);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS rate_limits (
      id CHAR(64) PRIMARY KEY,
      request_count INT NOT NULL,
      reset_at BIGINT NOT NULL,
      INDEX rate_limits_reset_idx (reset_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    this.schemaState = await runSchemaMigrations(this.pool);
    for (const [collection, spec] of Object.entries(TABLES)) {
      const [rows] = await this.pool.query(selectForCollection(collection, spec));
      this.data[collection] = spec.parse ? rows.map(spec.parse) : rows;
    }
    const refreshedAt = Date.now();
    for (const collection of Object.keys(TABLES)) this.collectionRefreshedAt.set(collection, refreshedAt);
    return this;
  }

  read(collection) {
    return this.data[collection];
  }

  async refreshCollections(collections) {
    const names = [...new Set(collections)].filter((name) => TABLES[name]);
    if (!names.length) return;
    const operation = this.writeQueue.then(async () => {
      const now = Date.now();
      const staleNames = names.filter((name) => now - Number(this.collectionRefreshedAt.get(name) || 0) >= this.refreshTtlMs);
      if (!staleNames.length) return;
      const refreshed = await Promise.all(staleNames.map(async (name) => {
        const spec = TABLES[name]; const [rows] = await this.pool.query(selectForCollection(name, spec));
        return [name, spec.parse ? rows.map(spec.parse) : rows];
      }));
      const completedAt = Date.now();
      for (const [name, rows] of refreshed) {
        this.data[name] = rows;
        this.collectionRefreshedAt.set(name, completedAt);
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async createUser(user) {
    let result = { created: false, error: null };
    const operation = this.writeQueue.then(async () => {
      try {
        await this.pool.query(TABLES.users.insert, [[TABLES.users.values(user)]]);
        this.data.users.push(user);
        result = { created: true, error: null };
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        const [rows] = await this.pool.query('SELECT email, username FROM users WHERE email = ? OR username = ? LIMIT 1', [user.email, user.username]);
        result = { created: false, error: rows.some((row) => row.email === user.email) ? 'EMAIL_EXISTS' : 'USERNAME_EXISTS' };
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async consumeRateLimit(id, limit, windowMs, now = Date.now()) {
    let result;
    const operation = this.writeQueue.then(async () => {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query('SELECT request_count AS count, reset_at AS resetAt FROM rate_limits WHERE id = ? FOR UPDATE', [id]);
        let count = 1;
        let resetAt = now + windowMs;
        if (rows.length && Number(rows[0].resetAt) > now) {
          count = Number(rows[0].count) + 1;
          resetAt = Number(rows[0].resetAt);
          await connection.query('UPDATE rate_limits SET request_count = ? WHERE id = ?', [count, id]);
        } else if (rows.length) {
          await connection.query('UPDATE rate_limits SET request_count = 1, reset_at = ? WHERE id = ?', [resetAt, id]);
        } else {
          await connection.query('INSERT INTO rate_limits (id, request_count, reset_at) VALUES (?, 1, ?)', [id, resetAt]);
        }
        await connection.commit();
        result = { allowed: count <= limit, count, resetAt };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async changeBalanceAtomic({ userId, amountCents, type, description, referenceId = null, createdBy = null }) {
    let result = { failure: null, balance: null, transaction: null };
    const operation = this.writeQueue.then(async () => {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        if (referenceId && type === 'admin_adjustment') {
          const [existing] = await connection.query('SELECT id, user_id AS userId, amount_cents AS amountCents, type, description, reference_id AS referenceId, created_by AS createdBy, created_at AS createdAt FROM balance_transactions WHERE reference_id = ? AND type = ? LIMIT 1 FOR UPDATE', [referenceId, type]);
          if (existing.length) { await connection.commit(); const user = this.data.users.find((item) => item.id === userId); result = { failure: null, balance: Number(user?.balanceCents || 0), transaction: existing[0], replayed: true }; return; }
        }
        const [users] = await connection.query('SELECT balance_cents AS balanceCents FROM users WHERE id = ? FOR UPDATE', [userId]);
        if (!users.length) { result.failure = 'USER_NOT_FOUND'; await connection.rollback(); return; }
        const next = Number(users[0].balanceCents) + Number(amountCents);
        if (next < 0) { result.failure = 'INSUFFICIENT_BALANCE'; await connection.rollback(); return; }
        const transaction = { id: randomUUID(), userId, amountCents: Number(amountCents), type, description, referenceId, createdBy, createdAt: new Date().toISOString() };
        await connection.query('UPDATE users SET balance_cents = ? WHERE id = ?', [next, userId]);
        await connection.query(TABLES.balanceTransactions.insert, [[TABLES.balanceTransactions.values(transaction)]]);
        await connection.commit();
        const user = this.data.users.find((item) => item.id === userId); if (user) user.balanceCents = next;
        this.data.balanceTransactions.push(transaction);
        result = { failure: null, balance: next, transaction };
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    });
    this.writeQueue = operation.catch(() => undefined); await operation; return result;
  }

  async saveProject(record, expectedVersion) {
    let result;
    const operation = this.writeQueue.then(async () => {
      const nextVersion = expectedVersion + 1;
      if (expectedVersion === 0) {
        try {
          await this.pool.query(TABLES.projects.insert, [[TABLES.projects.values({ ...record, version: nextVersion })]]);
          const stored = { ...record, version: nextVersion };
          this.data.projects.push(stored);
          result = { record: stored, conflict: false };
        } catch (error) {
          if (error.code !== 'ER_DUP_ENTRY') throw error;
          result = { record: null, conflict: true };
        }
        return;
      }
      const [update] = await this.pool.query(
        'UPDATE projects SET title = ?, description = ?, project_data = ?, version = ?, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?',
        [record.title, record.description, JSON.stringify(record.projectData), nextVersion, record.updatedAt, record.id, record.userId, expectedVersion],
      );
      if (!update.affectedRows) { result = { record: null, conflict: true }; return; }
      const previous = this.data.projects.find((item) => item.id === record.id && item.userId === record.userId);
      if (previous) {
        const revision = { id: randomUUID(), projectId: previous.id, userId: previous.userId, version: Number(previous.version || expectedVersion), projectData: previous.projectData, createdAt: new Date().toISOString(), reason: 'save' };
        await this.pool.query(TABLES.projectRevisions.insert, [[TABLES.projectRevisions.values(revision)]]);
        await this.pool.query(
          `DELETE old FROM project_revisions old
           JOIN (SELECT id FROM project_revisions WHERE project_id = ? ORDER BY version DESC, created_at DESC LIMIT 18446744073709551615 OFFSET ?) keep
             ON keep.id = old.id
           WHERE old.project_id = ?`,
          [record.id, MAX_PROJECT_REVISIONS, record.id],
        );
        this.data.projectRevisions.push(revision);
        this.data.projectRevisions = this.data.projectRevisions
          .filter((item) => item.projectId !== record.id)
          .concat(this.data.projectRevisions
            .filter((item) => item.projectId === record.id)
            .sort((a, b) => Number(b.version || 0) - Number(a.version || 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
            .slice(0, MAX_PROJECT_REVISIONS));
      }
      const stored = { ...record, version: nextVersion };
      const index = this.data.projects.findIndex((item) => item.id === record.id);
      if (index >= 0) this.data.projects[index] = stored;
      else this.data.projects.push(stored);
      result = { record: stored, conflict: false };
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async mutate(mutator) {
    let result;
    const operation = this.writeQueue.then(async () => {
      // Keep row references shallow. Deep-cloning the whole cache can briefly
      // require several GB when projects contain many nodes or media URLs.
      const before = Object.fromEntries(Object.keys(TABLES).map((name) => [name, (this.data[name] || []).map((row) => ({ ...row }))]));
      try { result = mutator(this.data); }
      catch (error) { this.data = before; throw error; }
      const changedCollections = Object.keys(TABLES).filter((name) => {
        const current = this.data[name] || []; const previous = before[name] || [];
        return current.length !== previous.length || current.some((row) => !sameRow(previous.find((item) => item.id === row.id), row));
      });
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const collection of changedCollections) await this.syncCollection(connection, collection, before[collection]);
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

  async mutateCollections(collections, mutator) {
    const names = [...new Set(collections)].filter((name) => TABLES[name]);
    if (!names.length) return mutator(this.data);
    let result;
    const operation = this.writeQueue.then(async () => {
      const before = Object.fromEntries(names.map((name) => [name, (this.data[name] || []).map((row) => ({ ...row }))]));
      try { result = mutator(this.data); }
      catch (error) { for (const name of names) this.data[name] = before[name]; throw error; }
      const changedCollections = names.filter((name) => {
        const current = this.data[name] || []; const previous = before[name] || [];
        return current.length !== previous.length || current.some((row) => !sameRow(previous.find((item) => item.id === row.id), row));
      });
      if (!changedCollections.length) return;
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const collection of changedCollections) await this.syncCollection(connection, collection, before[collection]);
        await connection.commit();
        const refreshedAt = Date.now();
        for (const collection of changedCollections) this.collectionRefreshedAt.set(collection, refreshedAt);
      } catch (error) {
        await connection.rollback();
        for (const name of names) this.data[name] = before[name];
        throw error;
      } finally {
        connection.release();
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async enqueueGenerationJob(job, maxPendingPerUser, terminalStatuses) {
    let result = { inserted: false, error: null };
    const operation = this.writeQueue.then(async () => {
      const existing = this.data.generationJobs.find((item) => item.id === job.id && item.userId === job.userId);
      if (existing) { result = { inserted: false, error: null, job: existing }; return; }
      const charge = Number(job.chargeCents || 0) > 0 ? {
        id: randomUUID(), userId: job.userId, amountCents: -Number(job.chargeCents), type: 'model_usage',
        description: `${job.modelId} 视频队列调用`, referenceId: job.billingReference, createdBy: null, createdAt: new Date().toISOString(),
      } : null;
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [users] = await connection.query('SELECT balance_cents AS balanceCents FROM users WHERE id = ? FOR UPDATE', [job.userId]);
        if (!users.length) { result.error = 'USER_NOT_FOUND'; await connection.rollback(); return; }
        const spec = TABLES.generationJobs;
        const [existingRows] = await connection.query(`${spec.select} WHERE id = ? AND user_id = ? LIMIT 1`, [job.id, job.userId]);
        if (existingRows.length) {
          const stored = spec.parse(existingRows[0]);
          await connection.commit();
          if (!this.data.generationJobs.some((item) => item.id === stored.id)) this.data.generationJobs.push(stored);
          result = { inserted: false, error: null, job: stored };
          return;
        }
        const terminal = [...terminalStatuses];
        const placeholders = terminal.map(() => '?').join(',');
        const [pendingRows] = await connection.query(`SELECT COUNT(*) AS pending FROM generation_jobs WHERE user_id = ? AND status NOT IN (${placeholders})`, [job.userId, ...terminal]);
        if (Number(pendingRows[0]?.pending || 0) >= maxPendingPerUser) { result.error = 'VIDEO_QUEUE_USER_LIMIT'; await connection.rollback(); return; }
        const currentBalance = Number(users[0].balanceCents || 0);
        if (Number(job.chargeCents || 0) > currentBalance) { result.error = 'INSUFFICIENT_BALANCE'; await connection.rollback(); return; }
        if (charge) {
          await connection.query('UPDATE users SET balance_cents = ? WHERE id = ?', [currentBalance - Number(job.chargeCents), job.userId]);
          await connection.query(TABLES.balanceTransactions.insert, [[TABLES.balanceTransactions.values(charge)]]);
        }
        await connection.query(TABLES.generationJobs.insert, [[TABLES.generationJobs.values(job)]]);
        await connection.commit();
        const cachedUser = this.data.users.find((item) => item.id === job.userId);
        if (charge) { if (cachedUser) cachedUser.balanceCents = currentBalance - Number(job.chargeCents); this.data.balanceTransactions.push(charge); }
        this.data.generationJobs.push(job);
        result = { inserted: true, error: null };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async patchGenerationJob(jobId, patch) {
    let updated = null;
    const operation = this.writeQueue.then(async () => {
      const job = this.data.generationJobs.find((item) => item.id === jobId);
      if (!job) return;
      const entries = Object.entries(patch).filter(([key]) => GENERATION_JOB_PATCH_COLUMNS[key]);
      if (!entries.length) { updated = { ...job }; return; }
      const assignments = entries.map(([key]) => `\`${GENERATION_JOB_PATCH_COLUMNS[key]}\` = ?`).join(', ');
      const values = entries.map(([, value]) => value ?? null);
      await this.pool.query(`UPDATE generation_jobs SET ${assignments} WHERE id = ?`, [...values, jobId]);
      Object.assign(job, patch);
      updated = { ...job };
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return updated;
  }

  async refreshGenerationJobs() {
    const operation = this.writeQueue.then(async () => {
      const spec = TABLES.generationJobs;
      const [rows] = await this.pool.query(spec.select);
      this.data.generationJobs = rows.map(spec.parse);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return this.data.generationJobs;
  }

  async claimGenerationJobs(jobIds, updatedAt, workerId = 'single-worker', leaseUntil = Date.now() + 120000) {
    if (!jobIds.length) return [];
    let claimed = [];
    const operation = this.writeQueue.then(async () => {
      const eligible = this.data.generationJobs.filter((job) => jobIds.includes(job.id) && job.status === 'queued');
      if (!eligible.length) return;
      for (const job of eligible) {
        const [result] = await this.pool.query(
          'UPDATE generation_jobs SET status = ?, updated_at = ?, lease_owner = ?, lease_until = ? WHERE id = ? AND status = ?',
          ['submitting', updatedAt, workerId, leaseUntil, job.id, 'queued'],
        );
        if (!result.affectedRows) continue;
        Object.assign(job, { status: 'submitting', submittedAt: job.submittedAt || updatedAt, updatedAt, leaseOwner: workerId, leaseUntil });
        claimed.push({ ...job });
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return claimed;
  }

  async claimGenerationJobsForPolling(jobIds, workerId, leaseUntil, now = Date.now()) {
    if (!jobIds.length) return [];
    let claimed = [];
    const operation = this.writeQueue.then(async () => {
      for (const jobId of jobIds) {
        const job = this.data.generationJobs.find((item) => item.id === jobId && item.status === 'processing');
        if (!job) continue;
        const [result] = await this.pool.query(
          'UPDATE generation_jobs SET lease_owner = ?, lease_until = ? WHERE id = ? AND status = ? AND (lease_owner = ? OR lease_owner IS NULL OR lease_until < ?)',
          [workerId, leaseUntil, jobId, 'processing', workerId, now],
        );
        if (!result.affectedRows) continue;
        Object.assign(job, { leaseOwner: workerId, leaseUntil });
        claimed.push({ ...job });
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return claimed;
  }

  async recoverExpiredGenerationJobs(now = Date.now()) {
    const operation = this.writeQueue.then(async () => {
      await this.pool.query(
        'UPDATE generation_jobs SET status = ?, lease_owner = NULL, lease_until = 0, next_poll_at = 0 WHERE status = ? AND (lease_owner IS NULL OR lease_until < ?)',
        ['queued', 'submitting', now],
      );
      const spec = TABLES.generationJobs;
      const [rows] = await this.pool.query(spec.select);
      this.data.generationJobs = rows.map(spec.parse);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async releaseGenerationJobLeases(workerId) {
    const operation = this.writeQueue.then(async () => {
      await this.pool.query(`UPDATE generation_jobs SET
        status = CASE WHEN status = 'submitting' THEN 'queued' ELSE status END,
        lease_owner = NULL, lease_until = 0,
        next_poll_at = CASE WHEN status = 'processing' THEN 0 ELSE next_poll_at END,
        updated_at = ?
        WHERE lease_owner = ? AND status IN ('submitting', 'processing', 'cancel_requested')`, [new Date().toISOString(), workerId]);
      const spec = TABLES.generationJobs;
      const [rows] = await this.pool.query(spec.select);
      this.data.generationJobs = rows.map(spec.parse);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async finalizeGenerationJob(jobId, patch, historyRecord = null) {
    let updated = null;
    const operation = this.writeQueue.then(async () => {
      const job = this.data.generationJobs.find((item) => item.id === jobId);
      if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return;
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const entries = Object.entries(patch).filter(([key]) => GENERATION_JOB_PATCH_COLUMNS[key]);
        const assignments = entries.map(([key]) => `\`${GENERATION_JOB_PATCH_COLUMNS[key]}\` = ?`).join(', ');
        await connection.query(`UPDATE generation_jobs SET ${assignments} WHERE id = ?`, [...entries.map(([, value]) => value ?? null), jobId]);
        const addHistory = historyRecord && !this.data.generationHistory.some((item) => item.userId === historyRecord.userId && item.url === historyRecord.url);
        if (addHistory) {
          await connection.query(TABLES.generationHistory.insert, [[TABLES.generationHistory.values(historyRecord)]]);
        }
        await connection.commit();
        if (addHistory) this.data.generationHistory.push(historyRecord);
        Object.assign(job, patch);
        updated = { ...job };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return updated;
  }

  async failGenerationJob(jobId, patch) {
    let updated = null;
    const operation = this.writeQueue.then(async () => {
      const job = this.data.generationJobs.find((item) => item.id === jobId);
      if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return;
      const user = this.data.users.find((item) => item.id === job.userId);
      const alreadyRefunded = this.data.balanceTransactions.some((item) => item.type === 'model_refund' && item.referenceId === job.billingReference);
      const shouldRefund = Number(job.chargeCents || 0) > 0 && job.billingReference && user && !alreadyRefunded;
      const refund = shouldRefund ? {
        id: randomUUID(), userId: job.userId, amountCents: Number(job.chargeCents), type: 'model_refund',
        description: patch.status === 'cancelled' ? '视频队列任务取消退款' : '视频队列任务失败退款', referenceId: job.billingReference, createdBy: null, createdAt: new Date().toISOString(),
      } : null;
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        if (refund) {
          await connection.query('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [refund.amountCents, job.userId]);
          await connection.query(TABLES.balanceTransactions.insert, [[TABLES.balanceTransactions.values(refund)]]);
        }
        const entries = Object.entries(patch).filter(([key]) => GENERATION_JOB_PATCH_COLUMNS[key]);
        const assignments = entries.map(([key]) => `\`${GENERATION_JOB_PATCH_COLUMNS[key]}\` = ?`).join(', ');
        await connection.query(`UPDATE generation_jobs SET ${assignments} WHERE id = ?`, [...entries.map(([, value]) => value ?? null), jobId]);
        await connection.commit();
        if (refund) { user.balanceCents = Number(user.balanceCents || 0) + refund.amountCents; this.data.balanceTransactions.push(refund); }
        Object.assign(job, patch);
        updated = { ...job };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return updated;
  }

  async cleanupGenerationJobs(cutoff, terminalStatuses) {
    const operation = this.writeQueue.then(async () => {
      const ids = this.data.generationJobs.filter((job) => terminalStatuses.has(job.status) && String(job.completedAt || job.updatedAt) < cutoff).map((job) => job.id);
      if (!ids.length) return;
      await this.pool.query('DELETE FROM generation_jobs WHERE id IN (?)', [ids]);
      const idSet = new Set(ids);
      this.data.generationJobs = this.data.generationJobs.filter((job) => !idSet.has(job.id));
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async syncCollection(connection, collection, previousRows = []) {
    const spec = TABLES[collection];
    const table = spec.table || collection;
    const currentRows = this.data[collection];
    const previousById = new Map(previousRows.map((row) => [row.id, row]));
    const currentIds = new Set(currentRows.map((row) => row.id));
    const removedIds = previousRows.filter((row) => !currentIds.has(row.id)).map((row) => row.id);
    const changedRows = currentRows.filter((row) => {
      const previous = previousById.get(row.id);
      return !sameRow(previous, row);
    });

    if (removedIds.length) await connection.query(`DELETE FROM \`${table}\` WHERE id IN (?)`, [removedIds]);
    if (!changedRows.length) return;

    const columnMatch = spec.insert.match(/\(([^)]+)\)\s+VALUES\s+\?/i);
    if (!columnMatch) throw new Error(`无法为 ${table} 生成行级 UPSERT`);
    const columns = columnMatch[1].split(',').map((column) => column.trim().replace(/^`|`$/g, ''));
    const updates = columns.slice(1).map((column) => `\`${column}\` = VALUES(\`${column}\`)`).join(', ');
    await connection.query(`${spec.insert} ON DUPLICATE KEY UPDATE ${updates}`, [changedRows.map(spec.values)]);
  }

  async settlePaymentOrder(provider, payment) {
    const result = { found: false, credited: false, mismatch: false };
    const operation = this.writeQueue.then(async () => {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query('SELECT id, user_id AS userId, amount_cents AS amountCents, status, expires_at AS expiresAt FROM payment_orders WHERE provider = ? AND merchant_order_no = ? FOR UPDATE', [provider, payment.merchantOrderNo]);
        if (!rows.length) { await connection.rollback(); return; }
        const order = rows[0]; result.found = true;
        if (order.status === 'pending' && Date.parse(order.expiresAt) < Date.now()) { await connection.query('UPDATE payment_orders SET status = ? WHERE id = ? AND status = ?', ['expired', order.id, 'pending']); await connection.commit(); const cachedOrder = this.data.paymentOrders.find((item) => item.id === order.id); if (cachedOrder) cachedOrder.status = 'expired'; return; }
        if (Number(order.amountCents) !== Number(payment.amountCents)) { result.mismatch = true; await connection.rollback(); return; }
        const [events] = await connection.query('SELECT id FROM payment_events WHERE provider = ? AND provider_event_id = ? LIMIT 1', [provider, payment.eventId]);
        if (events.length) { await connection.commit(); return; }
        const event = { id: createHash('sha256').update(`${provider}:${payment.eventId}`).digest('hex'), provider, providerEventId: payment.eventId, orderId: order.id, eventType: 'payment_succeeded', payloadHash: payment.payloadHash, createdAt: new Date().toISOString() };
        await connection.query(TABLES.paymentEvents.insert, [[TABLES.paymentEvents.values(event)]]);
        if (order.status !== 'pending') { await connection.commit(); this.data.paymentEvents.push(event); return; }
        const paidAt = new Date().toISOString();
        const transaction = { id: randomUUID(), userId: order.userId, amountCents: Number(order.amountCents), type: 'payment_recharge', description: `${provider === 'alipay' ? '支付宝' : '微信支付'}充值`, referenceId: order.id, createdBy: null, createdAt: paidAt };
        await connection.query('UPDATE payment_orders SET status = ?, provider_trade_no = ?, paid_at = ? WHERE id = ? AND status = ?', ['paid', payment.providerTradeNo, paidAt, order.id, 'pending']);
        await connection.query('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [order.amountCents, order.userId]);
        await connection.query(TABLES.balanceTransactions.insert, [[TABLES.balanceTransactions.values(transaction)]]);
        await connection.commit();
        this.data.paymentEvents.push(event);
        const cachedOrder = this.data.paymentOrders.find((item) => item.id === order.id);
        if (cachedOrder) Object.assign(cachedOrder, { status: 'paid', providerTradeNo: payment.providerTradeNo, paidAt });
        const user = this.data.users.find((item) => item.id === order.userId);
        if (user) user.balanceCents = Number(user.balanceCents || 0) + Number(order.amountCents);
        this.data.balanceTransactions.push(transaction);
        result.credited = true;
      } catch (error) {
        await connection.rollback(); throw error;
      } finally { connection.release(); }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async reservePaymentRefund(orderId) {
    let result = { ok: false, error: 'ORDER_NOT_FOUND', order: null };
    const operation = this.writeQueue.then(async () => {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [orders] = await connection.query('SELECT * FROM payment_orders WHERE id = ? FOR UPDATE', [orderId]);
        if (!orders.length) { await connection.rollback(); return; }
        const row = orders[0];
        if (['refunding', 'refunded'].includes(row.status)) { result.error = 'REFUND_ALREADY_STARTED'; await connection.rollback(); return; }
        if (row.status !== 'paid') { result.error = 'ORDER_NOT_PAID'; await connection.rollback(); return; }
        const [users] = await connection.query('SELECT balance_cents AS balanceCents FROM users WHERE id = ? FOR UPDATE', [row.user_id]);
        if (!users.length || Number(users[0].balanceCents) < Number(row.amount_cents)) { result.error = 'REFUND_BALANCE_SPENT'; await connection.rollback(); return; }
        const createdAt = new Date().toISOString();
        const transaction = { id: randomUUID(), userId: row.user_id, amountCents: -Number(row.amount_cents), type: 'payment_refund', description: '在线支付退款余额冻结', referenceId: orderId, createdBy: null, createdAt };
        await connection.query('UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?', [row.amount_cents, row.user_id]);
        await connection.query('UPDATE payment_orders SET status = ? WHERE id = ?', ['refunding', orderId]);
        await connection.query(TABLES.balanceTransactions.insert, [[TABLES.balanceTransactions.values(transaction)]]);
        await connection.commit();
        const cachedOrder = this.data.paymentOrders.find((item) => item.id === orderId); if (cachedOrder) cachedOrder.status = 'refunding';
        const user = this.data.users.find((item) => item.id === row.user_id); if (user) user.balanceCents -= Number(row.amount_cents);
        this.data.balanceTransactions.push(transaction);
        result = { ok: true, error: null, order: cachedOrder ? { ...cachedOrder } : { id: row.id, userId: row.user_id, merchantOrderNo: row.merchant_order_no, provider: row.provider, amountCents: Number(row.amount_cents), status: 'refunding', providerTradeNo: row.provider_trade_no, payUrl: row.pay_url, createdAt: row.created_at, expiresAt: row.expires_at, paidAt: row.paid_at, refundedAt: row.refunded_at } };
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    });
    this.writeQueue = operation.catch(() => undefined); await operation; return result;
  }

  async finishPaymentRefund(orderId, eventId) {
    let completed = false;
    const operation = this.writeQueue.then(async () => {
      const order = this.data.paymentOrders.find((item) => item.id === orderId);
      if (!order || order.status === 'refunded') return;
      const refundedAt = new Date().toISOString();
      const event = { id: createHash('sha256').update(`${order.provider}:${eventId}`).digest('hex'), provider: order.provider, providerEventId: eventId, orderId, eventType: 'refund_succeeded', payloadHash: createHash('sha256').update(eventId).digest('hex'), createdAt: refundedAt };
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [update] = await connection.query('UPDATE payment_orders SET status = ?, refunded_at = ? WHERE id = ? AND status = ?', ['refunded', refundedAt, orderId, 'refunding']);
        if (!update.affectedRows) { await connection.rollback(); return; }
        await connection.query(`${TABLES.paymentEvents.insert} ON DUPLICATE KEY UPDATE id = id`, [[TABLES.paymentEvents.values(event)]]);
        await connection.commit(); Object.assign(order, { status: 'refunded', refundedAt }); this.data.paymentEvents.push(event); completed = true;
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    });
    this.writeQueue = operation.catch(() => undefined); await operation; return completed;
  }

  async rollbackPaymentRefund(orderId) {
    const operation = this.writeQueue.then(async () => {
      const order = this.data.paymentOrders.find((item) => item.id === orderId && item.status === 'refunding'); if (!order) return;
      const transaction = { id: randomUUID(), userId: order.userId, amountCents: Number(order.amountCents), type: 'payment_refund_rollback', description: '商户退款创建失败，余额解冻', referenceId: order.id, createdBy: null, createdAt: new Date().toISOString() };
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [update] = await connection.query('UPDATE payment_orders SET status = ? WHERE id = ? AND status = ?', ['paid', orderId, 'refunding']);
        if (!update.affectedRows) { await connection.rollback(); return; }
        await connection.query('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [order.amountCents, order.userId]);
        await connection.query(TABLES.balanceTransactions.insert, [[TABLES.balanceTransactions.values(transaction)]]);
        await connection.commit(); order.status = 'paid'; const user = this.data.users.find((item) => item.id === order.userId); if (user) user.balanceCents += Number(order.amountCents); this.data.balanceTransactions.push(transaction);
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    });
    this.writeQueue = operation.catch(() => undefined); await operation;
  }

  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  migrationStatus() {
    return { ...this.schemaState, provider: 'mysql' };
  }

  async storageStats() {
    const [rows] = await this.pool.query('SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes, COALESCE(SUM(table_rows), 0) AS rowCount FROM information_schema.tables WHERE table_schema = DATABASE()');
    return { provider: 'mysql', bytes: Number(rows[0]?.bytes || 0), rows: Number(rows[0]?.rowCount || 0) };
  }

  async writeRequestMetricBuckets(buckets) {
    if (!buckets?.length) return;
    const values = buckets.map((item) => [item.bucketStart, item.scope, item.statusClass, item.latencyBucketMs, item.count, item.durationTotalMs]);
    await this.pool.query(`INSERT INTO request_metric_buckets
      (bucket_start, scope, status_class, latency_bucket_ms, request_count, duration_total_ms) VALUES ?
      ON DUPLICATE KEY UPDATE request_count = request_count + VALUES(request_count), duration_total_ms = duration_total_ms + VALUES(duration_total_ms)`, [values]);
  }

  async readRequestMetricBuckets(since) {
    const [rows] = await this.pool.query(`SELECT bucket_start AS bucketStart, scope, status_class AS statusClass,
      latency_bucket_ms AS latencyBucketMs, request_count AS count, duration_total_ms AS durationTotalMs
      FROM request_metric_buckets WHERE bucket_start >= ?`, [since]);
    return rows.map((row) => ({ ...row, bucketStart: Number(row.bucketStart), latencyBucketMs: Number(row.latencyBucketMs), count: Number(row.count), durationTotalMs: Number(row.durationTotalMs) }));
  }

  async cleanupRequestMetricBuckets(before) {
    const [result] = await this.pool.query('DELETE FROM request_metric_buckets WHERE bucket_start < ?', [before]);
    return Number(result.affectedRows || 0);
  }

  async close() {
    await this.pool.end();
  }
}
