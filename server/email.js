import nodemailer from 'nodemailer';

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 12_000;

function emailError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function createMessage({ email, code, purpose, expiresInMinutes }) {
  const action = purpose === 'register' ? '注册' : '登录';
  return {
    to: email,
    subject: `AI Drama Studio ${action}验证码`,
    text: `你的${action}验证码是 ${code}。验证码将在 ${expiresInMinutes} 分钟后失效，请勿转发给他人。`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111827"><h2>AI Drama Studio</h2><p>你的${action}验证码：</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${code}</p><p>验证码将在 ${expiresInMinutes} 分钟后失效，请勿转发给他人。</p></div>`,
  };
}

function createResendSender({ apiKey, from, fetchImpl, timeoutMs }) {
  return async (details) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, ...createMessage(details) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw emailError(`Resend 邮件接口返回 HTTP ${response.status}`, 'EMAIL_DELIVERY_FAILED');
      }
    } catch (error) {
      if (error?.code === 'EMAIL_DELIVERY_FAILED') throw error;
      if (error?.name === 'AbortError') {
        throw emailError('邮件服务请求超时，请稍后重试', 'EMAIL_TIMEOUT', error);
      }
      throw emailError('邮件服务暂时不可用，请稍后重试', 'EMAIL_DELIVERY_FAILED', error);
    } finally {
      clearTimeout(timer);
    }
  };
}

function createSmtpSender({ env, from }) {
  const host = String(env.SMTP_HOST || '').trim();
  const port = Number(env.SMTP_PORT || 587);
  const user = String(env.SMTP_USER || '').trim();
  const pass = String(env.SMTP_PASS || '');

  if (!host || !user || !pass || !from) return null;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: String(env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    auth: { user, pass },
    connectionTimeout: DEFAULT_TIMEOUT_MS,
    greetingTimeout: DEFAULT_TIMEOUT_MS,
    socketTimeout: DEFAULT_TIMEOUT_MS,
  });

  return async (details) => {
    try {
      await transporter.sendMail({ from, ...createMessage(details) });
    } catch (error) {
      const isTimeout = error?.code === 'ETIMEDOUT' || error?.code === 'ESOCKET';
      throw emailError(
        isTimeout ? '邮件服务连接超时，请稍后重试' : '邮件发送失败，请稍后重试',
        isTimeout ? 'EMAIL_TIMEOUT' : 'EMAIL_DELIVERY_FAILED',
        error,
      );
    }
  };
}

export function createEmailSenderFromEnv(env = process.env, options = {}) {
  const resendApiKey = String(env.RESEND_API_KEY || '').trim();
  const emailFrom = String(env.EMAIL_FROM || '').trim();
  const smtpFrom = String(env.SMTP_FROM || env.SMTP_USER || '').trim();

  if (resendApiKey) {
    if (!emailFrom) {
      return async () => {
        throw emailError('Resend 邮件服务尚未配置发件地址，请设置 EMAIL_FROM', 'EMAIL_NOT_CONFIGURED');
      };
    }
    return createResendSender({
      apiKey: resendApiKey,
      from: emailFrom,
      fetchImpl: options.fetchImpl || globalThis.fetch,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
  }

  const smtpSender = createSmtpSender({ env, from: smtpFrom });
  if (smtpSender) return smtpSender;

  return async () => {
    throw emailError(
      '邮件服务尚未配置，请设置 RESEND_API_KEY 和 EMAIL_FROM，或完整配置 SMTP',
      'EMAIL_NOT_CONFIGURED',
    );
  };
}
