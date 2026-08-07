import express from 'express';
import cookieParser from 'cookie-parser';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonDatabase } from './store.js';
import { MySqlDatabase } from './mysql-store.js';
import { createAuthService } from './auth.js';
import { registerDirectorRoutes } from './director.js';
import { registerSkillRoutes } from './skills.js';
import { createEmailSenderFromEnv } from './email.js';
import { registerProjectRoutes } from './projects.js';
import { createSecretVault } from './secrets.js';
import { registerAdminRoutes, registerBillingRoutes, registerCatalogRoutes } from './billing.js';
import { registerSystemAiRoutes } from './system-ai.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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

function createRateLimiter({ limit = 10, windowMs = 60_000 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const identity = req.body?.email || req.body?.identifier || req.body?.username || '';
    const key = `${req.ip}:${String(identity).toLowerCase()}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > limit) return res.status(429).json({ error: 'RATE_LIMITED', message: '尝试次数过多，请稍后重试' });
    return next();
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
  const allowedOrigins = new Set(options.allowedOrigins || ['http://localhost:3000', 'http://127.0.0.1:3000']);
  const auth = createAuthService(db, {
    secureCookies: options.secureCookies ?? process.env.NODE_ENV === 'production',
    sendEmailCode: options.sendEmailCode || createEmailSenderFromEnv(),
    generateImageCaptcha: options.generateImageCaptcha,
    systemUserEmails,
  });
  const encryptionKey = options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY;
  const vault = createSecretVault(encryptionKey || (process.env.NODE_ENV === 'production' ? '' : 'local-development-encryption-key-change-me'));

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '3mb' }));
  app.use(cookieParser());
  app.use(createOriginGuard(allowedOrigins));
  app.use(auth.authenticate);

  app.get('/api/health', async (_req, res, next) => {
    try {
      if (db.ping) await db.ping();
      return res.json({ ok: true, service: 'ai-drama-studio', database: db.kind || 'json' });
    } catch (error) {
      return next(error);
    }
  });
  const authRouter = express.Router();
  const authRateLimiter = createRateLimiter({ limit: 12, windowMs: 60_000 });
  authRouter.use('/login', authRateLimiter);
  authRouter.use('/register', authRateLimiter);
  authRouter.use('/email-code', authRateLimiter);
  authRouter.use('/captcha', authRateLimiter);
  auth.registerRoutes(authRouter);
  app.use('/api/auth', authRouter);
  const directorRouter = express.Router();
  registerDirectorRoutes(directorRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/director', directorRouter);
  const skillRouter = express.Router();
  registerSkillRoutes(skillRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/skills', skillRouter);
  const projectRouter = express.Router();
  registerProjectRoutes(projectRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/projects', projectRouter);
  const billingRouter = express.Router();
  registerBillingRoutes(billingRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/billing', billingRouter);
  const catalogRouter = express.Router();
  registerCatalogRoutes(catalogRouter, { db, requireAuth: auth.requireAuth });
  app.use('/api/catalog', catalogRouter);
  const adminRouter = express.Router();
  registerAdminRoutes(adminRouter, { db, requireSystem: auth.requireSystem, vault });
  app.use('/api/admin', adminRouter);
  const systemAiRouter = express.Router();
  registerSystemAiRoutes(systemAiRouter, { db, requireAuth: auth.requireAuth, vault, fetchImpl: options.fetchImpl });
  app.use('/api/system-ai', systemAiRouter);

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

  return { app, db, auth };
}
