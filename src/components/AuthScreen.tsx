import { FormEvent, useEffect, useState } from 'react';
import { Eye, EyeOff, Film, Loader2, LockKeyhole, Mail, RefreshCw, UserRound } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { apiRequest } from '@/services/apiClient';

export default function AuthScreen() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [captchaImage, setCaptchaImage] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [isLoadingCaptcha, setIsLoadingCaptcha] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => setResendSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  useEffect(() => {
    if (mode === 'login') void loadCaptcha();
  }, [mode]);

  async function loadCaptcha() {
    setIsLoadingCaptcha(true);
    setCaptchaCode('');
    try {
      const result = await apiRequest<{ captchaId: string; image: string }>('/api/auth/captcha');
      if (!result.captchaId || !result.image?.startsWith('data:image/svg+xml;base64,')) {
        throw new Error('图片验证码服务返回异常，请检查后端部署或 Netlify API 代理配置');
      }
      setCaptchaId(result.captchaId);
      setCaptchaImage(result.image);
    } catch (captchaError) {
      setCaptchaId('');
      setCaptchaImage('');
      setError(captchaError instanceof Error ? captchaError.message : '图片验证码加载失败');
    } finally {
      setIsLoadingCaptcha(false);
    }
  }

  const switchMode = (nextMode: 'login' | 'register' | 'forgot') => {
    setMode(nextMode);
    setVerificationCode('');
    setCaptchaCode('');
    setCaptchaId('');
    setCaptchaImage('');
    setError('');
    setNotice('');
    setResendSeconds(0);
  };

  const handleSendCode = async () => {
    setError('');
    setNotice('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('请先输入有效邮箱');
      return;
    }
    setIsSendingCode(true);
    try {
      const result = await apiRequest<{ message: string }>('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email, purpose: mode === 'forgot' ? 'reset_password' : 'register' }),
      });
      setNotice(result.message);
      setResendSeconds(60);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : '验证码发送失败');
    } finally {
      setIsSendingCode(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      if (mode === 'register') await register({ username, email, password, verificationCode });
      else if (mode === 'forgot') {
        await apiRequest('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, newPassword: password, confirmPassword, verificationCode }) });
        setNotice('密码已重置，请返回登录');
        switchMode('login');
      } else await login({ identifier: username, password, captchaId, captchaCode });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '认证失败');
      if (mode === 'login') void loadCaptcha();
    } finally {
      setIsSubmitting(false);
    }
  };

  if (mode === 'forgot') return (
    <main className="min-h-screen bg-dark-950 text-white flex items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-md space-y-4 bg-dark-900 border border-dark-700 rounded-xl p-6">
        <h1 className="text-2xl font-semibold">忘记密码</h1><p className="text-sm text-dark-400">使用注册邮箱接收验证码并设置新密码。</p>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full h-11 px-3 rounded-lg bg-dark-800 border border-dark-700" placeholder="注册邮箱" />
        <div className="grid grid-cols-[1fr_auto] gap-2"><input value={verificationCode} onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required maxLength={6} inputMode="numeric" className="w-full h-11 px-3 rounded-lg bg-dark-800 border border-dark-700" placeholder="6 位邮箱验证码" /><button type="button" onClick={handleSendCode} disabled={isSendingCode || resendSeconds > 0} className="h-11 px-3 rounded-lg border border-dark-600 text-sm">{resendSeconds > 0 ? `${resendSeconds}s` : '发送验证码'}</button></div>
        <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} maxLength={128} className="w-full h-11 px-3 rounded-lg bg-dark-800 border border-dark-700" placeholder="新密码" />
        <input type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} maxLength={128} className="w-full h-11 px-3 rounded-lg bg-dark-800 border border-dark-700" placeholder="确认新密码" />
        {notice && <div role="status" className="text-sm text-green-300">{notice}</div>}{error && <div role="alert" className="text-sm text-red-300">{error}</div>}
        <button type="submit" disabled={isSubmitting || verificationCode.length !== 6} className="w-full h-11 rounded-lg bg-primary-600 disabled:opacity-60">重置密码</button>
        <button type="button" onClick={() => switchMode('login')} className="w-full text-sm text-dark-400 hover:text-white">返回登录</button>
      </form>
    </main>
  );

  return (
    <main className="min-h-screen bg-dark-950 text-white grid lg:grid-cols-[minmax(320px,0.9fr)_minmax(420px,1.1fr)]">
      <section className="hidden lg:flex border-r border-dark-700/60 bg-dark-900 p-12 flex-col justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary-600 flex items-center justify-center"><Film className="w-6 h-6" /></div>
          <div><h1 className="font-semibold">AI Drama Studio</h1><p className="text-xs text-dark-400">受保护的创作工作区</p></div>
        </div>
        <div className="max-w-md">
          <p className="text-sm text-primary-400 mb-3">从剧本到可执行镜头</p>
          <h2 className="text-4xl font-semibold leading-tight">让角色、镜头和连续性保持在同一个故事里。</h2>
        </div>
        <p className="text-xs text-dark-500">账户会话由服务端验证，密码不会保存为明文。</p>
      </section>

      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="lg:hidden flex items-center gap-3 mb-10"><Film className="w-7 h-7 text-primary-400" /><span className="font-semibold">AI Drama Studio</span></div>
          <div className="flex items-center gap-2 text-dark-400 mb-4"><LockKeyhole className="w-4 h-4" /><span className="text-sm">服务端安全验证</span></div>
          <h2 className="text-3xl font-semibold mb-2">{mode === 'login' ? '登录创作空间' : '创建创作账户'}</h2>
          <p className="text-sm text-dark-400 mb-8">{mode === 'login' ? '继续编辑你的短剧项目与导演方案。' : '注册后即可管理自己的 Skill 和分镜方案。'}</p>

          <div className="grid grid-cols-2 bg-dark-900 border border-dark-700 rounded-lg p-1 mb-6">
            {(['login', 'register'] as const).map((item) => (
              <button key={item} type="button" onClick={() => switchMode(item)} className={`h-9 rounded-md text-sm ${mode === item ? 'bg-dark-700 text-white' : 'text-dark-400 hover:text-white'}`}>
                {item === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>
          {mode === 'login' && <button type="button" onClick={() => switchMode('forgot')} className="mb-4 text-sm text-primary-400 hover:text-primary-300">忘记密码？使用邮箱验证码重置</button>}

          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block"><span className="text-sm text-dark-300">{mode === 'login' ? '用户名或邮箱' : '用户名'}</span><div className="relative mt-2"><UserRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-500" /><input value={username} onChange={(e) => setUsername(e.target.value)} minLength={3} maxLength={mode === 'login' ? 320 : 30} required autoComplete="username" className="w-full h-11 pl-10 pr-3 rounded-lg bg-dark-900 border border-dark-700 focus:border-primary-500 outline-none" /></div></label>
            {mode === 'register' && <label className="block"><span className="text-sm text-dark-300">邮箱</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" className="mt-2 w-full h-11 px-3 rounded-lg bg-dark-900 border border-dark-700 focus:border-primary-500 outline-none" /></label>}
            <label className="block"><span className="text-sm text-dark-300">密码</span><div className="relative mt-2"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className="w-full h-11 px-3 pr-11 rounded-lg bg-dark-900 border border-dark-700 focus:border-primary-500 outline-none" /><button type="button" onClick={() => setShowPassword((visible) => !visible)} className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-dark-400 hover:text-white" title={showPassword ? '隐藏密码' : '显示密码'} aria-label={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button></div></label>
            {mode === 'register' ? (
              <label className="block"><span className="text-sm text-dark-300">邮箱验证码</span><div className="mt-2 grid grid-cols-[1fr_auto] gap-2"><input value={verificationCode} onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required placeholder="6 位验证码" className="w-full h-11 px-3 rounded-lg bg-dark-900 border border-dark-700 focus:border-primary-500 outline-none tracking-[0.3em]" /><button type="button" onClick={handleSendCode} disabled={isSendingCode || resendSeconds > 0} className="h-11 min-w-28 px-3 rounded-lg border border-dark-600 bg-dark-800 hover:bg-dark-700 disabled:opacity-50 text-sm flex items-center justify-center gap-2">{isSendingCode ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}{resendSeconds > 0 ? `${resendSeconds}s` : '发送验证码'}</button></div></label>
            ) : (
              <label className="block"><span className="text-sm text-dark-300">图片验证码</span><div className="mt-2 grid grid-cols-[minmax(0,1fr)_160px] gap-2"><input value={captchaCode} onChange={(e) => setCaptchaCode(e.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" autoComplete="off" pattern="\d{5}" maxLength={5} required placeholder="输入图中数字" className="w-full h-12 px-3 rounded-lg bg-dark-900 border border-dark-700 focus:border-primary-500 outline-none tracking-[0.25em]" /><button type="button" onClick={loadCaptcha} disabled={isLoadingCaptcha} title="刷新验证码" aria-label="刷新验证码" className="h-12 w-40 overflow-hidden rounded-lg border border-dark-600 bg-dark-800 hover:border-dark-500 disabled:opacity-50 flex items-center justify-center">{isLoadingCaptcha ? <Loader2 className="w-5 h-5 animate-spin" /> : captchaImage ? <img src={captchaImage} alt="数字验证码" className="block w-full h-full object-contain" /> : <RefreshCw className="w-5 h-5" />}</button></div></label>
            )}
            {notice && <div role="status" className="text-sm text-green-300 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2">{notice}</div>}
            {error && <div role="alert" className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
            <button disabled={isSubmitting || (mode === 'register' ? verificationCode.length !== 6 : captchaCode.length !== 5 || !captchaId)} className="w-full h-11 rounded-lg bg-primary-600 hover:bg-primary-500 disabled:opacity-60 font-medium flex items-center justify-center gap-2">
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}{mode === 'login' ? '登录' : '创建账户'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
