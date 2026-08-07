import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import svgCaptcha from 'svg-captcha';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'ads_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_COOLDOWN_MS = 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const IMAGE_CAPTCHA_TTL_MS = 5 * 60 * 1000;
const IMAGE_CAPTCHA_MAX_ATTEMPTS = 5;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const hashVerificationCode = (code, salt) => createHash('sha256').update(`${salt}:${code}`).digest('hex');

function createNumericCaptcha() {
  return svgCaptcha.create({
    size: 5,
    noise: 2,
    color: false,
    inverse: true,
    charPreset: '23456789',
    width: 160,
    height: 48,
    fontSize: 42,
  });
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = String(storedHash).split(':');
  if (!salt || !expectedHex) return false;
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(expectedHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

function validateCredentials({ email, password, name }, requireName = false) {
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return '请输入有效邮箱';
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return '密码长度需为 8-128 位';
  if (requireName && (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40)) return '昵称长度需为 2-40 位';
  return null;
}

function setSessionCookie(res, token, secure) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  });
}

export function createAuthService(db, { secureCookies = false, sendEmailCode, generateImageCaptcha = createNumericCaptcha } = {}) {
  async function issueEmailCode(email, purpose) {
    const now = Date.now();
    const activeCode = db.read('emailVerifications')
      .filter((item) => item.email === email && item.purpose === purpose && !item.usedAt && item.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (activeCode?.nextSendAt > now) {
      const error = new Error('验证码发送过于频繁，请稍后重试');
      error.code = 'EMAIL_CODE_COOLDOWN';
      error.retryAfter = Math.ceil((activeCode.nextSendAt - now) / 1000);
      throw error;
    }

    const code = String(randomInt(100000, 1000000));
    const salt = randomBytes(16).toString('hex');
    const record = {
      id: randomUUID(),
      email,
      purpose,
      codeHash: hashVerificationCode(code, salt),
      salt,
      attempts: 0,
      createdAt: now,
      nextSendAt: now + EMAIL_CODE_COOLDOWN_MS,
      expiresAt: now + EMAIL_CODE_TTL_MS,
      usedAt: null,
    };
    await db.mutate((data) => {
      data.emailVerifications = data.emailVerifications.filter((item) => item.expiresAt > now && !item.usedAt);
      data.emailVerifications.push(record);
    });

    try {
      await sendEmailCode({ email, code, purpose, expiresInMinutes: EMAIL_CODE_TTL_MS / 60_000 });
    } catch (error) {
      await db.mutate((data) => {
        data.emailVerifications = data.emailVerifications.filter((item) => item.id !== record.id);
      });
      throw error;
    }
  }

  async function consumeEmailCode(email, purpose, code) {
    if (!/^\d{6}$/.test(String(code || ''))) return false;
    const now = Date.now();
    const record = db.read('emailVerifications')
      .filter((item) => item.email === email && item.purpose === purpose && !item.usedAt && item.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!record || record.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return false;

    const actual = Buffer.from(hashVerificationCode(String(code), record.salt), 'hex');
    const expected = Buffer.from(record.codeHash, 'hex');
    const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
    await db.mutate((data) => {
      const current = data.emailVerifications.find((item) => item.id === record.id);
      if (!current) return;
      current.attempts += 1;
      if (valid) current.usedAt = now;
    });
    return valid;
  }

  async function issueImageCaptcha() {
    const now = Date.now();
    const generated = generateImageCaptcha();
    const code = String(generated.text || '');
    if (!/^\d{5}$/.test(code) || typeof generated.data !== 'string') {
      throw new Error('图片验证码生成失败');
    }
    const salt = randomBytes(16).toString('hex');
    const record = {
      id: randomUUID(),
      codeHash: hashVerificationCode(code, salt),
      salt,
      attempts: 0,
      createdAt: now,
      expiresAt: now + IMAGE_CAPTCHA_TTL_MS,
      usedAt: null,
    };
    await db.mutate((data) => {
      data.imageCaptchas = data.imageCaptchas.filter((item) => item.expiresAt > now && !item.usedAt);
      data.imageCaptchas.push(record);
    });
    return {
      captchaId: record.id,
      image: `data:image/svg+xml;base64,${Buffer.from(generated.data, 'utf8').toString('base64')}`,
      expiresIn: IMAGE_CAPTCHA_TTL_MS / 1000,
    };
  }

  async function consumeImageCaptcha(captchaId, code) {
    if (typeof captchaId !== 'string' || !/^\d{5}$/.test(String(code || ''))) return false;
    const now = Date.now();
    const record = db.read('imageCaptchas').find((item) => (
      item.id === captchaId && !item.usedAt && item.expiresAt > now && item.attempts < IMAGE_CAPTCHA_MAX_ATTEMPTS
    ));
    if (!record) return false;

    const actual = Buffer.from(hashVerificationCode(String(code), record.salt), 'hex');
    const expected = Buffer.from(record.codeHash, 'hex');
    const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
    await db.mutate((data) => {
      const current = data.imageCaptchas.find((item) => item.id === record.id);
      if (!current) return;
      current.attempts += 1;
      if (valid) current.usedAt = now;
    });
    return valid;
  }

  async function createSession(userId, req, res) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    await db.mutate((data) => {
      data.sessions = data.sessions.filter((session) => session.expiresAt > now);
      data.sessions.push({
        id: randomUUID(),
        userId,
        tokenHash: hashToken(token),
        createdAt: now,
        expiresAt: now + SESSION_MAX_AGE_MS,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      });
    });
    setSessionCookie(res, token, secureCookies);
  }

  async function authenticate(req, _res, next) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return next();
    const now = Date.now();
    const session = db.read('sessions').find((item) => item.tokenHash === hashToken(token) && item.expiresAt > now);
    if (!session) return next();
    const user = db.read('users').find((item) => item.id === session.userId);
    if (user) req.user = publicUser(user);
    return next();
  }

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'AUTH_REQUIRED', message: '请先登录' });
    return next();
  }

  function registerRoutes(router) {
    router.get('/me', (req, res) => res.json({ user: req.user || null }));

    router.get('/captcha', async (_req, res, next) => {
      try {
        return res.json(await issueImageCaptcha());
      } catch (routeError) {
        return next(routeError);
      }
    });

    router.post('/email-code', async (req, res, next) => {
      try {
        const email = normalizeEmail(req.body.email);
        const purpose = req.body.purpose;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || purpose !== 'register') {
          return res.status(400).json({ error: 'VALIDATION_ERROR', message: '邮箱或验证码用途无效' });
        }
        const userExists = db.read('users').some((user) => user.email === email);
        if (purpose === 'register' && userExists) {
          return res.status(409).json({ error: 'EMAIL_EXISTS', message: '该邮箱已注册' });
        }
        await issueEmailCode(email, purpose);
        return res.status(202).json({ message: '验证码已发送，请检查邮箱', expiresIn: 600 });
      } catch (routeError) {
        if (routeError.code === 'EMAIL_CODE_COOLDOWN') {
          res.setHeader('Retry-After', routeError.retryAfter);
          return res.status(429).json({ error: routeError.code, message: routeError.message, retryAfter: routeError.retryAfter });
        }
        if (routeError.code === 'EMAIL_NOT_CONFIGURED') {
          return res.status(503).json({ error: routeError.code, message: routeError.message });
        }
        return next(routeError);
      }
    });

    router.post('/register', async (req, res, next) => {
      try {
        const error = validateCredentials(req.body, true);
        if (error) return res.status(400).json({ error: 'VALIDATION_ERROR', message: error });
        const email = normalizeEmail(req.body.email);
        if (db.read('users').some((user) => user.email === email)) {
          return res.status(409).json({ error: 'EMAIL_EXISTS', message: '该邮箱已注册' });
        }
        if (!(await consumeEmailCode(email, 'register', req.body.verificationCode))) {
          return res.status(400).json({ error: 'INVALID_EMAIL_CODE', message: '邮箱验证码错误、已过期或尝试次数过多' });
        }
        const user = {
          id: randomUUID(),
          email,
          name: req.body.name.trim(),
          passwordHash: await hashPassword(req.body.password),
          createdAt: new Date().toISOString(),
        };
        await db.mutate((data) => data.users.push(user));
        await createSession(user.id, req, res);
        return res.status(201).json({ user: publicUser(user) });
      } catch (routeError) {
        return next(routeError);
      }
    });

    router.post('/login', async (req, res, next) => {
      try {
        const error = validateCredentials(req.body, false);
        if (error) return res.status(400).json({ error: 'VALIDATION_ERROR', message: error });
        if (!(await consumeImageCaptcha(req.body.captchaId, req.body.captchaCode))) {
          return res.status(400).json({ error: 'INVALID_CAPTCHA', message: '图片验证码错误、已过期或尝试次数过多' });
        }
        const user = db.read('users').find((item) => item.email === normalizeEmail(req.body.email));
        if (!user || !(await verifyPassword(req.body.password, user.passwordHash))) {
          return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' });
        }
        await createSession(user.id, req, res);
        return res.json({ user: publicUser(user) });
      } catch (routeError) {
        return next(routeError);
      }
    });

    router.post('/logout', requireAuth, async (req, res) => {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) {
        const tokenHash = hashToken(token);
        await db.mutate((data) => {
          data.sessions = data.sessions.filter((session) => session.tokenHash !== tokenHash);
        });
      }
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: secureCookies, path: '/' });
      return res.status(204).end();
    });
  }

  return { authenticate, requireAuth, registerRoutes };
}
