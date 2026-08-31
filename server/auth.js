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
// Limit concurrent login sessions across browsers, private windows, and devices.
// Regular tabs in the same browser share one HttpOnly cookie and count as one session.
const MAX_SESSIONS_PER_USER = 4;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeUsername = (value) => String(value || '').trim();
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

export async function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = String(storedHash).split(':');
  if (!salt || !expectedHex) return false;
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(expectedHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role || 'user',
    accountType: user.accountType || (user.role === 'system' ? 'system' : 'user'),
    balanceCents: Number(user.balanceCents || 0),
    createdAt: user.createdAt,
  };
}

function validateCredentials({ email, password, username }, requireRegistrationFields = false) {
  if (requireRegistrationFields && !/^[\p{L}\p{N}_-]{3,30}$/u.test(normalizeUsername(username))) {
    return '用户名需为 3-30 位，只能包含文字、字母、数字、下划线或连字符';
  }
  if (requireRegistrationFields && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) return '请输入有效邮箱';
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return '密码长度需为 8-128 位';
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

export function createAuthService(db, { secureCookies = false, sendEmailCode, generateImageCaptcha = createNumericCaptcha, systemUserEmails = new Set(), securityEvent = null } = {}) {
  const mutate = (collections, mutator) => db.mutateCollections ? db.mutateCollections(collections, mutator) : db.mutate(mutator);
  const recordSecurityEvent = async (req, action, metadata = {}) => {
    if (securityEvent) return securityEvent(req, action, metadata);
    return mutate(['auditLogs'], (data) => data.auditLogs.push({ id: randomUUID(), userId: metadata.userId || req.user?.id || null, action, targetType: 'security', targetId: null, ipAddress: String(req.ip || '').slice(0, 100), userAgent: String(req.get('user-agent') || '').slice(0, 300), metadata: { requestId: req.requestId || null, ...metadata }, createdAt: new Date().toISOString() }));
  };
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
    await mutate(['emailVerifications'], (data) => {
      data.emailVerifications = data.emailVerifications.filter((item) => item.expiresAt > now && !item.usedAt);
      data.emailVerifications.push(record);
    });

    try {
      await sendEmailCode({ email, code, purpose, expiresInMinutes: EMAIL_CODE_TTL_MS / 60_000 });
    } catch (error) {
      await mutate(['emailVerifications'], (data) => {
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
    await mutate(['emailVerifications'], (data) => {
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
    await mutate(['imageCaptchas'], (data) => {
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
    await mutate(['imageCaptchas'], (data) => {
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
    await mutate(['sessions'], (data) => {
      data.sessions = data.sessions.filter((session) => session.expiresAt > now);
      const existing = data.sessions.filter((session) => session.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
      const retained = new Set(existing.slice(0, MAX_SESSIONS_PER_USER - 1).map((session) => session.id));
      data.sessions = data.sessions.filter((session) => session.userId !== userId || retained.has(session.id));
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

  function requireSystem(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'AUTH_REQUIRED', message: '请先登录' });
    if (req.user.role !== 'system') return res.status(403).json({ error: 'SYSTEM_ROLE_REQUIRED', message: '仅系统用户可以执行此操作' });
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
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['register', 'reset_password'].includes(purpose)) {
          return res.status(400).json({ error: 'VALIDATION_ERROR', message: '邮箱或验证码用途无效' });
        }
        const userExists = db.read('users').some((user) => user.email === email);
        if (purpose === 'register' && userExists) {
          return res.status(409).json({ error: 'EMAIL_EXISTS', message: '该邮箱已注册' });
        }
        if (purpose === 'reset_password' && !userExists) {
          return res.status(202).json({ message: '如果该邮箱已注册，验证码将发送到邮箱', expiresIn: 600 });
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
        const username = normalizeUsername(req.body.username);
        if (db.read('users').some((user) => user.email === email)) {
          return res.status(409).json({ error: 'EMAIL_EXISTS', message: '该邮箱已注册' });
        }
        if (db.read('users').some((user) => user.username.toLowerCase() === username.toLowerCase())) {
          return res.status(409).json({ error: 'USERNAME_EXISTS', message: '该用户名已被使用' });
        }
        if (!(await consumeEmailCode(email, 'register', req.body.verificationCode))) {
          return res.status(400).json({ error: 'INVALID_EMAIL_CODE', message: '邮箱验证码错误、已过期或尝试次数过多' });
        }
        const user = {
          id: randomUUID(),
          username,
          email,
          name: username,
          passwordHash: await hashPassword(req.body.password),
          role: systemUserEmails.has(email) ? 'system' : 'user',
          accountType: systemUserEmails.has(email) ? 'system' : 'special',
          balanceCents: 0,
          createdAt: new Date().toISOString(),
        };
        const created = db.createUser ? await db.createUser(user) : await db.mutate((data) => {
          if (data.users.some((item) => item.email === email)) return { created: false, error: 'EMAIL_EXISTS' };
          if (data.users.some((item) => item.username.toLowerCase() === username.toLowerCase())) return { created: false, error: 'USERNAME_EXISTS' };
          data.users.push(user); return { created: true, error: null };
        });
        if (!created.created) {
          if (created.error === 'EMAIL_EXISTS') return res.status(409).json({ error: created.error, message: '该邮箱已注册' });
          return res.status(409).json({ error: 'USERNAME_EXISTS', message: '该用户名已被使用' });
        }
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
        const identifier = String(req.body.identifier || req.body.email || '').trim().toLowerCase();
        if (!identifier) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '请输入用户名或邮箱' });
        const user = db.read('users').find((item) => item.email === identifier || item.username.toLowerCase() === identifier);
        if (!user || !(await verifyPassword(req.body.password, user.passwordHash))) {
          await recordSecurityEvent(req, 'login_failed', { identifierType: identifier.includes('@') ? 'email' : 'username' });
          return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' });
        }
        await createSession(user.id, req, res);
        await recordSecurityEvent(req, 'login_succeeded', { userId: user.id });
        return res.json({ user: publicUser(user) });
      } catch (routeError) {
        return next(routeError);
      }
    });

    router.post('/change-password', requireAuth, async (req, res, next) => {
      try {
        const newPasswordError = validateCredentials({ password: req.body.newPassword }, false);
        if (newPasswordError) return res.status(400).json({ error: 'VALIDATION_ERROR', message: newPasswordError });
        if (req.body.newPassword !== req.body.confirmPassword) return res.status(400).json({ error: 'PASSWORD_MISMATCH', message: '两次输入的新密码不一致' });
        const user = db.read('users').find((item) => item.id === req.user.id);
        if (!user || !(await verifyPassword(String(req.body.currentPassword || ''), user.passwordHash))) {
          return res.status(401).json({ error: 'CURRENT_PASSWORD_INVALID', message: '当前密码错误' });
        }
        const currentTokenHash = req.cookies?.[SESSION_COOKIE] ? hashToken(req.cookies[SESSION_COOKIE]) : '';
        const newPasswordHash = await hashPassword(req.body.newPassword);
        await mutate(['users', 'sessions'], (data) => {
          const currentUser = data.users.find((item) => item.id === req.user.id);
          if (currentUser) currentUser.passwordHash = newPasswordHash;
          data.sessions = data.sessions.filter((session) => session.userId !== req.user.id || session.tokenHash === currentTokenHash);
        });
        return res.json({ message: '密码已修改，其他设备的登录会话已失效' });
      } catch (routeError) { return next(routeError); }
    });

    router.post('/reset-password', async (req, res, next) => {
      try {
        const email = normalizeEmail(req.body.email);
        const newPasswordError = validateCredentials({ password: req.body.newPassword }, false);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || newPasswordError) return res.status(400).json({ error: 'VALIDATION_ERROR', message: newPasswordError || '请输入有效邮箱' });
        const user = db.read('users').find((item) => item.email === email);
        if (!user || !(await consumeEmailCode(email, 'reset_password', req.body.verificationCode))) return res.status(400).json({ error: 'INVALID_RESET_CODE', message: '邮箱验证码错误、已过期或尝试次数过多' });
        const newPasswordHash = await hashPassword(req.body.newPassword);
        await mutate(['users', 'sessions'], (data) => {
          const currentUser = data.users.find((item) => item.id === user.id);
          if (currentUser) currentUser.passwordHash = newPasswordHash;
          data.sessions = data.sessions.filter((session) => session.userId !== user.id);
        });
        return res.json({ message: '密码已重置，请使用新密码登录' });
      } catch (routeError) { return next(routeError); }
    });

    router.post('/logout', requireAuth, async (req, res) => {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) {
        const tokenHash = hashToken(token);
        await mutate(['sessions'], (data) => {
          data.sessions = data.sessions.filter((session) => session.tokenHash !== tokenHash);
        });
      }
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: secureCookies, path: '/' });
      return res.status(204).end();
    });
  }

  return { authenticate, requireAuth, requireSystem, registerRoutes };
}
