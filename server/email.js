import nodemailer from 'nodemailer';

export function createEmailSenderFromEnv(env = process.env) {
  const host = String(env.SMTP_HOST || '').trim();
  const port = Number(env.SMTP_PORT || 587);
  const user = String(env.SMTP_USER || '').trim();
  const pass = String(env.SMTP_PASS || '');
  const from = String(env.SMTP_FROM || user).trim();

  if (!host || !user || !pass || !from) {
    return async () => {
      const error = new Error('邮件服务尚未配置，请设置 SMTP_HOST、SMTP_USER、SMTP_PASS 和 SMTP_FROM');
      error.code = 'EMAIL_NOT_CONFIGURED';
      throw error;
    };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: String(env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    auth: { user, pass },
  });

  return async ({ email, code, purpose, expiresInMinutes }) => {
    const action = purpose === 'register' ? '注册' : '登录';
    await transporter.sendMail({
      from,
      to: email,
      subject: `AI Drama Studio ${action}验证码`,
      text: `你的${action}验证码是 ${code}。验证码将在 ${expiresInMinutes} 分钟后失效，请勿转发给他人。`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111827"><h2>AI Drama Studio</h2><p>你的${action}验证码：</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${code}</p><p>验证码将在 ${expiresInMinutes} 分钟后失效，请勿转发给他人。</p></div>`,
    });
  };
}
