import express from 'express';
import cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonDatabase } from './store.js';
import { MySqlDatabase } from './mysql-store.js';
import { createAuthService } from './auth.js';
import { registerDirectorRoutes } from './director.js';
import { registerSkillRoutes } from './skills.js';
import { createEmailSenderFromEnv } from './email.js';
import { registerProjectRoutes } from './projects.js';
import { registerGenerationHistoryRoutes } from './generation-history.js';
import { createSecretVault } from './secrets.js';
import { registerAdminRoutes, registerBillingRoutes, registerCatalogRoutes } from './billing.js';
import { registerSystemAiRoutes } from './system-ai.js';
import { registerAssetRoutes } from './assets.js';
import { createObjectStorageFromEnv } from './object-storage.js';
import { createVideoQueue } from './video-queue.js';
import { createGeneratedMediaService, registerGeneratedMediaRoutes } from './generated-media.js';
import { registerUserApiConfigRoutes, registerUserAiRoutes } from './user-api-configs.js';
import { createResourceGuard } from './resource-guard.js';
import { startMaintenanceScheduler } from './maintenance.js';
import { createPaymentService, registerPaymentRoutes } from './payments.js';
import { createMonitoringService } from './monitoring.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (_req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

function createOriginGuard(allowedOrigins) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin || allowedOrigins.has(origin)) return next();
    try {
      if (new URL(origin).host === req.headers.host) return next();
    } catch {
      // Invalid origins are rejected below.
    }
    return res.status(403).json({ error: 'INVALID_ORIGIN', message: '请求来源不被允许' });
  };
}

function collectionsForRequest(pathname) {
  const scope = String(pathname || '').split('/').filter(Boolean)[1] || '';
  const common = ['users', 'sessions'];
  const byScope = {
    auth: ['emailVerifications', 'imageCaptchas'], director: [], skills: ['skills'], projects: ['projects'],
    assets: ['assets', 'projects'], 'generated-media': ['generatedMedia'], 'generation-history': ['generationHistory'],
    billing: ['balanceTransactions', 'rechargeRequests'], catalog: ['systemApis', 'modelPricing'],
    admin: ['systemApis', 'modelPricing', 'balanceTransactions', 'rechargeRequests', 'generationJobs', 'generatedMedia', 'auditLogs', 'paymentOrders', 'paymentEvents'],
    'system-ai': ['systemApis', 'modelPricing', 'balanceTransactions', 'generationJobs'],
    'user-api-configs': ['userApiConfigs'], 'user-ai': ['userApiConfigs'],
    payments: ['paymentOrders', 'paymentEvents', 'balanceTransactions'],
  };
  return [...common, ...(byScope[scope] || [])];
}

function createRateLimiter({ db, limit = 10, windowMs = 60_000, includeIdentity = true } = {}) {
  return async (req, res, next) => {
    const identity = req.body?.email || req.body?.identifier || req.body?.username || '';
    const scope = `${req.baseUrl || ''}${req.path || ''}`;
    const keyIdentity = includeIdentity ? String(identity).toLowerCase() : 'all';
    const key = createHash('sha256').update(`${scope}:${req.ip}:${keyIdentity}`).digest('hex');
    const now = Date.now();
    try {
      let bucket;
      if (db.consumeRateLimit) bucket = await db.consumeRateLimit(key, limit, windowMs, now);
      else await db.mutate((data) => {
        data.rateLimits = data.rateLimits.filter((item) => item.resetAt > now - windowMs);
        let stored = data.rateLimits.find((item) => item.id === key);
        if (!stored || stored.resetAt <= now) {
          stored = { id: key, count: 1, resetAt: now + windowMs };
          data.rateLimits = data.rateLimits.filter((item) => item.id !== key);
          data.rateLimits.push(stored);
        } else stored.count += 1;
        bucket = { allowed: stored.count <= limit, count: stored.count, resetAt: stored.resetAt };
      });
      if (!bucket.allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
        return res.status(429).json({ error: 'RATE_LIMITED', message: '尝试次数过多，请稍后重试' });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export async function createApp(options = {}) {
  const dataDirectory = String(process.env.DATA_DIR || '').trim();
  const databasePath = options.databasePath || resolve(dataDirectory || resolve(currentDir, 'data'), 'database.json');
  const databaseUrl = String(options.databaseUrl ?? process.env.DATABASE_URL ?? '').trim();
  const db = options.database || await (
    databaseUrl && !options.databasePath
      ? new MySqlDatabase(databaseUrl).init()
      : new JsonDatabase(databasePath).init()
  );
  const assetStorage = options.assetStorage === undefined ? createObjectStorageFromEnv() : options.assetStorage;
  const generatedMedia = createGeneratedMediaService({ db, storage: assetStorage, fetchImpl: options.fetchImpl });
  const monitoring = createMonitoringService({ db, fetchImpl: options.fetchImpl, env: process.env });
  const maintenance = options.maintenance === false ? null : startMaintenanceScheduler({ db, storage: assetStorage, generatedMedia });
  const paymentService = createPaymentService({ db, fetchImpl: options.fetchImpl, env: process.env, config: options.paymentConfig });
  const systemUserEmails = new Set(String(process.env.SYSTEM_USER_EMAILS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (systemUserEmails.size) {
    await db.mutate((data) => {
      data.users.forEach((user) => {
        if (systemUserEmails.has(user.email)) user.role = 'system';
        if (!user.role) user.role = 'user';
        if (!Number.isFinite(Number(user.balanceCents))) user.balanceCents = 0;
      });
    });
  }
  const app = express();
  if (options.monitoring !== false) monitoring.start();
  const allowedOrigins = new Set(options.allowedOrigins || ['http://localhost:3000', 'http://127.0.0.1:3000']);
  const auth = createAuthService(db, {
    secureCookies: options.secureCookies ?? process.env.NODE_ENV === 'production',
    sendEmailCode: options.sendEmailCode || createEmailSenderFromEnv(),
    generateImageCaptcha: options.generateImageCaptcha,
    systemUserEmails,
    securityEvent: async (req, action, metadata = {}) => db.mutate((data) => data.auditLogs.push({ id: randomUUID(), userId: metadata.userId || req.user?.id || null, action, targetType: 'security', targetId: null, ipAddress: String(req.ip || '').slice(0, 100), userAgent: String(req.get('user-agent') || '').slice(0, 300), metadata: { requestId: req.requestId || null, ...metadata }, createdAt: new Date().toISOString() })),
  });
  const encryptionKey = options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY;
  const vault = createSecretVault(encryptionKey || (process.env.NODE_ENV === 'production' ? '' : 'local-development-encryption-key-change-me'));
  await db.mutate((data) => {
    data.systemApis.forEach((api) => {
      try { vault.decrypt(api.baseUrl); } catch { api.baseUrl = vault.encrypt(String(api.baseUrl || '')); }
    });
  });
  const videoQueue = options.videoQueue === false ? null : await createVideoQueue({
    db, vault, fetchImpl: options.fetchImpl, autoStart: options.videoQueueAutoStart !== false, generatedMedia,
  });
  const resourceGuard = options.resourceGuard || createResourceGuard({ db });

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  const preserveRawBody = (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); };
  // Custom API calls may be multipart uploads; keep their exact body for the allowlisted proxy.
  app.use('/api/user-ai', express.raw({ type: () => true, limit: '12mb', verify: preserveRawBody }));
  app.use(express.json({ limit: '22mb', verify: preserveRawBody }));
  app.use(express.urlencoded({ extended: false, limit: '1mb', verify: preserveRawBody }));
  app.use(cookieParser());
  app.use(createOriginGuard(allowedOrigins));
  app.use(async (req, _res, next) => {
    try { if (db.refreshCollections && req.path.startsWith('/api/')) await db.refreshCollections(collectionsForRequest(req.path)); next(); }
    catch (error) { next(error); }
  });
  app.use(auth.authenticate);
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(async (req, res, next) => {
    if (!req.path.startsWith('/api/system-ai/') && !req.path.startsWith('/api/user-ai/')) return next();
    if (!req.user) return next();
    const bucket = await resourceGuard.rateLimit(req.user.id);
    if (!bucket.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))));
      return res.status(429).json({ error: 'AI_RATE_LIMITED', message: 'AI 请求次数过多，请稍后重试' });
    }
    if (req.method === 'GET' && (req.path.endsWith('/v1/models') || /\/v1\/videos\/[^/]+$/.test(req.path))) return next();
    let release;
    try { release = await resourceGuard.acquire(req.user.id); }
    catch (error) { return res.status(429).json({ error: error.code, message: error.message }); }
    res.once('finish', release); res.once('close', release);
    return next();
  });
  const requestLogger = options.logger === undefined ? (process.env.NODE_ENV === 'production' ? console : null) : options.logger;
  app.use((req, res, next) => {
    const suppliedRequestId = String(req.get('x-request-id') || '');
    const requestId = /^[A-Za-z0-9_-]{1,80}$/.test(suppliedRequestId) ? suppliedRequestId : randomUUID();
    const startedAt = Date.now();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => requestLogger?.info?.(JSON.stringify({
      event: 'http_request', requestId, method: req.method, path: req.path,
      status: res.statusCode, durationMs: Date.now() - startedAt, userId: req.user?.id || null,
    })));
    next();
  });

  app.get('/api/health', async (_req, res) => {
    const checks = { database: 'ok', objectStorage: assetStorage ? 'ok' : 'not_configured', queue: videoQueue ? 'ok' : 'disabled' };
    try { if (db.ping) await db.ping(); } catch { checks.database = 'error'; }
    try { if (assetStorage?.health) await assetStorage.health(); } catch { checks.objectStorage = 'error'; }
    const ok = checks.database === 'ok' && checks.objectStorage !== 'error';
    return res.status(ok ? 200 : 503).json({ ok, service: 'ai-drama-studio', checks, monitoring: { configured: monitoring.configured, intervalMs: monitoring.intervalMs } });
  });
  const authRouter = express.Router();
  const authRateLimiter = createRateLimiter({ db, limit: 12, windowMs: 60_000 });
  // Limit all code sends from one IP as well as each email address. This prevents
  // a rotating-address request flood from becoming an SMTP abuse vector.
  const emailCodeIpRateLimiter = createRateLimiter({ db, limit: 6, windowMs: 60_000, includeIdentity: false });
  authRouter.use('/login', authRateLimiter);
  authRouter.use('/register', authRateLimiter);
  authRouter.use('/email-code', emailCodeIpRateLimiter, authRateLimiter);
  authRouter.use('/captcha', authRateLimiter);
  authRouter.use('/reset-password', authRateLimiter);
  auth.registerRoutes(authRouter);
  app.use('/api/auth', authRouter);
  const paymentRouter = express.Router();
  registerPaymentRoutes(paymentRouter, { db, requireAuth: auth.requireAuth, requireSystem: auth.requireSystem, paymentService });
  app.use('/api/payments', paymentRouter);
  const directorRouter = express.Router();
  registerDirectorRoutes(directorRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/director', directorRouter);
  const skillRouter = express.Router();
  registerSkillRoutes(skillRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/skills', skillRouter);
  const projectRouter = express.Router();
  registerProjectRoutes(projectRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/projects', projectRouter);
  const assetRouter = express.Router();
  registerAssetRoutes(assetRouter, { db, requireAuth: auth.requireAuth, assetStorage, assetSigningKey: encryptionKey || 'local-development-encryption-key-change-me' });
  app.use('/api/assets', assetRouter);
  const generatedMediaRouter = express.Router();
  registerGeneratedMediaRoutes(generatedMediaRouter, { db, requireAuth: auth.requireAuth, storage: assetStorage });
  app.use('/api/generated-media', generatedMediaRouter);
  const generationHistoryRouter = express.Router();
  registerGenerationHistoryRoutes(generationHistoryRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/generation-history', generationHistoryRouter);
  const billingRouter = express.Router();
  registerBillingRoutes(billingRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/billing', billingRouter);
  const catalogRouter = express.Router();
  registerCatalogRoutes(catalogRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/catalog', catalogRouter);
  const adminRouter = express.Router();
  registerAdminRoutes(adminRouter, { db, requireSystem: auth.requireSystem, vault, fetchImpl: options.fetchImpl, resolveHost: options.resolveHost, videoQueue });
  app.use('/api/admin', adminRouter);
  const systemAiRouter = express.Router();
  registerSystemAiRoutes(systemAiRouter, { db, requireAuth: auth.requireAuth, vault, fetchImpl: options.fetchImpl, videoQueue });
  app.use('/api/system-ai', systemAiRouter);
  const userApiConfigRouter = express.Router();
  registerUserApiConfigRoutes(userApiConfigRouter, { db, requireAuth: auth.requireAuth, vault, fetchImpl: options.fetchImpl, resolveHost: options.resolveHost });
  app.use('/api/user-api-configs', userApiConfigRouter);
  const userAiRouter = express.Router();
  registerUserAiRoutes(userAiRouter, { db, requireAuth: auth.requireAuth, vault, fetchImpl: options.fetchImpl, resolveHost: options.resolveHost });
  app.use('/api/user-ai', userAiRouter);

  if (options.serveFrontend) {
    const distPath = resolve(currentDir, '..', 'dist');
    app.use(express.static(distPath));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      return res.sendFile(resolve(distPath, 'index.html'));
    });
  }

  app.use((error, _req, res, _next) => {
    console.error(error);
    if (error?.code === 'EMAIL_NOT_CONFIGURED') {
      return res.status(503).json({ error: error.code, message: error.message });
    }
    if (error?.code === 'EMAIL_TIMEOUT') {
      return res.status(504).json({ error: error.code, message: '邮件服务请求超时，请稍后重试' });
    }
    if (error?.code === 'EMAIL_DELIVERY_FAILED') {
      return res.status(502).json({ error: error.code, message: '邮件发送失败，请检查发件服务配置后重试' });
    }
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' });
  });

  return { app, db, auth, videoQueue, maintenance };
}
