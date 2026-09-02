import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiRequest, setSessionExpiredHandler } from '@/services/apiClient';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  name: string;
  createdAt: string;
  role: 'user' | 'system';
  accountType?: 'user' | 'special' | 'system';
  balanceCents: number;
}

interface RegisterCredentials {
  username: string;
  email: string;
  password: string;
  verificationCode: string;
}

interface LoginCredentials {
  identifier: string;
  password: string;
  captchaId: string;
  captchaCode: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  register: (credentials: RegisterCredentials) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await apiRequest<{ user: AuthUser | null }>('/api/auth/me');
      setUser(result.user);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => setSessionExpiredHandler(() => {
    // A newer login invalidated this browser's session. Returning to the
    // auth screen also prevents any further writes with the stale token.
    setUser(null);
  }), []);

  const login = useCallback(async (credentials: LoginCredentials) => {
    const result = await apiRequest<{ user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    setUser(result.user);
  }, []);

  const register = useCallback(async (credentials: RegisterCredentials) => {
    const result = await apiRequest<{ user: AuthUser }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    await apiRequest<void>('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, isLoading, login, register, logout, refresh }), [user, isLoading, login, register, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
