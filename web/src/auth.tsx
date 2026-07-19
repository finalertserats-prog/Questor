import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setToken, getToken } from './api/client';

export interface User { id: string; name: string; email: string; role: string; }
interface AuthCtx { user: User | null; tenant: { id: string; name: string } | null; loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (b: { email: string; password: string; name: string; tenantName?: string }) => Promise<void>;
  logout: () => void; }

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api.get<{ user: User; tenant: any }>('/auth/me')
      .then((d) => { setUser(d.user); setTenant(d.tenant); })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const d = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
    setToken(d.token); setUser(d.user);
    const me = await api.get<{ tenant: any }>('/auth/me'); setTenant(me.tenant);
  };
  const register = async (b: any) => {
    const d = await api.post<{ token: string; user: User }>('/auth/register', b);
    setToken(d.token); setUser(d.user);
    const me = await api.get<{ tenant: any }>('/auth/me'); setTenant(me.tenant);
  };
  const logout = () => { setToken(null); setUser(null); setTenant(null); };

  return <Ctx.Provider value={{ user, tenant, loading, login, register, logout }}>{children}</Ctx.Provider>;
}
