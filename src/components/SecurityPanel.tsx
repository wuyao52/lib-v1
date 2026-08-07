import { useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { apiRequest } from '@/services/apiClient';

export default function SecurityPanel({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true); setError(''); setMessage('');
    try {
      const result = await apiRequest<{ message: string }>('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
      setMessage(result.message); setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (requestError: any) { setError(requestError.message); } finally { setSaving(false); }
  };
  return <div className="fixed inset-0 z-[100] flex items-center justify-center p-4"><button className="absolute inset-0 bg-black/70" onClick={onClose} aria-label="关闭" /><section className="relative w-full max-w-md bg-dark-800 border border-dark-600 rounded-lg p-5 space-y-4"><header className="flex justify-between items-center"><h2 className="text-white font-semibold flex items-center gap-2"><KeyRound className="w-5 h-5 text-primary-400" />修改密码</h2><button onClick={onClose} className="p-2 text-dark-400" title="关闭"><X className="w-4 h-4" /></button></header><p className="text-xs text-dark-400">修改后其他设备的登录会话会失效。</p><input className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded text-white" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="当前密码" /><input className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded text-white" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="新密码（8-128 位）" minLength={8} maxLength={128} /><input className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded text-white" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="确认新密码" minLength={8} maxLength={128} />{message && <p className="text-sm text-green-300">{message}</p>}{error && <p className="text-sm text-red-300">{error}</p>}<button disabled={saving || !currentPassword || newPassword.length < 8 || newPassword !== confirmPassword} onClick={submit} className="w-full py-2 bg-primary-600 disabled:bg-dark-700 disabled:text-dark-500 rounded text-white">{saving ? '保存中...' : '确认修改密码'}</button></section></div>;
}
