import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { User, UsageStatus, AuthConfig, Plan } from '../api/types';

interface AuthState {
  user: User | null;
  usage: UsageStatus | null;
  plan: Pick<Plan, 'id' | 'name' | 'description' | 'durationMonths' | 'priceCents' | 'currency'> | null;
  authConfig: AuthConfig | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setUsage: (u: UsageStatus | null) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [plan, setPlan] = useState<AuthState['plan']>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(true);

  // Public sign-in policy (whether the sign-up page is available).
  useEffect(() => {
    api.get<AuthConfig>('/api/auth/config').then(setAuthConfig).catch(() => setAuthConfig(null));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: User | null; usage: UsageStatus | null; plan: AuthState['plan'] }>('/api/auth/me');
      setUser(r.user);
      setUsage(r.usage ?? null);
      setPlan(r.plan ?? null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setUser(null);
    setUsage(null);
    setPlan(null);
  }, []);

  return <Ctx.Provider value={{ user, usage, plan, authConfig, loading, refresh, setUsage, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
