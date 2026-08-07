import express from 'express';
import cookieParser from 'cookie-parser';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonDatabase } from './store.js';
import { createAuthService } from './auth.js';
import { registerDirectorRoutes } from './director.js';
import { registerSkillRoutes } from './skills.js';
import { createEmailSenderFromEnv } from './email.js';

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
    const key = `${req.ip}:${String(req.body?.email || '').toLowerCase()}`;
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
  const db = await new JsonDatabase(databasePath).init();
  const app = express();
  const allowedOrigins = new Set(options.allowedOrigins || ['http://localhost:3000', 'http://127.0.0.1:3000']);
  const auth = createAuthService(db, {
    secureCookies: options.secureCookies ?? process.env.NODE_ENV === 'production',
    sendEmailCode: options.sendEmailCode || createEmailSenderFromEnv(),
    generateImageCaptcha: options.generateImageCaptcha,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(createOriginGuard(allowedOrigins));
  app.use(auth.authenticate);

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'ai-drama-studio' }));
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
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' });
  });

  return { app, db, auth };
}
